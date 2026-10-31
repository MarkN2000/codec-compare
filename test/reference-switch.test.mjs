import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Player } from '../audio.js';
import { commonFilter } from '../model.js';

test('基準への切り替えは境界の前後で再試行せず、戻るときも準備済みPCMを使う', async () => {
  const settle = () => new Promise(setImmediate);
  for (const [position, cost, prepared, roundtrip, expectedCalls] of [
    [101, .6, false, false, 1], [103.7, .6, false, false, 1],
    [103.7, .6, true, false, 0], [104.05, 0, false, false, 1], [101, .6, false, true, 0],
  ]) {
    let now = 0, measuring = false, calls = 0;
    const requests = [];
    const context = { sampleRate: 48000, get currentTime() { return now; }, destination: {}, resume: async () => {}, close() {},
      createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
      createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }) };
    const player = new Player(() => {}, error => { throw error; }); clearInterval(player.timer);
    try {
      player.setSource({ rate: 44100, channels: 2, duration: 180, file: {} }); player.context = context;
      const opus = { id: 'opus', blob: {}, config: { codec: 'opus', rate: 48000, channels: 2 } };
      player.engine.decode = async (_, target, start, frames) => {
        if (measuring && target.reference) { calls++; now += cost * frames / (4 * 48000); requests.push([start, frames]); }
        return {};
      };
      if (!roundtrip) player.select(opus);
      player.seek(position); await player.play(); await settle(); now = player.anchorTime;
      if (roundtrip) { player.select(opus); await settle(); assert.equal(player.referenceCache.length, 2); }
      player.readPrepared = (target, start, frames) => prepared && target.reference && start >= 100 * 48000 && start + frames <= 108 * 48000
        ? { start: 100 * 48000, end: 108 * 48000, buffer: {} } : null;
      measuring = true;
      const oldTime = player.anchorTime, oldFrame = player.anchorFrame;
      player.select(null); await settle();
      assert.equal(calls, expectedCalls, `${position}秒からの切替で余分に復号しない`);
      assert.equal(player.target.reference, true, '次のpumpでの再試行を待たずに切り替わる');
      assert.equal(player.requested, null);
      assert.equal(player.anchorFrame, oldFrame + Math.round((player.anchorTime - oldTime) * 48000), '切り替え位置を進んだ時計へ正確に合わせる');
      assert.ok(player.referenceCache.length <= 2);
      if (position === 103.7 && !prepared) assert.deepEqual(requests, [[100 * 48000, 8 * 48000]], '境界直前は次の区間も含めて一度で準備する');
      if (position === 104.05) assert.equal(requests[0][0], 104 * 48000, '100 msの巻き戻しで古い区間へ戻らない');
      player.seek(40); assert.equal(player.referenceCache.length, 0, 'シーク後は基準の保持範囲もリセットする');
    } finally { player.dispose(); }
  }
});

test('グラフの先行生成が現在位置の基準PCMを追い出さず、保持数と長い区間を保つ', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const instance = { source: {}, rate: 48000, totalFrames: 180 * 48000, revision: 1, context: {}, playing: true,
    canEncode: true, frame: 103 * 48000, ahead: 7, scheduledEnd: 112 * 48000, target: { key: 'opus' },
    cache: [], referenceCache: [], analysisChunk: () => null, keepReference: Player.prototype.keepReference };
  const context = vm.createContext({ source: instance.source, player: instance, encoder: null, encoding: false,
    graphBusy: false, graphDecoder: null, graphChunks: [], graphDecodeCost: 0, patterns: [],
    graph: { stats: { decodes: 0 } }, performance, Engine: class { async decode() { return {}; } terminate() {} } });
  vm.runInContext(app.slice(app.indexOf('function releaseGraphDecoder('), app.indexOf('function message(')), context);
  const target = { key: 'reference', reference: true, blob: {} };
  const current = await context.readGraphChunk(instance, target, 100 * 48000, 4 * 48000);
  for (const start of [108, 116, 124]) await context.readGraphChunk(instance, target, start * 48000, 4 * 48000);
  assert.equal(instance.referenceCache.length, 2);
  assert.equal(Player.prototype.analysisChunk.call(instance, target, 100 * 48000, 4 * 48000), current, '先読み後も再生へ現在位置のPCMを渡せる');
  instance.keepReference({ ...current, end: 104 * 48000, buffer: {} });
  assert.equal(instance.referenceCache[0], current, '遅れて届いた短い区間で長い準備済み区間を置き換えない');
  instance.frame = 109 * 48000;
  await context.readGraphChunk(instance, target, 116 * 48000, 4 * 48000);
  assert.ok(instance.referenceCache.every(c => c.end > instance.frame));
  assert.ok(instance.referenceCache.length <= 2);
});

test('整数PCMとFLACの安全な条件だけ量子化を省き、実WASMの全サンプルを維持する', async () => {
  const base = { rate: 44100, channels: 2, originalChannels: 2, codec: 'pcm_s16le', bits: 16, layout: 'stereo' };
  for (const codec of ['pcm_u8', 'pcm_s8', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be']) assert.ok(!commonFilter({ ...base, codec }).includes('aeval'));
  for (const source of [
    { ...base, codec: 'pcm_f32le' }, { ...base, codec: 'pcm_s32le' }, { ...base, codec: 'mp3' },
    { ...base, codec: 'flac', bits: 32 }, { ...base, codec: 'flac', bits: null },
    { ...base, originalChannels: 6 }, { ...base, originalChannels: undefined }, { ...base, layout: '2 channels (FC+LFE)' },
  ]) assert.ok(commonFilter(source).includes('aeval'), JSON.stringify(source));
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const create = createRequire(import.meta.url)('../vendor/core/umd/ffmpeg-core.js');
  const core = await create({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  let logs = []; core.setLogger(({ message }) => logs.push(message));
  const run = args => { logs = []; core.exec(...args); const ret = core.ret; core.reset(); assert.equal(ret, 0, logs.slice(-4).join('\n')); };
  const frames = 8827;
  const input = Float32Array.from({ length: frames * 2 }, (_, i) => .7 * Math.sin(i * .061) + .2 * Math.sin(i * .177));
  input.set([-1, 1, 0, 2 ** -23, -(2 ** -23), 1 - 2 ** -23]);
  core.FS.writeFile('/input.raw', new Uint8Array(input.buffer));
  for (const channels of [1, 2]) for (const bits of [16, 24]) for (const flac of [false, true]) {
    const codec = flac ? 'flac' : `pcm_s${bits}le`, path = flac ? '/input.flac' : '/input.wav';
    run(['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '/input.raw', '-ac', String(channels), '-c:a', codec,
      ...(flac ? ['-sample_fmt', bits === 16 ? 's16' : 's32', '-bits_per_raw_sample', String(bits)] : []), path]);
    const source = { ...base, channels, originalChannels: channels, codec, bits, layout: channels === 1 ? 'mono' : 'stereo' };
    assert.ok(!commonFilter(source).includes('aeval'));
    for (const rate of [44100, 48000]) {
      const outputs = [];
      for (const quantize of [true, false]) {
        const filter = commonFilter(quantize ? { ...source, codec: 'pcm_f32le' } : source);
        run(['-v', 'error', '-i', path, '-af', `${filter},aresample=${rate}`, '-c:a', 'pcm_f32le', '-f', 'f32le', '/out.raw']);
        outputs.push(core.FS.readFile('/out.raw')); core.FS.unlink('/out.raw');
      }
      assert.deepEqual(outputs[0], outputs[1], `${codec} ${bits} bit ${channels} ch→${rate} Hzで全サンプル一致`);
    }
    core.FS.unlink(path);
  }
});
