import { toCents, toIsoDate } from '../core/csv';
import { luhn } from '../core/detectors';
import type { StatementRow } from '../core/types';
import type { OnDevice, PhotoKind } from './types';

export type { PhotoKind };
export const PHOTO_TYPES = ['image/jpeg', 'image/png'];

export class PhotoNeedsOnDeviceError extends Error {
  constructor() {
    super('Reading a photo needs the on-device model (Gemini Nano in desktop Chrome). Turn on on-device AI and try again. Your photo stayed on this device and was not sent anywhere.');
  }
}

/** What a photo turned into: rows for the review screen, names the receipt printed, and a note when the count looks off. */
export interface PhotoRead { rows: StatementRow[]; persons: string[]; warning: string }

// A plain money figure: optional sign or parentheses, optional $, digits with or without thousands commas, up to 2 decimals.
const AMOUNT = /^-?\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\)?$/;
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/** A real calendar day as YYYY-MM-DD, or null. A time printed after the date is ignored. */
function day(raw: unknown): string | null {
  try {
    const iso = toIsoDate(str(raw).split(/\s+/)[0]);
    return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
  } catch { return null; }
}
const cents = (raw: unknown): number | null => (AMOUNT.test(str(raw).replace(/\s/g, '')) ? toCents(str(raw).replace(/\s/g, '')) : null);

function row(date: unknown, description: unknown, amount: unknown): StatementRow | null {
  const d = day(date), c = cents(amount), text = str(description).replace(/\s+/g, ' ');
  return d && c !== null && text ? { date: d, description: text, amountCents: c, currency: 'USD', balanceCents: null } : null;
}

const NOTHING = 'No transactions could be read from this photo. Try a sharper, straight-on picture.';

/**
 * One printed statement row, copied by the model as a single line of text: date first, amount (with cents) last.
 * Measured with Gemini Nano on 2026-11-12: asking for separate date/description/amount fields made it read the
 * amount column out of step with the rows; copying each row as one line kept them together.
 */
function splitRowText(text: unknown): StatementRow | null {
  const words = str(text).split(/\s+/);
  if (words.length < 3 || !/\.\d{2}\)?$/.test(words[words.length - 1])) return null;
  return row(words[0], words.slice(1, -1).join(' '), words[words.length - 1]);
}

/** Statement rows from the model: each needs its line number, a real date, some text and an amount with cents. */
export function statementFromModel(raw: unknown): PhotoRead {
  const o = (raw ?? {}) as { visibleRows?: unknown; rows?: unknown };
  const items = (Array.isArray(o.rows) ? o.rows : []) as Record<string, unknown>[];
  const byLine = new Map<number, StatementRow>();
  for (const it of items) {
    const line = it?.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || byLine.has(line)) continue;
    const r = splitRowText(it.text);
    if (r) byLine.set(line, r);
  }
  const rows = [...byLine].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  if (!rows.length) throw new Error(NOTHING);
  const seen = typeof o.visibleRows === 'number' ? o.visibleRows : null;
  const warning = seen !== null && seen !== rows.length
    ? `The model counted ${seen} rows on the page but could read ${rows.length}. Check the list below against your photo.`
    : '';
  return { rows, persons: [], warning };
}

/** A receipt is one payment: the code builds the row from fields, so line items never become transactions. */
export function receiptFromModel(raw: unknown): PhotoRead {
  const o = (raw ?? {}) as Record<string, unknown>;
  const date = day(o.date), total = cents(o.total);
  if (!date || !total) throw new Error('Could not read the receipt total and date. Nothing was sent; try a sharper, straight-on picture.');
  const merchant = str(o.merchant).replace(/\s+/g, ' ') || 'Receipt';
  const last4 = str(o.cardLast4);
  const name = str(o.payerName).replace(/\s+/g, ' ');
  const email = str(o.payerEmail);
  const description = [
    merchant,
    /^\d{4}$/.test(last4) ? `card ****${last4}` : '',
    name || /@/.test(email) ? `paid by ${[name, /@/.test(email) ? email : ''].filter(Boolean).join(' ')}` : '',
  ].filter(Boolean).join(' ');
  return { rows: [{ date, description, amountCents: -Math.abs(total), currency: 'USD', balanceCents: null }], persons: name ? [name] : [], warning: '' };
}

/**
 * A long number after "card", or any 13-19 digit run, that fails the Luhn check: most likely a card number the model
 * misread (Nano often drops a digit). The card detector skips it, so the review screen asks the user to check it.
 */
export function misreadCard(description: string): boolean {
  return [...description.matchAll(/(card\W*)?(?<![\dA-Za-z])(\d{12,19})(?![\dA-Za-z])/gi)].some((m) => (m[1] || m[2].length >= 13) && !luhn(m[2]));
}

/** Rows as the user left them on the review screen. Anything still invalid is named, not silently dropped. */
export function rowsFromReview(edited: { date: string; description: string; amount: string }[]): StatementRow[] {
  if (!edited.length) throw new Error('Keep at least one transaction.');
  return edited.map((e, i) => {
    const r = row(e.date, e.description, e.amount);
    if (!r) throw new Error(`Row ${i + 1}: use a date like 2025-09-13, a description, and an amount like -236.40.`);
    return r;
  });
}

/**
 * A photo is raw, unredacted data, so only the on-device model may read it.
 * There is no cloud path here: no on-device model means the photo is refused.
 */
export async function readPhoto(image: Blob, kind: PhotoKind, onDevice: OnDevice | null, ready = false): Promise<PhotoRead> {
  if (!PHOTO_TYPES.includes(image.type)) throw new Error('Use a JPEG or PNG photo.');
  if (!onDevice || !ready) throw new PhotoNeedsOnDeviceError();
  const raw = await onDevice.readImage(image, kind);
  return kind === 'receipt' ? receiptFromModel(raw) : statementFromModel(raw);
}
