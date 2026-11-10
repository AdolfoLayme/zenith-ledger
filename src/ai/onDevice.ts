import { getGenerativeModel, InferenceMode } from 'firebase/ai';
import type { RowEntities } from '../core/types';
import { getFirebase } from './firebase';
import { chunk, type OnDevice } from './types';

// SECURITY: raw bank descriptions only ever go through InferenceMode.ONLY_ON_DEVICE.
// Never switch this to PREFER_ON_DEVICE: if Gemini Nano is missing, that mode silently
// falls back to the cloud and would send the raw text away, which is the leak this app exists to prevent.
// With ONLY_ON_DEVICE a missing model is an error, and the app drops to strict mode instead.

const PROMPT = `You label bank statement lines. For each numbered line return one object with:
"category" (one of Revenue, Supplies, Meals, Software, Insurance, Payroll, Utilities, Travel, Transfers, Other),
"merchant" (the business name, or "" if none) and "persons" (full names of people, [] if none).
Answer with a JSON array only, one object per line, in order.

`;

export function isNanoAvailable(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== 'undefined';
}

/** Returns null when Gemini Nano cannot be used, so the caller falls back to strict mode. */
export function createOnDevice(): OnDevice | null {
  if (!isNanoAvailable()) return null;
  let model: ReturnType<typeof getGenerativeModel> | null = null;
  const get = () => (model ??= getGenerativeModel(getFirebase().ai, { mode: InferenceMode.ONLY_ON_DEVICE }));
  return {
    async init(onProgress) {
      await get().initializeDeviceModel(onProgress);
    },
    async extract(descriptions) {
      const out: RowEntities[] = [];
      for (const batch of chunk(descriptions)) {
        const prompt = PROMPT + batch.map((d, i) => `${i + 1}. ${d}`).join('\n');
        const res = await get().generateContent(prompt);
        const text = res.response.text().replace(/^```(?:json)?|```$/gm, '').trim();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = []; }
        const arr = Array.isArray(parsed) ? parsed : [];
        batch.forEach((_, i) => {
          const o = (arr[i] ?? {}) as Record<string, unknown>;
          out.push({
            category: typeof o.category === 'string' ? o.category : undefined,
            merchant: typeof o.merchant === 'string' && o.merchant ? o.merchant : undefined,
            persons: Array.isArray(o.persons) ? o.persons.filter((p): p is string => typeof p === 'string') : [],
          });
        });
      }
      return out;
    },
    async summarize(overview) {
      const res = await get().generateContent(`Summarize this already-anonymized bookkeeping overview in 3 short sentences:\n${overview}`);
      return res.response.text().trim();
    },
  };
}
