import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
// All money is integer cents. Negative = money out.
export interface Txn { id: number; date: string; amountCents: number; vendor: string; category: string }

export type Signal =
  | { type: 'duplicate'; vendor: string; amountCents: number; dates: [string, string]; exportDuplicate?: true }
  | { type: 'price_increase'; vendor: string; fromCents: number; toCents: number; date: string }
  | { type: 'outlier'; vendor: string; category: string; amountCents: number; date: string; zScore: number }
  | { type: 'round_transfer'; vendor: string; amountCents: number; date: string }
  | { type: 'weekend_spend'; vendor: string; category: string; amountCents: number; date: string };

export const totals = (txns: Txn[]) => ({
  incomeCents: txns.reduce((s, t) => s + (t.amountCents > 0 ? t.amountCents : 0), 0),
  expenseCents: txns.reduce((s, t) => s + (t.amountCents < 0 ? -t.amountCents : 0), 0),
  count: txns.length,
});

const dayNum = (iso: string) => Date.parse(iso + 'T00:00:00Z') / 86400000;
const isWeekend = (iso: string) => [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());

export function detectSignals(txns: Txn[], limits: Thresholds = DEFAULT_THRESHOLDS): Signal[] {
  const out: Signal[] = [];
  const spend = txns.filter((t) => t.amountCents < 0).sort((a, b) => dayNum(a.date) - dayNum(b.date) || a.id - b.id);

  // duplicates: same vendor + amount within the window
  const lastByKey = new Map<string, Txn>();
  for (const t of spend) {
    const key = `${t.vendor}|${t.amountCents}`;
    const prev = lastByKey.get(key);
    if (prev && dayNum(t.date) - dayNum(prev.date) <= limits.duplicateWindowDays) out.push({ type: 'duplicate', vendor: t.vendor, amountCents: t.amountCents, dates: [prev.date, t.date] });
    lastByKey.set(key, t);
  }

  // subscription increases: a stable monthly price (2+ equal charges) that then goes up
  const byVendor = new Map<string, Txn[]>();
  for (const t of spend) byVendor.set(t.vendor, [...(byVendor.get(t.vendor) ?? []), t]);
  for (const [vendor, list] of byVendor) {
    for (let i = 2; i < list.length; i++) {
      const monthly = [1, 2].every((k) => {
        const gap = dayNum(list[i - k + 1].date) - dayNum(list[i - k].date);
        return gap >= 25 && gap <= 35;
      });
      const rise = list[i - 1].amountCents - list[i].amountCents;
      if (monthly && list[i - 1].amountCents === list[i - 2].amountCents && rise > 0 && (rise / -list[i - 1].amountCents) * 100 >= limits.priceIncreaseMinPercent) {
        out.push({ type: 'price_increase', vendor, fromCents: -list[i - 1].amountCents, toCents: -list[i].amountCents, date: list[i].date });
      }
    }
  }

  // outliers per category (population z-score on spend)
  const byCat = new Map<string, Txn[]>();
  for (const t of spend) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  for (const [category, list] of byCat) {
    if (list.length < limits.outlierMinSamples) continue;
    const xs = list.map((t) => -t.amountCents);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    if (sd === 0) continue;
    for (const t of list) {
      const z = (-t.amountCents - mean) / sd;
      if (z > limits.outlierZ) out.push({ type: 'outlier', vendor: t.vendor, category, amountCents: t.amountCents, date: t.date, zScore: Math.round(z * 100) / 100 });
    }
  }

  for (const t of spend) {
    if (t.category === 'Transfers' && -t.amountCents >= limits.roundTransferMinCents && t.amountCents % limits.roundTransferMultipleCents === 0)
      out.push({ type: 'round_transfer', vendor: t.vendor, amountCents: t.amountCents, date: t.date });
    if (isWeekend(t.date) && -t.amountCents >= limits.weekendMinCents)
      out.push({ type: 'weekend_spend', vendor: t.vendor, category: t.category, amountCents: t.amountCents, date: t.date });
  }
  return out;
}
