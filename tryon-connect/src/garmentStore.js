// Conservation des articles importés dans IndexedDB (stockage local du navigateur).
// Rien n'est envoyé : les images restent sur cet ordinateur.
// Chaque fonction peut échouer (navigation privée, quota…) : l'appelant
// doit utiliser try/catch, l'article reste alors utilisable pour la session.

const DB_NAME = "tryon-connect";
const DB_VERSION = 1;
const STORE = "garments";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB indisponible"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // En cas d'échec, on pourra réessayer plus tard
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = fn(store);
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

// record = { id, name, anchors, fit, tolerance, hadAlpha, warning,
//            original: Blob, processed: Blob, createdAt }
export function saveGarment(record) {
  return run("readwrite", (s) => s.put(record));
}

export function loadGarments() {
  return run("readonly", (s) => s.getAll()).then((list) =>
    (list ?? []).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  );
}

export function deleteGarment(id) {
  return run("readwrite", (s) => s.delete(id));
}
