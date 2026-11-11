import { detectPii } from '../core/detectors';
import { guessMerchant } from '../core/pipeline';
import { readPngText } from '../core/pngText';
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
    const [period, money, , flagged = ''] = overview.split('\n');
    const items = flagged.replace(/^Flagged: |\.$/g, '').split('; ');
    return `On-device summary (scripted): ${period} ${money} ${items.length} item(s) flagged, starting with ${items[0]}.`;
  },
  async readImage(image) {
    // The bundled synthetic photos carry their rows in a PNG text chunk; there is no OCR here.
    const rows = readPngText(new Uint8Array(await image.arrayBuffer()), 'zenith-rows');
    if (!rows) throw new Error('Demo mode can only read the bundled sample photos. Real photos need Gemini Nano.');
    await new Promise((r) => setTimeout(r, 300));
    return JSON.parse(rows);
  },
};
