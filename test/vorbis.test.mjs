import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defaults, encodeArgs, chunkArgs } from '../model.js';

test('Vorbisの36秒以降も区間サンプルが欠けず、全量復号した同区間と一致する', async () => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const core = await createRequire(import.meta.url)('../vendor/core/umd/ffmpeg-core.js')({
    wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)),
  });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  const run = args => {
    logs = []; core.exec(...args); const result = core.ret; core.reset();
    assert.equal(result, 0, logs.slice(-4).join('\n'));
  };
  const source = { rate: 48000, channels: 2, originalChannels: 2, codec: 'pcm_s16le', bits: 16, duration: 44, frames: 44 * 48000 };
  const samples = new Float32Array(source.frames * 2);
  let seed = 7;
  for (let i = 0; i < source.frames; i++) {
    const t = i / source.rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    // 40秒直前の過渡音でVorbisのフレーム時刻が揺れる条件を作る。
    const sample = .1 * Math.sin(2 * Math.PI * 440 * t) + (t >= 39.98 && t < 40.02 ? .6 * (seed / 2147483648 - 1) : 0);
    samples[2 * i] = samples[2 * i + 1] = sample;
  }
  core.FS.writeFile('/source.raw', new Uint8Array(samples.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', '/source.raw', '-c:a', 'pcm_s16le', '/source.wav']);
  const config = defaults('vorbis', source);
  run(encodeArgs(source, config, '/source.wav', '/encoded.ogg'));
  for (const rate of [44100, 48000]) {
    run(['-v', 'error', '-i', '/encoded.ogg', '-af', `aresample=${rate}`, '-c:a', 'pcm_f32le', '-f', 'f32le', '/whole.raw']);
    const whole = core.FS.readFile('/whole.raw'); core.FS.unlink('/whole.raw');
    for (const seconds of [4, 8, 16]) {
      const start = (40 - seconds) * rate, frames = seconds * rate;
      run(chunkArgs(source, config, start, frames, rate, '/encoded.ogg', '/piece.raw'));
      const piece = core.FS.readFile('/piece.raw'); core.FS.unlink('/piece.raw');
      assert.equal(piece.length, frames * 2 * 4, `${rate} Hz・${seconds}秒区間のサンプル数`);
      assert.deepEqual(piece, whole.subarray(start * 2 * 4, (start + frames) * 2 * 4), '全量復号と同じ位置・内容');
    }
  }
});
