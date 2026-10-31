import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CODECS, LIMITS, defaults, encodeArgs, commonFilter, chunkArgs, samePreview, metrics, validateConfig } from '../model.js';
import { Player } from '../audio.js';
import { spectrumFrames, FFT_SIZE } from '../analysis.js';

test('基準PCM・設定・サイズ計算', () => {
  const source = { rate: 44100, channels: 2, frames: 441000, duration: 10 };
  assert.equal(defaults('opus', source).rate, 48000);
  assert.equal(defaults('opus', source).mode, 'VBR');
  assert.equal(defaults('flac', source).rate, 44100);
  assert.equal(defaults('mp3', { ...source, channels: 1 }).channels, 1);
  assert.equal(samePreview(defaults('flac', source), source), true);
  for (const changes of [{ depth: 16 }, { rate: 48000 }, { channels: 1 }]) assert.equal(samePreview({ ...defaults('flac', source), ...changes }, source), false);
  assert.deepEqual(metrics(441000 * 6, source), { ratio: 100, saved: 0, bitrate: 2116.8 });
  assert.throws(() => validateConfig({ ...defaults('opus', source), rate: 44100 }, source));
  assert.throws(() => validateConfig({ ...defaults('mp3', source), channels: 3 }, source));
  assert.deepEqual(LIMITS, { input: 512 * 1024 ** 2, output: 512 * 1024 ** 2, total: 1024 ** 3 });
  const args = encodeArgs(source, defaults('wav', source));
  assert.equal(Number(args[args.indexOf('-fs') + 1]), LIMITS.output);
});

test('配布するWASMで対応形式を生成し、区間復号と24 bit一致を検証', async () => {
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
  function probe(path) {
    core.ffprobe('-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', '-o', '/probe.json', path);
    core.reset();
    const info = JSON.parse(new TextDecoder().decode(core.FS.readFile('/probe.json'))).streams?.[0];
    core.FS.unlink('/probe.json');
    assert.ok(info, '音声メタデータを取得できる');
    return info;
  }
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
  run(['-v', 'info', '-i', '/source.wav', '-map', '0:a:0', '-vn', '-af', 'ashowinfo', '-f', 'null', '-']);
  assert.equal(logs.reduce((n, line) => n + Number(line.match(/\bnb_samples:(\d+)/)?.[1] || 0), 0), source.frames, 'PCMを保存せず正確なサンプル数を取得');
  run(['-v', 'error', '-i', '/source.wav', '-af', commonFilter(source), '-f', 'f32le', '/reference']);
  const reference = readFloat('/reference');
  assert.equal(reference.length, input.length);
  for (const sample of reference) assert.equal(sample * 8388608, Math.round(sample * 8388608), '24 bitの量子化単位');
  const renderRate = 48000, total = Math.round(source.duration * renderRate);
  for (const config of Object.keys(CODECS).flatMap(codec => codec === 'g711'
    ? CODECS.g711.laws.map(([law]) => ({ ...defaults(codec, source), law })) : [defaults(codec, source)])) {
    const codec = config.codec, output = `/encoded.${CODECS[codec].ext}`;
    run(encodeArgs(source, config, '/source.wav', output));
    assert.ok(core.FS.stat(output).size > 0, `${codec}の出力`);
    if (['wav', 'flac'].includes(codec)) {
      run(['-v', 'error', '-i', output, '-f', 'f32le', '/lossless']);
      assert.deepEqual(readFloat('/lossless'), reference, `${codec}のプレビュー共通化`);
      core.FS.unlink('/lossless');
    }
    const target = { ...config, reference: false };
    run(chunkArgs(source, target, 0, total, renderRate, output, '/whole'));
    const whole = readFloat('/whole');
    for (const start of [0, 192000, 384000, 413517]) {
      const count = 48000;
      run(chunkArgs(source, target, start, count, renderRate, output, '/piece'));
      const piece = readFloat('/piece');
      assert.equal(piece.length, count * config.channels, `${codec}の区間サンプル数`);
      let diff = 0;
      // AACのPNSはシークで乱数状態が変わる。PNSを使わない右chの正弦波で位置を検証する。
      for (let i = codec === 'aac' ? 1 : 0; i < piece.length; i += codec === 'aac' ? 2 : 1) diff = Math.max(diff, Math.abs(piece[i] - whole[start * config.channels + i]));
      assert.ok(diff < 0.00005, `${codec} 位置${start}の全体復号との差 ${diff}`);
      core.FS.unlink('/piece');
    }
    if (['lc3', 'g722', 'sbc', 'g711'].includes(codec)) {
      const info = probe(output);
      if (codec === 'g711') assert.equal(info.codec_name, `pcm_${config.law}`);
      assert.equal(Number(info.sample_rate), config.rate);
      assert.equal(Number(info.channels), config.channels);
      assert.equal(whole.length, total * config.channels, `${codec}の末尾まで元音源の長さを維持する`);
      const control = { ...defaults('wav', source), rate: config.rate, channels: config.channels, depth: 16 };
      run(encodeArgs(source, control, '/source.wav', '/control.wav'));
      run(chunkArgs(source, control, 0, total, renderRate, '/control.wav', '/control.raw'));
      const baseline = readFloat('/control.raw');
      let best = { correlation: -1, lag: null };
      for (let lag = -16; lag <= 16; lag++) {
        let dot = 0, p = 0, q = 0;
        for (let frame = 48000; frame < 96000; frame++) {
          const a = baseline[frame * config.channels], b = whole[(frame + lag) * config.channels];
          dot += a * b; p += a * a; q += b * b;
        }
        const correlation = dot / Math.sqrt(p * q);
        if (correlation > best.correlation) best = { lag, correlation };
      }
      assert.equal(best.lag, 0, `${codec}は同じレート・チャンネルのPCM対照と位置が揃う`);
      assert.ok(best.correlation > .9, `${codec}のPCM対照との相関 ${best.correlation}`);
      core.FS.unlink('/control.wav'); core.FS.unlink('/control.raw');
    }
    core.FS.unlink('/whole');
    core.FS.unlink(output);
  }
  // 44.1→48 kHz変換を、圧縮なしの対照とOpus 192 kbpsで分けて検証する。
  const render = (input, target) => {
    run(chunkArgs(source, target, 48000 * 4, 48000 * 4, 48000, input, '/rate.raw'));
    const raw = readFloat('/rate.raw'); core.FS.unlink('/rate.raw'); return raw;
  };
  const reference48 = render('/source.wav', { reference: true, channels: 2 });
  run(encodeArgs(source, { ...defaults('wav', source), rate: 48000 }, '/source.wav', '/rate.wav'));
  const pcm48 = render('/rate.wav', { channels: 2, codec: 'wav' });
  assert.equal(pcm48.length, reference48.length);
  let resampleError = 0;
  for (let i = 0; i < pcm48.length; i++) resampleError = Math.max(resampleError, Math.abs(pcm48[i] - reference48[i]));
  assert.ok(resampleError < 2e-7, `44.1→48 kHzのPCM対照との差: ${resampleError}`);
  run(encodeArgs(source, { ...defaults('opus', source), bitrate: 192 }, '/source.wav', '/rate.ogg'));
  const opus192 = render('/rate.ogg', { channels: 2, codec: 'opus' });
  const spectrum = raw => spectrumFrames(Array.from({ length: 2 }, (_, ch) => Float32Array.from({ length: raw.length / 2 }, (_, i) => raw[i * 2 + ch])), 48000);
  const before = spectrum(reference48), after = spectrum(opus192);
  for (const [lo, hi] of [[20, 1000], [1000, 10000]]) {
    let p = 0, q = 0;
    for (let row = 0; row < before.times.length; row++) for (let bin = Math.ceil(lo * FFT_SIZE / 48000); bin < hi * FFT_SIZE / 48000; bin++) {
      p += before.powers[row * before.bins + bin]; q += after.powers[row * after.bins + bin];
    }
    assert.ok(Math.abs(10 * Math.log10(q / p)) < .5, `192 kbpsで${lo}–${hi} Hzの強さが不自然に増減しない`);
  }
  for (const path of ['/rate.wav', '/rate.ogg']) core.FS.unlink(path);
  for (const bitrate of [6, 8, 12, 16, 20, 24]) {
    for (const [channels, mode] of [[1, 'VBR'], [2, 'CBR']]) {
      const config = { ...defaults('opus', source), bitrate, channels, mode };
      run(encodeArgs(source, config, '/source.wav', '/low.ogg'));
      assert.equal(probe('/low.ogg').channels, channels);
      run(chunkArgs(source, { codec: 'opus', channels }, 48000, 48000, 48000, '/low.ogg', '/low.raw'));
      assert.equal(readFloat('/low.raw').length, 48000 * channels, `${bitrate} kbps ${mode}の区間復号`);
      run(chunkArgs(source, { codec: 'opus', channels }, total - 48000, 48000, 48000, '/low.ogg', '/tail.raw'));
      assert.ok(readFloat('/tail.raw').length >= (48000 - 2) * channels, `${bitrate} kbps ${mode}の末尾サンプル数: ${readFloat('/tail.raw').length / channels}`);
      if (bitrate === 16 && mode === 'VBR') {
        run(chunkArgs(source, { codec: 'opus', channels }, 0, total, 48000, '/low.ogg', '/low-whole.raw'));
        const whole = readFloat('/low-whole.raw');
        for (let start = 0; start < total; start += 48000 * 4) {
          const frames = Math.min(48000 * 4, total - start);
          run(chunkArgs(source, { codec: 'opus', channels }, start, frames, 48000, '/low.ogg', '/joined.raw'));
          const part = readFloat('/joined.raw');
          assert.equal(part.length, frames * channels, 'Opus VBR 48 kHzの4秒区間に欠落がない');
          let error = 0;
          for (let i = 0; i < part.length; i++) error = Math.max(error, Math.abs(part[i] - whole[start * channels + i]));
          assert.ok(error < .00005, `Opus VBR 48 kHzの区間${start}の全体復号との差: ${error}`);
          core.FS.unlink('/joined.raw');
        }
        core.FS.unlink('/low-whole.raw');
      }
      core.FS.unlink('/tail.raw');
      core.FS.unlink('/low.ogg');
      core.FS.unlink('/low.raw');
    }
  }
  // 単純なモノラル信号でSILKを通す。旧native Opus復号は先頭で24サンプル欠落した。
  const short = { rate: 48000, channels: 1, frames: 96000, duration: 2 };
  const tone = Float32Array.from({ length: short.frames }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / short.rate) * .1);
  core.FS.writeFile('/tone.raw', new Uint8Array(tone.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', '/tone.raw', '/tone.wav']);
  run(encodeArgs(short, { ...defaults('opus', short), bitrate: 6 }, '/tone.wav', '/tone.ogg'));
  for (const rate of [44100, 48000]) {
    const target = { codec: 'opus', channels: 1 };
    run(chunkArgs(short, target, 0, rate * 2, rate, '/tone.ogg', '/tone-full.raw'));
    const whole = readFloat('/tone-full.raw');
    assert.equal(whole.length, rate * 2, 'SILKの先頭・末尾サンプルを欠落させない');
    run(chunkArgs(short, target, rate, rate, rate, '/tone.ogg', '/tone-part.raw'));
    assert.deepEqual(readFloat('/tone-part.raw'), whole.slice(rate), 'SILKの区間位置が全体復号と一致');
    core.FS.unlink('/tone-full.raw');
    core.FS.unlink('/tone-part.raw');
  }
  for (const changes of [{ depth: 16 }, { channels: 1 }, { rate: 22050 }]) {
    const config = { ...defaults('wav', source), ...changes };
    run(encodeArgs(source, config, '/source.wav', '/changed.wav'));
    const info = probe('/changed.wav');
    assert.equal(Number(info.sample_rate), config.rate);
    assert.equal(info.channels, config.channels);
    assert.equal(Number(info.bits_per_sample), config.depth);
    assert.equal(samePreview(config, source), false);
    run(['-v', 'error', '-i', '/changed.wav', '-f', 'f32le', '/changed.raw']);
    const changed = readFloat('/changed.raw');
    if (config.depth === 16) {
      assert.notDeepEqual(changed, reference);
      for (const sample of changed) assert.equal(sample * 32768, Math.round(sample * 32768));
    }
    core.FS.unlink('/changed.wav');
    core.FS.unlink('/changed.raw');
  }
  // 多チャンネル入力でも基準の最大2チャンネル条件を適用する。
  core.FS.writeFile('/six.raw', new Uint8Array(new Float32Array(44100 * 6).fill(0.01).buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '6', '-channel_layout', '5.1', '-i', '/six.raw', '-c:a', 'pcm_f32le', '/six.wav']);
  run(encodeArgs(source, defaults('wav', source), '/six.wav', '/stereo.wav'));
  assert.equal(probe('/six.wav').channels, 6);
  assert.equal(probe('/stereo.wav').channels, 2);
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
      const chunk = { key: target.key, start, end: Math.min(player.totalFrames, start + 48000 * 8), buffer: {} };
      player.cache.push(chunk);
      return chunk;
    };
    await player.play();
    await new Promise(setImmediate);
    assert.equal(player.buffering, false);
    assert.equal(started.length, 2, '現在と次区間を隙間なく予約');
    assert.equal(started[1][0], started[0][0] + started[0][2]);
    for (const time of [7.9, 8.1, 12.1, 16.1, 20.1]) {
      context.currentTime = time;
      await player.pump();
      assert.equal(player.buffering, false, '区間の境界でもバッファ待ちにならない');
      for (let i = 1; i < started.length; i++) assert.equal(started[i][0], started[i - 1][0] + started[i - 1][2], '予約した再生に隙間を作らない');
    }
    let clock = 21;
    const oldAnchor = player.anchorTime, oldFrame = player.anchorFrame;
    Object.defineProperty(context, 'currentTime', { configurable: true, get: () => (clock += 1 / 48000) });
    player.select({ id: 'mp3', config: { codec: 'mp3', channels: 2 }, blob: {} });
    await new Promise(setImmediate);
    assert.equal(player.target.id, 'mp3');
    assert.equal(stopped.at(-1), started.at(-1)[0], '旧音声の停止時刻と新音声の開始時刻が一致');
    assert.equal(player.anchorFrame, oldFrame + Math.round((player.anchorTime - oldAnchor) * 48000), '時計が読み取り中に進んでも切替位置をずらさない');
    Object.defineProperty(context, 'currentTime', { configurable: true, writable: true, value: started.at(-1)[0] });
    player.pause();
    const paused = player.position;
    context.currentTime += 5;
    assert.equal(player.position, paused);
    player.loop = true;
    player.seek(59);
    await player.play();
    await new Promise(setImmediate);
    assert.equal(player.canEncode, true, '末尾まで準備済みなら残り2秒未満でも変換できる');
    context.currentTime = player.endTime;
    await player.pump();
    assert.equal(player.position, 0, 'ループ時は末尾から先頭に戻る');
    assert.equal(player.playing, true);
    assert.equal(player.target.id, 'mp3', 'ループしても選択中の形式を維持');
    await player.pump();
    assert.equal(player.buffering, false, '先頭区間を準備したら再生を再開');
    player.loop = false;
    player.seek(59);
    await player.pump();
    context.currentTime = player.endTime;
    await player.pump();
    assert.equal(player.playing, false, 'ループをオフにすると末尾で停止');
    assert.equal(player.position, 60);
    const beforeReplay = started.length;
    await player.play();
    await new Promise(setImmediate);
    assert.equal(started.length, beforeReplay + 2, '末尾から再生し直しても先頭と次区間を予約する');
    assert.ok(player.cache.every(c => c.start < 16 * 48000), '末尾のキャッシュを先頭の先読みに数えない');
    player.pause();
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
