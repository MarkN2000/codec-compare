import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CODECS, defaults, bitratesFor, validateConfig, encodeArgs, chunkArgs, codecDelay } from '../model.js';
import { Engine } from '../audio.js';

test('通信用コーデックの固定条件、SBC・LC3の範囲と遅延補正', () => {
  const source = { rate: 44100, channels: 2 };
  assert.equal(CODECS.msbc, undefined, 'キャンセルされたmSBCを公開しない');
  for (const [codec, rate] of [['g722', 16000], ['mulaw', 8000], ['alaw', 8000]]) {
    const config = defaults(codec, source);
    assert.equal(config.rate, rate); assert.equal(config.channels, 1); assert.equal(config.bitrate, 64);
    assert.throws(() => validateConfig({ ...config, channels: 2 }, source));
    assert.throws(() => validateConfig({ ...config, bitrate: 128 }, source));
  }
  assert.equal(defaults('sbc', source).bitrate, 328);
  assert.equal(defaults('sbc', { rate: 16000, channels: 1 }).bitrate, 128);
  for (const codec of ['sbc', 'lc3']) for (const rate of CODECS[codec].rates) for (const channels of [1, 2]) {
    for (const frameDuration of CODECS[codec].frameDurations || [undefined]) {
      const config = { ...defaults(codec, source), rate, channels, frameDuration };
      for (const bitrate of bitratesFor(config)) validateConfig({ ...config, bitrate }, source);
    }
  }
  const lc3 = defaults('lc3', source);
  assert.equal(lc3.frameDuration, 10); assert.equal(lc3.bitrate, 192);
  assert.ok(!bitratesFor({ ...lc3, channels: 2, frameDuration: 7.5 }).includes(32));
  assert.ok(bitratesFor({ ...lc3, channels: 2, frameDuration: 10 }).includes(32));
  assert.throws(() => validateConfig({ ...lc3, frameDuration: 5 }, source));
  assert.equal(codecDelay(defaults('g722', source)), 22);
  assert.equal(codecDelay({ ...defaults('sbc', source), channels: 1 }), 37);
  assert.equal(codecDelay(defaults('sbc', source)), 73);
  assert.equal(codecDelay(lc3), 120);
  assert.equal(codecDelay({ ...lc3, frameDuration: 7.5 }), 192);
  const args = chunkArgs(source, lc3, 48000, 48000, 48000);
  assert.match(args[args.indexOf('-af') + 1], /^atrim=start_sample=120,asetpts=PTS-STARTPTS,aresample=48000/);
  assert.ok(!args.includes('-ss'), '先頭から読む形式に入力シークを要求しない');
  const encoded = encodeArgs(source, lc3);
  assert.equal(encoded[encoded.indexOf('-frame_duration') + 1], '10');
  assert.ok(!encoded[encoded.indexOf('-af') + 1].includes('apad'), 'LC3は公式エンコーダーが末尾を補完する');
});

test('LC3の実際の出力処理で元のサンプル数を保存し、不正ヘッダー・長さを拒否する', async () => {
  const source = { rate: 44100, channels: 2, duration: 13.00001, file: {} }, config = defaults('lc3', source);
  const engine = new Engine();
  const header = new Uint8Array(32);
  new DataView(header.buffer).setUint16(0, 0x1ccc);
  let deleted = 0, mounted = 0;
  engine.mount = async () => mounted++;
  engine.run = async () => {};
  engine.ffmpeg = { readFile: async () => header, deleteFile: async () => deleted++ };
  const blob = await engine.encode(source, config);
  assert.equal(new DataView(await blob.arrayBuffer()).getUint32(14, true), Math.ceil(source.duration * config.rate));
  assert.equal(deleted, 1);
  header[0] = 0;
  await assert.rejects(engine.encode(source, config), /LC3の出力ヘッダー/);
  assert.equal(deleted, 2, '異常時も出力を解放する');
  const before = mounted;
  await assert.rejects(engine.encode({ ...source, duration: 0x100000000 / config.rate }, config), /サンプル数上限/);
  assert.equal(mounted, before, '長すぎる音源は変換前に拒否する');
});

test('実WASMでSBC・LC3の全候補を変換し、端数フレームの末尾と途中位置を検証する', async () => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const require = createRequire(import.meta.url);
  const core = await require('../vendor/core/umd/ffmpeg-core.js')({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  const run = args => {
    logs = []; core.exec(...args); const result = core.ret; core.reset();
    assert.equal(result, 0, `${args.join(' ')}\n${logs.slice(-5).join('\n')}`);
  };
  const source = { rate: 48000, channels: 2, frames: 16800, duration: .35, file: {} };
  const samples = Float32Array.from({ length: source.frames * 2 }, (_, i) => .2 * Math.sin(Math.floor(i / 2) * .061 + i % 2));
  core.FS.writeFile('/source.raw', new Uint8Array(samples.buffer)); core.FS.mkdir('/input');
  run(['-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', '/source.raw', '-f', 'wav', '/input/audio']);
  const engine = new Engine();
  engine.mount = async () => {};
  engine.run = async args => run(args);
  engine.ffmpeg = { readFile: async path => core.FS.readFile(path), deleteFile: async path => core.FS.unlink(path) };
  for (const codec of ['sbc', 'lc3']) for (const rate of CODECS[codec].rates) for (const channels of [1, 2]) {
    for (const frameDuration of CODECS[codec].frameDurations || [undefined]) {
      const config = { ...defaults(codec, source), rate, channels, frameDuration };
      for (const bitrate of bitratesFor(config)) {
        const settings = { ...config, bitrate };
        const blob = await engine.encode(source, settings);
        core.FS.writeFile('/encoded', new Uint8Array(await blob.arrayBuffer()));
        run(chunkArgs(source, settings, 0, source.frames, 48000, '/encoded', '/whole'));
        const whole = core.FS.readFile('/whole');
        assert.equal(whole.length, source.frames * channels * 4, `${codec} ${rate} Hz ${channels} ch ${bitrate} kbps ${frameDuration} msの末尾`);
        run(chunkArgs(source, settings, 997, 4000, 48000, '/encoded', '/piece'));
        assert.deepEqual(core.FS.readFile('/piece'), whole.slice(997 * channels * 4, 4997 * channels * 4), `${codec}の途中位置`);
        for (const path of ['/encoded', '/whole', '/piece']) core.FS.unlink(path);
      }
    }
  }
});
