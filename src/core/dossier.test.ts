import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { rowsFromReview } from '../ai/photo';
import { clearLocalData, getDecision, listDecisions, listDossiers, saveDecision, saveDossiers } from '../store/receipts';
import { parseStatement } from './csv';
import { buildDossiers } from './dossier';
import { analyzeLocally } from './pipeline';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';

describe('buildDossiers', () => {
  beforeEach(async () => {
    await clearLocalData();
  });

  it('builds a complete evidence dossier for each anomaly and integrity alert with source rows, Remote Config thresholds, and computed values', () => {
    const rows = parseStatement(readFileSync('public/samples/acme-q3-gaps.csv', 'utf8'));
    const customThresholds: Thresholds = {
      ...DEFAULT_THRESHOLDS,
      duplicateWindowDays: 4,
      outlierZ: 2.2,
    };
    const analysis = analyzeLocally(rows, {
      thresholds: customThresholds,
      fileName: 'acme-q3-gaps.csv',
    });

    const dossiers = buildDossiers(analysis, customThresholds);
    expect(dossiers.length).toBe(analysis.signals.length + analysis.integrity.length);

    const dup = dossiers.find((d) => d.kind === 'anomaly' && d.type === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.sourceRows).toHaveLength(2);
    expect(dup!.sourceRows[0].line).toBeGreaterThanOrEqual(1);
    expect(dup!.sourceRows[1].line).toBeGreaterThan(dup!.sourceRows[0].line);
    expect(dup!.rule.thresholdSummary).toContain('4 days');
    expect(dup!.rule.thresholds.duplicateWindowDays).toBe(4);
    expect(dup!.computed.some((m) => m.label === 'Interval' && m.value.includes('day'))).toBe(true);

    const outlier = dossiers.find((d) => d.kind === 'anomaly' && d.type === 'outlier');
    expect(outlier).toBeDefined();
    expect(outlier!.rule.thresholdSummary).toContain('2.2');
    expect(outlier!.computed.map((m) => m.label)).toEqual(
      expect.arrayContaining(['Charge amount', 'Category mean', 'Category std dev', 'Category samples', 'Computed z-score']),
    );

    const balMismatch = dossiers.find((d) => d.kind === 'integrity' && d.type === 'balance_mismatch');
    expect(balMismatch).toBeDefined();
    expect(balMismatch!.sourceRows.map((r) => r.line)).toEqual([41, 42]);
    expect(balMismatch!.proof).toContain('gap between rows 41–42');
    expect(balMismatch!.computed.map((m) => m.label)).toEqual(
      expect.arrayContaining(['Expected', 'Statement says', 'Discrepancy']),
    );
  });

  it('records Gemini Nano photo provenance and whether the user edited the row in Check what was read', () => {
    const initial = [
      { date: '2025-09-05', description: 'CLOUDNEST HOSTING monthly plan', amount: '-78.00' },
      { date: '2025-09-08', description: 'CLOUDNEST HOSTING monthly plan', amount: '-79.00' },
    ];
    const edited = [
      { date: '2025-09-05', description: 'CLOUDNEST HOSTING monthly plan', amount: '-79.00', page: 1 },
      { date: '2025-09-08', description: 'CLOUDNEST HOSTING monthly plan', amount: '-79.00', page: 1 },
    ];
    const statementRows = rowsFromReview(edited, initial);
    const analysis = analyzeLocally(statementRows);
    const dossiers = buildDossiers(analysis, DEFAULT_THRESHOLDS);

    const dup = dossiers.find((d) => d.type === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.sourceRows[0].page).toBe(1);
    expect(dup!.sourceRows[0].photo).toEqual({
      rawDate: '2025-09-05',
      rawDescription: 'CLOUDNEST HOSTING monthly plan',
      rawAmount: '-78.00',
      editedByUser: true,
    });
    expect(dup!.sourceRows[1].photo).toEqual({
      rawDate: '2025-09-08',
      rawDescription: 'CLOUDNEST HOSTING monthly plan',
      rawAmount: '-79.00',
      editedByUser: false,
    });
  });

  it('persists dossiers and user decisions (explained, ask_accountant, ignore) with notes in IndexedDB', async () => {
    const rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
    const analysis = analyzeLocally(rows, { fileName: 'acme-q3.csv' });
    const dossiers = buildDossiers(analysis, DEFAULT_THRESHOLDS);

    await saveDossiers(dossiers);
    const storedDossiers = await listDossiers();
    expect(storedDossiers).toHaveLength(dossiers.length);

    await saveDecision({
      alertId: dossiers[0].id,
      status: 'ask_accountant',
      note: 'Please check if we received a credit note for the second charge.',
      updatedAt: '2026-11-24T14:00:00.000Z',
    });
    await saveDecision({
      alertId: dossiers[1].id,
      status: 'explained',
      note: 'Annual tier upgrade approved in August.',
      updatedAt: '2026-11-24T14:01:00.000Z',
    });
    await saveDecision({
      alertId: dossiers[2].id,
      status: 'ignore',
      note: 'Normal weekend office order.',
      updatedAt: '2026-11-24T14:02:00.000Z',
    });

    const d0 = await getDecision(dossiers[0].id);
    expect(d0).toEqual({
      alertId: dossiers[0].id,
      status: 'ask_accountant',
      note: 'Please check if we received a credit note for the second charge.',
      updatedAt: '2026-11-24T14:00:00.000Z',
    });

    const all = await listDecisions();
    expect(all.map((d) => d.status).sort()).toEqual(['ask_accountant', 'explained', 'ignore']);

    await clearLocalData();
    expect(await listDecisions()).toEqual([]);
    expect(await listDossiers()).toEqual([]);
  });
});
