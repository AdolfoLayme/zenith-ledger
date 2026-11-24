/** Tunable limits for the anomaly detectors. Amounts are integer cents. */
export interface Thresholds {
  /** Same vendor and amount again within this many days is a possible duplicate. */
  duplicateWindowDays: number;
  /** A monthly price must rise by at least this percent to be flagged (0 flags every rise). */
  priceIncreaseMinPercent: number;
  /** Z-score above which a charge is unusual for its category. */
  outlierZ: number;
  /** Categories with fewer charges than this are not checked for outliers. */
  outlierMinSamples: number;
  /** Transfers below this are never "round transfers". */
  roundTransferMinCents: number;
  /** A transfer is round when it is an exact multiple of this. */
  roundTransferMultipleCents: number;
  /** Weekend charges below this are ignored. */
  weekendMinCents: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  duplicateWindowDays: 3,
  priceIncreaseMinPercent: 0,
  outlierZ: 2.5,
  outlierMinSamples: 10,
  roundTransferMinCents: 50000,
  roundTransferMultipleCents: 50000,
  weekendMinCents: 20000,
};

/** Tunable limits for statement integrity checks, configured via Firebase Remote Config. */
export interface IntegrityThresholds {
  /** Maximum normal gap in calendar days between consecutive transactions before flagging date_gap. */
  maxDateGapDays: number;
  /** Allowed grace days at the start or end of a declared period before flagging incomplete_period. */
  periodGraceDays: number;
}

export const DEFAULT_INTEGRITY_THRESHOLDS: IntegrityThresholds = {
  maxDateGapDays: 14,
  periodGraceDays: 5,
};
