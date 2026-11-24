import {
  DEFAULT_INTEGRITY_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  type IntegrityThresholds,
  type Thresholds,
} from '../core/thresholds';

// Remote Config can change these without a new release. Every default lives here in code,
// so the app behaves the same when it cannot reach the network.

export interface FeatureFlags {
  /** Opt-in sync of Data Receipts (never content) through Firebase Auth and Firestore. */
  receiptVault: boolean;
  /** Gemini Nano writes a short summary while offline. */
  offlineSummary: boolean;
  /** Photos of statements and receipts can be dropped in. */
  photoInput: boolean;
}

export interface AppConfig {
  thresholds: Thresholds;
  integrity: IntegrityThresholds;
  cloudModel: string;
  flags: FeatureFlags;
}

export const DEFAULT_CONFIG: AppConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  integrity: DEFAULT_INTEGRITY_THRESHOLDS,
  cloudModel: 'gemini-3.5-flash-lite',
  flags: { receiptVault: true, offlineSummary: true, photoInput: true },
};

const isInt = (min: number) => (v: unknown): v is number => Number.isInteger(v) && (v as number) >= min;
const isNum = (min: number, max: number) => (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

const THRESHOLD_RULES: { [K in keyof Thresholds]: (v: unknown) => v is number } = {
  duplicateWindowDays: isInt(1),
  priceIncreaseMinPercent: isNum(0, 100),
  outlierZ: isNum(0.1, 20),
  outlierMinSamples: isInt(1),
  roundTransferMinCents: isInt(0),
  roundTransferMultipleCents: isInt(1),
  weekendMinCents: isInt(0),
};

const INTEGRITY_RULES: { [K in keyof IntegrityThresholds]: (v: unknown) => v is number } = {
  maxDateGapDays: isInt(1),
  periodGraceDays: isInt(0),
};

function parseObject(text: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Builds the effective config from raw Remote Config values. Anything invalid falls back to its default. */
export function resolveConfig(raw: Record<string, string>): AppConfig {
  const t = parseObject(raw.anomaly_thresholds);
  const it = parseObject(raw.integrity_thresholds);
  const f = parseObject(raw.feature_flags);
  const thresholds = { ...DEFAULT_CONFIG.thresholds };
  for (const key of Object.keys(THRESHOLD_RULES) as (keyof Thresholds)[]) {
    if (THRESHOLD_RULES[key](t[key])) thresholds[key] = t[key] as number;
  }
  const integrity = { ...DEFAULT_CONFIG.integrity };
  for (const key of Object.keys(INTEGRITY_RULES) as (keyof IntegrityThresholds)[]) {
    const candidate = it[key] !== undefined ? it[key] : t[key];
    if (INTEGRITY_RULES[key](candidate)) integrity[key] = candidate as number;
  }
  const flags = { ...DEFAULT_CONFIG.flags };
  for (const key of Object.keys(flags) as (keyof FeatureFlags)[]) {
    if (typeof f[key] === 'boolean') flags[key] = f[key];
  }
  const cloudModel = /^gemini-[a-z0-9.-]+$/.test(raw.cloud_model ?? '') ? raw.cloud_model : DEFAULT_CONFIG.cloudModel;
  return { thresholds, integrity, cloudModel, flags };
}

/** Fetches Remote Config values, giving up after `timeoutMs`. Offline or slow means the defaults. */
export async function loadConfig(fetchValues: () => Promise<Record<string, string>>, timeoutMs = 3000): Promise<AppConfig> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Remote Config timed out')), timeoutMs); });
  try {
    return resolveConfig(await Promise.race([fetchValues(), timeout]));
  } catch {
    return DEFAULT_CONFIG;
  } finally {
    clearTimeout(timer);
  }
}
