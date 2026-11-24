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

  describe('Accountant Review Pack rules (/packs/{packId})', () => {
    const nowMs = Date.now();
    const packHash = 'ab'.repeat(32);
    const packId = `${nowMs}-${packHash.slice(0, 16)}`;
    const validPackDoc = {
      schema: 'zenith-ledger/accountant-pack@1',
      packId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
      expiresAtMs: nowMs + 3600_000,
      currency: 'USD',
      periodFrom: '2025-07-01',
      periodTo: '2025-09-30',
      totalStatementRows: 117,
      selectedAlertCount: 1,
      selectedRowCount: 2,
      hash: packHash,
      items: [
        {
          alertId: 'anomaly:duplicate:Vendor_C:-18420:2025-08-10:2025-08-11',
          kind: 'anomaly',
          type: 'duplicate',
          severity: 'high',
          vendorAlias: 'Vendor_C',
          category: 'Supplies',
          title: 'Possible duplicate · Vendor_C',
          proof: 'Vendor_C charged -$184.20 twice within 1 day(s)',
          ruleName: 'Duplicate charge within window',
          thresholdSummary: 'duplicateWindowDays <= 3 days',
          computedSummary: 'Repeated amount: -$184.20 · Interval: 1 day(s)',
          question: 'Did Vendor_C issue a credit memo?',
          rows: [
            {
              line: 41,
              date: '2025-08-10',
              vendorAlias: 'Vendor_C',
              category: 'Supplies',
              amountCents: -18420,
              balanceCents: 120410,
            },
            {
              line: 42,
              date: '2025-08-11',
              vendorAlias: 'Vendor_C',
              category: 'Supplies',
              amountCents: -18420,
              balanceCents: 101990,
            },
          ],
        },
      ],
    };

    it('lets a client create a valid pack and an unauthenticated accountant read it and post a reply', async () => {
      await setDoc(doc(alice.db, 'packs', packId), { ...validPackDoc, uid: alice.uid });
      // Unauthenticated accountant reads the pack via the capability link
      const snap = await getDoc(doc(anon.db, 'packs', packId));
      expect(snap.exists()).toBe(true);
      expect(snap.data()?.selectedRowCount).toBe(2);

      // Accountant posts a reply with aliases only, without needing an account
      const alertId = validPackDoc.items[0].alertId;
      const replyDoc = {
        alertId,
        packId,
        reply: 'Keep the second Vendor_C charge in disputed receivables until refunded.',
        repliedAt: new Date(nowMs + 60_000).toISOString(),
        author: 'Accountant',
      };
      await setDoc(doc(anon.db, 'packs', packId, 'replies', alertId), replyDoc);

      const replies = await getDocs(collection(alice.db, 'packs', packId, 'replies'));
      expect(replies.size).toBe(1);
      expect(replies.docs[0].data().reply).toContain('Vendor_C');
    });

    it('forbids listing all packs without knowing a packId', async () => {
      await denied(getDocs(collection(anon.db, 'packs')));
    });

    it('rejects a pack with raw descriptions, extra fields, real vendor names, or an already-expired timestamp', async () => {
      const badId = (n: number) => `${nowMs + n}-${packHash.slice(0, 16)}`;
      // Extra top-level raw field
      await denied(
        setDoc(doc(alice.db, 'packs', badId(1)), {
          ...validPackDoc,
          packId: badId(1),
          rawDescriptions: ['POS DEBIT DELTA OFFICE DEPOT'],
        }),
      );
      // Raw description inside a row
      await denied(
        setDoc(doc(alice.db, 'packs', badId(2)), {
          ...validPackDoc,
          packId: badId(2),
          items: [
            {
              ...validPackDoc.items[0],
              rows: [{ ...validPackDoc.items[0].rows[0], description: 'POS DEBIT DELTA OFFICE DEPOT' }],
            },
          ],
        }),
      );
      // Real vendor name instead of Vendor_X alias
      await denied(
        setDoc(doc(alice.db, 'packs', badId(3)), {
          ...validPackDoc,
          packId: badId(3),
          items: [{ ...validPackDoc.items[0], vendorAlias: 'DELTA OFFICE DEPOT' }],
        }),
      );
      // Expired pack (expiresAtMs in the past)
      await denied(
        setDoc(doc(alice.db, 'packs', badId(4)), {
          ...validPackDoc,
          packId: badId(4),
          expiresAtMs: nowMs - 60_000,
        }),
      );
      // Forged uid from another user
      await denied(
        setDoc(doc(alice.db, 'packs', badId(5)), {
          ...validPackDoc,
          packId: badId(5),
          uid: bob.uid,
        }),
      );
    });

    it('rejects replies with extra fields', async () => {
      const alertId = validPackDoc.items[0].alertId;
      await denied(
        setDoc(doc(anon.db, 'packs', packId, 'replies', alertId), {
          alertId,
          packId,
          reply: 'Looks fine.',
          repliedAt: new Date(nowMs + 120_000).toISOString(),
          author: 'Accountant',
          rawVendor: 'DELTA OFFICE DEPOT',
        }),
      );
    });
  });
});
