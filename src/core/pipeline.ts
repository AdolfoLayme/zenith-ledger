import { detectSignals, totals, type Signal, type Txn } from './analytics';
import { detectPii } from './detectors';
import { sha256Hex, countRawLeaks, type CloudPayload, type Counters } from './payload';
import { createAliaser, redact } from './pseudonymize';
import type { RowEntities, Span, StatementRow } from './types';

export interface AnalyzedRow {
  index: number;
  date: string;
  description: string;
  amountCents: number;
  spans: Span[];
  /** Description with sensitive values swapped for aliases. Local display only. */
  redacted: string;
  vendorAlias: string;
  category: string;
}

export interface LocalAnalysis {
  mode: 'strict' | 'assisted';
  currency: string;
  period: { from: string; to: string };
  rows: AnalyzedRow[];
  txns: Txn[];
  signals: Signal[];
  totals: ReturnType<typeof totals>;
  /** alias -> original value. Never leaves the device. */
  aliases: Map<string, string>;
  counters: Counters;
}

const STOP = new Set(['POS', 'DEBIT', 'ACH', 'PAYMENT', 'ZELLE', 'FROM', 'TO', 'WIRE', 'ONLINE', 'TRANSFER', 'DEPOSIT', 'INVOICE', 'PAID', 'BY', 'TEL', 'CARD', 'ACCT', 'CONTRACTOR', 'PAY', 'XFER', 'IBAN', 'EIN', 'ORDER', 'INV', 'REFUND', 'THE']);

/** Deterministic fallback when no on-device model is available: first two meaningful words. */
export function guessMerchant(description: string, spans: Span[]): string {
  let t = '';
  let pos = 0;
  for (const s of spans) { t += description.slice(pos, s.start) + ' '; pos = s.end; }
  t += description.slice(pos);
  const words = t.toUpperCase().replace(/[^A-Z& ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  return words.slice(0, 2).join(' ') || 'UNKNOWN';
}

const RULES: [RegExp, string][] = [
  [/transfer|xfer/i, 'Transfers'], [/insurance|premium/i, 'Insurance'], [/airline|ticket|hotel/i, 'Travel'],
  [/coffee|cafe|bistro|restaurant|lunch|dinner|bakery/i, 'Meals'], [/power|water|utility|telecom|business line/i, 'Utilities'],
  [/software|hosting|subscription|license|monthly plan/i, 'Software'], [/payroll|contractor|wire to|eftps/i, 'Payroll'],
  [/supply|plumbing|depot|repair|order/i, 'Supplies'],
];
export function guessCategory(description: string, amountCents: number): string {
  if (/transfer|xfer/i.test(description)) return 'Transfers';
  if (amountCents > 0) return 'Revenue';
  return RULES.find(([re]) => re.test(description))?.[1] ?? 'Other';
}

function personSpans(text: string, persons: string[], taken: Span[]): Span[] {
  const out: Span[] = [];
  for (const p of persons) {
    if (!p) continue;
    let i = text.indexOf(p);
    while (i >= 0) {
      const end = i + p.length;
      if (![...taken, ...out].some((s) => i < s.end && end > s.start)) out.push({ start: i, end, type: 'person', value: p });
      i = text.indexOf(p, end);
    }
  }
  return out;
}

export function analyzeLocally(input: StatementRow[], opts: { entities?: RowEntities[] } = {}): LocalAnalysis {
  const aliaser = createAliaser();
  const assisted = !!opts.entities;
  let piiFound = 0;
  const rows: AnalyzedRow[] = input.map((r, index) => {
    const ent = opts.entities?.[index];
    const det = detectPii(r.description);
    const spans = [...det, ...personSpans(r.description, ent?.persons ?? [], det)].sort((a, b) => a.start - b.start);
    piiFound += spans.length;
    const merchant = (ent?.merchant?.trim().toUpperCase()) || guessMerchant(r.description, spans);
    return {
      index, date: r.date, description: r.description, amountCents: r.amountCents, spans,
      redacted: redact(r.description, spans, aliaser),
      vendorAlias: aliaser.alias('vendor', merchant),
      category: ent?.category || guessCategory(r.description, r.amountCents),
    };
  });
  const txns: Txn[] = rows.map((r) => ({ id: r.index, date: r.date, amountCents: r.amountCents, vendor: r.vendorAlias, category: r.category }));
  const dates = rows.map((r) => r.date).sort();
  return {
    mode: assisted ? 'assisted' : 'strict',
    currency: input[0]?.currency ?? 'USD',
    period: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    rows, txns, signals: detectSignals(txns), totals: totals(txns), aliases: aliaser.map,
    counters: { piiFound, piiReplaced: piiFound, rawDescriptionsSent: 0 },
  };
}

export interface BuiltPayload { payload: CloudPayload; json: string; hash: string; counters: Counters }

/** The exact object that would leave the device. Descriptions are never part of it. */
export async function buildPayload(a: LocalAnalysis): Promise<BuiltPayload> {
  const cats = new Map<string, { spendCents: number; incomeCents: number; count: number }>();
  const vendors = new Map<string, { category: Map<string, number>; spendCents: number; count: number }>();
  for (const t of a.txns) {
    const c = cats.get(t.category) ?? { spendCents: 0, incomeCents: 0, count: 0 };
    if (t.amountCents < 0) c.spendCents += -t.amountCents; else c.incomeCents += t.amountCents;
    c.count++;
    cats.set(t.category, c);
    const v = vendors.get(t.vendor) ?? { category: new Map(), spendCents: 0, count: 0 };
    v.category.set(t.category, (v.category.get(t.category) ?? 0) + 1);
    if (t.amountCents < 0) v.spendCents += -t.amountCents;
    v.count++;
    vendors.set(t.vendor, v);
  }
  const payload: CloudPayload = {
    schema: 'zenith-ledger/payload@1', mode: a.mode, currency: a.currency, period: a.period, totals: a.totals,
    categories: [...cats].map(([category, c]) => ({ category, ...c })).sort((x, y) => x.category.localeCompare(y.category)),
    vendors: [...vendors].map(([alias, v]) => ({ alias, category: [...v.category].sort((x, y) => y[1] - x[1])[0][0], spendCents: v.spendCents, count: v.count })).sort((x, y) => x.alias.length - y.alias.length || x.alias.localeCompare(y.alias)),
    signals: a.signals,
  };
  const json = JSON.stringify(payload, null, 2);
  return {
    payload, json, hash: await sha256Hex(json),
    counters: { ...a.counters, rawDescriptionsSent: countRawLeaks(json, a.rows.map((r) => r.description)) },
  };
}

/** Plain-text overview for the offline on-device summary. Aliases and computed numbers only, never descriptions. */
export function summaryOverview(a: LocalAnalysis): string {
  const money = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
  const spend = new Map<string, number>();
  for (const t of a.txns) if (t.amountCents < 0) spend.set(t.category, (spend.get(t.category) ?? 0) - t.amountCents);
  const top = [...spend].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([c, v]) => `${c} ${money(v)}`).join(', ');
  const sig = a.signals.map((s) => {
    switch (s.type) {
      case 'duplicate': return `possible duplicate: ${s.vendor} ${money(s.amountCents)} on ${s.dates.join(' and ')}`;
      case 'price_increase': return `price increase: ${s.vendor} ${money(s.fromCents)} to ${money(s.toCents)} on ${s.date}`;
      case 'outlier': return `unusual ${s.category} expense: ${s.vendor} ${money(s.amountCents)} on ${s.date}`;
      case 'round_transfer': return `round transfer: ${s.vendor} ${money(s.amountCents)} on ${s.date}`;
      case 'weekend_spend': return `weekend spend: ${s.vendor} ${money(s.amountCents)} on ${s.date}`;
    }
  });
  return [
    `Period ${a.period.from} to ${a.period.to}, ${a.rows.length} transactions, ${a.currency}.`,
    `Money in ${money(a.totals.incomeCents)}, money out ${money(a.totals.expenseCents)}.`,
    `Top spending categories: ${top || 'none'}.`,
    `Flagged: ${sig.length ? sig.join('; ') : 'nothing unusual'}.`,
  ].join('\n');
}
