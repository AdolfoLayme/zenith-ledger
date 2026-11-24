import { getAuth, signInAnonymously } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocs, getFirestore, setDoc } from 'firebase/firestore';
import { DEMO_FAKE_AI, firebaseConfigured, getFirebase } from '../ai/firebase';
import { memoryVault } from './memory';
import { parseVaultDoc, vaultId, type VaultDoc } from './receipt';
import type { ReceiptVault } from './sync';

const demoInstance = memoryVault();

/** Connects to the user's anonymous Firestore Receipt Vault (or in-memory stand-in in demo mode). */
export async function openReceiptVault(): Promise<ReceiptVault> {
  if (DEMO_FAKE_AI) return demoInstance;
  if (!firebaseConfigured) throw new Error('Firebase is not configured.');
  const { app } = getFirebase();
  const auth = getAuth(app);
  const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
  const db = getFirestore(app);
  const col = collection(db, 'users', user.uid, 'receipts');

  return {
    async list() {
      const snap = await getDocs(col);
      return snap.docs.map((d) => d.data() as VaultDoc);
    },
    async put(entry) {
      const clean = parseVaultDoc(entry);
      if (!clean) throw new Error('Refusing to upload a receipt that failed allowlist validation.');
      await setDoc(doc(col, vaultId(clean)), clean);
    },
    async wipe() {
      const snap = await getDocs(col);
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    },
  };
}
