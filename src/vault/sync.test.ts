import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearLocalData, listReceipts, saveReceipt, type Receipt } from '../store/receipts';
import { memoryVault } from './memory';
import { vaultId } from './receipt';
import { syncVault } from './sync';

const receipt = (n: number): Receipt => ({ sentAt: `2026-11-2${n}T10:00:00.000Z`, hash: String(n).repeat(64), fields: ['totals'], rowCount: n, piiFound: n, piiReplaced: n, rawDescriptionsSent: 0 });

describe('syncVault', () => {
  it('uploads receipts the vault lacks and brings back the ones this device lacks', async () => {
    await clearLocalData();
    const vault = memoryVault([receipt(2)]);
    await saveReceipt(receipt(1));

    const result = await syncVault(vault, await listReceipts());

    expect(result).toEqual({ uploaded: 1, restored: 1 });
    expect((await vault.list()).map(vaultId).sort()).toEqual([receipt(1), receipt(2)].map((r) => vaultId(r)).sort());
    expect((await listReceipts()).map((r) => r.rowCount).sort()).toEqual([1, 2]);
  });

  it('is idempotent: a second sync changes nothing', async () => {
    const vault = memoryVault();
    await syncVault(vault, await listReceipts());
    expect(await syncVault(vault, await listReceipts())).toEqual({ uploaded: 0, restored: 0 });
  });

  it('ignores vault documents that fail validation instead of importing them', async () => {
    await clearLocalData();
    const vault = memoryVault([{ sentAt: 'now', hash: 'nope', fields: ['description'], rowCount: 1, description: 'ACME' }]);
    expect(await syncVault(vault, [])).toEqual({ uploaded: 0, restored: 0 });
    expect(await listReceipts()).toEqual([]);
  });

  it('wipe removes the synced copy but keeps local receipts', async () => {
    await clearLocalData();
    const vault = memoryVault();
    await saveReceipt(receipt(3));
    await syncVault(vault, await listReceipts());
    await vault.wipe();
    expect(await vault.list()).toEqual([]);
    expect(await listReceipts()).toHaveLength(1);
  });
});
