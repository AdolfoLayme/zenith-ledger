import { describe, expect, it } from 'vitest';
import { detectSignals, totals, type Txn } from './analytics';
import { DEFAULT_THRESHOLDS } from './thresholds';

let id = 0;
const tx = (date: string, cents: number, vendor = 'V', category = 'Other'): Txn => ({ id: id++, date, amountCents: cents, vendor, category });

describe('totals', () => {
  it('sums integer cents without drift', () => {
    const t = totals([tx('2025-01-01', 10), tx('2025-01-02', 20), tx('2025-01-03', -5)]);
    expect(t).toEqual({ incomeCents: 30, expenseCents: 5, count: 3 });
  });
});

describe('detectSignals', () => {
  it('flags duplicates within 3 days only', () => {
    const s = detectSignals([tx('2025-07-10', -18420, 'A'), tx('2025-07-11', -18420, 'A'), tx('2025-07-20', -18420, 'A'), tx('2025-07-10', -500, 'B'), tx('2025-07-15', -500, 'B')]);
    const d = s.filter((x) => x.type === 'duplicate');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ vendor: 'A', amountCents: -18420 });
  });
  it('flags a subscription price increase', () => {
    const s = detectSignals([tx('2025-07-07', -4900, 'S'), tx('2025-08-07', -4900, 'S'), tx('2025-09-07', -5900, 'S')]);
    expect(s.filter((x) => x.type === 'price_increase')).toEqual([
      expect.objectContaining({ vendor: 'S', fromCents: 4900, toCents: 5900 }),
    ]);
  });
  it('flags an outlier with z-score above 2.5', () => {
    const rows = Array.from({ length: 12 }, (_, i) => tx(`2025-07-${String(i + 1).padStart(2, '0')}`, -(10000 + i * 100), 'X' + i, 'Supplies'));
    rows.push(tx('2025-07-20', -240000, 'BIG', 'Supplies'));
    const o = detectSignals(rows).filter((x) => x.type === 'outlier');
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ vendor: 'BIG' });
  });
  it('does not flag outliers in tiny categories', () => {
    const rows = [tx('2025-07-01', -100, 'a', 'C'), tx('2025-07-02', -100000, 'b', 'C')];
    expect(detectSignals(rows).filter((x) => x.type === 'outlier')).toHaveLength(0);
  });
  it('flags round transfers (multiples of $500)', () => {
    const s = detectSignals([tx('2025-07-01', -500000, 'T', 'Transfers'), tx('2025-07-02', -23740, 'T', 'Transfers'), tx('2025-07-03', -50000, 'Z', 'Meals')]);
    expect(s.filter((x) => x.type === 'round_transfer')).toHaveLength(1);
  });
  it('flags large weekend spend (2025-07-12 is a Saturday)', () => {
    const s = detectSignals([tx('2025-07-12', -64015, 'W'), tx('2025-07-12', -1200, 'C'), tx('2025-07-14', -64015, 'M')]);
    expect(s.filter((x) => x.type === 'weekend_spend')).toEqual([expect.objectContaining({ vendor: 'W' })]);
  });
});

describe('detectSignals with custom thresholds', () => {
  const limits = (o: Partial<typeof DEFAULT_THRESHOLDS>) => ({ ...DEFAULT_THRESHOLDS, ...o });
  it('widens the duplicate window', () => {
    const rows = [tx('2025-07-10', -18420, 'A'), tx('2025-07-20', -18420, 'A')];
    expect(detectSignals(rows).filter((x) => x.type === 'duplicate')).toHaveLength(0);
    expect(detectSignals(rows, limits({ duplicateWindowDays: 10 })).filter((x) => x.type === 'duplicate')).toHaveLength(1);
  });
  it('ignores small price rises when a minimum percent is set', () => {
    const rows = [tx('2025-07-07', -4900, 'S'), tx('2025-08-07', -4900, 'S'), tx('2025-09-07', -5000, 'S')];
    expect(detectSignals(rows).filter((x) => x.type === 'price_increase')).toHaveLength(1);
    expect(detectSignals(rows, limits({ priceIncreaseMinPercent: 5 })).filter((x) => x.type === 'price_increase')).toHaveLength(0);
  });
  it('raises the outlier z-score', () => {
    const rows = Array.from({ length: 12 }, (_, i) => tx(`2025-07-${String(i + 1).padStart(2, '0')}`, -(10000 + i * 100), 'X' + i, 'Supplies'));
    rows.push(tx('2025-07-20', -240000, 'BIG', 'Supplies'));
    expect(detectSignals(rows, limits({ outlierZ: 10 })).filter((x) => x.type === 'outlier')).toHaveLength(0);
  });
  it('changes what counts as a round transfer and a weekend charge', () => {
    const rows = [tx('2025-07-01', -300000, 'T', 'Transfers'), tx('2025-07-12', -30000, 'W')];
    expect(detectSignals(rows).filter((x) => x.type === 'round_transfer')).toHaveLength(1);
    expect(detectSignals(rows, limits({ roundTransferMinCents: 400000 })).filter((x) => x.type === 'round_transfer')).toHaveLength(0);
    expect(detectSignals(rows, limits({ roundTransferMultipleCents: 70000 })).filter((x) => x.type === 'round_transfer')).toHaveLength(0);
    expect(detectSignals(rows, limits({ weekendMinCents: 40000 })).filter((x) => x.type === 'weekend_spend')).toHaveLength(0);
  });
});
