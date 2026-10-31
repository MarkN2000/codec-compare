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
    this.protected = new Set(); this.pending = new Map(); this.writing = new Map();
    this.stats = { memoryHits: 0, storageHits: 0, misses: 0, readMs: 0, writeMs: 0, queueMs: 0, writes: 0, batches: 0, scans: 0, dropped: 0 };
    this.db = this.open();
  }
  key(blob, rate, seconds) {
    if (!this.ids.has(blob)) this.ids.set(blob, ++this.nextId);
    return `${this.prefix}:1024-v2:${this.ids.get(blob)}:${rate}:${seconds}`;
  }
  async open() {
    try {
      if (!globalThis.indexedDB) { this.failed = true; return null; }
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
      const oldest = [...this.memory.keys()].find(k => !this.protected.has(k)) ?? this.memory.keys().next().value;
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
    const waiting = this.pending.get(key) || this.writing.get(key);
    if (waiting) { this.stats.memoryHits++; return waiting.value; }
    if (!this.catalog?.has(key)) { this.stats.misses++; return null; }
    try {
      const begin = performance.now();
      const db = await this.db;
      const value = db && !this.failed ? await request(db.transaction('blocks').objectStore('blocks').get(key)) : null;
      this.stats.readMs = performance.now() - begin;
      if (value) { this.remember(key, value); this.stats.storageHits++; return value; }
    } catch { this.failed = true; }
    this.stats.misses++; return null;
  }
  put(key, value) {
    const bytes = this.remember(key, value);
    if (this.failed) return;
    this.pending.delete(key);
    this.pending.set(key, { key, value, bytes, time: Date.now(), queued: performance.now() });
    let waiting = [...this.pending.values()].reduce((n, e) => n + e.bytes, 0);
    while (this.pending.size > 16 || waiting > 2 * 1024 ** 2) {
      const oldest = [...this.pending.keys()].find(k => !this.protected.has(k)) ?? this.pending.keys().next().value;
      waiting -= this.pending.get(oldest).bytes; this.pending.delete(oldest); this.stats.dropped++;
    }
    if (!this.timer && !this.saving) this.timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        const db = await this.db;
        if (!db || this.failed) { this.pending.clear(); return; }
        while (this.pending.size && !this.failed) {
          const batch = [...this.pending.values()].slice(0, 4);
          for (const entry of batch) { this.pending.delete(entry.key); this.writing.set(entry.key, entry); }
          const begin = performance.now();
          await this.prune(db, batch.reduce((n, e) => n + e.bytes, 0));
          const tx = db.transaction(['blocks', 'metadata'], 'readwrite'), done = complete(tx);
          for (const entry of batch) {
            entry.time = Date.now();
            const { key, value, bytes, time } = entry;
            tx.objectStore('blocks').put(value, key); tx.objectStore('metadata').put({ key, bytes, time });
          }
          await done;
          for (const { key, bytes, time, queued } of batch) {
            this.diskBytes += bytes - (this.catalog.get(key)?.bytes || 0);
            this.catalog.delete(key); this.catalog.set(key, { key, bytes, time });
            this.stats.queueMs = Math.max(this.stats.queueMs, begin - queued);
          }
          this.writing.clear(); this.stats.writes += batch.length; this.stats.batches++;
          this.stats.writeMs = performance.now() - begin;
          if (this.pending.size) await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch { this.failed = true; this.pending.clear(); }
      finally {
        this.writing.clear(); this.saving = null;
        if (this.pending.size && !this.failed) this.timer = setTimeout(() => this.flush(), 50);
      }
    })();
    return this.saving;
  }
  async prune(db, reserve = 0, refresh = false) {
    if (refresh || !this.catalog || Date.now() - this.scannedAt >= 30000) {
      // ponytail: 他ページの増分反映は最大30秒遅れる。全ページの厳密な上限が必要なら共通ロックと容量カウンターへ置換する。
      const entries = await request(db.transaction('metadata').objectStore('metadata').getAll());
      entries.sort((a, b) => a.time - b.time);
      this.catalog = new Map(entries.map(e => [e.key, e]));
      this.diskBytes = entries.reduce((n, e) => n + e.bytes, 0); this.scannedAt = Date.now(); this.stats.scans++;
    }
    const expired = [];
    for (const entry of this.catalog.values()) {
      if (entry.time >= Date.now() - 86400000 && this.diskBytes + reserve <= STORAGE_LIMIT) break;
      expired.push(entry); this.diskBytes -= entry.bytes;
    }
    if (!expired.length) return;
    const tx = db.transaction(['blocks', 'metadata'], 'readwrite'), done = complete(tx);
    for (const { key } of expired) { tx.objectStore('blocks').delete(key); tx.objectStore('metadata').delete(key); }
    await done;
    for (const { key } of expired) this.catalog.delete(key);
  }
}
