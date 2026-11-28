import { parseQuestionLocally } from '../core/ask';
import { CATEGORIES } from '../core/categories';
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
  // the stand-in always starts "not downloaded" so the demo shows the Enable click
  async alreadyAvailable() { return false; },
  async extract(descriptions, onBatch) {
    onBatch?.(1, 1);
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
  async parseQuestion(question, months) {
    return parseQuestionLocally(question, CATEGORIES, months);
  },
  async readImage(image, kind) {
    // The bundled synthetic photos carry their answers in PNG text chunks; there is no OCR here.
    const png = new Uint8Array(await image.arrayBuffer());
    const rows = readPngText(png, 'zenith-rows');
    if (!rows) throw new Error('Demo mode can only read the bundled sample photos. Real photos need Gemini Nano.');
    await new Promise((r) => setTimeout(r, 300));
    if (kind === 'receipt') return JSON.parse(readPngText(png, 'zenith-fields') ?? '{}');
    const items = JSON.parse(rows) as { date: string; description: string; amount: string }[];
    return { visibleRows: items.length, rows: items.map((r, i) => ({ line: i + 1, text: `${r.date} ${r.description} ${r.amount}` })) };
  },
};
