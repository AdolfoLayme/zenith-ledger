import type { StatementRow } from './types';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** Money string to integer cents, no floating point. */
export function toCents(raw: string): number {
  let s = raw.trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error(`Bad amount: "${raw}"`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

export function toIsoDate(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  throw new Error(`Bad date: "${raw}"`);
}

export function parseStatement(text: string): StatementRow[] {
  const [head, ...body] = parseCsv(text);
  const cols = (head ?? []).map((h) => h.trim().toLowerCase());
  const idx = (n: string) => cols.indexOf(n);
  const [d, desc, amt] = [idx('date'), idx('description'), idx('amount')];
  if (d < 0 || desc < 0 || amt < 0) throw new Error('Expected columns: date, description, amount (currency and balance are optional)');
  const cur = idx('currency');
  const bal = idx('balance');
  return body.map((r) => ({
    date: toIsoDate(r[d]),
    description: r[desc] ?? '',
    amountCents: toCents(r[amt]),
    currency: cur >= 0 && r[cur] ? r[cur].trim() : 'USD',
    balanceCents: bal >= 0 && r[bal]?.trim() ? toCents(r[bal]) : null,
  }));
}

/** Rows an on-device model read from a photo, normalized exactly like CSV rows. Unreadable rows are dropped. */
export function toStatementRows(items: unknown): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const o = (it ?? {}) as Record<string, unknown>;
    try {
      const description = String(o.description ?? '').trim();
      if (!description) continue;
      rows.push({ date: toIsoDate(String(o.date ?? '')), description, amountCents: toCents(String(o.amount ?? '')), currency: 'USD', balanceCents: null });
    } catch { /* unreadable row */ }
  }
  if (!rows.length) throw new Error('No transactions could be read from this photo. Try a sharper, straight-on picture.');
  return rows;
}
