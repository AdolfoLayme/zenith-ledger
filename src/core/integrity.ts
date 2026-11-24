import type { StatementRow } from './types';

export type IntegrityIssueType =
  | 'balance_mismatch'
  | 'missing_page'
  | 'duplicate_row'
  | 'date_gap'
  | 'incomplete_period';

export interface IntegrityIssue {
  type: IntegrityIssueType;
  /** 1-based row numbers where the discrepancy occurs, e.g. [41, 42] */
  rows: [number, number];
  /** Expected value in integer cents */
  expectedCents: number;
  /** Actual value reported by the statement in integer cents */
  actualCents: number;
  /** Difference (actualCents - expectedCents) in integer cents */
  deltaCents: number;
  /** Reconciliation string: "expected 1,204.10, statement says 1,104.10, gap between rows 41–42" */
  proof: string;
  /** Human-readable explanation of the integrity issue */
  detail: string;
  /** Page range when a multi-page photo jump is detected */
  pages?: [number, number];
  /** Calendar day gap for date_gap or incomplete_period */
  gapDays?: number;
}

export interface IntegrityOptions {
  /** Maximum normal gap in days between consecutive transactions before flagging date_gap (default: 14) */
  maxDateGapDays?: number;
  /** Declared statement period { from: YYYY-MM-DD, to: YYYY-MM-DD } to check coverage */
  declaredPeriod?: { from: string; to: string };
  /** Allowed grace days at the start/end of a declared period (default: 5) */
  periodGraceDays?: number;
  /** Optional declared opening balance in cents */
  openingBalanceCents?: number;
  /** Optional declared closing balance in cents */
  closingBalanceCents?: number;
}

const dayNum = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

export const plainMoney = (cents: number): string =>
  `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const formatProof = (expectedCents: number, actualCents: number, rowA: number, rowB: number): string =>
  `expected ${plainMoney(expectedCents)}, statement says ${plainMoney(actualCents)}, gap between rows ${rowA}–${rowB}`;

/** Infers a declared quarterly period when the filename names a quarter (e.g. acme-q3.csv, acme-q4.csv). */
export function inferDeclaredPeriod(
  fileName: string,
  rows: Pick<StatementRow, 'date'>[],
): { from: string; to: string } | undefined {
  const m = /\bq([1-4])\b/i.exec(fileName);
  if (!m || !rows.length) return undefined;
  const year = rows[0].date.slice(0, 4);
  if (!/^\d{4}$/.test(year)) return undefined;
  const q = Number(m[1]);
  const ranges: Record<number, [string, string]> = {
    1: [`${year}-01-01`, `${year}-03-31`],
    2: [`${year}-04-01`, `${year}-06-30`],
    3: [`${year}-07-01`, `${year}-09-30`],
    4: [`${year}-10-01`, `${year}-12-31`],
  };
  const [from, to] = ranges[q];
  return { from, to };
}

export function checkStatementIntegrity(rows: StatementRow[], opts: IntegrityOptions = {}): IntegrityIssue[] {
  if (!rows.length) return [];
  const issues: IntegrityIssue[] = [];
  const maxGap = opts.maxDateGapDays ?? 14;
  const grace = opts.periodGraceDays ?? 5;

  if (opts.openingBalanceCents !== undefined && rows[0].balanceCents !== null) {
    const expected = opts.openingBalanceCents + rows[0].amountCents;
    const actual = rows[0].balanceCents;
    if (actual !== expected) {
      const proof = formatProof(expected, actual, 1, 1);
      issues.push({
        type: 'balance_mismatch',
        rows: [1, 1],
        expectedCents: expected,
        actualCents: actual,
        deltaCents: actual - expected,
        proof,
        detail: `Opening balance does not reconcile on row 1: ${proof}`,
      });
    }
  }

  let runningNet = rows[0].amountCents;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const rowA = i;
    const rowB = i + 1;
    const prevNet = runningNet;
    runningNet += curr.amountCents;

    // 1. Exact duplicate rows from export errors (identical date, description, and amount)
    const isExactDup =
      prev.date === curr.date &&
      prev.description.trim() === curr.description.trim() &&
      prev.amountCents === curr.amountCents;

    let handledBalanceInDup = false;
    if (isExactDup) {
      let expectedCents: number;
      let actualCents: number;
      if (prev.balanceCents !== null && curr.balanceCents !== null) {
        if (curr.balanceCents === prev.balanceCents) {
          // Export duplicated the line and its balance verbatim; applying rowB would have changed balance to prev + amount
          expectedCents = prev.balanceCents + curr.amountCents;
          actualCents = curr.balanceCents;
          handledBalanceInDup = true;
        } else {
          // Export duplicated the line and applied its amount twice; without duplicate row, balance would stay at prev.balanceCents
          expectedCents = prev.balanceCents;
          actualCents = curr.balanceCents;
          handledBalanceInDup = curr.balanceCents === prev.balanceCents + curr.amountCents;
        }
      } else {
        expectedCents = prevNet;
        actualCents = runningNet;
      }
      const proof = formatProof(expectedCents, actualCents, rowA, rowB);
      issues.push({
        type: 'duplicate_row',
        rows: [rowA, rowB],
        expectedCents,
        actualCents,
        deltaCents: actualCents - expectedCents,
        proof,
        detail: `Exact duplicate row on ${curr.date} (${proof})`,
      });
    }

    // 2. Running balance & multi-page photo jumps
    const pageBoundary = prev.page !== undefined && curr.page !== undefined && curr.page !== prev.page;
    const skippedPageNumber = prev.page !== undefined && curr.page !== undefined && curr.page > prev.page + 1;

    if (!handledBalanceInDup && prev.balanceCents !== null && curr.balanceCents !== null) {
      const expected = prev.balanceCents + curr.amountCents;
      const actual = curr.balanceCents;
      if (actual !== expected) {
        const proof = formatProof(expected, actual, rowA, rowB);
        if (pageBoundary) {
          issues.push({
            type: 'missing_page',
            rows: [rowA, rowB],
            pages: [prev.page!, curr.page!],
            expectedCents: expected,
            actualCents: actual,
            deltaCents: actual - expected,
            proof,
            detail: `Missing page between page ${prev.page} and page ${curr.page}: ${proof}`,
          });
        } else {
          issues.push({
            type: 'balance_mismatch',
            rows: [rowA, rowB],
            expectedCents: expected,
            actualCents: actual,
            deltaCents: actual - expected,
            proof,
            detail: `Running balance mismatch: ${proof}`,
          });
        }
      } else if (skippedPageNumber) {
        const proof = formatProof(expected, actual, rowA, rowB);
        issues.push({
          type: 'missing_page',
          rows: [rowA, rowB],
          pages: [prev.page!, curr.page!],
          expectedCents: expected,
          actualCents: actual,
          deltaCents: 0,
          proof,
          detail: `Page jump from page ${prev.page} to page ${curr.page}: ${proof}`,
        });
      }
    } else if (skippedPageNumber) {
      const proof = formatProof(prevNet, runningNet, rowA, rowB);
      issues.push({
        type: 'missing_page',
        rows: [rowA, rowB],
        pages: [prev.page!, curr.page!],
        expectedCents: prevNet,
        actualCents: runningNet,
        deltaCents: curr.amountCents,
        proof,
        detail: `Page jump from page ${prev.page} to page ${curr.page}: ${proof}`,
      });
    }

    // 3. Unusual chronological date gaps
    const gapDays = dayNum(curr.date) - dayNum(prev.date);
    if (gapDays > maxGap) {
      const expected =
        prev.balanceCents !== null && curr.balanceCents !== null
          ? prev.balanceCents + curr.amountCents
          : prevNet + curr.amountCents;
      const actual = curr.balanceCents !== null ? curr.balanceCents : runningNet;
      const proof = formatProof(expected, actual, rowA, rowB);
      issues.push({
        type: 'date_gap',
        rows: [rowA, rowB],
        gapDays,
        expectedCents: expected,
        actualCents: actual,
        deltaCents: actual - expected,
        proof,
        detail: `${gapDays}-day date gap between ${prev.date} and ${curr.date} (${proof})`,
      });
    }
  }

  // 4. Period coverage check against declaredPeriod
  if (opts.declaredPeriod) {
    const sortedDates = rows.map((r) => r.date).sort();
    const firstDate = sortedDates[0];
    const lastDate = sortedDates[sortedDates.length - 1];
    const startGap = dayNum(firstDate) - dayNum(opts.declaredPeriod.from);
    const endGap = dayNum(opts.declaredPeriod.to) - dayNum(lastDate);

    if (startGap > grace || endGap > grace) {
      const atEnd = endGap >= startGap;
      const rowNum = atEnd ? rows.length : 1;
      const gapDays = atEnd ? endGap : startGap;
      const lastBal = rows[rows.length - 1].balanceCents;
      const actual = lastBal !== null ? lastBal : runningNet;
      const expected = opts.closingBalanceCents !== undefined ? opts.closingBalanceCents : actual;
      const proof = formatProof(expected, actual, rowNum, rowNum);
      issues.push({
        type: 'incomplete_period',
        rows: [rowNum, rowNum],
        gapDays,
        expectedCents: expected,
        actualCents: actual,
        deltaCents: actual - expected,
        proof,
        detail: `Statement covers ${firstDate} to ${lastDate}, missing ${gapDays} days of declared period ${opts.declaredPeriod.from} to ${opts.declaredPeriod.to} (${proof})`,
      });
    }
  }

  return issues;
}
