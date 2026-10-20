// Persists user-chosen directory handles (per viewer, per origin). Handles are structured-cloneable in Chromium.
export const FOLDER_DB = Object.freeze({ name: 'network-log-lab-explorer', store: 'folders', version: 1 });

const promised = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

export async function openFolderStore({ indexedDB = globalThis.indexedDB, name = FOLDER_DB.name } = {}) {
  if (!indexedDB) throw new Error('IndexedDB unavailable');
  const request = indexedDB.open(name, FOLDER_DB.version);
  request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(FOLDER_DB.store)) request.result.createObjectStore(FOLDER_DB.store, { keyPath: 'id' }); };
  const db = await promised(request);
  const run = (mode, action) => new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_DB.store, mode), result = action(tx.objectStore(FOLDER_DB.store));
    tx.oncomplete = () => resolve(result.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Folder store transaction aborted'));
  });
  return {
    async list() { return (await run('readonly', store => store.getAll())).sort((a, b) => a.added - b.added); },
    put(record) { return run('readwrite', store => store.put({ id: record.id, name: record.name, handle: record.handle, added: record.added })); },
    delete(id) { return run('readwrite', store => store.delete(id)); },
    close() { db.close(); },
  };
}

// Same contract without durability; used when IndexedDB is blocked (private windows, policies, tests).
export function memoryFolderStore() {
  const records = new Map();
  return { async list() { return [...records.values()].sort((a, b) => a.added - b.added); }, async put(record) { records.set(record.id, { ...record }); }, async delete(id) { records.delete(id); }, close() {} };
}
