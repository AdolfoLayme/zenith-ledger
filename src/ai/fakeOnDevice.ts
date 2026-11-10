import { detectPii } from '../core/detectors';
import { guessMerchant } from '../core/pipeline';
import type { RowEntities } from '../core/types';
import type { OnDevice } from './types';

const NAME = /\b(?:from|to|by|pay)\s+([A-Z][a-z]+ [A-Z][a-z]+)\b/;

/** Scripted stand-in for Gemini Nano: same interface, no model, no network. */
export const fakeOnDevice: OnDevice = {
  async init(onProgress) {
    for (const f of [0.2, 0.5, 0.8, 1]) { onProgress(f); await new Promise((r) => setTimeout(r, 40)); }
  },
  async extract(descriptions) {
    return descriptions.map((d): RowEntities => {
      const person = NAME.exec(d)?.[1];
      return { persons: person ? [person] : [], merchant: guessMerchant(d, detectPii(d)), category: undefined };
    });
  },
  async summarize(overview) {
    return `On-device summary (scripted): ${overview.slice(0, 160)}`;
  },
};
