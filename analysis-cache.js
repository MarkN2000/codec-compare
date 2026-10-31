const MEMORY_LIMIT = 8 * 1024 ** 2, STORAGE_LIMIT = 128 * 1024 ** 2;
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = transaction.onerror = () => reject(transaction.error);
});

// 音声は保存しない。Blobの実体をページ内で識別し、別ファイル・再変換結果を混ぜない。
export class AnalysisCache {
  constructor() {
    this.prefix = crypto.getRandomValues(new Uint32Array(4)).join('-');
    this.ids = new WeakMap(); this.nextId = 0;
    this.memory = new Map(); this.bytes = 0;
    this.stats = { memoryHits: 0, storageHits: 0, misses: 0 };
    this.db = this.open();
  }
  key(blob, rate, seconds) {
    if (!this.ids.has(blob)) this.ids.set(blob, ++this.nextId);
    return `${this.prefix}:2048-v1:${this.ids.get(blob)}:${rate}:${seconds}`;
  }
  async open() {
    try {
      if (!globalThis.indexedDB) return null;
      const opening = indexedDB.open('kikikurabe-analysis', 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('blocks');
        opening.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      const db = await new Promise((resolve, reject) => {
        opening.onsuccess = () => { if (this.failed) opening.result.close(); else resolve(opening.result); };
        opening.onerror = () => reject(opening.error);
        opening.onblocked = () => { this.failed = true; reject(Error('分析キャッシュを開けません。')); };
      });
      db.onversionchange = () => { db.close(); this.failed = true; };
      await this.prune(db);
      return db;
    } catch { this.failed = true; return null; }
  }
  remember(key, value) {
    const bytes = Object.values(value).reduce((n, v) => n + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
    if (this.memory.has(key)) { this.bytes -= this.memory.get(key).bytes; this.memory.delete(key); }
    this.memory.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > MEMORY_LIMIT) {
      const oldest = this.memory.keys().next().value;
      this.bytes -= this.memory.get(oldest).bytes; this.memory.delete(oldest);
    }
    return bytes;
  }
  async get(key) {
    const item = this.memory.get(key);
    if (item) {
      this.memory.delete(key); this.memory.set(key, item);
      this.stats.memoryHits++; return item.value;
    }
    try {
      const db = await this.db;
      const value = db && !this.failed ? await request(db.transaction('blocks').objectStore('blocks').get(key)) : null;
      if (value) { this.remember(key, value); this.stats.storageHits++; return value; }
    } catch { this.failed = true; }
    this.stats.misses++; return null;
  }
  async put(key, value) {
    const bytes = this.remember(key, value);
    try {
      const db = await this.db;
      if (!db || this.failed) return;
      const tx = db.transaction(['blocks', 'metadata'], 'readwrite'), done = complete(tx);
      tx.objectStore('blocks').put(value, key);
      tx.objectStore('metadata').put({ key, bytes, time: Date.now() });
      await done; await this.prune(db);
    } catch { this.failed = true; }
  }
  async prune(db) {
    // ponytail: 128 MiBまでのメタデータのみを走査する。細かな区間が大量になる場合は時刻索引へ置き換える。
    const entries = await request(db.transaction('metadata').objectStore('metadata').getAll());
    entries.sort((a, b) => a.time - b.time);
    let bytes = entries.reduce((n, e) => n + e.bytes, 0);
    const expired = entries.filter(e => {
      if (e.time >= Date.now() - 86400000 && bytes <= STORAGE_LIMIT) return false;
      bytes -= e.bytes; return true;
    });
    if (!expired.length) return;
    const tx = db.transaction(['blocks', 'metadata'], 'readwrite'), done = complete(tx);
    for (const { key } of expired) { tx.objectStore('blocks').delete(key); tx.objectStore('metadata').delete(key); }
    await done;
  }
}
