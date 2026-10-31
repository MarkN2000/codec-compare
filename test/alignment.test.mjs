import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { encodeArgs, defaults, chunkArgs } from '../model.js';
import { spectrumFrames, FFT_SIZE } from '../analysis.js';
import { bandDifference } from '../graph.js';

// 波形の平均音量では検出できない1サンプルのずれも検査する。
function bestLag(reference, selected, start, count = 4096) {
  let best = -Infinity, lag = null;
  for (let shift = -96; shift <= 96; shift++) {
    let dot = 0, p = 0, q = 0;
    for (let i = start; i < start + count; i++) {
      const x = reference[i], y = selected[i + shift] || 0;
      dot += x * y; p += x * x; q += y * y;
    }
    const correlation = dot / Math.sqrt(p * q);
    if (correlation > best) { best = correlation; lag = shift; }
  }
  return { lag, correlation: best };
}

test('44.1/48 kHzの実WASM復号で周波数・位置・FFT窓を照合する', async t => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const require = createRequire(import.meta.url);
  const create = require('../vendor/core/umd/ffmpeg-core.js');
  const core = await create({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  function run(args) {
    logs = []; core.exec(...args); const result = core.ret; core.reset();
    assert.equal(result, 0, logs.slice(-3).join('\n'));
  }
  function decode(source, path, target, start, frames, rate) {
    run(chunkArgs(source, target, start, frames, rate, path, '/audit.raw'));
    const bytes = core.FS.readFile('/audit.raw'); core.FS.unlink('/audit.raw');
    const raw = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    return [0, 1].map(ch => Float32Array.from({ length: raw.length / 2 }, (_, i) => raw[i * 2 + ch]));
  }
  for (const sourceRate of [44100, 48000]) {
    const source = { rate: sourceRate, channels: 2, frames: sourceRate * 12 + 123 };
    source.duration = source.frames / sourceRate;
    const input = new Float32Array(source.frames * 2);
    let seed = 12345, filtered = 0;
    for (let i = 0; i < source.frames; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      filtered = filtered * .6 + (seed / 2 ** 32 - .5) * .2;
      input[i * 2] = filtered;
      input[i * 2 + 1] = .3 * Math.sin(2 * Math.PI * 1000 * i / sourceRate);
    }
    core.FS.writeFile('/audit-input.raw', new Uint8Array(input.buffer));
    run(['-v', 'error', '-f', 'f32le', '-ar', String(sourceRate), '-ac', '2', '-i', '/audit-input.raw', '/audit-input.wav']);
    run(encodeArgs(source, { ...defaults('opus', source), rate: 48000, bitrate: 192 }, '/audit-input.wav', '/audit.ogg'));
    run(encodeArgs(source, { ...defaults('wav', source), rate: 48000 }, '/audit-input.wav', '/audit-pcm.wav'));
    for (const rate of [44100, 48000]) {
      const total = Math.round(source.duration * rate);
      const refTarget = { reference: true, channels: 2 }, opusTarget = { codec: 'opus', channels: 2 };
      const reference = decode(source, '/audit-input.wav', refTarget, 0, total, rate);
      const opus = decode(source, '/audit.ogg', opusTarget, 0, total, rate);
      assert.ok(Math.abs(reference[0].length - total) <= 1);
      assert.ok(Math.abs(opus[0].length - total) <= 1);
      let maxChunkError = 0, lowestCorrelation = 1, toneHz = null;
      const positions = [0, Math.round(3.987 * rate), 4 * rate, Math.round(8.123 * rate), total - rate];
      for (const start of positions) {
        const frames = Math.min(rate, total - start);
        const a = decode(source, '/audit-input.wav', refTarget, start, frames, rate);
        const b = decode(source, '/audit.ogg', opusTarget, start, frames, rate);
        assert.equal(a[0].length, frames); assert.equal(b[0].length, frames);
        for (const [piece, whole] of [[a, reference], [b, opus]]) {
          for (let ch = 0; ch < 2; ch++) for (let i = 0; i < frames; i++) {
            maxChunkError = Math.max(maxChunkError, Math.abs(piece[ch][i] - whole[ch][start + i]));
          }
        }
        const match = bestLag(a[0], b[0], 256);
        assert.equal(match.lag, 0, `${sourceRate}→Opus 48000→比較${rate} Hz、位置${start}の相互相関`);
        lowestCorrelation = Math.min(lowestCorrelation, match.correlation);
        const fftA = spectrumFrames(a, rate), fftB = spectrumFrames(b, rate);
        assert.equal(fftA.rate, fftB.rate); assert.equal(fftA.bins, fftB.bins);
        assert.deepEqual(fftA.times, fftB.times, '比較するFFT窓の中心時刻が全て一致');
        const tone = spectrumFrames([b[1]], rate);
        let peak = 1;
        for (let bin = 2; bin < tone.bins; bin++) if (tone.powers[bin] > tone.powers[peak]) peak = bin;
        toneHz = peak * rate / FFT_SIZE;
        assert.ok(Math.abs(toneHz - 1000) <= rate / FFT_SIZE / 2, `1 kHzが${toneHz} Hzのビンに出る`);
        const wrongRate = rate === 48000 ? 44100 : 48000;
        assert.ok(Math.abs(peak * wrongRate / FFT_SIZE - 1000) > 70, '故意に44.1/48 kHzを取り違えると周波数検査が失敗する');
        if (rate === 48000) {
          const control = decode(source, '/audit-pcm.wav', { codec: 'wav', channels: 2 }, start, frames, rate);
          const controlFft = spectrumFrames(control, rate);
          let maxPcmError = 0, maxDbError = 0;
          for (let ch = 0; ch < 2; ch++) for (let i = 0; i < frames; i++) maxPcmError = Math.max(maxPcmError, Math.abs(a[ch][i] - control[ch][i]));
          for (const hz of [50, 500, 1000, 5000, 10000]) {
            const bin = Math.round(hz * FFT_SIZE / rate);
            for (let row = 0; row < fftA.times.length; row++) {
              const index = row * fftA.bins + bin;
              maxDbError = Math.max(maxDbError, Math.abs(bandDifference(fftA.powers[index], controlFft.powers[index])));
            }
          }
          assert.ok(maxPcmError < 2e-7, '圧縮なしの48 kHz対照とサンプル単位で一致');
          assert.ok(maxDbError < .01, `可逆対照の差分グラフが0 dBに戻る: ${maxDbError}`);
        }
      }
      assert.ok(maxChunkError < .00005, `全体復号と区間復号の最大誤差: ${maxChunkError}`);
      const shifted = new Float32Array(reference[0].length); shifted.set(reference[0].subarray(0, -1), 1);
      assert.equal(bestLag(reference[0], shifted, rate).lag, 1, '故意に1サンプルずらすと検出できる');
      t.diagnostic(JSON.stringify({ sourceRate, opusRate: 48000, comparisonRate: rate, checkedPositions: positions,
        bestLagSamples: 0, lowestCorrelation, maxChunkError, toneHz, fftWindowsMatch: true }));
    }
    for (const path of ['/audit-input.raw', '/audit-input.wav', '/audit.ogg', '/audit-pcm.wav']) core.FS.unlink(path);
  }
});
