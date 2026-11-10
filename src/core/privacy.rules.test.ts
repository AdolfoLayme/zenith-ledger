// DESIGN RULES AS TESTS. Do not weaken, skip or delete these to make a change pass.
// If one fails, fix the code.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './csv';
import { analyzeLocally, buildPayload } from './pipeline';
import { reidentify } from './pseudonymize';

interface Truth {
  pii: Record<'cards' | 'emails' | 'phones' | 'ibans' | 'accounts' | 'ssns' | 'eins' | 'urls' | 'persons' | 'vendors', string[]>;
  anomalies: { duplicates: unknown[]; priceIncreases: unknown[]; outliers: unknown[]; roundTransfers: unknown[]; weekendSpend: unknown[] };
}
const load = (name: string) => ({
  rows: parseStatement(readFileSync(`public/samples/${name}.csv`, 'utf8')),
  truth: JSON.parse(readFileSync(`public/samples/${name}.truth.json`, 'utf8')) as Truth,
});

describe.each(['acme-q3', 'acme-q4'])('privacy rules: %s', (name) => {
  const { rows, truth } = load(name);

  it('the sample has between 90 and 150 rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(90);
    expect(rows.length).toBeLessThanOrEqual(150);
  });

  it('no seeded sensitive value appears in the outgoing payload (strict mode)', async () => {
    const a = analyzeLocally(rows);
    const { json } = await buildPayload(a);
    const compact = json.replace(/[\s\-().+]/g, '');
    const sensitive = [...truth.pii.cards, ...truth.pii.emails, ...truth.pii.phones, ...truth.pii.ibans,
      ...truth.pii.accounts, ...truth.pii.ssns, ...truth.pii.eins, ...truth.pii.urls, ...truth.pii.persons, ...truth.pii.vendors];
    expect(sensitive.length).toBeGreaterThan(10);
    for (const v of sensitive) {
      expect(json.toLowerCase(), v).not.toContain(v.toLowerCase());
      if (/\d{7}/.test(v)) expect(compact, v).not.toContain(v.replace(/[\s\-().+]/g, ''));
    }
    expect(json).not.toMatch(/token=/);
  });

  it('no sensitive value leaks either when an on-device model supplied entities', async () => {
    const entities = rows.map((r) => ({ persons: truth.pii.persons.filter((p) => r.description.includes(p)), merchant: truth.pii.vendors.find((v) => r.description.includes(v)) }));
    const a = analyzeLocally(rows, { entities });
    const { json } = await buildPayload(a);
    for (const v of [...truth.pii.persons, ...truth.pii.vendors, ...truth.pii.emails, ...truth.pii.cards]) {
      expect(json.toLowerCase(), v).not.toContain(v.toLowerCase());
    }
  });

  it('rawDescriptionsSent is 0', async () => {
    const { counters } = await buildPayload(analyzeLocally(rows));
    expect(counters.rawDescriptionsSent).toBe(0);
  });

  it('every seeded deterministic PII value is detected locally', () => {
    const a = analyzeLocally(rows);
    const found = new Set(a.rows.flatMap((r) => r.spans.map((s) => s.value)));
    for (const v of [...truth.pii.cards, ...truth.pii.emails, ...truth.pii.phones, ...truth.pii.ibans, ...truth.pii.ssns, ...truth.pii.eins, ...truth.pii.urls]) {
      expect(found.has(v), `not detected: ${v}`).toBe(true);
    }
    expect(a.counters.piiFound).toBeGreaterThan(10);
    expect(a.counters.piiReplaced).toBe(a.counters.piiFound);
  });

  it('re-identifying an alias returns the original value', () => {
    const a = analyzeLocally(rows);
    expect(a.aliases.size).toBeGreaterThan(10);
    for (const [alias, original] of a.aliases) expect(reidentify(`x ${alias} y`, a.aliases)).toBe(`x ${original} y`);
  });

  it('local text with PII replaced contains no seeded sensitive value', () => {
    const a = analyzeLocally(rows);
    const text = a.rows.map((r) => r.redacted).join('\n');
    for (const v of [...truth.pii.cards, ...truth.pii.emails, ...truth.pii.phones, ...truth.pii.ibans, ...truth.pii.ssns, ...truth.pii.eins]) {
      expect(text).not.toContain(v);
    }
  });

  it('finds every seeded anomaly kind', () => {
    const a = analyzeLocally(rows);
    const count = (t: string) => a.signals.filter((s) => s.type === t).length;
    expect(count('duplicate')).toBe(truth.anomalies.duplicates.length);
    expect(count('price_increase')).toBe(truth.anomalies.priceIncreases.length);
    expect(count('outlier')).toBeGreaterThanOrEqual(truth.anomalies.outliers.length);
    expect(count('round_transfer')).toBe(truth.anomalies.roundTransfers.length);
    expect(count('weekend_spend')).toBe(truth.anomalies.weekendSpend.length);
  });
});
