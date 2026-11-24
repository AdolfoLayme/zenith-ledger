import { PAYLOAD_FIELDS } from '../core/payload';

/** Strictly allowlisted keys for a synced Data Receipt. Never statement rows, descriptions, or aliases. */
export const VAULT_KEYS = ['sentAt', 'hash', 'fields', 'rowCount', 'piiFound', 'piiReplaced', 'rawDescriptionsSent'] as const;

export interface VaultDoc {
  sentAt: string;
  hash: string;
  fields: string[];
  rowCount: number;
  piiFound?: number;
  piiReplaced?: number;
  rawDescriptionsSent?: number;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_FIELDS = new Set<string>(PAYLOAD_FIELDS);
const MAX_COUNT = 1_000_000;

const validCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

/** Validates and strips a receipt down to the allowlisted metadata fields, or returns null if invalid. */
export function parseVaultDoc(raw: unknown): VaultDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sentAt !== 'string' || !ISO_UTC.test(o.sentAt) || !Number.isFinite(Date.parse(o.sentAt))) return null;
  if (typeof o.hash !== 'string' || !SHA256.test(o.hash)) return null;
  if (!Array.isArray(o.fields) || o.fields.length < 1 || o.fields.length > PAYLOAD_FIELDS.length) return null;
  if (!o.fields.every((f): f is string => typeof f === 'string' && ALLOWED_FIELDS.has(f))) return null;
  if (!validCount(o.rowCount)) return null;

  const doc: VaultDoc = { sentAt: o.sentAt, hash: o.hash, fields: [...o.fields], rowCount: o.rowCount };
  for (const key of ['piiFound', 'piiReplaced', 'rawDescriptionsSent'] as const) {
    if (o[key] !== undefined) {
      if (!validCount(o[key])) return null;
      doc[key] = o[key];
    }
  }
  return doc;
}

/** Deterministic document ID from send timestamp and hash prefix so retries cannot duplicate a receipt. */
export function vaultId(r: Pick<VaultDoc, 'sentAt' | 'hash'>): string {
  return `${Date.parse(r.sentAt)}-${r.hash.slice(0, 16)}`;
}
