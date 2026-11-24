import type { AlertDecision, EvidenceDossier } from '../core/dossier';

// Everything here lives in the browser's IndexedDB. Nothing is uploaded.
export interface Receipt {
  id?: number;
  sentAt: string;
  hash: string;
  fields: string[];
  rowCount: number;
  /** Counters shown in the Privacy Firewall at send time. Absent on receipts saved by older versions. */
  piiFound?: number;
  piiReplaced?: number;
  rawDescriptionsSent?: number;
}

const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open('zenith-ledger', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('aliases')) db.createObjectStore('aliases', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('decisions')) db.createObjectStore('decisions', { keyPath: 'alertId' });
    if (!db.objectStoreNames.contains('dossiers')) db.createObjectStore('dossiers', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function saveReceipt(r: Receipt): Promise<void> {
  const db = await open();
  await done(db.transaction('receipts', 'readwrite').objectStore('receipts').add(r));
  db.close();
}

export async function listReceipts(): Promise<Receipt[]> {
  const db = await open();
  const all = await done(db.transaction('receipts').objectStore('receipts').getAll() as IDBRequest<Receipt[]>);
  db.close();
  return all.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export async function saveAliasMap(id: string, map: Map<string, string>): Promise<void> {
  const db = await open();
  await done(db.transaction('aliases', 'readwrite').objectStore('aliases').put({ id, entries: [...map] }));
  db.close();
}

export async function loadAliasMap(id: string): Promise<Map<string, string> | null> {
  const db = await open();
  const row = await done(db.transaction('aliases').objectStore('aliases').get(id) as IDBRequest<{ entries: [string, string][] } | undefined>);
  db.close();
  return row ? new Map(row.entries) : null;
}

export async function saveDossiers(dossiers: EvidenceDossier[]): Promise<void> {
  const db = await open();
  const tx = db.transaction('dossiers', 'readwrite');
  const store = tx.objectStore('dossiers');
  await done(store.clear());
  await Promise.all(dossiers.map((d) => done(store.put(d))));
  db.close();
}

export async function listDossiers(): Promise<EvidenceDossier[]> {
  const db = await open();
  const all = await done(db.transaction('dossiers').objectStore('dossiers').getAll() as IDBRequest<EvidenceDossier[]>);
  db.close();
  return all;
}

export async function saveDecision(decision: AlertDecision): Promise<void> {
  const db = await open();
  await done(db.transaction('decisions', 'readwrite').objectStore('decisions').put(decision));
  db.close();
}

export async function getDecision(alertId: string): Promise<AlertDecision | null> {
  const db = await open();
  const row = await done(db.transaction('decisions').objectStore('decisions').get(alertId) as IDBRequest<AlertDecision | undefined>);
  db.close();
  return row ?? null;
}

export async function listDecisions(): Promise<AlertDecision[]> {
  const db = await open();
  const all = await done(db.transaction('decisions').objectStore('decisions').getAll() as IDBRequest<AlertDecision[]>);
  db.close();
  return all;
}

/** "Delete all": every receipt, stored alias map, evidence dossier and decision in this browser. */
export async function clearLocalData(): Promise<void> {
  const db = await open();
  const tx = db.transaction(['receipts', 'aliases', 'decisions', 'dossiers'], 'readwrite');
  await Promise.all([
    done(tx.objectStore('receipts').clear()),
    done(tx.objectStore('aliases').clear()),
    done(tx.objectStore('decisions').clear()),
    done(tx.objectStore('dossiers').clear()),
  ]);
  db.close();
}
