/**
 * Automatic backup into a folder you choose once.
 *
 * This is the answer to "can it save to Google Drive or OneDrive" and it deliberately
 * does not touch either company's API. Point the app at your OneDrive or Google Drive
 * folder and it writes a `.jigsaw` file there whenever a puzzle is saved; the desktop
 * sync client you already run does the uploading. No OAuth, no account, no API keys, no
 * server, nothing to re-verify every year — and the offline-first promise stays intact,
 * because writing to a local folder works with the network unplugged.
 *
 * The honest limits:
 *
 * - **Desktop Chromium only.** The File System Access API is Chrome, Edge and Opera on
 *   desktop; no mobile browser implements it, and Firefox has declined to. On a tablet
 *   the fallback is exporting and importing `.jigsaw` files by hand.
 * - **It is file sync, not merge.** Two devices editing the same puzzle produce whatever
 *   the sync client does with a conflict — usually a second copy — and one version wins.
 *   For one person on one device at a time it is exactly right; it is not a substitute
 *   for real multi-device sync, and it is not sold as one.
 * - **Permission is not permanent.** Browsers drop the grant between sessions, so the
 *   handle is stored and re-permissioned on demand rather than assumed.
 */

const DB_NAME = 'open-jigsaw-studio-handles';
const STORE = 'handles';
const KEY = 'backupFolder';

type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
};

export function backupSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the handle store'));
  });
}

function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('handle store request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export async function getStoredFolder(): Promise<DirectoryHandle | null> {
  if (!backupSupported()) return null;
  try {
    return (await idb<DirectoryHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

/** Ask for a folder. Returns null if the user cancels. */
export async function chooseFolder(): Promise<DirectoryHandle | null> {
  if (!backupSupported()) return null;
  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker: (o: { mode: string; id: string }) => Promise<DirectoryHandle>;
      }
    ).showDirectoryPicker;
    const handle = await picker({ mode: 'readwrite', id: 'ojs-backup' });
    await idb('readwrite', (s) => s.put(handle, KEY));
    return handle;
  } catch {
    // Cancelling the picker throws; that is not an error worth reporting.
    return null;
  }
}

export async function forgetFolder(): Promise<void> {
  try {
    await idb('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing stored */
  }
}

/**
 * Check we may still write there.
 *
 * `prompt: false` first, because a browser will only show the permission dialog during a
 * user gesture — asking during a background autosave would silently fail and look like a
 * bug. The caller re-prompts from a real click when this returns 'prompt'.
 */
export async function folderPermission(
  handle: DirectoryHandle,
  request = false,
): Promise<PermissionState> {
  const options = { mode: 'readwrite' } as const;
  try {
    const current = (await handle.queryPermission?.(options)) ?? 'granted';
    if (current === 'granted' || !request) return current;
    return (await handle.requestPermission?.(options)) ?? 'denied';
  } catch {
    return 'denied';
  }
}

export async function writeBackup(
  handle: DirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const file = await handle.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}
