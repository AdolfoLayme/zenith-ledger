import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './csv';
import { checkStatementIntegrity, formatProof, inferDeclaredPeriod } from './integrity';
import type { StatementRow } from './types';

const row = (
  date: string,
  description: string,
  amountCents: number,
  balanceCents: number | null = null,
  page?: number,
): StatementRow => ({
  date,
  description,
  amountCents,
  currency: 'USD',
  balanceCents,
  ...(page !== undefined ? { page } : {}),
});

describe('formatProof', () => {
  it('formats the exact reconciliation string with expected, actual and 1-based row range', () => {
    expect(formatProof(120410, 110410, 41, 42)).toBe(
      'expected 1,204.10, statement says 1,104.10, gap between rows 41–42',
    );
  });

  it('names a single row instead of a range like 1–1', () => {
    expect(formatProof(100, 200, 1, 1)).toBe('expected 1.00, statement says 2.00, at row 1');
  });
});

describe('checkStatementIntegrity', () => {
  it('passes a clean statement with a valid running balance and full period coverage', () => {
    const rows: StatementRow[] = [
      row('2025-07-02', 'ACH deposit Client A', 200000, 1200000),
      row('2025-07-08', 'POS DEBIT Office Supplies', -15000, 1185000),
      row('2025-07-16', 'Utility payment', -25000, 1160000),
      row('2025-07-28', 'Software subscription', -4900, 1155100),
    ];
    expect(
      checkStatementIntegrity(rows, {
        declaredPeriod: { from: '2025-07-01', to: '2025-07-31' },
      }),
    ).toEqual([]);
  });

  it('detects a running balance mismatch with the exact row range and math proof', () => {
    const dayIso = (offset: number) => new Date(Date.UTC(2025, 6, 1 + offset)).toISOString().slice(0, 10);
    const rows: StatementRow[] = Array.from({ length: 41 }, (_, i) =>
      row(dayIso(i), `Item ${i + 1}`, -1000, 171410 - (i + 1) * 1000),
    );
    // Row 41 ends at 130,410 ($1,304.10); Row 42 spends -$100.00 (-10,000), so expected is 120,410 ($1,204.10), statement says 110,410 ($1,104.10)
    rows.push(row(dayIso(41), 'POS DEBIT Hardware #42', -10000, 110410));

    const issues = checkStatementIntegrity(rows);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: 'balance_mismatch',
      rows: [41, 42],
      expectedCents: 120410,
      actualCents: 110410,
      deltaCents: -10000,
      proof: 'expected 1,204.10, statement says 1,104.10, gap between rows 41–42',
    });
  });

  it('detects unusual chronological date gaps between consecutive rows', () => {
    const rows: StatementRow[] = [
      row('2025-07-03', 'Opening deposit', 100000, 500000),
      row('2025-07-05', 'Coffee shop', -1200, 498800),
      row('2025-07-29', 'Late month utility', -8800, 490000),
    ];
    const issues = checkStatementIntegrity(rows, { maxDateGapDays: 14 });
    expect(issues).toEqual([
      expect.objectContaining({
        type: 'date_gap',
        rows: [2, 3],
        gapDays: 24,
        proof: 'no transactions for 24 days between 2025-07-05 (row 2) and 2025-07-29 (row 3)',
      }),
    ]);
    expect(issues[0].expectedCents).toBeUndefined();
  });

  it('detects exact duplicate rows caused by export errors when the balance did not move', () => {
    const rows: StatementRow[] = [
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 120410),
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 120410),
      row('2025-08-12', 'CITY POWER & WATER utility bill', -20000, 100410),
    ];
    const issues = checkStatementIntegrity(rows);
    expect(issues).toEqual([
      expect.objectContaining({
        type: 'duplicate_row',
        rows: [1, 2],
        proof:
          'rows 1 and 2 are identical (date, description, amount, balance 1,204.10): the balance did not move, so the export repeated the line',
      }),
    ]);
  });

  it('does not call a repeated charge an export error when the balance moved both times', () => {
    const rows: StatementRow[] = [
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 120410),
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 101990),
      row('2025-08-12', 'CITY POWER & WATER utility bill', -20000, 81990),
    ];
    expect(checkStatementIntegrity(rows)).toEqual([]);
  });

  it('cannot prove an export duplicate without a balance column', () => {
    const rows: StatementRow[] = [
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420),
      row('2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420),
    ];
    expect(checkStatementIntegrity(rows)).toEqual([]);
  });

  it('detects periods that do not cover the declared range', () => {
    const rows: StatementRow[] = [
      row('2025-07-02', 'ACH deposit', 150000, 350000),
      row('2025-07-14', 'Office supplies', -5000, 345000),
      row('2025-07-26', 'Software monthly', -4900, 340100),
      row('2025-08-05', 'Insurance', -38000, 302100),
      row('2025-08-18', 'Contractor wire', -120000, 182100),
      row('2025-08-29', 'Telecom line', -9500, 172600),
    ];
    const issues = checkStatementIntegrity(rows, {
      declaredPeriod: { from: '2025-07-01', to: '2025-09-30', label: 'Q3' },
    });
    expect(issues).toEqual([
      expect.objectContaining({
        type: 'incomplete_period',
        rows: [6, 6],
        gapDays: 32,
        proof:
          'statement covers 2025-07-02 to 2025-08-29, declared Q3 is 2025-07-01 to 2025-09-30: 32 days missing at the end',
      }),
    ]);
  });

  it('reports a period that starts late as missing days at the start', () => {
    const rows: StatementRow[] = [
      row('2025-07-20', 'ACH deposit', 150000, 350000),
      row('2025-07-31', 'Office supplies', -5000, 345000),
    ];
    const [issue] = checkStatementIntegrity(rows, { declaredPeriod: { from: '2025-07-01', to: '2025-07-31' } });
    expect(issue.rows).toEqual([1, 1]);
    expect(issue.proof).toBe(
      'statement covers 2025-07-20 to 2025-07-31, declared period is 2025-07-01 to 2025-07-31: 19 days missing at the start',
    );
  });

  it('detects missing pages (balance jumps across page boundaries) in multi-page photo reads', () => {
    const rows: StatementRow[] = [
      row('2025-09-02', 'ACH deposit Summit Fitness', 214000, 514000, 1),
      row('2025-09-05', 'CLOUDNEST HOSTING monthly plan', -7900, 506100, 1),
      // Page 2 is missing; page 3 starts with balance reflecting -$1,450.00 of unseen transactions
      row('2025-09-18', 'PINECREST INSURANCE premium', -38000, 323100, 3),
    ];
    const issues = checkStatementIntegrity(rows);
    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'missing_page',
        rows: [2, 3],
        pages: [1, 3],
        expectedCents: 468100,
        actualCents: 323100,
        deltaCents: -145000,
        proof: 'expected 4,681.00, statement says 3,231.00, gap between rows 2–3',
      }),
    );
  });

  it('reports a skipped page number when there is no balance column to prove the loss', () => {
    const rows: StatementRow[] = [
      row('2025-09-02', 'ACH deposit', 214000, null, 1),
      row('2025-09-08', 'PINECREST INSURANCE premium', -38000, null, 3),
    ];
    expect(checkStatementIntegrity(rows)).toEqual([
      expect.objectContaining({
        type: 'missing_page',
        rows: [1, 2],
        pages: [1, 3],
        proof: '1 page missing: the statement jumps from page 1 (row 1) to page 3 (row 2)',
      }),
    ]);
  });

  it('reports zero integrity issues on the clean synthetic acme-q2, acme-q3 and acme-q4 statements', () => {
    for (const name of ['acme-q2.csv', 'acme-q3.csv', 'acme-q4.csv']) {
      const rows = parseStatement(readFileSync(`public/samples/${name}`, 'utf8'));
      const declaredPeriod = inferDeclaredPeriod(name, rows);
      expect(declaredPeriod).toBeDefined();
      expect(checkStatementIntegrity(rows, { declaredPeriod })).toEqual([]);
    }
  });

  it('detects all seeded integrity errors in the synthetic acme-q3-gaps.csv statement', () => {
    const rows = parseStatement(readFileSync('public/samples/acme-q3-gaps.csv', 'utf8'));
    const truth = JSON.parse(readFileSync('public/samples/acme-q3-gaps.truth.json', 'utf8')) as {
      integrity: {
        balanceMismatches: { rows: [number, number]; expectedCents: number; actualCents: number; proof: string }[];
        duplicateRows: { rows: [number, number]; proof: string }[];
        dateGaps: { rows: [number, number]; gapDays: number; proof: string }[];
        incompletePeriod: { declaredFrom: string; declaredTo: string; actualTo: string; proof: string };
      };
    };
    const declaredPeriod = inferDeclaredPeriod('acme-q3-gaps.csv', rows);
    const issues = checkStatementIntegrity(rows, { declaredPeriod });

    const mismatches = issues.filter((i) => i.type === 'balance_mismatch');
    expect(mismatches.length).toBeGreaterThanOrEqual(truth.integrity.balanceMismatches.length);
    for (const expected of truth.integrity.balanceMismatches) {
      expect(mismatches).toContainEqual(
        expect.objectContaining({
          type: 'balance_mismatch',
          rows: expected.rows,
          expectedCents: expected.expectedCents,
          actualCents: expected.actualCents,
          proof: expected.proof,
        }),
      );
    }

    const dupRows = issues.filter((i) => i.type === 'duplicate_row');
    expect(dupRows).toHaveLength(truth.integrity.duplicateRows.length);
    expect(dupRows[0].rows).toEqual(truth.integrity.duplicateRows[0].rows);
    expect(dupRows[0].proof).toBe(truth.integrity.duplicateRows[0].proof);

    const dateGaps = issues.filter((i) => i.type === 'date_gap');
    expect(dateGaps.length).toBeGreaterThanOrEqual(truth.integrity.dateGaps.length);
    expect(dateGaps[0]).toMatchObject(truth.integrity.dateGaps[0]);

    const incomplete = issues.filter((i) => i.type === 'incomplete_period');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].proof).toBe(truth.integrity.incompletePeriod.proof);
  });
});
