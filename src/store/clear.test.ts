import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearLocalData, listReceipts, loadAliasMap, saveAliasMap, saveReceipt } from './receipts';

describe('delete all local data', () => {
  it('removes every receipt and every stored alias map', async () => {
    await saveReceipt({ sentAt: '2025-11-03T10:00:00Z', hash: 'c'.repeat(64), fields: ['totals'], rowCount: 5 });
    await saveAliasMap('s2', new Map([['Person_1', 'John Smith']]));
    await clearLocalData();
    expect(await listReceipts()).toEqual([]);
    expect(await loadAliasMap('s2')).toBeNull();
  });
});
