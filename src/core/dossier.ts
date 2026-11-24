import type { Signal } from './analytics';
import { plainMoney, type IntegrityIssue } from './integrity';
import type { AnalyzedRow, LocalAnalysis } from './pipeline';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { PhotoProvenance } from './types';

export type DecisionStatus = 'explained' | 'ask_accountant' | 'ignore';

export interface AlertDecision {
  alertId: string;
  status: DecisionStatus;
  note: string;
  updatedAt: string;
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
  kind: 'anomaly' | 'integrity';
  type: Signal['type'] | IntegrityIssue['type'];
  severity: 'high' | 'medium' | 'low';
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
      return {
        id: `anomaly:duplicate:${s.vendor}:${s.amountCents}:${s.dates[0]}:${s.dates[1]}`,
        kind: 'anomaly',
        type: 'duplicate',
        severity: 'high',
        vendorAlias: s.vendor,
        category: matched[0]?.category ?? 'Other',
        title: `Possible duplicate · ${s.vendor}`,
        summary: `${usd(s.amountCents)} on ${s.dates[0]} and ${s.dates[1]}`,
        proof: `${s.vendor} charged ${usd(s.amountCents)} twice within ${interval} day(s) (lines ${lines || 'n/a'})`,
        sourceRows: matched,
        rule: {
          id: 'duplicate',
          name: 'Duplicate charge within window',
          thresholdSummary: `duplicateWindowDays <= ${limits.duplicateWindowDays} days`,
          thresholds: { duplicateWindowDays: limits.duplicateWindowDays },
        },
        computed: [
          { label: 'Repeated amount', value: usd(s.amountCents) },
          { label: 'Interval', value: `${interval} day(s)` },
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
    thresholdSummary: 'identical (date, description, amountCents) on consecutive lines',
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

function buildIntegrityDossier(issue: IntegrityIssue, a: LocalAnalysis): EvidenceDossier {
  const indices = [...new Set([issue.rows[0] - 1, issue.rows[1] - 1])].filter((idx) => idx >= 0 && idx < a.rows.length);
  const sourceRows = indices.map((idx) => toSourceRow(a.rows[idx]));
  const meta = INTEGRITY_LABELS[issue.type];
  const primaryRow = sourceRows[sourceRows.length - 1] ?? sourceRows[0];
  const computed: ComputedMetric[] = [
    { label: 'Expected', value: plainMoney(issue.expectedCents) },
    { label: 'Statement says', value: plainMoney(issue.actualCents) },
    { label: 'Discrepancy', value: usd(issue.deltaCents) },
    { label: 'Row span', value: `rows ${issue.rows[0]}–${issue.rows[1]}` },
  ];
  if (issue.pages) computed.push({ label: 'Pages', value: `page ${issue.pages[0]} → page ${issue.pages[1]}` });
  if (issue.gapDays !== undefined) computed.push({ label: 'Gap length', value: `${issue.gapDays} days` });

  return {
    id: `integrity:${issue.type}:${issue.rows[0]}-${issue.rows[1]}`,
    kind: 'integrity',
    type: issue.type,
    severity: issue.type === 'balance_mismatch' || issue.type === 'missing_page' ? 'high' : 'medium',
    vendorAlias: primaryRow?.vendorAlias ?? 'Statement',
    category: primaryRow?.category ?? 'Integrity',
    title: `${meta.title} · rows ${issue.rows[0]}–${issue.rows[1]}`,
    summary: issue.proof,
    proof: issue.proof,
    sourceRows,
    rule: {
      id: issue.type,
      name: meta.ruleName,
      thresholdSummary: meta.thresholdSummary,
      thresholds: issue.gapDays !== undefined ? { maxGapDays: issue.type === 'date_gap' ? 14 : 5 } : { toleranceCents: 0 },
    },
    computed,
  };
}

export function buildDossiers(analysis: LocalAnalysis, thresholds: Thresholds = DEFAULT_THRESHOLDS): EvidenceDossier[] {
  return [
    ...analysis.integrity.map((issue) => buildIntegrityDossier(issue, analysis)),
    ...analysis.signals.map((s) => buildSignalDossier(s, analysis, thresholds)),
  ];
}
