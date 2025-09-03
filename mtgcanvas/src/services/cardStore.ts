// IndexedDB store for imported Scryfall cards so they persist across reloads (scales beyond localStorage limits).
import type { Card } from "../types/card";

const DB_NAME = "mtgCanvas";
const DB_VERSION = 1;
const STORE = "imported_cards";

let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Use Scryfall card id (string) as keyPath
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onerror = () => reject(req.error!);
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

export async function addImportedCards(cards: Card[]): Promise<void> {
  if (!cards || !cards.length) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      cards.forEach((c) => {
        if (c && c.id) store.put(c);
      });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error!);
    });
  } catch {
    /* ignore */
  }
}

export async function getAllImportedCards(): Promise<Card[]> {
  try {
    const db = await openDB();
    return await new Promise<any[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error!);
    });
  } catch {
    return [];
  }
}

export async function clearImportedCards(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error!);
    });
  } catch {
    /* ignore */
  }
}
