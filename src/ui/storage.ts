/**
 * Local persistence: IndexedDB, no dependencies, no network.
 *
 * Images are stored once, keyed by the SHA-256 of their bytes, and puzzles reference
 * them. Making six puzzles from the same photograph therefore costs one copy of the
 * photograph, not six -- which also means a portable `.jigsaw` export later is a
 * manifest plus a referenced image rather than a fresh copy every time.
 */

const DB_NAME = 'open-jigsaw-studio';
const DB_VERSION = 1;
const IMAGES = 'images';
const PUZZLES = 'puzzles';

export interface StoredImage {
  hash: string;
  blob: Blob;
  width: number;
  height: number;
  name: string;
  addedAt: number;
}

export interface PuzzleRecord {
  id: string;
  title: string;
  imageHash: string;
  /** Serialised `SavedPuzzle` from the engine. */
  saved: unknown;
  pieceCount: number;
  createdAt: number;
  lastPlayed: number;
  completedAt: number | null;
  progress: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'hash' });
      if (!db.objectStoreNames.contains(PUZZLES)) {
        const store = db.createObjectStore(PUZZLES, { keyPath: 'id' });
        store.createIndex('lastPlayed', 'lastPlayed');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open database'));
  });
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('database request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function putImage(image: StoredImage): Promise<void> {
  await run(IMAGES, 'readwrite', (s) => s.put(image));
}

export async function getImage(hash: string): Promise<StoredImage | undefined> {
  return run<StoredImage | undefined>(IMAGES, 'readonly', (s) => s.get(hash));
}

export async function putPuzzle(record: PuzzleRecord): Promise<void> {
  await run(PUZZLES, 'readwrite', (s) => s.put(record));
}

export async function getPuzzle(id: string): Promise<PuzzleRecord | undefined> {
  return run<PuzzleRecord | undefined>(PUZZLES, 'readonly', (s) => s.get(id));
}

export async function listPuzzles(): Promise<PuzzleRecord[]> {
  const all = await run<PuzzleRecord[]>(PUZZLES, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

/** Id of the puzzle to reopen on startup. Kept in localStorage: it is a UI preference. */
export function setLastOpened(id: string | null): void {
  try {
    if (id) localStorage.setItem('ojs:lastOpened', id);
    else localStorage.removeItem('ojs:lastOpened');
  } catch {
    /* private browsing, or storage disabled -- resume is a convenience, not a requirement */
  }
}

export function getLastOpened(): string | null {
  try {
    return localStorage.getItem('ojs:lastOpened');
  } catch {
    return null;
  }
}
