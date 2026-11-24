import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatement } from '../core/csv';
import { buildDossiers, type AlertDecision } from '../core/dossier';
import { analyzeLocally } from '../core/pipeline';
import { reidentify } from '../core/pseudonymize';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import {
  buildAccountantPack,
  isPackExpired,
  memoryPackStore,
  parseAccountantPack,
  parsePackReply,
} from './pack';

const truth = JSON.parse(readFileSync('public/samples/acme-q3.truth.json', 'utf8')) as {
  pii: Record<string, string[]>;
};
const allSensitive = Object.values(truth.pii).flat();

describe('Accountant review pack', () => {
  const rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
  const entities = rows.map((r) => ({
    persons: truth.pii.persons.filter((p) => r.description.includes(p)),
    merchant: truth.pii.vendors.find((v) => r.description.includes(v)),
  }));
  const analysis = analyzeLocally(rows, { entities, fileName: 'acme-q3.csv' });
  const dossiers = buildDossiers(analysis, DEFAULT_THRESHOLDS);

  it('refuses to build a pack when no alert is marked ask_accountant', async () => {
    await expect(buildAccountantPack(analysis, dossiers, {})).rejects.toThrow(/Ask my accountant/i);
  });

  it('includes ONLY the rows of alerts marked ask_accountant, pseudonymized with aliases, and zero raw descriptions or unselected rows', async () => {
    const dupDossier = dossiers.find((d) => d.type === 'duplicate')!;
    const priceDossier = dossiers.find((d) => d.type === 'price_increase')!;
    const decisions: Record<string, AlertDecision> = {
      [dupDossier.id]: {
        alertId: dupDossier.id,
        status: 'ask_accountant',
        note: 'Did DELTA OFFICE DEPOT or John Smith issue a refund for this duplicate?',
        updatedAt: '2026-11-24T15:00:00.000Z',
      },
      [priceDossier.id]: {
        alertId: priceDossier.id,
        status: 'explained',
        note: 'We upgraded our plan.',
        updatedAt: '2026-11-24T15:01:00.000Z',
      },
    };

    const built = await buildAccountantPack(analysis, dossiers, decisions, {
      nowMs: Date.parse('2026-11-24T15:00:00.000Z'),
      ttlMs: 7 * 86400000,
    });

    expect(built.pack.selectedAlertCount).toBe(1);
    expect(built.pack.items).toHaveLength(1);
    expect(built.pack.items[0].alertId).toBe(dupDossier.id);
    expect(built.pack.items[0].rows).toHaveLength(2);
    expect(built.pack.selectedRowCount).toBe(2);
    expect(built.pack.totalStatementRows).toBe(117);
    expect(built.counters.unselectedRowsExcluded).toBe(115);
    expect(built.counters.rawDescriptionsSent).toBe(0);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);

    // Only the chosen rows' line numbers are present
    const chosenLines = dupDossier.sourceRows.map((r) => r.line);
    expect(built.pack.items[0].rows.map((r) => r.line)).toEqual(chosenLines);

    // Real names in the user's question ("DELTA OFFICE DEPOT", "John Smith") were replaced with aliases
    expect(built.pack.items[0].question).not.toContain('DELTA OFFICE DEPOT');
    expect(built.pack.items[0].question).not.toContain('John Smith');
    expect(built.pack.items[0].question).toMatch(/Vendor_[A-Z]+/);
    expect(built.pack.items[0].question).toMatch(/Person_\d+/);

    // No sensitive value from the entire statement appears anywhere in the serialized pack JSON
    for (const v of allSensitive) {
      expect(built.json.toLowerCase(), `leaked: ${v}`).not.toContain(v.toLowerCase());
    }
    // No row object has a description field
    for (const r of built.pack.items[0].rows) {
      expect('description' in r).toBe(false);
      expect('redacted' in r).toBe(false);
    }
  });

  it('validates the pack allowlist and rejects raw fields, real vendor names, or expired packs', async () => {
    const dupDossier = dossiers.find((d) => d.type === 'duplicate')!;
    const built = await buildAccountantPack(
      analysis,
      dossiers,
      {
        [dupDossier.id]: {
          alertId: dupDossier.id,
          status: 'ask_accountant',
          note: 'Check duplicate charge.',
          updatedAt: '2026-11-24T15:00:00.000Z',
        },
      },
      { nowMs: Date.parse('2026-11-24T15:00:00.000Z'), ttlMs: 3600_000 },
    );

    expect(parseAccountantPack(built.pack)).toEqual(built.pack);
    expect(isPackExpired(built.pack, Date.parse('2026-11-24T15:30:00.000Z'))).toBe(false);
    expect(isPackExpired(built.pack, Date.parse('2026-11-24T16:00:01.000Z'))).toBe(true);

    // Reject extra top-level field
    expect(parseAccountantPack({ ...built.pack, rawStatement: 'secret' })).toBeNull();
    // Reject extra row field (e.g. description)
    expect(
      parseAccountantPack({
        ...built.pack,
        items: [
          {
            ...built.pack.items[0],
            rows: [{ ...built.pack.items[0].rows[0], description: 'POS DEBIT DELTA OFFICE DEPOT' }],
          },
        ],
      }),
    ).toBeNull();
    // Reject real vendor name in place of alias
    expect(
      parseAccountantPack({
        ...built.pack,
        items: [{ ...built.pack.items[0], vendorAlias: 'DELTA OFFICE DEPOT' }],
      }),
    ).toBeNull();
  });

  it('stores a pack, accepts accountant replies with aliases, rejects expired packs, and re-identifies real names on the client', async () => {
    const dupDossier = dossiers.find((d) => d.type === 'duplicate')!;
    const nowMs = Date.parse('2026-11-24T15:00:00.000Z');
    const built = await buildAccountantPack(
      analysis,
      dossiers,
      {
        [dupDossier.id]: {
          alertId: dupDossier.id,
          status: 'ask_accountant',
          note: 'Was this billed twice?',
          updatedAt: '2026-11-24T15:00:00.000Z',
        },
      },
      { nowMs, ttlMs: 3600_000 },
    );

    const store = memoryPackStore(() => nowMs);
    await store.create(built.pack);

    const loaded = await store.get(built.pack.packId);
    expect(loaded?.pack.packId).toBe(built.pack.packId);

    const alias = built.pack.items[0].vendorAlias;
    const reply = parsePackReply({
      alertId: dupDossier.id,
      packId: built.pack.packId,
      reply: `Book the second ${alias} charge to accounts receivable pending a credit memo.`,
      repliedAt: '2026-11-24T15:10:00.000Z',
      author: 'Accountant',
    });
    expect(reply).not.toBeNull();
    await store.reply(built.pack.packId, reply!);

    const updated = await store.get(built.pack.packId);
    expect(updated?.replies).toHaveLength(1);
    const reidentified = reidentify(updated!.replies[0].reply, analysis.aliases);
    expect(reidentified).toContain('DELTA OFFICE');
    expect(reidentified).not.toContain(alias);

    // After expiration, get and reply are refused
    const expiredStore = memoryPackStore(() => nowMs + 7200_000);
    await expect(expiredStore.create(built.pack)).rejects.toThrow(/expired/i);
  });
});
