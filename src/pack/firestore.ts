import { getAuth, signInAnonymously } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, setDoc } from 'firebase/firestore';
import { DEMO_FAKE_AI, firebaseConfigured, getFirebase } from '../ai/firebase';
import {
  isPackExpired,
  memoryPackStore,
  parseAccountantPack,
  parsePackReply,
  type AccountantPackDoc,
  type PackReply,
  type PackStore,
} from './pack';

const localMemory = memoryPackStore();

/**
 * In Vite dev server mode (`pnpm e2e`), two isolated Playwright browser contexts share packs via `/__demo_packs`
 * on the local Vite server (same origin `http://127.0.0.1:5421`, zero external network requests).
 */
function httpDemoPackStore(): PackStore {
  return {
    async create(raw) {
      const clean = parseAccountantPack(raw);
      if (!clean) throw new Error('Refusing to upload a pack that failed allowlist validation.');
      if (isPackExpired(clean)) throw new Error('Refusing to upload an expired pack.');
      await localMemory.create(clean);
      try {
        const res = await fetch(`/__demo_packs/${encodeURIComponent(clean.packId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clean),
        });
        if (!res.ok && res.status !== 404) throw new Error(await res.text());
      } catch {
        // Fallback to in-process memory store when running outside Vite dev server
      }
    },
    async get(packId) {
      try {
        const res = await fetch(`/__demo_packs/${encodeURIComponent(packId)}`);
        if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
          const data = (await res.json()) as { pack?: unknown; replies?: unknown[] };
          const pack = parseAccountantPack(data.pack);
          if (!pack) return null;
          if (isPackExpired(pack)) throw new Error('This accountant review pack has expired.');
          const replies = (Array.isArray(data.replies) ? data.replies : [])
            .map(parsePackReply)
            .filter((r): r is PackReply => r !== null);
          return { pack, replies };
        }
      } catch (e) {
        if ((e as Error).message?.includes('expired')) throw e;
      }
      return localMemory.get(packId);
    },
    async reply(packId, rawReply) {
      const clean = parsePackReply(rawReply);
      if (!clean || clean.packId !== packId) throw new Error('Reply failed allowlist validation.');
      try {
        const res = await fetch(`/__demo_packs/${encodeURIComponent(packId)}/replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clean),
        });
        if (res.ok) return;
      } catch {
        // Fallback to in-process memory store
      }
      await localMemory.reply(packId, clean);
    },
  };
}

export async function openPackStore(): Promise<PackStore> {
  if (DEMO_FAKE_AI && import.meta.env.DEV) return httpDemoPackStore();
  if (!firebaseConfigured) {
    if (DEMO_FAKE_AI) return httpDemoPackStore();
    throw new Error('Firebase is not configured.');
  }
  const { app } = getFirebase();
  const db = getFirestore(app);

  return {
    async create(raw) {
      const clean = parseAccountantPack(raw);
      if (!clean) throw new Error('Refusing to upload a pack that failed allowlist validation.');
      if (isPackExpired(clean)) throw new Error('Refusing to upload an expired pack.');
      let uid: string | undefined;
      try {
        const auth = getAuth(app);
        const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
        uid = user.uid;
      } catch {
        // Anonymous auth provider may not be initialized yet in console; Firestore rules still validate the capability packId, allowlist and expiry
      }
      const payload: AccountantPackDoc = uid ? { ...clean, uid } : clean;
      await setDoc(doc(db, 'packs', clean.packId), payload);
    },
    async get(packId) {
      const snap = await getDoc(doc(db, 'packs', packId));
      if (!snap.exists()) return null;
      const pack = parseAccountantPack(snap.data());
      if (!pack) throw new Error('Stored pack did not pass allowlist validation.');
      if (isPackExpired(pack)) throw new Error('This accountant review pack has expired.');
      const replySnap = await getDocs(collection(db, 'packs', packId, 'replies'));
      const replies = replySnap.docs
        .map((d) => parsePackReply(d.data()))
        .filter((r): r is PackReply => r !== null);
      return { pack, replies };
    },
    async reply(packId, rawReply) {
      const clean = parsePackReply(rawReply);
      if (!clean || clean.packId !== packId) throw new Error('Reply failed allowlist validation.');
      await setDoc(doc(db, 'packs', packId, 'replies', clean.alertId), clean);
    },
  };
}
