import { DEFAULT_INTEGRITY_THRESHOLDS } from './thresholds';
import type { StatementRow } from './types';

export type IntegrityIssueType =
  | 'balance_mismatch'
  | 'missing_page'
  | 'duplicate_row'
  | 'date_gap'
  | 'incomplete_period';

export interface DeclaredPeriod {
  from: string;
  to: string;
  /** Short name used in proofs, e.g. "Q3" */
  label?: string;
}

export interface IntegrityIssue {
  type: IntegrityIssueType;
  /** 1-based row numbers where the problem occurs, e.g. [41, 42] */
  rows: [number, number];
  /** One readable sentence that proves the problem, written for this issue type */
  proof: string;
  /** Balance problems only: the balance the previous row implies, in integer cents */
  expectedCents?: number;
  /** Balance problems only: the balance the statement reports, in integer cents */
  actualCents?: number;
  /** Balance problems only: actualCents - expectedCents */
  deltaCents?: number;
  /** Page range for missing pages */
  pages?: [number, number];
  /** Calendar days: the gap between rows (date_gap) or the days of the declared period not covered (incomplete_period) */
  gapDays?: number;
  /** date_gap: the dates on both sides of the gap. incomplete_period: first and last date the statement covers. */
  dates?: [string, string];
  /** incomplete_period: the declared period and which end is missing */
  declared?: DeclaredPeriod;
  side?: 'start' | 'end';
  /** duplicate_row: the balance both identical rows show */
  balanceCents?: number;
}

export interface IntegrityOptions {
  /** Maximum normal gap in days between consecutive transactions before flagging date_gap (default: 14) */
  maxDateGapDays?: number;
  /** Declared statement period to check coverage against */
  declaredPeriod?: DeclaredPeriod;
  /** Allowed grace days at the start/end of a declared period (default: 5) */
  periodGraceDays?: number;
  /** Optional declared opening balance in cents */
  openingBalanceCents?: number;
}

const dayNum = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

export const plainMoney = (cents: number): string =>
  `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The reconciliation sentence for balance problems: the only issues where a sum is the proof. */
export const formatProof = (expectedCents: number, actualCents: number, rowA: number, rowB: number): string =>
  `expected ${plainMoney(expectedCents)}, statement says ${plainMoney(actualCents)}, ${
    rowA === rowB ? `at row ${rowA}` : `gap between rows ${rowA}–${rowB}`
  }`;

/** Infers a declared quarterly period when the filename names a quarter (e.g. acme-q3.csv, acme-q4.csv). */
export function inferDeclaredPeriod(
  fileName: string,
  rows: Pick<StatementRow, 'date'>[],
): DeclaredPeriod | undefined {
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
  return { from, to, label: `Q${q}` };
}

export function checkStatementIntegrity(rows: StatementRow[], opts: IntegrityOptions = {}): IntegrityIssue[] {
  if (!rows.length) return [];
  const issues: IntegrityIssue[] = [];
  const maxGap = opts.maxDateGapDays ?? DEFAULT_INTEGRITY_THRESHOLDS.maxDateGapDays;
  const grace = opts.periodGraceDays ?? DEFAULT_INTEGRITY_THRESHOLDS.periodGraceDays;

  if (opts.openingBalanceCents !== undefined && rows[0].balanceCents !== null) {
    const expected = opts.openingBalanceCents + rows[0].amountCents;
    const actual = rows[0].balanceCents;
    if (actual !== expected) {
      issues.push({
        type: 'balance_mismatch',
        rows: [1, 1],
        expectedCents: expected,
        actualCents: actual,
        deltaCents: actual - expected,
        proof: `opening balance does not reconcile: ${formatProof(expected, actual, 1, 1)}`,
      });
    }
  }

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const rowA = i;
    const rowB = i + 1;

    // An identical line whose balance did not move is the export repeating itself. If the balance moved
    // again, the charge really happened twice and the anomaly detector reports it as a double charge.
    const repeatedWithoutBalanceChange =
      prev.date === curr.date &&
      prev.description.trim() === curr.description.trim() &&
      prev.amountCents === curr.amountCents &&
      curr.amountCents !== 0 &&
      prev.balanceCents !== null &&
      prev.balanceCents === curr.balanceCents;
    if (repeatedWithoutBalanceChange) {
      issues.push({
        type: 'duplicate_row',
        rows: [rowA, rowB],
        balanceCents: curr.balanceCents!,
        proof: `rows ${rowA} and ${rowB} are identical (date, description, amount, balance ${plainMoney(curr.balanceCents!)}): the balance did not move, so the export repeated the line`,
      });
    }

    const pageBoundary = prev.page !== undefined && curr.page !== undefined && curr.page !== prev.page;
    const skippedPages = prev.page !== undefined && curr.page !== undefined ? curr.page - prev.page - 1 : 0;
    const jump = `${plural(skippedPages, 'page')} missing: the statement jumps from page ${prev.page} (row ${rowA}) to page ${curr.page} (row ${rowB})`;
    let balanceChecked = false;

    if (!repeatedWithoutBalanceChange && prev.balanceCents !== null && curr.balanceCents !== null) {
      balanceChecked = true;
      const expected = prev.balanceCents + curr.amountCents;
      const actual = curr.balanceCents;
      if (actual !== expected) {
        issues.push({
          type: pageBoundary ? 'missing_page' : 'balance_mismatch',
          rows: [rowA, rowB],
          ...(pageBoundary ? { pages: [prev.page!, curr.page!] as [number, number] } : {}),
          expectedCents: expected,
          actualCents: actual,
          deltaCents: actual - expected,
          proof: formatProof(expected, actual, rowA, rowB),
        });
      } else if (skippedPages > 0) {
        issues.push({
          type: 'missing_page',
          rows: [rowA, rowB],
          pages: [prev.page!, curr.page!],
          proof: `${jump}, though the running balance still reconciles`,
        });
      }
    }
    if (!balanceChecked && skippedPages > 0) {
      issues.push({ type: 'missing_page', rows: [rowA, rowB], pages: [prev.page!, curr.page!], proof: jump });
    }

    const gapDays = dayNum(curr.date) - dayNum(prev.date);
    if (gapDays > maxGap) {
      issues.push({
        type: 'date_gap',
        rows: [rowA, rowB],
        gapDays,
        dates: [prev.date, curr.date],
        proof: `no transactions for ${plural(gapDays, 'day')} between ${prev.date} (row ${rowA}) and ${curr.date} (row ${rowB})`,
      });
    }
  }

  const declared = opts.declaredPeriod;
  if (declared) {
    const sortedDates = rows.map((r) => r.date).sort();
    const firstDate = sortedDates[0];
    const lastDate = sortedDates[sortedDates.length - 1];
    const startGap = dayNum(firstDate) - dayNum(declared.from);
    const endGap = dayNum(declared.to) - dayNum(lastDate);

    if (startGap > grace || endGap > grace) {
      const side = endGap >= startGap ? 'end' : 'start';
      const rowNum = side === 'end' ? rows.length : 1;
      const gapDays = side === 'end' ? endGap : startGap;
      issues.push({
        type: 'incomplete_period',
        rows: [rowNum, rowNum],
        gapDays,
        dates: [firstDate, lastDate],
        declared,
        side,
        proof: `statement covers ${firstDate} to ${lastDate}, declared ${declared.label ?? 'period'} is ${declared.from} to ${declared.to}: ${plural(gapDays, 'day')} missing at the ${side}`,
      });
    }
  }

  return issues;
}
