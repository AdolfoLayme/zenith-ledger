import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, resolveConfig } from './index';

describe('resolveConfig', () => {
  it('returns the built-in defaults when Remote Config has nothing', () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('defaults match the detector limits the app shipped with', () => {
    expect(DEFAULT_CONFIG.thresholds).toEqual({
      duplicateWindowDays: 3, priceIncreaseMinPercent: 0, outlierZ: 2.5, outlierMinSamples: 10,
      roundTransferMinCents: 50000, roundTransferMultipleCents: 50000, weekendMinCents: 20000,
      categoryGrowthMinPercent: 25,
    });
    expect(DEFAULT_CONFIG.integrity).toEqual({
      maxDateGapDays: 14,
      periodGraceDays: 5,
    });
    expect(DEFAULT_CONFIG.cloudModel).toBe('gemini-3.5-flash-lite');
  });

  it('overrides integrity thresholds from Remote Config and ignores invalid values', () => {
    const c = resolveConfig({
      integrity_thresholds: JSON.stringify({ maxDateGapDays: 21, periodGraceDays: 3 }),
    });
    expect(c.integrity).toEqual({ maxDateGapDays: 21, periodGraceDays: 3 });

    const invalid = resolveConfig({
      integrity_thresholds: JSON.stringify({ maxDateGapDays: 0, periodGraceDays: -2, extra: 99 }),
    });
    expect(invalid.integrity).toEqual(DEFAULT_CONFIG.integrity);
  });

  it('overrides only the thresholds it is given', () => {
    const c = resolveConfig({ anomaly_thresholds: JSON.stringify({ duplicateWindowDays: 7, outlierZ: 3 }) });
    expect(c.thresholds.duplicateWindowDays).toBe(7);
    expect(c.thresholds.outlierZ).toBe(3);
    expect(c.thresholds.weekendMinCents).toBe(DEFAULT_CONFIG.thresholds.weekendMinCents);
  });

  it('ignores values of the wrong type or out of range, field by field', () => {
    const c = resolveConfig({
      anomaly_thresholds: JSON.stringify({ duplicateWindowDays: -1, outlierZ: 'high', outlierMinSamples: 0, weekendMinCents: 30000.5, roundTransferMinCents: 100000, unknown: 1 }),
    });
    expect(c.thresholds).toEqual({ ...DEFAULT_CONFIG.thresholds, roundTransferMinCents: 100000 });
  });

  it('survives malformed JSON', () => {
    expect(resolveConfig({ anomaly_thresholds: '{nope', feature_flags: '[1,2' })).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({ anomaly_thresholds: '42', feature_flags: 'null' })).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a cloud model name only when it looks like a Gemini model id', () => {
    expect(resolveConfig({ cloud_model: 'gemini-3.5-pro' }).cloudModel).toBe('gemini-3.5-pro');
    expect(resolveConfig({ cloud_model: 'https://evil.example/x' }).cloudModel).toBe(DEFAULT_CONFIG.cloudModel);
    expect(resolveConfig({ cloud_model: '' }).cloudModel).toBe(DEFAULT_CONFIG.cloudModel);
  });

  it('merges boolean feature flags and ignores anything else', () => {
    const c = resolveConfig({ feature_flags: JSON.stringify({ receiptVault: false, photoInput: 'no', extra: true }) });
    expect(c.flags).toEqual({ ...DEFAULT_CONFIG.flags, receiptVault: false });
  });
});

describe('loadConfig', () => {
  it('applies fetched values', async () => {
    const c = await loadConfig(async () => ({ cloud_model: 'gemini-3.5-pro' }));
    expect(c.cloudModel).toBe('gemini-3.5-pro');
  });

  it('falls back to defaults when the fetch fails (offline)', async () => {
    expect(await loadConfig(async () => { throw new Error('network'); })).toEqual(DEFAULT_CONFIG);
  });

  it('falls back to defaults when the fetch is too slow', async () => {
    const never = () => new Promise<Record<string, string>>(() => {});
    expect(await loadConfig(never, 20)).toEqual(DEFAULT_CONFIG);
  });
});
