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
    properties: { line: { type: 'integer' }, category: { type: 'string', enum: CATEGORIES }, merchant: { type: 'string' }, persons: { type: 'array', items: { type: 'string' } } },
    required: ['line', 'category', 'merchant', 'persons'],
  },
};
// Statement: each printed row copied as one line of text; photo.ts splits and validates date, description and amount.
const STATEMENT_SCHEMA = {
  type: 'object',
  properties: {
    visibleRows: { type: 'integer' },
    rows: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, text: { type: 'string' } }, required: ['line', 'text'] } },
  },
  required: ['visibleRows', 'rows'],
};
// Receipt: fields, not rows, so line items never turn into transactions; photo.ts builds the one row.
const RECEIPT_FIELDS = ['merchant', 'date', 'total', 'cardLast4', 'payerName', 'payerEmail'];
const RECEIPT_SCHEMA = { type: 'object', properties: Object.fromEntries(RECEIPT_FIELDS.map((f) => [f, { type: 'string' }])), required: RECEIPT_FIELDS };

const ENTITIES_PROMPT = `You label bank statement lines. For each numbered line return one object with:
"line" (its number),
"category" (one of ${CATEGORIES.join(', ')}),
"merchant" (the business name, or "" if none) and "persons" (full names of people, [] if none).
Answer with a JSON array only, one object per line, in order.

`;

// Both prompts were compared against the sample photos with Gemini Nano in Chrome (2026-11-12).
const STATEMENT_PROMPT = `This image is a bank statement. First count the transaction rows in its table (not the header) as "visibleRows".
Then transcribe every row in "rows", top to bottom. Each row: "line" (1 for the first row under the header, then 2, 3...) and
"text": everything printed on that one horizontal row, left to right, exactly as printed: the date, the full description with every digit of any card or account number, and the amount at the right end with its minus sign.`;

const RECEIPT_PROMPT = `This image is a store receipt. Read these fields from it:
"merchant": the store name printed at the top;
"date": the purchase date as printed;
"total": the final TOTAL amount as printed (not a line item, not tax or tip);
"cardLast4": the last 4 digits of the payment card, "" if none is printed;
"payerName": the customer or cardholder name if printed (for example after "Paid by" or "Cardholder"), "" if none;
"payerEmail": any email address printed on the receipt, "" if none.
Copy names, digits and the email exactly as printed.`;

const PHOTO = { statement: [STATEMENT_PROMPT, STATEMENT_SCHEMA], receipt: [RECEIPT_PROMPT, RECEIPT_SCHEMA] } as const;

const CREATE_OPTIONS = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }, { type: 'image' as const }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

/** Keeps only what the line really contains: a merchant or a person the model names must appear in the text. */
export function acceptEntities(text: string, o: Record<string, unknown>): RowEntities {
  const has = (v: string) => text.toLowerCase().includes(v.trim().toLowerCase());
  const merchant = typeof o.merchant === 'string' && o.merchant.trim() && has(o.merchant) ? o.merchant.trim() : undefined;
  const persons = Array.isArray(o.persons) ? o.persons.filter((p): p is string => typeof p === 'string' && !!p.trim() && has(p)) : [];
  return { category: typeof o.category === 'string' ? o.category : undefined, merchant, persons };
}

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
      m = getGenerativeModel(getFirebase().ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        // English in and out, images allowed: declared up front so Chrome can check the output language
        onDeviceParams: { createOptions: CREATE_OPTIONS, ...(promptOptions ? { promptOptions } : {}) },
      });
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
    async alreadyAvailable() {
      const lm = (globalThis as { LanguageModel?: { availability(o?: unknown): Promise<string> } }).LanguageModel;
      try { return (await lm?.availability(CREATE_OPTIONS)) === 'available'; } catch { return false; }
    },
    async extract(descriptions, onBatch) {
      const out: RowEntities[] = [];
      const batches = chunk(descriptions);
      for (const [n, batch] of batches.entries()) {
        onBatch?.(n, batches.length);
        const parsed = parseJson(await run('entities', ENTITIES_PROMPT + batch.map((d, i) => `${i + 1}. ${d}`).join('\n'), { responseConstraint: ENTITIES_SCHEMA }));
        const arr = (Array.isArray(parsed) ? parsed : []) as Record<string, unknown>[];
        // match answers by their line number, not by position: the model sometimes skips or reorders lines
        const byLine = new Map(arr.filter((o) => typeof o?.line === 'number').map((o) => [o.line as number, o]));
        batch.forEach((text, i) => out.push(acceptEntities(text, byLine.get(i + 1) ?? (byLine.size ? {} : arr[i] ?? {}))));
      }
      return out;
    },
    async summarize(overview) {
      return (await run('plain', `Summarize this already-anonymized bookkeeping overview in 3 short sentences. Keep aliases like Vendor_A as they are.\n${overview}`)).trim();
    },
    async readImage(image, kind) {
      const [prompt, schema] = PHOTO[kind];
      return parseJson(await run(kind, [prompt, await toInlinePart(image)], { responseConstraint: schema }));
    },
  };
}
