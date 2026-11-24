import type { Signal } from './analytics';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Top-level keys of the payload. The Receipt Vault and its Firestore rules only accept these as field names. */
export const PAYLOAD_FIELDS = ['schema', 'mode', 'currency', 'period', 'totals', 'categories', 'vendors', 'signals'] as const satisfies readonly (keyof CloudPayload)[];

export interface CloudPayload {
  schema: 'zenith-ledger/payload@1';
  mode: 'strict' | 'assisted';
  currency: string;
  period: { from: string; to: string };
  totals: { incomeCents: number; expenseCents: number; count: number };
  categories: { category: string; spendCents: number; incomeCents: number; count: number }[];
  vendors: { alias: string; category: string; spendCents: number; count: number }[];
  signals: Signal[];
}

export interface Counters { piiFound: number; piiReplaced: number; rawDescriptionsSent: number }

/** Count rows whose original description text (or any detected PII value) appears in the serialized payload. */
export function countRawLeaks(json: string, descriptions: string[]): number {
  return descriptions.filter((d) => d.trim().length >= 6 && json.includes(d.trim())).length;
}
