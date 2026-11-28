import type { Signal } from './analytics';
import type { ComparisonFinding } from './compare';
import { plainMoney, type IntegrityIssue } from './integrity';
import type { AnalyzedRow, LocalAnalysis } from './pipeline';
import {
  DEFAULT_INTEGRITY_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  type IntegrityThresholds,
  type Thresholds,
} from './thresholds';
import type { PhotoProvenance } from './types';

export type DecisionStatus = 'explained' | 'ask_accountant' | 'ignore';

export interface AlertDecision {
  alertId: string;
  status: DecisionStatus;
  note: string;
  updatedAt: string;
  /** Statement period (from_to) the decision was made on, so it does not carry over to another statement. */
  statement?: string;
}

export interface SourceRowEvidence {
  rowIndex: number;
  /** 1-based line number in the statement or photo table */
  line: number;
  /** Optional 1-based page number when read from a photo */
  page?: number;
  date: string;
  vendorAlias: string;
  category: string;
  amountCents: number;
  balanceCents: number | null;
  /** Pseudonymized description (aliases only) */
  redacted: string;
  /** Original description (local display only; never leaves device) */
  description: string;
  /** Present when the row came from a photo read by Gemini Nano on device */
  photo?: PhotoProvenance;
}

export interface RuleEvidence {
  id: string;
  name: string;
  thresholdSummary: string;
  thresholds: Record<string, number>;
}

export interface ComputedMetric {
  label: string;
  value: string;
}

export interface EvidenceDossier {
  id: string;
  kind: 'anomaly' | 'integrity' | 'comparison';
  type: Signal['type'] | IntegrityIssue['type'] | ComparisonFinding['type'];
  severity: 'high' | 'medium' | 'low';
  /** Present when a duplicate signal was confirmed as a statement export duplicate (balance did not move). */
  exportDuplicate?: true;
  vendorAlias: string;
  category: string;
  title: string;
  summary: string;
  proof: string;
  sourceRows: SourceRowEvidence[];
  rule: RuleEvidence;
  computed: ComputedMetric[];
}

const usd = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const dayNum = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

function toSourceRow(r: AnalyzedRow): SourceRowEvidence {
  return {
    rowIndex: r.index,
    line: r.index + 1,
    ...(r.page !== undefined ? { page: r.page } : {}),
    date: r.date,
    vendorAlias: r.vendorAlias,
    category: r.category,
    amountCents: r.amountCents,
    balanceCents: r.balanceCents,
    redacted: r.redacted,
    description: r.description,
    ...(r.photo ? { photo: r.photo } : {}),
  };
}

function buildSignalDossier(s: Signal, a: LocalAnalysis, limits: Thresholds): EvidenceDossier {
  switch (s.type) {
    case 'duplicate': {
      const matched = a.rows
        .filter((r) => r.vendorAlias === s.vendor && r.amountCents === s.amountCents && (r.date === s.dates[0] || r.date === s.dates[1]))
        .slice(0, 2)
        .map(toSourceRow);
      const interval = Math.abs(dayNum(s.dates[1]) - dayNum(s.dates[0]));
      const lines = matched.map((r) => r.line).join(' and ');
      const within = interval === 0 ? 'on the same day' : `within ${interval} day${interval === 1 ? '' : 's'}`;
      const balances = matched.map((r) => r.balanceCents);
      const balanceTrail = balances.length === 2 && balances.every((b) => b !== null)
        ? `${plainMoney(balances[0]!)} → ${plainMoney(balances[1]!)} (${balances[0] === balances[1] ? 'did not move' : 'moved'})`
        : null;
      const proof = s.exportDuplicate
        ? `Likely an export duplicate, not a double charge: the running balance did not move between lines ${lines}`
        : `${s.vendor} charged ${usd(s.amountCents)} twice ${within} (lines ${lines || 'n/a'})`;
      return {
        id: `anomaly:duplicate:${s.vendor}:${s.amountCents}:${s.dates[0]}:${s.dates[1]}`,
        kind: 'anomaly',
        type: 'duplicate',
        severity: s.exportDuplicate ? 'low' : 'high',
        ...(s.exportDuplicate ? { exportDuplicate: true as const } : {}),
        vendorAlias: s.vendor,
        category: matched[0]?.category ?? 'Other',
        title: `${s.exportDuplicate ? 'Likely export duplicate' : 'Possible duplicate'} · ${s.vendor}`,
        summary: `${usd(s.amountCents)} on ${s.dates[0]}${s.dates[0] === s.dates[1] ? ' (listed twice)' : ` and ${s.dates[1]}`}`,
        proof,
        sourceRows: matched,
        rule: {
          id: 'duplicate',
          name: 'Duplicate charge within window',
          thresholdSummary: `duplicateWindowDays <= ${limits.duplicateWindowDays} days`,
          thresholds: { duplicateWindowDays: limits.duplicateWindowDays },
        },
        computed: [
          { label: 'Repeated amount', value: usd(s.amountCents) },
          { label: 'Interval', value: interval === 0 ? 'Same day' : `${interval} day${interval === 1 ? '' : 's'}` },
          ...(balanceTrail ? [{ label: 'Running balance', value: balanceTrail }] : []),
          { label: 'Source lines', value: lines || 'n/a' },
        ],
      };
    }
    case 'price_increase': {
      const vendorRows = a.rows
        .filter((r) => r.vendorAlias === s.vendor && r.amountCents < 0 && r.date <= s.date)
        .slice(-3)
        .map(toSourceRow);
      const deltaCents = s.toCents - s.fromCents;
      const pct = s.fromCents > 0 ? Math.round((deltaCents / s.fromCents) * 1000) / 10 : 0;
      return {
        id: `anomaly:price_increase:${s.vendor}:${s.fromCents}:${s.toCents}:${s.date}`,
        kind: 'anomaly',
        type: 'price_increase',
        severity: 'medium',
        vendorAlias: s.vendor,
        category: vendorRows[vendorRows.length - 1]?.category ?? 'Software',
        title: `Price increase · ${s.vendor}`,
        summary: `${usd(s.fromCents)} to ${usd(s.toCents)} on ${s.date}`,
        proof: `Monthly recurring charge rose from ${usd(s.fromCents)} to ${usd(s.toCents)} (+${pct}%) on ${s.date}`,
        sourceRows: vendorRows,
        rule: {
          id: 'price_increase',
          name: 'Recurring subscription price increase',
          thresholdSummary: `priceIncreaseMinPercent >= ${limits.priceIncreaseMinPercent}% (25–35 day cadence)`,
          thresholds: { priceIncreaseMinPercent: limits.priceIncreaseMinPercent },
        },
        computed: [
          { label: 'Previous price', value: usd(-s.fromCents) },
          { label: 'New price', value: usd(-s.toCents) },
          { label: 'Increase', value: `+${usd(deltaCents)} (+${pct}%)` },
        ],
      };
    }
    case 'outlier': {
      const matched = a.rows
        .filter((r) => r.vendorAlias === s.vendor && r.category === s.category && r.amountCents === s.amountCents && r.date === s.date)
        .slice(0, 1)
        .map(toSourceRow);
      const catRows = a.rows.filter((r) => r.category === s.category && r.amountCents < 0);
      const xs = catRows.map((r) => -r.amountCents);
      const mean = xs.length ? xs.reduce((acc, v) => acc + v, 0) / xs.length : 0;
      const sd = xs.length ? Math.sqrt(xs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / xs.length) : 0;
      return {
        id: `anomaly:outlier:${s.vendor}:${s.category}:${s.amountCents}:${s.date}`,
        kind: 'anomaly',
        type: 'outlier',
        severity: 'high',
        vendorAlias: s.vendor,
        category: s.category,
        title: `Outlier · ${s.vendor}`,
        summary: `${usd(s.amountCents)} on ${s.date} (${s.category}, z=${s.zScore})`,
        proof: `${usd(s.amountCents)} in ${s.category} exceeds category mean ${usd(-Math.round(mean))} by ${s.zScore} standard deviations`,
        sourceRows: matched,
        rule: {
          id: 'outlier',
          name: 'Category spend z-score outlier',
          thresholdSummary: `outlierZ > ${limits.outlierZ}, outlierMinSamples >= ${limits.outlierMinSamples}`,
          thresholds: { outlierZ: limits.outlierZ, outlierMinSamples: limits.outlierMinSamples },
        },
        computed: [
          { label: 'Charge amount', value: usd(s.amountCents) },
          { label: 'Category mean', value: usd(-Math.round(mean)) },
          { label: 'Category std dev', value: usd(Math.round(sd)) },
          { label: 'Category samples', value: String(catRows.length) },
          { label: 'Computed z-score', value: String(s.zScore) },
        ],
      };
    }
    case 'round_transfer': {
      const matched = a.rows
        .filter((r) => r.vendorAlias === s.vendor && r.amountCents === s.amountCents && r.date === s.date)
        .slice(0, 1)
        .map(toSourceRow);
      const mult = Math.abs(s.amountCents) / (limits.roundTransferMultipleCents || 50000);
      return {
        id: `anomaly:round_transfer:${s.vendor}:${s.amountCents}:${s.date}`,
        kind: 'anomaly',
        type: 'round_transfer',
        severity: 'medium',
        vendorAlias: s.vendor,
        category: 'Transfers',
        title: `Round transfer · ${s.vendor}`,
        summary: `${usd(s.amountCents)} on ${s.date}`,
        proof: `${usd(s.amountCents)} transfer is an exact ${mult}x multiple of ${usd(limits.roundTransferMultipleCents)}`,
        sourceRows: matched,
        rule: {
          id: 'round_transfer',
          name: 'Large round-number transfer',
          thresholdSummary: `roundTransferMinCents >= ${usd(limits.roundTransferMinCents)}, multiple of ${usd(limits.roundTransferMultipleCents)}`,
          thresholds: {
            roundTransferMinCents: limits.roundTransferMinCents,
            roundTransferMultipleCents: limits.roundTransferMultipleCents,
          },
        },
        computed: [
          { label: 'Transfer amount', value: usd(s.amountCents) },
          { label: 'Multiple unit', value: usd(limits.roundTransferMultipleCents) },
          { label: 'Factor', value: `${mult}x` },
        ],
      };
    }
    case 'weekend_spend': {
      const matched = a.rows
        .filter((r) => r.vendorAlias === s.vendor && r.amountCents === s.amountCents && r.date === s.date)
        .slice(0, 1)
        .map(toSourceRow);
      const dow = new Date(s.date + 'T00:00:00Z').getUTCDay() === 6 ? 'Saturday' : 'Sunday';
      return {
        id: `anomaly:weekend_spend:${s.vendor}:${s.amountCents}:${s.date}`,
        kind: 'anomaly',
        type: 'weekend_spend',
        severity: 'low',
        vendorAlias: s.vendor,
        category: s.category,
        title: `Weekend spend · ${s.vendor}`,
        summary: `${usd(s.amountCents)} on ${s.date} (${dow})`,
        proof: `${usd(s.amountCents)} charged on ${dow} (${s.date}), above ${usd(limits.weekendMinCents)} threshold`,
        sourceRows: matched,
        rule: {
          id: 'weekend_spend',
          name: 'Large weekend expenditure',
          thresholdSummary: `weekendMinCents >= ${usd(limits.weekendMinCents)} on Saturday/Sunday`,
          thresholds: { weekendMinCents: limits.weekendMinCents },
        },
        computed: [
          { label: 'Charge amount', value: usd(s.amountCents) },
          { label: 'Day of week', value: dow },
          { label: 'Weekend floor', value: usd(limits.weekendMinCents) },
        ],
      };
    }
  }
}

const INTEGRITY_LABELS: Record<IntegrityIssue['type'], { title: string; ruleName: string; thresholdSummary: string }> = {
  balance_mismatch: {
    title: 'Running balance mismatch',
    ruleName: 'Running balance continuity check',
    thresholdSummary: 'expectedBalance = prevBalance + rowAmount (0 cents tolerance)',
  },
  missing_page: {
    title: 'Missing page (balance jump)',
    ruleName: 'Multi-page balance continuity check',
    thresholdSummary: 'pageSequenceIncrement = 1, balanceDelta = 0 cents',
  },
  duplicate_row: {
    title: 'Exact duplicate row (export error)',
    ruleName: 'Export duplicate row check',
    thresholdSummary: 'identical (date, description, amount, balance) on consecutive lines',
  },
  date_gap: {
    title: 'Unusual date gap',
    ruleName: 'Chronological date gap check',
    thresholdSummary: 'maxDateGapDays <= 14 days',
  },
  incomplete_period: {
    title: 'Incomplete statement period',
    ruleName: 'Declared period coverage check',
    thresholdSummary: 'periodGraceDays <= 5 days at period boundaries',
  },
};

const isoRange = (a: string, b: string) => `${a} to ${b}`;

function integrityMetrics(issue: IntegrityIssue, sourceRows: SourceRowEvidence[]): ComputedMetric[] {
  const [rowA, rowB] = issue.rows;
  switch (issue.type) {
    case 'balance_mismatch':
    case 'missing_page':
      return [
        ...(issue.expectedCents !== undefined && issue.actualCents !== undefined && issue.deltaCents !== undefined
          ? [
              { label: 'Expected', value: plainMoney(issue.expectedCents) },
              { label: 'Statement says', value: plainMoney(issue.actualCents) },
              { label: 'Discrepancy', value: usd(issue.deltaCents) },
            ]
          : []),
        { label: 'Row span', value: `rows ${rowA}–${rowB}` },
        ...(issue.pages ? [{ label: 'Pages', value: `page ${issue.pages[0]} → page ${issue.pages[1]}` }] : []),
      ];
    case 'duplicate_row':
      return [
        { label: 'Repeated amount', value: usd(sourceRows[0]?.amountCents ?? 0) },
        { label: 'Balance on both rows', value: plainMoney(issue.balanceCents ?? 0) },
        { label: 'Balance movement', value: '0.00 (did not move)' },
        { label: 'Rows', value: `${rowA} and ${rowB}` },
      ];
    case 'date_gap':
      return [
        { label: 'Gap length', value: `${issue.gapDays} days` },
        { label: 'Last date before the gap', value: `${issue.dates![0]} (row ${rowA})` },
        { label: 'First date after the gap', value: `${issue.dates![1]} (row ${rowB})` },
      ];
    case 'incomplete_period':
      return [
        { label: 'Statement covers', value: isoRange(...issue.dates!) },
        { label: `Declared ${issue.declared!.label ?? 'period'}`, value: isoRange(issue.declared!.from, issue.declared!.to) },
        { label: 'Missing', value: `${issue.gapDays} days at the ${issue.side}` },
      ];
  }
}

function buildIntegrityDossier(
  issue: IntegrityIssue,
  a: LocalAnalysis,
  integrityLimits: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): EvidenceDossier {
  const indices = [...new Set([issue.rows[0] - 1, issue.rows[1] - 1])].filter((idx) => idx >= 0 && idx < a.rows.length);
  const sourceRows = indices.map((idx) => toSourceRow(a.rows[idx]));
  const meta = INTEGRITY_LABELS[issue.type];
  const primaryRow = sourceRows[sourceRows.length - 1] ?? sourceRows[0];
  const where = issue.rows[0] === issue.rows[1] ? `row ${issue.rows[0]}` : `rows ${issue.rows[0]}–${issue.rows[1]}`;

  const rule: RuleEvidence =
    issue.type === 'date_gap'
      ? {
          id: issue.type,
          name: meta.ruleName,
          thresholdSummary: `maxDateGapDays <= ${integrityLimits.maxDateGapDays} days`,
          thresholds: { maxDateGapDays: integrityLimits.maxDateGapDays },
        }
      : issue.type === 'incomplete_period'
        ? {
            id: issue.type,
            name: meta.ruleName,
            thresholdSummary: `periodGraceDays <= ${integrityLimits.periodGraceDays} days at period boundaries`,
            thresholds: { periodGraceDays: integrityLimits.periodGraceDays },
          }
        : {
            id: issue.type,
            name: meta.ruleName,
            thresholdSummary: meta.thresholdSummary,
            thresholds: { toleranceCents: 0 },
          };

  return {
    id: `integrity:${issue.type}:${issue.rows[0]}-${issue.rows[1]}`,
    kind: 'integrity',
    type: issue.type,
    severity: issue.type === 'balance_mismatch' || issue.type === 'missing_page' ? 'high' : 'medium',
    vendorAlias: primaryRow?.vendorAlias ?? 'Statement',
    category: primaryRow?.category ?? 'Integrity',
    title: `${meta.title} · ${where}`,
    summary: issue.proof,
    proof: issue.proof,
    sourceRows,
    rule,
    computed: integrityMetrics(issue, sourceRows),
  };
}

export function buildDossiers(
  analysis: LocalAnalysis,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  integrityLimits: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
  comparisonFindings: ComparisonFinding[] = [],
): EvidenceDossier[] {
  return [
    ...analysis.integrity.map((issue) => buildIntegrityDossier(issue, analysis, integrityLimits)),
    ...analysis.signals.map((s) => buildSignalDossier(s, analysis, thresholds)),
    ...comparisonFindings.map((f) => buildComparisonDossier(f, analysis, thresholds)),
  ];
}

function buildComparisonDossier(
  finding: ComparisonFinding,
  a: LocalAnalysis,
  limits: Thresholds,
): EvidenceDossier {
  switch (finding.type) {
    case 'new_subscription': {
      const sourceRows = a.rows
        .filter((r) => r.vendorAlias === finding.vendorAlias && r.amountCents < 0)
        .slice(0, 6)
        .map(toSourceRow);
      return {
        id: `comparison:new_subscription:${finding.vendorAlias}:${finding.unitAmountCents}`,
        kind: 'comparison',
        type: 'new_subscription',
        severity: 'medium',
        vendorAlias: finding.vendorAlias,
        category: finding.category,
        title: `New recurring subscription · ${finding.vendorAlias}`,
        summary: `${usd(-finding.unitAmountCents)}/mo (${finding.count} charges in ${finding.currentPeriodLabel}, 0 in ${finding.priorPeriodLabel})`,
        proof: finding.proof,
        sourceRows,
        rule: {
          id: 'new_subscription',
          name: 'New recurring subscription across periods',
          thresholdSummary: 'recurringCadence = 20–40 days, priorPeriodCount = 0',
          thresholds: { minRecurringCount: 2 },
        },
        computed: [
          { label: 'Prior period', value: `${finding.priorPeriodLabel} (0 charges)` },
          { label: 'Current period', value: `${finding.currentPeriodLabel} (${finding.count} charges)` },
          { label: 'Recurring amount', value: usd(-finding.unitAmountCents) },
          { label: 'Current period total', value: usd(-finding.totalSpendCents) },
        ],
      };
    }
    case 'recurring_price_increase': {
      const sourceRows = a.rows
        .filter((r) => r.vendorAlias === finding.vendorAlias && r.amountCents < 0)
        .slice(-3)
        .map(toSourceRow);
      const deltaCents = finding.toCents - finding.fromCents;
      return {
        id: `comparison:recurring_price_increase:${finding.vendorAlias}:${finding.fromCents}:${finding.toCents}`,
        kind: 'comparison',
        type: 'recurring_price_increase',
        severity: 'medium',
        vendorAlias: finding.vendorAlias,
        category: finding.category,
        title: `Period price increase · ${finding.vendorAlias}`,
        summary: `${usd(-finding.fromCents)} in ${finding.priorPeriodLabel} to ${usd(-finding.toCents)} in ${finding.currentPeriodLabel} (+${finding.increasePercent}%)`,
        proof: finding.proof,
        sourceRows,
        rule: {
          id: 'recurring_price_increase',
          name: 'Period-over-period recurring price increase',
          thresholdSummary: `priceIncreaseMinPercent >= ${limits.priceIncreaseMinPercent}% across periods`,
          thresholds: { priceIncreaseMinPercent: limits.priceIncreaseMinPercent },
        },
        computed: [
          { label: `${finding.priorPeriodLabel} price`, value: usd(-finding.fromCents) },
          { label: `${finding.currentPeriodLabel} price`, value: usd(-finding.toCents) },
          { label: 'Increase', value: `+${usd(deltaCents)} (+${finding.increasePercent}%)` },
        ],
      };
    }
    case 'stopped_recurring': {
      const baselineRow: SourceRowEvidence = {
        rowIndex: -1,
        line: 1,
        date: finding.priorPeriodTo,
        vendorAlias: finding.vendorAlias,
        category: finding.category,
        amountCents: -finding.priorUnitAmountCents,
        balanceCents: null,
        redacted: `${finding.vendorAlias} (${finding.priorPeriodLabel} aggregate baseline: ${finding.priorCount} recurring charges)`,
        description: `${finding.vendorAlias} (${finding.priorPeriodLabel} aggregate baseline: ${finding.priorCount} recurring charges)`,
      };
      return {
        id: `comparison:stopped_recurring:${finding.vendorAlias}:${finding.priorUnitAmountCents}`,
        kind: 'comparison',
        type: 'stopped_recurring',
        severity: 'low',
        vendorAlias: finding.vendorAlias,
        category: finding.category,
        title: `Disappeared recurring charge · ${finding.vendorAlias}`,
        summary: `${usd(-finding.priorUnitAmountCents)}/mo in ${finding.priorPeriodLabel} (${finding.priorCount} charges) → 0 in ${finding.currentPeriodLabel}`,
        proof: finding.proof,
        sourceRows: [baselineRow],
        rule: {
          id: 'stopped_recurring',
          name: 'Disappeared recurring charge across periods',
          thresholdSummary: 'priorPeriodRecurring = true, currentPeriodCount = 0',
          thresholds: { currentPeriodCount: 0 },
        },
        computed: [
          { label: 'Prior period', value: `${finding.priorPeriodLabel} (${finding.priorCount} charges)` },
          { label: 'Prior recurring amount', value: usd(-finding.priorUnitAmountCents) },
          { label: 'Prior period total', value: usd(-finding.priorTotalSpendCents) },
          { label: 'Current period', value: `${finding.currentPeriodLabel} (0 charges)` },
        ],
      };
    }
    case 'category_growth': {
      const sourceRows = [...a.rows]
        .filter((r) => r.category === finding.category && r.amountCents < 0)
        .sort((x, y) => x.amountCents - y.amountCents)
        .slice(0, 3)
        .map(toSourceRow);
      return {
        id: `comparison:category_growth:${finding.category}:${finding.currentSpendCents}`,
        kind: 'comparison',
        type: 'category_growth',
        severity: finding.growthPercent >= 50 ? 'high' : 'medium',
        vendorAlias: finding.topVendorAlias,
        category: finding.category,
        title: `Category spend growth · ${finding.category}`,
        summary: `${usd(-finding.priorSpendCents)} in ${finding.priorPeriodLabel} to ${usd(-finding.currentSpendCents)} in ${finding.currentPeriodLabel} (+${finding.growthPercent}%)`,
        proof: finding.proof,
        sourceRows,
        rule: {
          id: 'category_growth',
          name: 'Period-over-period category spend growth',
          thresholdSummary: `categoryGrowthMinPercent >= ${limits.categoryGrowthMinPercent}%`,
          thresholds: { categoryGrowthMinPercent: limits.categoryGrowthMinPercent },
        },
        computed: [
          { label: `${finding.priorPeriodLabel} spend`, value: usd(-finding.priorSpendCents) },
          { label: `${finding.currentPeriodLabel} spend`, value: usd(-finding.currentSpendCents) },
          { label: 'Growth', value: `+${usd(finding.deltaCents)} (+${finding.growthPercent}%)` },
          { label: 'Top vendor', value: finding.topVendorAlias },
        ],
      };
    }
  }
}
