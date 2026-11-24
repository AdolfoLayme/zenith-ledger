import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAccountantPack, parseAccountantPack } from '../pack/pack';
import { clearLocalData, listPeriodSummaries, saveAliasMap, savePeriodSummary } from '../store/receipts';
import { comparePeriods, summarizePeriod } from './compare';
import { parseStatement } from './csv';
import { buildDossiers, type AlertDecision } from './dossier';
import { analyzeLocally } from './pipeline';
import { reidentify } from './pseudonymize';
import { DEFAULT_THRESHOLDS } from './thresholds';

describe('Period-over-period comparison (Q2 vs Q3)', () => {
  beforeEach(async () => {
    await clearLocalData();
  });

  it('ships coherent acme-q2.csv and acme-q3.csv synthetic samples', () => {
    expect(existsSync('public/samples/acme-q2.csv')).toBe(true);
    expect(existsSync('public/samples/acme-q2.truth.json')).toBe(true);
    const q2Rows = parseStatement(readFileSync('public/samples/acme-q2.csv', 'utf8'));
    const q3Rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
    expect(q2Rows.length).toBeGreaterThanOrEqual(90);
    expect(q3Rows.length).toBe(117);
    expect(q2Rows[0].date.startsWith('2025-04')).toBe(true);
    expect(q2Rows[q2Rows.length - 1].date.startsWith('2025-06')).toBe(true);
  });

  it('stores only aggregate vendor aliases, amounts, and counts in IndexedDB (never raw rows or real merchant names)', async () => {
    const q2Rows = parseStatement(readFileSync('public/samples/acme-q2.csv', 'utf8'));
    const q2Truth = JSON.parse(readFileSync('public/samples/acme-q2.truth.json', 'utf8')) as {
      pii: Record<string, string[]>;
    };
    const q2Analysis = analyzeLocally(q2Rows, { fileName: 'acme-q2.csv' });
    const summary = summarizePeriod(q2Analysis, 'acme-q2.csv');

    await savePeriodSummary(summary);
    await saveAliasMap(`period:${summary.id}`, q2Analysis.aliases);

    const saved = await listPeriodSummaries();
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('Q2 2025');

    const serialized = JSON.stringify(saved[0]);
    for (const secret of Object.values(q2Truth.pii).flat()) {
      expect(serialized.toLowerCase(), `leaked in period summary: ${secret}`).not.toContain(secret.toLowerCase());
    }
    for (const row of q2Rows) {
      expect(serialized).not.toContain(row.description);
    }
    expect(saved[0].vendors.every((v) => /^Vendor_[A-Z]+$/.test(v.vendorAlias))).toBe(true);
  });

  it('detects new subscriptions, recurring price increases, disappeared recurring charges, and category spend growth above Remote Config threshold', () => {
    const q2Rows = parseStatement(readFileSync('public/samples/acme-q2.csv', 'utf8'));
    const q3Rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));

    const q2Analysis = analyzeLocally(q2Rows, { fileName: 'acme-q2.csv' });
    const q2Summary = summarizePeriod(q2Analysis, 'acme-q2.csv');
    const q3Analysis = analyzeLocally(q3Rows, {
      fileName: 'acme-q3.csv',
      initialAliases: q2Analysis.aliases,
    });

    const findings = comparePeriods(q3Analysis, q2Summary, DEFAULT_THRESHOLDS);

    // 1. New subscription in Q3 that did not exist in Q2: STREAMDESK PRO ($15.99/mo)
    const newSubs = findings.filter((f) => f.type === 'new_subscription');
    expect(newSubs.length).toBeGreaterThanOrEqual(1);
    const streamDesk = newSubs.find((f) => reidentify(f.vendorAlias, q3Analysis.aliases).includes('STREAMDESK'));
    expect(streamDesk).toBeDefined();
    expect(streamDesk!.unitAmountCents).toBe(1599);

    // 2. Recurring price increases from Q2 to Q3: NORTHWIND SOFTWARE ($99 -> $129) and CLOUDNEST HOSTING ($49 -> $59)
    const increases = findings.filter((f) => f.type === 'recurring_price_increase');
    const northwind = increases.find((f) => reidentify(f.vendorAlias, q3Analysis.aliases).includes('NORTHWIND'));
    expect(northwind).toBeDefined();
    expect(northwind).toMatchObject({
      fromCents: 9900,
      toCents: 12900,
    });
    const cloudnest = increases.find((f) => reidentify(f.vendorAlias, q3Analysis.aliases).includes('CLOUDNEST'));
    expect(cloudnest).toBeDefined();
    expect(cloudnest).toMatchObject({
      fromCents: 4900,
      toCents: 5900,
    });

    // 3. Disappeared recurring charge from Q2 that vanished in Q3: ATLAS BACKUP PRO ($39/mo)
    const stopped = findings.filter((f) => f.type === 'stopped_recurring');
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    const atlas = stopped.find((f) => reidentify(f.vendorAlias, q3Analysis.aliases).includes('ATLAS BACKUP'));
    expect(atlas).toBeDefined();
    expect(atlas!.priorUnitAmountCents).toBe(3900);

    // 4. Category growth above Remote Config threshold (25%): Supplies
    const catGrowth = findings.filter((f) => f.type === 'category_growth');
    const supplies = catGrowth.find((f) => f.category === 'Supplies');
    expect(supplies).toBeDefined();
    expect(supplies!.growthPercent).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.categoryGrowthMinPercent);

    // Raising categoryGrowthMinPercent in Remote Config above the growth percentage suppresses category_growth
    const highThresholdFindings = comparePeriods(q3Analysis, q2Summary, {
      ...DEFAULT_THRESHOLDS,
      categoryGrowthMinPercent: 500,
    });
    expect(highThresholdFindings.filter((f) => f.type === 'category_growth')).toHaveLength(0);
  });

  it('builds an Evidence Dossier for every period comparison finding and packages any of them into a valid Accountant Review Pack', async () => {
    const q2Rows = parseStatement(readFileSync('public/samples/acme-q2.csv', 'utf8'));
    const q3Rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
    const q2Analysis = analyzeLocally(q2Rows, { fileName: 'acme-q2.csv' });
    const q2Summary = summarizePeriod(q2Analysis, 'acme-q2.csv');
    const q3Analysis = analyzeLocally(q3Rows, {
      fileName: 'acme-q3.csv',
      initialAliases: q2Analysis.aliases,
    });

    const findings = comparePeriods(q3Analysis, q2Summary, DEFAULT_THRESHOLDS);
    const dossiers = buildDossiers(q3Analysis, DEFAULT_THRESHOLDS, undefined, findings);
    const compDossiers = dossiers.filter((d) => d.kind === 'comparison');
    expect(compDossiers).toHaveLength(findings.length);

    // Mark every comparison dossier (including stopped_recurring which has 0 rows in Q3) as ask_accountant
    const decisions: Record<string, AlertDecision> = {};
    for (const d of compDossiers) {
      decisions[d.id] = {
        alertId: d.id,
        status: 'ask_accountant',
        note: 'Please review this period-over-period change for our quarterly close.',
        updatedAt: '2026-11-24T17:00:00.000Z',
      };
    }

    const built = await buildAccountantPack(q3Analysis, dossiers, decisions, {
      nowMs: Date.parse('2026-11-24T17:00:00.000Z'),
    });
    expect(built.pack.selectedAlertCount).toBe(compDossiers.length);
    expect(built.counters.rawDescriptionsSent).toBe(0);
    // Must pass the strict allowlist validator
    expect(parseAccountantPack(built.pack)).toEqual(built.pack);
  });
});
