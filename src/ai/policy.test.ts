import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BATCH_SIZE, chunk } from './types';

const code = (f: string) => readFileSync(`src/ai/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('inference mode policy', () => {
  it('never uses a mode that can fall back to the cloud', () => {
    for (const f of readdirSync('src/ai').filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      expect(code(f), f).not.toMatch(/PREFER_ON_DEVICE|PREFER_IN_CLOUD/);
    }
  });
  it('raw text goes ONLY_ON_DEVICE, the cloud call is ONLY_IN_CLOUD', () => {
    expect(code('onDevice.ts')).toContain('InferenceMode.ONLY_ON_DEVICE');
    expect(code('onDevice.ts')).not.toContain('ONLY_IN_CLOUD');
    expect(code('cloud.ts')).toContain('InferenceMode.ONLY_IN_CLOUD');
    expect(code('cloud.ts')).not.toContain('ONLY_ON_DEVICE');
  });
});

describe('chunk', () => {
  it('batches descriptions by 20', () => {
    const parts = chunk(Array.from({ length: 45 }, (_, i) => i));
    expect(BATCH_SIZE).toBe(20);
    expect(parts.map((p) => p.length)).toEqual([20, 20, 5]);
  });
});
