(() => {
  'use strict';

  const DB_NAME = 'tme-media-staging';
  const STORE = 'assets';
  const LIFETIME_MS = 24 * 60 * 60 * 1000;
  let opening;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE).createIndex('expires', 'expires');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const cursor = store.index('expires').openKeyCursor(IDBKeyRange.upperBound(Date.now()));
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          store.delete(cursor.result.primaryKey);
          cursor.result.continue();
        };
        resolve(db);
      };
    });
    return opening;
  }

  async function get(url) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(url);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.expires > Date.now() ? request.result : null);
    });
  }

  async function put(url, asset) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...asset, expires: Date.now() + LIFETIME_MS }, url);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }

  globalThis.TMEMediaCache = { get, put };
})();
