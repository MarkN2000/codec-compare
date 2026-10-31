import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AnalysisCache } from '../analysis-cache.js';
import { spectrumFrames, spectrumSteps, compactFrames, FFT_SIZE } from '../analysis.js';
import { averageSpectrum, bandDifference } from '../graph.js';

test('1024 FFTは実行間隔を増やさず、小分けでも一致し、集計後のパワーを保つ', () => {
  assert.equal(FFT_SIZE, 1024);
  const rate = 48000, tone = Float32Array.from({ length: rate * 4 }, (_, i) => .5 * Math.sin(2 * Math.PI * 100 * i / FFT_SIZE));
  const raw = spectrumFrames([tone], rate), steps = spectrumSteps([tone], rate);
  let step, yields = 0;
  do { step = steps.next(); if (!step.done) yields++; } while (!step.done);
  assert.deepEqual(step.value, raw); assert.ok(yields > 10, '少数窓ずつ区切って再開できる');
  assert.ok(Math.abs(raw.times[1] - raw.times[0] - 2048 / rate) < 1e-7);
  const compact = compactFrames(raw);
  assert.equal(compact.times.length, 40); assert.equal(compact.bins, 513);
  assert.equal(compact.bands.length, 40 * 64);
  assert.ok(compact.powers.byteLength < raw.powers.byteLength / 2);
  assert.ok(Math.abs(averageSpectrum(compact, 2)[100] + 6.0206) < .001);
  const quiet = compactFrames(spectrumFrames([tone.map(v => v / 2)], rate));
  for (let i = 0; i < compact.bands.length; i++) {
    if (compact.bands[i] > 1e-9) assert.ok(Math.abs(bandDifference(compact.bands[i], quiet.bands[i]) + 6.0206) < .001);
  }
  assert.deepEqual(compact.times, quiet.times, '基準と比較の集計時刻を揃える');
  const short = compactFrames(spectrumFrames([new Float32Array(100)], rate));
  assert.equal(short.times.length, 1); assert.ok(short.powers.every(v => v === 0));
});

test('分析キャッシュは実体で識別し、保存・復元・期限・容量制限と保存不可を扱う', async () => {
  const previous = globalThis.indexedDB;
  const stores = new Map();
  let gets = 0, scans = 0, stall = false;
  const blocked = [];
  // IndexedDBの非同期要求・トランザクション完了を再現し、キャッシュの実処理を通す。
  const db = {
    createObjectStore: name => stores.set(name, new Map()),
    transaction() {
      const tx = { pending: 0, objectStore(name) {
        const map = stores.get(name);
        const operation = (run, writing = false) => {
          const req = {}; tx.pending++;
          const finish = () => {
            req.result = structuredClone(run()); req.onsuccess?.();
            if (--tx.pending === 0) queueMicrotask(() => tx.oncomplete?.());
          };
          if (stall && writing) blocked.push(finish); else queueMicrotask(finish);
          return req;
        };
        return { get: key => { gets++; return operation(() => map.get(key)); }, getAll: () => { scans++; return operation(() => [...map.values()]); },
          put: (value, key = value.key) => operation(() => map.set(key, structuredClone(value)) && key, true),
          delete: key => operation(() => { map.delete(key); }, true) };
      } }; return tx;
    }, close() {},
  };
  globalThis.indexedDB = { open() { const req = { result: db }; queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } };
  try {
    const cache = new AnalysisCache(); await cache.db;
    const blob = {}, value = { powers: new Float32Array([.25, 1]), bands: new Float32Array([.5]), rate: 48000, length: 100 };
    const key = cache.key(blob, 48000, 4);
    assert.match(key, /:1024-v2:/, '以前のFFT結果を再利用しない');
    assert.equal(key, cache.key(blob, 48000, 4));
    assert.notEqual(key, cache.key({}, 48000, 4)); assert.notEqual(key, cache.key(blob, 44100, 4));
    cache.put(key, value); assert.equal(await cache.get(key), value, '保存を待たずに計算結果を使う');
    const queries = gets;
    assert.equal(await cache.get('未生成'), null); assert.equal(gets, queries, '未保存の区間はディスク照会しない');
    await cache.flush();
    cache.memory.clear(); cache.bytes = 0;
    assert.deepEqual(await cache.get(key), value, 'ストレージから型付き配列を復元する');
    assert.equal(cache.stats.storageHits, 1);
    for (const [id, bytes, time] of [['expired', 10, Date.now() - 86400001], ['old', 90 * 1024 ** 2, Date.now() - 2], ['new', 90 * 1024 ** 2, Date.now()]]) {
      stores.get('blocks').set(id, value); stores.get('metadata').set(id, { key: id, bytes, time });
    }
    await cache.prune(db, 0, true);
    assert.equal(stores.get('blocks').has('expired'), false); assert.equal(stores.get('blocks').has('old'), false);
    assert.equal(stores.get('blocks').has('new'), true);
    assert.ok([...stores.get('metadata').values()].reduce((n, e) => n + e.bytes, 0) <= 128 * 1024 ** 2);
    const priorScans = scans, priorBatches = cache.stats.batches;
    for (let i = 0; i < 12; i++) cache.put(`まとめ${i}`, value);
    await cache.flush();
    assert.equal(scans, priorScans, '保存のたびに管理情報を全件走査しない');
    assert.equal(cache.stats.batches - priorBatches, 3, '12件を4件ずつ保存する');
    stall = true;
    cache.put('保存中', value);
    const saving = cache.flush(); await new Promise(setImmediate);
    cache.memory.clear(); cache.bytes = 0;
    assert.equal(await cache.get('保存中'), value, '保存中でも待たずに結果を使える');
    for (let i = 0; i < 50; i++) cache.put(`待ち${i}`, value);
    assert.ok(cache.pending.size <= 16); assert.ok(cache.stats.dropped > 0, '保存待ちを無制限に増やさない');
    const newer = { ...value, powers: new Float32Array([.5, .75]) };
    cache.put('保存中', newer);
    stall = false; for (const finish of blocked.splice(0)) queueMicrotask(finish);
    await saving;
    assert.deepEqual(stores.get('blocks').get('保存中'), newer, '保存中に更新されたキーは新しい結果を残す');
    assert.equal(cache.diskBytes, [...stores.get('metadata').values()].reduce((n, e) => n + e.bytes, 0), '更新で容量を二重計上しない');
    const large = { powers: new Float32Array(1024 ** 2) };
    cache.protected.add('近い区間'); cache.remember('近い区間', large);
    for (const k of ['first', 'second', 'third']) cache.remember(k, large);
    assert.equal(cache.memory.has('first'), false); assert.ok(cache.bytes <= 8 * 1024 ** 2);
    assert.equal(cache.memory.has('近い区間'), true, '遠い区間の生成で近い区間を追い出さない');
    globalThis.indexedDB = { open() { throw Error('保存できない環境'); } };
    const fallback = new AnalysisCache(); await fallback.put('x', value);
    assert.equal(await fallback.get('x'), value); assert.equal(await fallback.get('missing'), null);
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

test('グラフ復号はまとめ処理と再利用を行い、遅い実測でも通常の先読みで再開できる', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8'), calls = [];
  let clock = 0, pending = null;
  const instance = { source: {}, analysisChunk: () => null, totalFrames: 48000 * 300, rate: 48000,
    revision: 1, context: {}, playing: false, canEncode: true, frame: 0, cache: [], target: { key: 'selected' } };
  const context = vm.createContext({
    source: instance.source, player: instance, encoder: null, encoding: false, graphBusy: false, graphDecoder: null,
    graphChunks: [], graphDecodeCost: 0, patterns: [], graph: { stats: { decodes: 0 } }, performance: { now: () => clock },
    Engine: class {
      decode(source, target, start, frames) { calls.push({ start, frames }); clock += 6500; return pending || {}; }
      terminate() { this.closed = true; }
    },
  });
  vm.runInContext(app.slice(app.indexOf('function releaseGraphDecoder('), app.indexOf('function message(')), context);
  const target = { key: 'selected', blob: {} }, reference = { key: 'reference', blob: {} };
  const first = await context.readGraphChunk(instance, target, 0, 192000);
  assert.equal(first.end, 48000 * 16);
  assert.equal(context.graphDecodeCost, 1625, '16秒分の実測を4秒相当へ換算する');
  assert.equal(context.graph.stats.decodeMs, 6500, '診断には実際の所要時間を残す');
  const engine = context.graphDecoder;
  context.releaseGraphDecoder();
  assert.equal(context.graphDecoder, engine, '仕事をしていないWorkerは再起動しない');
  assert.equal(await context.readGraphChunk(instance, target, 48000 * 4, 192000), first);
  assert.equal(calls.length, 1, '4秒ごとに復号し直さない');
  await context.readGraphChunk(instance, reference, 0, 192000);
  await context.readGraphChunk(instance, target, 48000 * 16, 192000);
  await context.readGraphChunk(instance, target, 48000 * 32, 192000);
  assert.equal(instance.cache[0], first, '先行生成で現在位置の再生PCMを追い出さない');
  assert.ok(context.graphChunks.length <= 2); assert.ok(instance.cache.length <= 2);
  instance.playing = true;
  for (const [ahead, cost, start] of [[4, 6500, 60], [5, 30000, 80]]) {
    instance.ahead = ahead; context.graphDecodeCost = cost;
    assert.ok(await context.readGraphChunk(instance, reference, 48000 * start, 192000));
    assert.equal(calls.at(-1).frames, 192000, '以前の遅い実測が先読み上限を超える待機条件にならない');
  }
  instance.ahead = 6.5; context.graphDecodeCost = 500;
  await context.readGraphChunk(instance, reference, 48000 * 100, 192000);
  assert.equal(calls.at(-1).frames, 384000, '通常の先読み上限8秒以内でも8秒をまとめる');
  instance.ahead = 7; context.graphDecodeCost = 30000;
  await context.readGraphChunk(instance, reference, 48000 * 120, 192000);
  assert.equal(calls.at(-1).frames, 384000, '遅い実測でもバッチ条件を到達可能に保つ');
  instance.ahead = 3.99;
  const before = calls.length;
  assert.equal(await context.readGraphChunk(instance, reference, 48000 * 140, 192000), null);
  assert.equal(calls.length, before, '先読み4秒未満では追加復号を待つ');
  instance.scheduledEnd = instance.totalFrames;
  assert.ok(await context.readGraphChunk(instance, reference, 48000 * 140, 192000), '末尾まで音声を予約済みなら待たない');
  instance.scheduledEnd = 0; instance.ahead = 5;
  const cost = context.graphDecodeCost;
  let finish;
  pending = new Promise(resolve => { finish = resolve; });
  const canceled = context.readGraphChunk(instance, reference, 48000 * 160, 192000);
  assert.equal(context.graphBusy, true);
  clock += 30000; context.releaseGraphDecoder();
  assert.equal(engine.closed, true);
  finish({});
  assert.equal(await canceled, null);
  assert.equal(context.graphDecodeCost, cost, '中断した経過時間を処理コストに混ぜない');
  assert.ok(context.graphChunks.length > 0, '完了済みPCMは中断時も残す');
  context.releaseGraphDecoder(true);
  assert.equal(context.graphChunks.length, 0);
  pending = null;
  await context.readGraphChunk(instance, reference, 48000 * 180, 192000);
  const idle = context.graphDecoder;
  context.releaseGraphDecoder(true);
  assert.equal(idle.closed, true, '折りたたみや変換開始では空きWorkerも解放する');
  assert.equal(context.graphDecoder, null);
  instance.scheduledEnd = 48000 * 8; instance.ahead = 5;
  assert.equal(await context.readGraphChunk(instance, target, 48000 * 8, 192000), null, '余裕がなければ将来区間の追加復号をしない');
  instance.ahead = 7;
  instance.busy = true;
  assert.equal(await context.readGraphChunk(instance, target, 48000 * 8, 192000), null, '再生側が復号中なら将来区間を重ねて復号しない');
  instance.busy = false;
  assert.equal(await context.readGraphChunk(instance, target, 48000 * 4, 192000), null, '予約済み区間は再生PCMを待ち、二重復号しない');
  const future = await context.readGraphChunk(instance, target, 48000 * 8, 192000);
  assert.equal(future.end, 48000 * 16, '余裕があるときだけ将来の8秒を準備する');
  const count = calls.length;
  assert.equal(await context.readGraphChunk(instance, target, 48000 * 12, 192000), future);
  assert.equal(calls.length, count);
});

test('FFT Workerは時間でまとめ、休止・再開しても計算結果を変えない', async () => {
  const text = await readFile(new URL('../analysis.js', import.meta.url), 'utf8');
  let clock = 0, stopped = false, result;
  const waits = [], Scope = class {};
  const self = new Scope(); self.postMessage = data => { result = data; };
  const scope = vm.createContext({ WorkerGlobalScope: Scope, self, Float32Array, Float64Array, Uint16Array,
    performance: { now: () => ++clock }, setTimeout(fn, ms) {
      waits.push(ms);
      if (ms === 0 && !stopped) { stopped = true; self.onmessage({ data: { paused: true } }); }
      else if (ms === 20) self.onmessage({ data: { paused: false } });
      queueMicrotask(fn);
    } });
  vm.runInContext(text.replaceAll('export ', ''), scope);
  const channels = [Float32Array.from({ length: 48000 * 4 }, (_, i) => Math.sin(i * .05) * .25)];
  await self.onmessage({ data: { channels: [channels], rate: 48000 } });
  const expected = compactFrames(spectrumFrames(channels, 48000));
  for (const field of ['powers', 'bands', 'times', 'weights']) assert.deepEqual(result.results[0][field], expected[field]);
  assert.ok(waits.includes(20), '途中休止を受け付ける');
  assert.ok(waits.filter(ms => ms === 0).length <= 4, '固定4窓ごとの待機に戻らない');
});
