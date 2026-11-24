import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_FIELDS } from '../core/payload';
import { analyzeLocally, buildPayload } from '../core/pipeline';
import { parseStatement } from '../core/csv';
import { parseVaultDoc, vaultId, VAULT_KEYS } from './receipt';

const good = {
  sentAt: '2026-11-24T15:00:00.000Z', hash: 'ab'.repeat(32), fields: ['schema', 'totals', 'signals'], rowCount: 117,
  piiFound: 60, piiReplaced: 60, rawDescriptionsSent: 0,
};

describe('parseVaultDoc', () => {
  it('keeps a valid receipt as is', () => {
    expect(parseVaultDoc(good)).toEqual(good);
  });

  it('accepts receipts from older versions without counters', () => {
    const { piiFound, piiReplaced, rawDescriptionsSent, ...old } = good;
    void piiFound; void piiReplaced; void rawDescriptionsSent;
    expect(parseVaultDoc(old)).toEqual(old);
  });

  it('drops keys that are not on the allowlist, including the local database id', () => {
    const doc = parseVaultDoc({ ...good, id: 7, description: 'ACME PLUMBING LLC', note: 'x' });
    expect(Object.keys(doc ?? {}).every((k) => (VAULT_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('ACME');
  });

  it.each([
    ['hash that is not a SHA-256', { hash: 'ACME PLUMBING LLC' }],
    ['uppercase hash', { hash: 'AB'.repeat(32) }],
    ['a field name outside the payload', { fields: ['schema', 'description'] }],
    ['more field names than the payload has', { fields: [...PAYLOAD_FIELDS, 'schema'] }],
    ['fields that are not a list', { fields: 'schema' }],
    ['a time that is not ISO UTC', { sentAt: 'yesterday at 3pm' }],
    ['a negative count', { rowCount: -1 }],
    ['a count that is not an integer', { rowCount: 1.5 }],
    ['a huge count', { piiFound: 10_000_000 }],
    ['a counter holding text', { rawDescriptionsSent: 'zero' }],
  ])('rejects %s', (_label, patch) => {
    expect(parseVaultDoc({ ...good, ...patch })).toBeNull();
  });

  it('rejects things that are not objects or lack a required field', () => {
    expect(parseVaultDoc(null)).toBeNull();
    expect(parseVaultDoc('receipt')).toBeNull();
    const { hash, ...noHash } = good;
    void hash;
    expect(parseVaultDoc(noHash)).toBeNull();
  });
});

describe('vaultId', () => {
  it('is the send time in milliseconds plus the start of the hash, so a retry cannot duplicate it', () => {
    expect(vaultId(good)).toBe(`${Date.parse(good.sentAt)}-${'ab'.repeat(8)}`);
  });
});

describe('the vault never sees content', () => {
  it('a real receipt built from a statement carries only metadata', async () => {
    const rows = parseStatement(readFileSync('public/samples/acme-q3.csv', 'utf8'));
    const built = await buildPayload(analyzeLocally(rows));
    const doc = parseVaultDoc({
      sentAt: new Date().toISOString(), hash: built.hash, fields: Object.keys(built.payload), rowCount: rows.length, ...built.counters,
    });
    expect(doc).not.toBeNull();
    const text = JSON.stringify(doc).toLowerCase();
    for (const r of rows) {
      const d = r.description.trim().toLowerCase();
      if (d.length >= 6) expect(text).not.toContain(d);
    }
    expect(Object.keys(built.payload).every((k) => (PAYLOAD_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
});

describe('firestore.rules stay in step with the client allowlist', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  it('lists every vault key and payload field name', () => {
    for (const k of [...VAULT_KEYS, ...PAYLOAD_FIELDS]) expect(rules, k).toContain(`'${k}'`);
  });
  it('allows nothing but the owner, and has no catch-all allow', () => {
    expect(rules).toContain('request.auth.uid == uid');
    expect(rules).not.toMatch(/allow[^;]*:\s*if\s+true/);
  });
});
