import { LIMITS } from './model.js';

let entries = [], directory;
const prefix = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
let nextId = 0;
async function storage() {
  if (!directory) directory = (async () => {
    // ページが生きている間は名前のロックを持ち、別ページの期限整理から保護する。
    if (navigator.locks) await new Promise((resolve, reject) => {
      navigator.locks.request(`kikikurabe-pcm:${prefix}`, () => { resolve(); return new Promise(() => {}); }).catch(reject);
    });
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('kikikurabe-pcm', { create: true });
    const held = navigator.locks ? (await navigator.locks.query()).held : null;
    for await (const [name] of dir.entries()) {
      const owner = `kikikurabe-pcm:${name.slice(0, name.lastIndexOf('-'))}`;
      if (held && /^\d+-[\d-]+\.wav$/.test(name) && Number(name.split('-')[0]) < Date.now() - 86400000 && !held.some(lock => lock.name === owner)) await dir.removeEntry(name).catch(() => {});
    }
    return dir;
  })();
  return directory;
}

// 圧縮ファイルと基準条件が同じ場合だけ共有し、PCM本体はFileとして区間参照する。
export async function storedPCM(blob, key, bytes, write) {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  const cached = entries.find(e => e.blob === blob && e.key === key);
  if (cached) return cached.promise;
  const entry = { blob, key, bytes: 0, name: `${prefix}-${++nextId}.wav` };
  const allowed = Number.isSafeInteger(bytes) && bytes > 44 && bytes <= LIMITS.output && entries.reduce((n, e) => n + e.bytes, 0) + bytes <= LIMITS.total;
  entries.push(entry);
  entry.promise = (async () => {
    if (!allowed) return null;
    entry.bytes = bytes;
    let dir;
    try {
      dir = await storage();
      const handle = await dir.getFileHandle(entry.name, { create: true });
      entry.dir = dir;
      await write(handle);
      const file = await handle.getFile();
      if (file.size < 44 || file.size > bytes) throw Error('一時PCMのサイズが不正です。');
      return file;
    } catch (error) {
      entry.bytes = 0;
      await dir?.removeEntry(entry.name).catch(() => {});
      console.warn('一時PCMを保存できないため、従来の区間復号を使用します。', error);
      return null;
    }
  })();
  return entry.promise;
}

export async function clearPCM(blob) {
  const removed = entries.filter(e => blob === undefined || e.blob === blob);
  entries = entries.filter(e => blob !== undefined && e.blob !== blob);
  await Promise.allSettled(removed.map(async entry => {
    await entry.promise;
    if (entry.dir) await entry.dir.removeEntry(entry.name);
  }));
}
