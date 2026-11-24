import { saveReceipt, type Receipt } from '../store/receipts';
import { parseVaultDoc, vaultId, type VaultDoc } from './receipt';

export interface ReceiptVault {
  list(): Promise<VaultDoc[]>;
  put(doc: VaultDoc): Promise<void>;
  wipe(): Promise<void>;
}

/** Two-way sync of validated receipt metadata between IndexedDB and the Receipt Vault. */
export async function syncVault(vault: ReceiptVault, local: Receipt[]): Promise<{ uploaded: number; restored: number }> {
  const remoteById = new Map<string, VaultDoc>();
  for (const raw of await vault.list()) {
    const doc = parseVaultDoc(raw);
    if (doc) remoteById.set(vaultId(doc), doc);
  }

  const localById = new Map<string, VaultDoc>();
  for (const r of local) {
    const doc = parseVaultDoc(r);
    if (doc) localById.set(vaultId(doc), doc);
  }

  let uploaded = 0;
  for (const [id, doc] of localById) {
    if (!remoteById.has(id)) {
      await vault.put(doc);
      uploaded++;
    }
  }

  let restored = 0;
  for (const [id, doc] of remoteById) {
    if (!localById.has(id)) {
      await saveReceipt(doc);
      restored++;
    }
  }

  return { uploaded, restored };
}
