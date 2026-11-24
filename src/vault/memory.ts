import { vaultId, type VaultDoc } from './receipt';
import type { ReceiptVault } from './sync';

/** In-memory Receipt Vault used by unit tests and demo mode. */
export function memoryVault(seed: unknown[] = []): ReceiptVault {
  const docs = new Map<string, VaultDoc>();
  for (const [i, item] of seed.entries()) {
    const d = item as VaultDoc;
    const key = typeof d?.sentAt === 'string' && typeof d?.hash === 'string' ? vaultId(d) : `invalid-${i}`;
    docs.set(key, d);
  }
  return {
    async list() {
      return [...docs.values()];
    },
    async put(doc) {
      docs.set(vaultId(doc), doc);
    },
    async wipe() {
      docs.clear();
    },
  };
}
