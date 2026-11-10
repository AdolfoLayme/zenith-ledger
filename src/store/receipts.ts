// Everything here lives in the browser's IndexedDB. Nothing is uploaded.
export interface Receipt { id?: number; sentAt: string; hash: string; fields: string[]; rowCount: number }

const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open('zenith-ledger', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
    req.result.createObjectStore('aliases', { keyPath: 'id' });
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
