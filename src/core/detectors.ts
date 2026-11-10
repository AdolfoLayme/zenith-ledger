import type { PiiType, Span } from './types';

export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function isValidIban(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

interface Rule { type: PiiType; re: RegExp; group?: number; ok?: (v: string) => boolean }

// Order = priority when two matches overlap (earlier wins).
const RULES: Rule[] = [
  { type: 'url', re: /https?:\/\/[^\s,;"']+[?&](?:token|access_token|auth|key|sig|session)=[^\s,;"']+/gi },
  { type: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, ok: isValidIban },
  { type: 'card', re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, ok: (v) => luhn(v.replace(/\D/g, '')) },
  { type: 'ssn', re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g },
  { type: 'ein', re: /(?<![\d-])\d{2}-\d{7}(?![\d-])/g },
  { type: 'phone', re: /(?<![\d-])(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?!\d)/g },
  { type: 'account', re: /\b(?:acct|account|a\/c)\.?\s*(?:no\.?|number|#)?:?\s*(\d{6,17})\b/gi, group: 1 },
];

export function detectPii(text: string): Span[] {
  const hits: Span[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (rule.ok && !rule.ok(value)) continue;
      const start = (m.index ?? 0) + (rule.group ? m[0].indexOf(value) : 0);
      const end = start + value.length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, type: rule.type, value });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
