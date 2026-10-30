import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { CODECS, defaults, bitratesFor, cutoffsFor, validateConfig, encodeArgs, chunkArgs, codecDelay, description } from '../model.js';
import { Engine } from '../audio.js';

test('通信用コーデックの固定条件、SBC・LC3の範囲と遅延補正', () => {
  const source = { rate: 44100, channels: 2 };
  assert.equal(CODECS.msbc, undefined, 'キャンセルされたmSBCを公開しない');
  assert.equal(CODECS.mulaw, undefined); assert.equal(CODECS.alaw, undefined);
  for (const [codec, rate] of [['g722', 16000], ['g711', 8000]]) {
    const config = defaults(codec, source);
    assert.equal(config.rate, rate); assert.equal(config.channels, 1); assert.equal(config.bitrate, 64);
    assert.throws(() => validateConfig({ ...config, channels: 2 }, source));
    assert.throws(() => validateConfig({ ...config, bitrate: 128 }, source));
  }
  assert.equal(defaults('sbc', source).bitrate, 328);
  assert.equal(defaults('sbc', { rate: 48000, channels: 2 }).bitrate, 345);
  assert.equal(defaults('sbc', { rate: 44100, channels: 1 }).bitrate, 193);
  assert.equal(defaults('sbc', { rate: 48000, channels: 1 }).bitrate, 198);
  assert.equal(defaults('sbc', { rate: 16000, channels: 1 }).bitrate, 128);
  assert.deepEqual(bitratesFor(defaults('sbc', source)), [128, 192, 229, 256, 320, 328]);
  assert.deepEqual(bitratesFor(defaults('sbc', { rate: 48000, channels: 2 })), [128, 192, 237, 256, 320, 345]);
  for (const [codec, stereo] of [['opus', 128], ['mp3', 192], ['aac', 256]]) for (const channels of [1, 2]) {
    assert.equal(defaults(codec, { ...source, channels }).bitrate, stereo * channels / 2);
  }
  for (const [rate, mono] of [[8000, 24], [16000, 32], [24000, 48], [32000, 64], [48000, 96]]) for (const channels of [1, 2]) {
    const config = defaults('lc3', { rate, channels });
    assert.equal(config.bitrate, mono * channels); validateConfig(config, source);
    assert.ok(bitratesFor(config).every(n => n <= 128 * channels));
    assert.ok(bitratesFor(config).includes(124 * channels));
    assert.ok(bitratesFor({ ...config, frameDuration: 7.5 }).includes(124.8 * channels));
  }
  const g711 = defaults('g711', source);
  assert.equal(g711.law, 'mulaw');
  for (const law of ['mulaw', 'alaw']) {
    const config = { ...g711, law }, args = encodeArgs(source, config);
    assert.equal(args[args.indexOf('-c:a') + 1], `pcm_${law}`);
    assert.match(description(config), law === 'alaw' ? /A-law/ : /μ-law/);
  }
  assert.throws(() => validateConfig({ ...g711, law: 'invalid' }, source), /圧伸方式/);
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
  assert.equal(codecDelay(defaults('sbc', { ...source, channels: 1 })), 73);
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

test('設定欄で初期値は出力条件に追従し、手動値は維持または最寄り候補に合わせる', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  let selected;
  const context = vm.createContext({
    defaults, bitratesFor, cutoffsFor, source: { rate: 44100, channels: 2 }, draft: defaults('sbc', { rate: 44100, channels: 2 }),
    document: { createTextNode: text => text, createElement: tag => tag === 'select' ? (selected = { add() {}, addEventListener(type, listener) { this.change = listener; } }) : { append() {} } },
    Option: class {}, $: () => ({ append() {}, querySelector: () => ({ focus() {} }) }), fields() {},
  });
  vm.runInContext(app.slice(app.indexOf('function field('), app.indexOf('function fields(')), context);
  const change = (key, value) => { context.field(key, key, [context.draft[key], value]); selected.value = String(value); selected.change(); };
  change('rate', 48000); assert.equal(context.draft.bitrate, 345);
  change('channels', 1); assert.equal(context.draft.bitrate, 198);
  context.draft = { ...defaults('sbc', context.source), bitrate: 256 };
  change('rate', 48000); assert.equal(context.draft.bitrate, 256);
  context.draft = { ...defaults('sbc', context.source), bitrate: 229 };
  change('rate', 48000); assert.equal(context.draft.bitrate, 237);
  context.draft = { ...defaults('lc3', context.source), bitrate: 32 };
  change('frameDuration', 7.5); assert.equal(context.draft.bitrate, 48);
  context.draft = { ...defaults('lc3', context.source), bitrate: 248 };
  change('frameDuration', 7.5); assert.equal(context.draft.bitrate, 249.6);
  context.draft = defaults('g711', context.source);
  change('law', 'alaw'); assert.equal(context.draft.law, 'alaw'); validateConfig(context.draft, context.source);
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
        const data = new Uint8Array(await blob.arrayBuffer());
        if (codec === 'sbc') {
          assert.equal(data[0], 0x9c);
          assert.equal((data[1] >> 2) & 3, channels === 2 ? 3 : 0, 'Joint Stereo／Mono');
          assert.equal(data[1] & 1, 1, '8サブバンド');
          assert.equal((data[1] >> 4) & 3, 3, '16ブロック');
          assert.equal((data[1] >> 1) & 1, 0, 'Loudness');
          const expected = { '44100-1-127': 19, '44100-1-193': 31, '48000-1-132': 18, '48000-1-198': 29,
            '44100-2-229': 35, '44100-2-328': 53, '48000-2-237': 33, '48000-2-345': 51 }[`${rate}-${channels}-${bitrate}`];
          if (expected) assert.equal(data[2], expected, `${rate} Hz ${channels} ch ${bitrate} kbpsのBluetooth設定例`);
          const frameBytes = 4 + 4 * channels + 2 * data[2] + (channels === 2 ? 1 : 0);
          const actual = frameBytes * 8 * rate / 128 / 1000;
          assert.ok(Math.abs(actual - bitrate) <= rate / 8000 + .001, '目標値からビットプール半刻み以内の実レート');
        }
        core.FS.writeFile('/encoded', data);
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
