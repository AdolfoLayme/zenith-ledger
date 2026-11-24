import type { Txn } from './analytics';
import type { LocalAnalysis } from './pipeline';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';

export interface PeriodVendorAggregate {
  vendorAlias: string;
  category: string;
  count: number;
  totalSpendCents: number;
  /** Latest recurring/charge amount in positive integer cents. */
  unitAmountCents: number;
  /** First charge amount in the period in positive integer cents. */
  firstAmountCents: number;
  /** True when this vendor billed on a recurring monthly cadence (2+ charges, 20–40 day gaps, consistent price). */
  recurring: boolean;
}

export interface PeriodCategoryAggregate {
  category: string;
  spendCents: number;
  count: number;
}

/**
 * Aggregate-only summary of a statement period persisted in IndexedDB.
 * Contains ONLY vendor aliases (Vendor_A), categories, integer-cent totals, and counts — never raw rows or names.
 */
export interface PeriodSummary {
  id: string;
  label: string;
  fileName: string;
  currency: string;
  period: { from: string; to: string };
  savedAt: string;
  totals: { incomeCents: number; expenseCents: number; count: number };
  vendors: PeriodVendorAggregate[];
  categories: PeriodCategoryAggregate[];
}

export type ComparisonFinding =
  | {
      type: 'new_subscription';
      vendorAlias: string;
      category: string;
      unitAmountCents: number;
      totalSpendCents: number;
      count: number;
      priorPeriodLabel: string;
      currentPeriodLabel: string;
      proof: string;
    }
  | {
      type: 'recurring_price_increase';
      vendorAlias: string;
      category: string;
      fromCents: number;
      toCents: number;
      increasePercent: number;
      priorPeriodLabel: string;
      currentPeriodLabel: string;
      proof: string;
    }
  | {
      type: 'stopped_recurring';
      vendorAlias: string;
      category: string;
      priorUnitAmountCents: number;
      priorTotalSpendCents: number;
      priorCount: number;
      priorPeriodTo: string;
      priorPeriodLabel: string;
      currentPeriodLabel: string;
      proof: string;
    }
  | {
      type: 'category_growth';
      category: string;
      topVendorAlias: string;
      priorSpendCents: number;
      currentSpendCents: number;
      deltaCents: number;
      growthPercent: number;
      priorPeriodLabel: string;
      currentPeriodLabel: string;
      proof: string;
    };

const dayNum = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

const usd = (cents: number) =>
  `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function inferPeriodLabel(period: { from: string; to: string }, fileName = ''): string {
  const year = period.from.slice(0, 4);
  const qMatch = /\bq([1-4])\b/i.exec(fileName);
  if (qMatch && /^\d{4}$/.test(year)) return `Q${qMatch[1]} ${year}`;
  if (/^\d{4}$/.test(year)) {
    const startMonth = Number(period.from.slice(5, 7));
    const endMonth = Number(period.to.slice(5, 7));
    if (startMonth === 1 && endMonth === 3) return `Q1 ${year}`;
    if (startMonth === 4 && endMonth === 6) return `Q2 ${year}`;
    if (startMonth === 7 && endMonth === 9) return `Q3 ${year}`;
    if (startMonth === 10 && endMonth === 12) return `Q4 ${year}`;
  }
  return period.from && period.to ? `${period.from} to ${period.to}` : fileName || 'Period';
}

function isRecurringCadence(sortedSpendTxns: Txn[]): boolean {
  if (sortedSpendTxns.length < 2) return false;
  for (let i = 1; i < sortedSpendTxns.length; i++) {
    const gap = dayNum(sortedSpendTxns[i].date) - dayNum(sortedSpendTxns[i - 1].date);
    if (gap < 20 || gap > 40) return false;
  }
  const distinctAmounts = new Set(sortedSpendTxns.map((t) => -t.amountCents));
  return distinctAmounts.size < sortedSpendTxns.length;
}

export function summarizePeriod(analysis: LocalAnalysis, fileName = 'statement.csv'): PeriodSummary {
  const spendTxns = analysis.txns
    .filter((t) => t.amountCents < 0)
    .sort((a, b) => dayNum(a.date) - dayNum(b.date) || a.id - b.id);

  const byVendor = new Map<string, Txn[]>();
  const byCategory = new Map<string, { spendCents: number; count: number }>();

  for (const t of spendTxns) {
    byVendor.set(t.vendor, [...(byVendor.get(t.vendor) ?? []), t]);
    const c = byCategory.get(t.category) ?? { spendCents: 0, count: 0 };
    c.spendCents += -t.amountCents;
    c.count += 1;
    byCategory.set(t.category, c);
  }

  const vendors: PeriodVendorAggregate[] = [...byVendor.entries()]
    .map(([vendorAlias, list]) => {
      const catCounts = new Map<string, number>();
      let totalSpendCents = 0;
      for (const t of list) {
        totalSpendCents += -t.amountCents;
        catCounts.set(t.category, (catCounts.get(t.category) ?? 0) + 1);
      }
      const category = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Other';
      return {
        vendorAlias,
        category,
        count: list.length,
        totalSpendCents,
        unitAmountCents: -list[list.length - 1].amountCents,
        firstAmountCents: -list[0].amountCents,
        recurring: isRecurringCadence(list),
      };
    })
    .sort((a, b) => a.vendorAlias.length - b.vendorAlias.length || a.vendorAlias.localeCompare(b.vendorAlias));

  const categories: PeriodCategoryAggregate[] = [...byCategory.entries()]
    .map(([category, v]) => ({ category, spendCents: v.spendCents, count: v.count }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const label = inferPeriodLabel(analysis.period, fileName);
  const id = `${analysis.period.from}_${analysis.period.to}`;

  return {
    id,
    label,
    fileName,
    currency: analysis.currency,
    period: analysis.period,
    savedAt: new Date().toISOString(),
    totals: analysis.totals,
    vendors,
    categories,
  };
}

export function comparePeriods(
  currentAnalysis: LocalAnalysis,
  priorSummary: PeriodSummary,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  currentFileName = '',
): ComparisonFinding[] {
  const currentSummary = summarizePeriod(currentAnalysis, currentFileName);
  const priorLabel = priorSummary.label || inferPeriodLabel(priorSummary.period, priorSummary.fileName);
  const currentLabel = currentSummary.label || inferPeriodLabel(currentSummary.period, currentFileName);

  const priorVendors = new Map(priorSummary.vendors.map((v) => [v.vendorAlias, v]));
  const currentVendors = new Map(currentSummary.vendors.map((v) => [v.vendorAlias, v]));
  const priorCategories = new Map(priorSummary.categories.map((c) => [c.category, c]));

  const findings: ComparisonFinding[] = [];

  // 1. New subscriptions & 2. Recurring price increases
  for (const curr of currentSummary.vendors) {
    if (!curr.recurring) continue;
    const prev = priorVendors.get(curr.vendorAlias);
    if (!prev) {
      findings.push({
        type: 'new_subscription',
        vendorAlias: curr.vendorAlias,
        category: curr.category,
        unitAmountCents: curr.unitAmountCents,
        totalSpendCents: curr.totalSpendCents,
        count: curr.count,
        priorPeriodLabel: priorLabel,
        currentPeriodLabel: currentLabel,
        proof: `${curr.vendorAlias} billed ${usd(curr.unitAmountCents)} across ${curr.count} recurring charges in ${currentLabel} (${usd(curr.totalSpendCents)} total), with 0 charges in ${priorLabel}`,
      });
    } else if (prev.recurring && curr.unitAmountCents > prev.unitAmountCents) {
      const delta = curr.unitAmountCents - prev.unitAmountCents;
      const pct = Math.round((delta / prev.unitAmountCents) * 1000) / 10;
      if (pct >= thresholds.priceIncreaseMinPercent) {
        findings.push({
          type: 'recurring_price_increase',
          vendorAlias: curr.vendorAlias,
          category: curr.category,
          fromCents: prev.unitAmountCents,
          toCents: curr.unitAmountCents,
          increasePercent: pct,
          priorPeriodLabel: priorLabel,
          currentPeriodLabel: currentLabel,
          proof: `Recurring charge from ${curr.vendorAlias} rose from ${usd(prev.unitAmountCents)} in ${priorLabel} to ${usd(curr.unitAmountCents)} in ${currentLabel} (+${pct}%)`,
        });
      }
    }
  }

  // 3. Disappeared recurring charges
  for (const prev of priorSummary.vendors) {
    if (!prev.recurring) continue;
    if (!currentVendors.has(prev.vendorAlias)) {
      findings.push({
        type: 'stopped_recurring',
        vendorAlias: prev.vendorAlias,
        category: prev.category,
        priorUnitAmountCents: prev.unitAmountCents,
        priorTotalSpendCents: prev.totalSpendCents,
        priorCount: prev.count,
        priorPeriodTo: priorSummary.period.to || '2025-06-30',
        priorPeriodLabel: priorLabel,
        currentPeriodLabel: currentLabel,
        proof: `${prev.vendorAlias} billed ${usd(prev.unitAmountCents)} across ${prev.count} recurring charges in ${priorLabel} (${usd(prev.totalSpendCents)} total), but had 0 charges in ${currentLabel}`,
      });
    }
  }

  // 4. Categories that grew by more than categoryGrowthMinPercent (Remote Config)
  for (const currCat of currentSummary.categories) {
    if (currCat.category === 'Transfers' || currCat.category === 'Revenue') continue;
    const prevCat = priorCategories.get(currCat.category);
    if (!prevCat || prevCat.spendCents <= 0 || currCat.spendCents <= prevCat.spendCents) continue;
    const deltaCents = currCat.spendCents - prevCat.spendCents;
    const growthPercent = Math.round((deltaCents / prevCat.spendCents) * 1000) / 10;
    if (growthPercent >= thresholds.categoryGrowthMinPercent) {
      const topVendor =
        currentSummary.vendors
          .filter((v) => v.category === currCat.category)
          .sort((a, b) => b.totalSpendCents - a.totalSpendCents)[0]?.vendorAlias ?? 'Vendor_A';
      findings.push({
        type: 'category_growth',
        category: currCat.category,
        topVendorAlias: topVendor,
        priorSpendCents: prevCat.spendCents,
        currentSpendCents: currCat.spendCents,
        deltaCents,
        growthPercent,
        priorPeriodLabel: priorLabel,
        currentPeriodLabel: currentLabel,
        proof: `${currCat.category} spending grew by +${growthPercent}% (+${usd(deltaCents)}), from ${usd(prevCat.spendCents)} in ${priorLabel} to ${usd(currCat.spendCents)} in ${currentLabel}, led by ${topVendor}`,
      });
    }
  }

  return findings;
}
