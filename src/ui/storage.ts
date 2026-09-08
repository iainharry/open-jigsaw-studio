/**
 * Local persistence: IndexedDB, no dependencies, no network.
 *
 * Images are stored once, keyed by the SHA-256 of their bytes, and puzzles reference
 * them. Making six puzzles from the same photograph therefore costs one copy of the
 * photograph, not six -- which also means a portable `.jigsaw` export later is a
 * manifest plus a referenced image rather than a fresh copy every time.
 */

import type { ImageEdit } from '../engine/imageEdit.js';

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

/**
 * One finish of a puzzle.
 *
 * The conditions are recorded beside the time because a time on its own is not
 * comparable with another: 500 pieces with rotation off and the ghost at 45% is a
 * different afternoon from 500 pieces unaided, and a history that hid that would flatter
 * the player rather than inform them.
 */
export interface Completion {
  finishedAt: number;
  elapsedMs: number;
  pieceCount: number;
  rotation: boolean;
  /** Any assistance switched on at the moment of finishing. */
  assists: string[];
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
  /** Small data-URL preview, so the library lists without decoding every full image. */
  thumbnail: string | null;
  /** Free text the player keeps with the puzzle. */
  notes?: string;
  /** 1..5, set by the player after playing. Null or absent when unrated. */
  difficulty?: number | null;
  /** Every time this puzzle has been finished, oldest first. */
  history?: Completion[];
  /**
   * How the stored image was prepared before cutting — crop, rotation, adjustments.
   *
   * Held as parameters rather than as a second copy of the picture, so the original stays
   * deduplicated by content hash and the preparation can be reopened and changed. Absent
   * or null on every puzzle made before preparation existed, and on any puzzle cut from
   * the picture as it came.
   */
  edit?: ImageEdit | null;
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

/**
 * Run one request and resolve when its **transaction commits**, not when the request
 * succeeds.
 *
 * These are not the same moment. A request fires `onsuccess` while its transaction is
 * still open, and the transaction can still abort afterwards — most importantly on a
 * quota error, when the browser rolls the whole thing back. Resolving on `onsuccess`
 * therefore reported a successful write for data that was never stored, which is exactly
 * how a puzzle ends up listed in the library with its picture missing.
 */
function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result: T | undefined;
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error ?? new Error('database request failed'));
        tx.onabort = () => {
          db.close();
          reject(
            tx.error ??
              new Error('the change was rolled back — the browser may be out of storage space'),
          );
        };
        tx.oncomplete = () => {
          db.close();
          resolve(result as T);
        };
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

/**
 * Every stored image hash. Used to tell, in one read, which library cards have lost
 * their picture — asking per card would be one transaction per puzzle.
 */
export async function storedImageHashes(): Promise<Set<string>> {
  const keys = await run<IDBValidKey[]>(IMAGES, 'readonly', (s) => s.getAllKeys());
  return new Set(keys.filter((k): k is string => typeof k === 'string'));
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

export async function deletePuzzle(id: string): Promise<void> {
  await run(PUZZLES, 'readwrite', (s) => s.delete(id));
  if (getLastOpened() === id) setLastOpened(null);
}

/**
 * Remove any stored image no puzzle refers to any more.
 *
 * Images are shared by content hash, so this cannot simply delete the image belonging to
 * a deleted puzzle -- another puzzle may have been made from the same photograph.
 */
export async function pruneOrphanImages(): Promise<number> {
  const puzzles = await listPuzzles();
  const inUse = new Set(puzzles.map((p) => p.imageHash));
  const hashes = await run<IDBValidKey[]>(IMAGES, 'readonly', (s) => s.getAllKeys());
  let removed = 0;
  for (const key of hashes) {
    if (typeof key === 'string' && !inUse.has(key)) {
      await run(IMAGES, 'readwrite', (s) => s.delete(key));
      removed++;
    }
  }
  return removed;
}

/** Small preview for the library, kept as a data URL so listing needs no image decode. */
export function makeThumbnail(image: CanvasImageSource, width: number, height: number): string {
  const target = 240;
  const scale = Math.min(1, target / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.7);
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
