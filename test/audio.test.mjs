import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CODECS, defaults, encodeArgs, commonFilter, chunkArgs, samePreview, metrics, validateConfig } from '../model.js';
import { Player } from '../audio.js';

test('基準PCM・設定・サイズ計算', () => {
  const source = { rate: 44100, channels: 2, frames: 441000, duration: 10 };
  assert.equal(defaults('opus', source).rate, 48000);
  assert.equal(defaults('flac', source).rate, 44100);
  assert.equal(defaults('mp3', { ...source, channels: 1 }).channels, 1);
  assert.equal(samePreview(defaults('flac', source), source), true);
  for (const changes of [{ depth: 16 }, { rate: 48000 }, { channels: 1 }]) assert.equal(samePreview({ ...defaults('flac', source), ...changes }, source), false);
  assert.deepEqual(metrics(441000 * 6, source), { ratio: 100, saved: 0, bitrate: 2116.8 });
  assert.throws(() => validateConfig({ ...defaults('opus', source), rate: 44100 }, source));
  assert.throws(() => validateConfig({ ...defaults('mp3', source), channels: 3 }, source));
});

test('配布するWASMで7形式を生成し、区間復号と24 bit一致を検証', async () => {
  // ブラウザ用コアにWASMバイナリを渡す。UI/Worker/WORKERFSの試験はブラウザ側で別途行う。
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const require = createRequire(import.meta.url);
  const corePath = existsSync(new URL('../vendor/core/umd/ffmpeg-core.js', import.meta.url)) ? '../vendor/core/umd/' : '../node_modules/@ffmpeg/core/dist/umd/';
  const create = require(corePath + 'ffmpeg-core.js');
  const core = await create({ wasmBinary: await readFile(new URL(corePath + 'ffmpeg-core.wasm', import.meta.url)) });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  function run(args) {
    logs = [];
    try { core.exec(...args); } catch (error) { throw Error(`${args.join(' ')}\n${logs.join('\n')}`, { cause: error }); }
    const result = core.ret;
    core.reset();
    assert.equal(result, 0, logs.join('\n'));
  }
  function readFloat(path) { const data = core.FS.readFile(path); return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4); }
  const source = { rate: 44100, channels: 2, frames: 44100 * 13 + 123 };
  source.duration = source.frames / source.rate;
  const input = new Float32Array(source.frames * 2);
  let seed = 123;
  for (let i = 0; i < source.frames; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    input[i * 2] = Math.sin(i * .063) * .3 + (seed / 2 ** 32 - .5) * .1;
    input[i * 2 + 1] = Math.sin(i * .17) * .2;
  }
  core.FS.writeFile('/source.raw', new Uint8Array(input.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '/source.raw', '-c:a', 'pcm_f32le', '/source.wav']);
  run(['-v', 'error', '-i', '/source.wav', '-af', commonFilter(source), '-f', 'f32le', '/reference']);
  const reference = readFloat('/reference');
  assert.equal(reference.length, input.length);
  for (const sample of reference) assert.equal(sample * 8388608, Math.round(sample * 8388608), '24 bitの量子化単位');
  const renderRate = 48000, total = Math.round(source.duration * renderRate);
  for (const codec of Object.keys(CODECS)) {
    const config = defaults(codec, source), output = `/encoded.${CODECS[codec].ext}`;
    run(encodeArgs(source, config, '/source.wav', output));
    assert.ok(core.FS.stat(output).size > 0, `${codec}の出力`);
    if (['wav', 'flac'].includes(codec)) {
      run(['-v', 'error', '-i', output, '-f', 'f32le', '/lossless']);
      assert.deepEqual(readFloat('/lossless'), reference, `${codec}のプレビュー共通化`);
      core.FS.unlink('/lossless');
    }
    const target = { reference: false, channels: 2, codec };
    run(chunkArgs(source, target, 0, total, renderRate, output, '/whole'));
    const whole = readFloat('/whole');
    for (const start of [0, 192000, 384000, 413517]) {
      const count = 48000;
      run(chunkArgs(source, target, start, count, renderRate, output, '/piece'));
      const piece = readFloat('/piece');
      assert.equal(piece.length, count * 2, `${codec}の区間サンプル数`);
      let diff = 0;
      // AACのPNSはシークで乱数状態が変わる。PNSを使わない右chの正弦波で位置を検証する。
      for (let i = codec === 'aac' ? 1 : 0; i < piece.length; i += codec === 'aac' ? 2 : 1) diff = Math.max(diff, Math.abs(piece[i] - whole[start * 2 + i]));
      assert.ok(diff < 0.00005, `${codec} 位置${start}の全体復号との差 ${diff}`);
      core.FS.unlink('/piece');
    }
    core.FS.unlink('/whole');
    core.FS.unlink(output);
  }
});

test('再生中の切替で位置を保ち、2パターンを重ねず、シークで古い復号を捨てる', async () => {
  const started = [], stopped = [];
  const context = {
    sampleRate: 48000, currentTime: 0, destination: {},
    resume: async () => {}, close: () => {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start(...args) { started.push(args); }, stop(at) { stopped.push(at); } }),
  };
  const player = new Player(() => {}, error => { throw error; });
  clearInterval(player.timer);
  try {
    player.context = context;
    player.setSource({ duration: 60, rate: 48000, channels: 2, file: {} });
    player.decode = async (target, start) => {
      const chunk = { key: target.key, start, end: start + 48000 * 8, buffer: {} };
      player.cache.push(chunk);
      return chunk;
    };
    await player.play();
    await new Promise(setImmediate);
    assert.equal(player.buffering, false);
    assert.equal(started.length, 2, '現在と次区間を隙間なく予約');
    assert.equal(started[1][0], started[0][0] + started[0][2]);
    context.currentTime = 3;
    const before = player.position;
    player.select({ id: 'mp3', config: { codec: 'mp3', channels: 2 }, blob: {} });
    await new Promise(setImmediate);
    assert.equal(player.target.id, 'mp3');
    assert.equal(stopped.at(-1), started.at(-1)[0], '旧音声の停止時刻と新音声の開始時刻が一致');
    context.currentTime = started.at(-1)[0];
    assert.ok(Math.abs(player.position - (before + .025)) < 1 / 48000);
    player.pause();
    const paused = player.position;
    context.currentTime += 5;
    assert.equal(player.position, paused);
    player.seek(20);
    assert.equal(player.position, 20);
    let finish;
    player.decode = () => new Promise(resolve => { finish = resolve; });
    await player.play();
    player.seek(40);
    finish({ key: 'mp3', start: 20 * 48000, end: 28 * 48000, buffer: {} });
    await new Promise(setImmediate);
    assert.equal(player.position, 40, '以前の復号結果でシーク位置を巻き戻さない');
  } finally { player.dispose(); }
});
