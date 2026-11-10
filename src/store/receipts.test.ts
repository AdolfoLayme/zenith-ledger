import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { listReceipts, saveReceipt, saveAliasMap, loadAliasMap } from './receipts';

describe('data receipts', () => {
  it('stores and lists receipts, newest first', async () => {
    await saveReceipt({ sentAt: '2025-11-01T10:00:00Z', hash: 'a'.repeat(64), fields: ['totals'], rowCount: 3 });
    await saveReceipt({ sentAt: '2025-11-02T10:00:00Z', hash: 'b'.repeat(64), fields: ['totals'], rowCount: 4 });
    const all = await listReceipts();
    expect(all.map((r) => r.hash[0])).toEqual(['b', 'a']);
  });
  it('keeps the alias map locally', async () => {
    await saveAliasMap('s1', new Map([['Vendor_A', 'Acme']]));
    expect((await loadAliasMap('s1'))?.get('Vendor_A')).toBe('Acme');
  });
});
