// Runs against the Firebase emulators: `pnpm test:rules`. Without them these tests are skipped.
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, setDoc, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYLOAD_FIELDS } from '../core/payload';
import { parseVaultDoc, vaultId } from './receipt';

const emulators = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? 'x:0').split(':');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';

const valid = {
  sentAt: '2026-11-24T15:00:00.000Z', hash: 'cd'.repeat(32), fields: ['schema', 'totals', 'signals'], rowCount: 117,
  piiFound: 60, piiReplaced: 60, rawDescriptionsSent: 0,
};
const id = vaultId(valid);

describe.skipIf(!emulators)('firestore rules for the Receipt Vault', () => {
  const apps: FirebaseApp[] = [];
  let alice: { db: Firestore; uid: string };
  let bob: { db: Firestore; uid: string };
  let anon: { db: Firestore };

  const client = async (name: string, signIn: boolean) => {
    const app = initializeApp({ apiKey: 'fake', projectId: 'demo-zenith-ledger' }, name);
    apps.push(app);
    const db = getFirestore(app);
    connectFirestoreEmulator(db, host, Number(port));
    if (!signIn) return { db, uid: '' };
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    return { db, uid: (await signInAnonymously(auth)).user.uid };
  };
  const at = (c: { db: Firestore }, uid: string, docId = id) => doc(c.db, 'users', uid, 'receipts', docId);
  const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'permission-denied' });

  beforeAll(async () => {
    alice = await client('alice', true);
    bob = await client('bob', true);
    anon = await client('anon', false);
  });
  afterAll(async () => { await Promise.all(apps.map(deleteApp)); });

  it('lets a user store the receipt the client builds, and read it back', async () => {
    await setDoc(at(alice, alice.uid), parseVaultDoc(valid)!);
    const snap = await getDoc(at(alice, alice.uid));
    expect(snap.data()).toEqual(valid);
    expect((await getDocs(collection(alice.db, 'users', alice.uid, 'receipts'))).size).toBe(1);
  });

  it('accepts a receipt without counters', async () => {
    const { piiFound, piiReplaced, rawDescriptionsSent, ...old } = valid;
    void piiFound; void piiReplaced; void rawDescriptionsSent;
    const oldDoc = { ...old, sentAt: '2026-11-23T10:00:00.000Z' };
    await setDoc(at(alice, alice.uid, vaultId(oldDoc)), oldDoc);
  });

  it('keeps one user out of another user\'s vault', async () => {
    await denied(getDoc(at(bob, alice.uid)));
    await denied(getDocs(collection(bob.db, 'users', alice.uid, 'receipts')));
    await denied(setDoc(at(bob, alice.uid, `${id.slice(0, -1)}0`), valid));
    await denied(deleteDoc(at(bob, alice.uid)));
  });

  it('keeps signed-out visitors out', async () => {
    await denied(getDoc(at(anon, alice.uid)));
    await denied(setDoc(at(anon, alice.uid), valid));
  });

  describe('rejects anything that is not allowlisted metadata', () => {
    const attempt = (data: Record<string, unknown>, docId = id) => setDoc(at(alice, alice.uid, docId), data);
    it.each([
      ['an extra field holding raw text', { ...valid, description: 'ACME PLUMBING LLC' }],
      ['an extra field holding a nested map', { ...valid, rows: { a: { description: 'John Smith' } } }],
      ['a field name outside the payload', { ...valid, fields: ['schema', 'description'] }],
      ['a hash that is not a hex digest', { ...valid, hash: 'John Smith paid ACME on 2026-11-24' }],
      ['a hash of the wrong length', { ...valid, hash: 'cd'.repeat(16) }],
      ['text in place of a counter', { ...valid, piiFound: 'John Smith' }],
      ['a negative counter', { ...valid, rowCount: -5 }],
      ['a huge counter', { ...valid, rowCount: 5_000_000 }],
      ['a time that carries free text', { ...valid, sentAt: 'ACME PLUMBING LLC' }],
      ['fields as a plain string', { ...valid, fields: 'ACME PLUMBING LLC' }],
      ['too many field names', { ...valid, fields: [...PAYLOAD_FIELDS, 'schema'] }],
      ['a missing required field', (({ hash, ...rest }) => (void hash, rest))(valid)],
    ])('%s', async (_label, data) => { await denied(attempt(data)); });

    it('a document id that does not match the receipt', async () => { await denied(attempt(valid, 'John-Smith-ACME')); });
    it('an update of an existing receipt', async () => { await denied(attempt({ ...valid, rowCount: 1 })); });
  });

  it('only accepts documents under the user\'s own receipts path', async () => {
    await denied(setDoc(doc(alice.db, 'users', alice.uid, 'notes', 'x'), { text: 'hello' }));
    await denied(setDoc(doc(alice.db, 'receipts', id), valid));
  });

  it('lets the owner delete their own copy', async () => {
    await deleteDoc(at(alice, alice.uid));
    expect((await getDoc(at(alice, alice.uid))).exists()).toBe(false);
  });
});
