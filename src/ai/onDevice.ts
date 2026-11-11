import { getGenerativeModel, InferenceMode, InferenceSource, type LanguageModelPromptOptions, type Part } from 'firebase/ai';
import type { RowEntities } from '../core/types';
import { getFirebase } from './firebase';
import { chunk, type OnDevice } from './types';

// SECURITY: raw bank descriptions and statement photos only ever go through InferenceMode.ONLY_ON_DEVICE.
// Never switch this to PREFER_ON_DEVICE: if Gemini Nano is missing, that mode silently
// falls back to the cloud and would send the raw text away, which is the leak this app exists to prevent.
// With ONLY_ON_DEVICE a missing model is an error, and the app drops to strict mode instead.
// API per https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options
// and https://firebase.google.com/docs/ai-logic/hybrid/web/generate-structured-output (checked 2026-11-11).

const CATEGORIES = ['Revenue', 'Supplies', 'Meals', 'Software', 'Insurance', 'Payroll', 'Utilities', 'Travel', 'Transfers', 'Other'];

// Plain JSON schemas passed to Chrome's Prompt API as responseConstraint (structured output on device).
const ENTITIES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { category: { type: 'string', enum: CATEGORIES }, merchant: { type: 'string' }, persons: { type: 'array', items: { type: 'string' } } },
    required: ['category', 'merchant', 'persons'],
  },
};
const ROWS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { date: { type: 'string' }, description: { type: 'string' }, amount: { type: 'string' } },
    required: ['date', 'description', 'amount'],
  },
};

const ENTITIES_PROMPT = `You label bank statement lines. For each numbered line return one object with:
"category" (one of ${CATEGORIES.join(', ')}),
"merchant" (the business name, or "" if none) and "persons" (full names of people, [] if none).
Answer with a JSON array only, one object per line, in order.

`;

const ROWS_PROMPT = `This image is a bank statement or a store receipt. Return a JSON array of transactions.
Each item: "date" (YYYY-MM-DD or MM/DD/YYYY as printed), "description" (the full line text exactly as printed, including any names, card or account numbers),
"amount" (as printed; money going out is negative, money coming in is positive).
For a receipt return a single item: the store name and printed card details as description, and minus the total as amount.`;

export function isNanoAvailable(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== 'undefined';
}

async function toInlinePart(image: Blob): Promise<Part> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: 'inlineData', inlineData: { data: btoa(bin), mimeType: image.type } };
}

const parseJson = (text: string): unknown => {
  try { return JSON.parse(text.replace(/^```(?:json)?|```$/gm, '').trim()); } catch { return []; }
};

/** Returns null when Gemini Nano cannot be used, so the caller falls back to strict mode. */
export function createOnDevice(): OnDevice | null {
  if (!isNanoAvailable()) return null;
  // The generation config is fixed per model instance, so each task gets its own instance.
  const models = new Map<string, ReturnType<typeof getGenerativeModel>>();
  const model = (key: string, promptOptions?: LanguageModelPromptOptions) => {
    let m = models.get(key);
    if (!m) {
      m = getGenerativeModel(getFirebase().ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: promptOptions ? { promptOptions } : undefined });
      models.set(key, m);
    }
    return m;
  };
  const run = async (key: string, request: string | (string | Part)[], promptOptions?: LanguageModelPromptOptions) => {
    const res = await model(key, promptOptions).generateContent(request);
    // Belt and braces: ONLY_ON_DEVICE cannot fall back, but refuse any answer that did not come from the device.
    if (res.response.inferenceSource && res.response.inferenceSource !== InferenceSource.ON_DEVICE) throw new Error('Refusing a response that did not come from the on-device model.');
    return res.response.text();
  };
  return {
    async init(onProgress) {
      await model('plain').initializeDeviceModel(onProgress);
    },
    async extract(descriptions) {
      const out: RowEntities[] = [];
      for (const batch of chunk(descriptions)) {
        const parsed = parseJson(await run('entities', ENTITIES_PROMPT + batch.map((d, i) => `${i + 1}. ${d}`).join('\n'), { responseConstraint: ENTITIES_SCHEMA }));
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
      return (await run('plain', `Summarize this already-anonymized bookkeeping overview in 3 short sentences. Keep aliases like Vendor_A as they are.\n${overview}`)).trim();
    },
    async readImage(image) {
      return parseJson(await run('rows', [ROWS_PROMPT, await toInlinePart(image)], { responseConstraint: ROWS_SCHEMA }));
    },
  };
}
