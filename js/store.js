// IndexedDB storage. Points of a drive in progress are saved in small chunks as they arrive,
// so closing the page or losing signal never loses what was already recorded.
const DB = 'street-legal';
let dbp;

function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('drives', { keyPath: 'id' });
      d.createObjectStore('chunks', { keyPath: ['d', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const putDrive = drive => tx(['drives'], 'readwrite', t => { t.objectStore('drives').put(drive); });
export const getDrive = id => tx(['drives'], 'readonly', t => req2p(t.objectStore('drives').get(id)));
export const allDrives = () => tx(['drives'], 'readonly', t => req2p(t.objectStore('drives').getAll()));

export const deleteDrive = id => tx(['drives', 'chunks'], 'readwrite', t => {
  t.objectStore('drives').delete(id);
  t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
});

export const putChunk = (d, seq, points) => tx(['chunks'], 'readwrite', t => { t.objectStore('chunks').put({ d, seq, points }); });

export async function chunkPoints(id) {
  const chunks = await tx(['chunks'], 'readonly', t => req2p(t.objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))));
  chunks.sort((a, b) => a.seq - b.seq);
  return chunks.flatMap(c => c.points);
}

export const clearChunks = id => tx(['chunks'], 'readwrite', t => { t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity])); });

export async function wipe() {
  await tx(['drives', 'chunks'], 'readwrite', t => { t.objectStore('drives').clear(); t.objectStore('chunks').clear(); });
}

const SETTINGS_KEY = 'sl-settings';
const DEFAULT_SETTINGS = { name: '', trimShare: true, autoStopMin: 5 };
export function settings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
