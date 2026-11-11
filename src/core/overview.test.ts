import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './csv';
import { analyzeLocally, summaryOverview } from './pipeline';

describe('overview handed to the on-device summary', () => {
  const rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
  const truth = JSON.parse(readFileSync('public/samples/acme-q3.truth.json', 'utf8'));
  const a = analyzeLocally(rows);
  const text = summaryOverview(a);

  it('uses aliases and computed numbers only', () => {
    for (const v of Object.values(truth.pii).flat() as string[]) expect(text.toLowerCase(), v).not.toContain(v.toLowerCase());
    for (const r of rows) expect(text).not.toContain(r.description);
  });

  it('mentions the period, totals and every flagged signal', () => {
    expect(text).toContain(a.period.from);
    expect(text).toContain(`${a.rows.length} transactions`);
    for (const s of a.signals) expect(text).toContain(s.vendor);
  });
});
