import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CODECS, defaults, cutoffsFor, validateConfig, encodeArgs, description } from '../model.js';

test('カットオフの自動・形式別候補・サンプルレート制約・一覧表示', () => {
  const source = { rate: 48000, channels: 1 };
  for (const codec of Object.keys(CODECS)) {
    const config = defaults(codec, source);
    assert.equal(config.cutoff, 0);
    assert.ok(!encodeArgs(source, config).includes('-cutoff'), '自動ではエンコーダーの既定値を使う');
    delete config.cutoff;
    assert.ok(!encodeArgs(source, config).includes('-cutoff'), '既存設定も自動として扱う');
    if (!CODECS[codec].cutoffs) {
      assert.deepEqual(cutoffsFor(config), []);
      assert.throws(() => validateConfig({ ...config, cutoff: 4000 }, source));
      continue;
    }
    for (const rate of CODECS[codec].rates) {
      const settings = { ...config, rate };
      assert.ok(cutoffsFor(settings).every(hz => hz <= rate / 2));
      for (const cutoff of cutoffsFor(settings)) {
        validateConfig({ ...settings, cutoff }, source);
        const args = encodeArgs(source, { ...settings, cutoff });
        if (cutoff) assert.equal(args[args.indexOf('-cutoff') + 1], String(cutoff));
      }
    }
    assert.match(description({ ...config, cutoff: 12000 }), /カットオフ 12,000 Hz/);
    for (const cutoff of [-1, NaN, '12000', 999999]) assert.throws(() => validateConfig({ ...config, cutoff }, source));
  }
  assert.deepEqual(cutoffsFor({ codec: 'opus', rate: 48000 }), [0, 4000, 6000, 8000, 12000, 20000]);
  assert.deepEqual(cutoffsFor({ codec: 'opus', rate: 8000 }), [0, 4000]);
  assert.ok(cutoffsFor({ codec: 'aac', rate: 44100 }).includes(22050));
  assert.ok(!cutoffsFor({ codec: 'aac', rate: 44100 }).includes(24000));
  for (const codec of ['aac', 'vorbis']) {
    assert.equal(cutoffsFor({ codec, rate: 48000 }).at(-1), 24000);
    assert.equal(cutoffsFor({ codec, rate: 88200 }).at(-1), 44100);
    assert.equal(cutoffsFor({ codec, rate: 96000 }).at(-1), 48000);
  }
});

test('配布するWASMで候補値を変換し、カットオフで高域が減ることを確認する', async () => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const require = createRequire(import.meta.url);
  const create = require('../vendor/core/umd/ffmpeg-core.js');
  const core = await create({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  const run = args => {
    logs = []; core.exec(...args); const code = core.ret; core.reset();
    assert.equal(code, 0, `${args.join(' ')}\n${logs.slice(-5).join('\n')}`);
  };
  const source = { rate: 48000, channels: 1, duration: 2, frames: 96000 };
  const samples = Float32Array.from({ length: source.frames }, (_, i) =>
    .25 * Math.sin(2 * Math.PI * 1000 * i / source.rate) + .2 * Math.sin(2 * Math.PI * 18000 * i / source.rate));
  core.FS.writeFile('/source.raw', new Uint8Array(samples.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', '/source.raw', '/source.wav']);
  for (const codec of ['opus', 'mp3', 'aac', 'vorbis']) {
    const path = `/encoded.${CODECS[codec].ext}`, base = { ...defaults(codec, source), bitrate: 192 };
    for (const rate of [8000, 16000, 24000, 48000, ...(['aac', 'vorbis'].includes(codec) ? [88200, 96000] : [])]) {
      const config = { ...base, rate, bitrate: rate < 32000 ? 64 : 192 };
      for (const cutoff of cutoffsFor(config)) {
        const args = encodeArgs(source, { ...config, cutoff }, '/source.wav', path);
        args.splice(-1, 0, '-t', '0.15');
        run(args);
        assert.ok(core.FS.stat(path).size > 0, `${codec} ${rate} Hz / cutoff ${cutoff}`);
        core.FS.unlink(path);
      }
    }
    const ratios = [];
    for (const cutoff of [0, 12000]) {
      run(encodeArgs(source, { ...base, cutoff }, '/source.wav', path));
      run(['-v', 'error', '-i', path, '-ar', '48000', '-ac', '1', '-f', 'f32le', '/decoded.raw']);
      const data = core.FS.readFile('/decoded.raw'), pcm = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      const amplitude = hz => {
        let real = 0, imaginary = 0;
        for (let i = 24000; i < 72000; i++) {
          real += pcm[i] * Math.cos(2 * Math.PI * hz * i / 48000);
          imaginary += pcm[i] * Math.sin(2 * Math.PI * hz * i / 48000);
        }
        return Math.hypot(real, imaginary);
      };
      ratios.push(amplitude(18000) / amplitude(1000));
      core.FS.unlink(path); core.FS.unlink('/decoded.raw');
    }
    assert.ok(ratios[0] > .1, `${codec}の自動設定では18 kHzの音がある`);
    assert.ok(ratios[1] < ratios[0] / 10, `${codec}の12 kHz指定で18 kHzが20 dB以上減少する`);
  }
  const highSource = { rate: 96000, channels: 1, duration: 2, frames: 192000 };
  const highSamples = Float32Array.from({ length: highSource.frames }, (_, i) =>
    .25 * Math.sin(2 * Math.PI * 1000 * i / highSource.rate) + .2 * Math.sin(2 * Math.PI * 30000 * i / highSource.rate));
  core.FS.writeFile('/high.raw', new Uint8Array(highSamples.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '96000', '-ac', '1', '-i', '/high.raw', '/high.wav']);
  for (const codec of ['aac', 'vorbis']) {
    const path = `/high.${CODECS[codec].ext}`, ratios = [];
    for (const cutoff of [24000, 48000]) {
      run(encodeArgs(highSource, { ...defaults(codec, highSource), bitrate: 320, quality: 10, cutoff }, '/high.wav', path));
      run(['-v', 'error', '-i', path, '-ar', '96000', '-ac', '1', '-f', 'f32le', '/high-decoded.raw']);
      const data = core.FS.readFile('/high-decoded.raw'), pcm = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      const amplitude = hz => {
        let real = 0, imaginary = 0;
        for (let i = 48000; i < 144000; i++) {
          real += pcm[i] * Math.cos(2 * Math.PI * hz * i / 96000);
          imaginary += pcm[i] * Math.sin(2 * Math.PI * hz * i / 96000);
        }
        return Math.hypot(real, imaginary);
      };
      ratios.push(amplitude(30000) / amplitude(1000));
      core.FS.unlink(path); core.FS.unlink('/high-decoded.raw');
    }
    assert.ok(ratios[1] > .1, `${codec}の48 kHz指定では30 kHzの音がある`);
    assert.ok(ratios[0] < ratios[1] / 10, `${codec}の24 kHz指定では30 kHzが20 dB以上減少する`);
  }
});
