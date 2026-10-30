import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrumFrames, FFT_SIZE } from '../analysis.js';
import { melAt, melPosition, timePosition, fftColumns, averageSpectrum, bandDifference, frameBandDifferences, differenceColor, ComparisonGraph } from '../graph.js';
import { Player } from '../audio.js';

test('周波数とdBFSを校正し、逆位相ステレオ・無音・短い音源を扱う', () => {
  const rate = 48000, bin = 128;
  const tone = Float32Array.from({ length: rate }, (_, i) => .5 * Math.sin(2 * Math.PI * bin * i / FFT_SIZE));
  const mono = spectrumFrames([tone], rate);
  const stereo = spectrumFrames([tone, tone.map(v => -v)], rate);
  assert.deepEqual(mono.powers, stereo.powers, '逆位相でも音が相殺されない');
  const db = averageSpectrum(mono, .5);
  assert.equal(db.indexOf(Math.max(...db)), bin, '1,500 Hzの位置');
  assert.ok(Math.abs(db[bin] + 6.0206) < .001, '振幅0.5は約−6 dBFS');
  const quiet = averageSpectrum(spectrumFrames([tone.map(v => v / 10)], rate), .5);
  assert.ok(Math.abs(db[bin] - quiet[bin] - 20) < .001, '音源別の自動正規化をしない');
  // FFTとは別の直接DFTで、ビンに一致しない音の周辺と漏れ成分も照合する。
  const offBin = Float32Array.from({ length: FFT_SIZE }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * i / rate));
  const measured = spectrumFrames([offBin], rate);
  for (const k of [1, 36, 37, 38, 60]) {
    let real = 0, imaginary = 0, weight = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
      weight += w;
      real += offBin[i] * w * Math.cos(2 * Math.PI * k * i / FFT_SIZE);
      imaginary -= offBin[i] * w * Math.sin(2 * Math.PI * k * i / FFT_SIZE);
    }
    const expected = 4 * (real ** 2 + imaginary ** 2) / weight ** 2;
    assert.ok(Math.abs(measured.powers[k] - expected) < Math.max(1e-18, expected * 1e-6), 'FFTと直接DFTのパワーが一致する');
  }
  assert.ok(averageSpectrum(spectrumFrames([new Float32Array(100)], rate), 0).every(v => v === -120));
  assert.ok(averageSpectrum(spectrumFrames([tone.slice(0, 100)], rate), 0).every(Number.isFinite));
  assert.throws(() => spectrumFrames([new Float32Array(rate * 4 + 1)], rate));
  assert.throws(() => spectrumFrames([tone, new Float32Array(1)], rate));
});

test('グラフは再生用Workerを使わず、既存PCMだけを再利用する', async () => {
  const player = new Player(() => {}, error => { throw error; });
  clearInterval(player.timer);
  let calls = 0;
  try {
    player.context = { sampleRate: 48000, currentTime: 1, close() {} };
    player.setSource({ duration: 60, channels: 2, rate: 48000, file: {} });
    player.pump = () => {};
    const target = player.target;
    player.engine.decode = async () => { calls++; throw Error('再生用Workerを使ってはいけない'); };
    player.playing = true; player.anchorFrame = 123; player.anchorTime = 0;
    player.scheduledEnd = 96000;
    assert.equal(await player.analysisChunk(target, 0, 192000), null, '先読み2秒未満なら待機');
    player.scheduledEnd = 480000;
    player.requested = { id: 'next' };
    assert.equal(await player.analysisChunk(target, 0, 192000), null, '切替中は待機');
    player.requested = null; player.busy = true;
    assert.equal(await player.analysisChunk(target, 0, 192000), null, '復号を並列実行しない');
    player.busy = false;
    assert.equal(await player.analysisChunk(target, 0, 192000), null);
    const chunk = { key: target.key, start: 0, end: 192000, buffer: {} };
    assert.equal(calls, 0); assert.equal(player.anchorFrame, 123, '分析で再生時計を変えない');
    assert.equal(player.busy, false);
    player.cache = [chunk]; player.busy = true;
    assert.equal(await player.analysisChunk(target, 48000, 48000), chunk, '復号中でも既存PCMを使える');
    assert.equal(calls, 0);
    player.context.createBuffer = (channels, length) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: ch => data[ch] };
    };
    player.cache = [0, 96000].map(start => ({ key: target.key, start, end: start + 96000,
      buffer: { getChannelData: () => Float32Array.from({ length: 96000 }, (_, i) => start + i) } }));
    const joined = await player.analysisChunk(target, 48000, 96000);
    assert.equal(calls, 0, '2区間の境界も追加復号せず取り出す');
    assert.deepEqual(joined.buffer.getChannelData(0), Float32Array.from({ length: 96000 }, (_, i) => 48000 + i));
    player.busy = false; player.cache = []; player.playing = false;
    assert.equal(await player.analysisChunk(target, 0, 192000), null, '停止中の不足分も変換側で復号する');
  } finally { player.dispose(); }
});

test('シークで古い再生復号を捨て、キャッシュに混ぜない', async () => {
  const player = new Player(() => {}, error => { throw error; });
  clearInterval(player.timer);
  let finish;
  try {
    player.context = { sampleRate: 48000, currentTime: 0, close() {}, createBuffer: () => { throw Error('古い結果を展開してはいけない'); } };
    player.setSource({ duration: 60, channels: 1, rate: 48000, file: {} });
    player.engine = {
      decode: () => new Promise(resolve => { finish = resolve; }), terminate() {},
    };
    const pending = player.decode(player.target, 0, player.revision);
    await new Promise(setImmediate);
    player.seek(30); finish();
    assert.equal(await pending, null);
    assert.equal(player.position, 30); assert.deepEqual(player.cache, []);
  } finally { player.dispose(); }
});

test('差分の符号・無音マスク・色相・表示上限', () => {
  assert.equal(bandDifference(.01, .01), 0);
  assert.equal(bandDifference(.01, .0001), -20);
  assert.equal(bandDifference(.0001, .01), 20);
  assert.equal(bandDifference(1e-12, 1e-10), 0, '両方−90 dBFS未満なら無音');
  assert.equal(bandDifference(.1, 0), -24);
  assert.equal(bandDifference(0, .1), 24);
  const blue = differenceColor(-24), neutral = differenceColor(0), red = differenceColor(24);
  assert.ok(blue[2] > blue[0]); assert.ok(red[0] > red[2]);
  assert.equal(neutral[0], neutral[2]);
});

test('差分はFFT窓ごとに計算し、隣の窓へ変化を広げない', () => {
  const data = powers => ({ times: Float32Array.from([0, .1, .2, .3, .4]), bins: 1, powers: Float32Array.from(powers) });
  const reference = data([1, 1, 1, 1, 1]);
  const changing = data([1, 1, 2, 1, 1]);
  const differences = frameBandDifferences(reference, changing, 0, 1);
  assert.ok(Math.abs(differences[2] - 3.0103) < .001);
  for (const row of [0, 1, 3, 4]) assert.equal(differences[row], 0, '前後の窓へにじませない');
  const louder = data([2, 2, 2, 2, 2]);
  for (const db of frameBandDifferences(reference, louder, 0, 1)) assert.ok(Math.abs(db - 3.0103) < .001, '約+3 dBを正規化で消さない');
});

test('差分画像と再生位置の線はFFTの実時刻を同じ横座標へ対応させる', () => {
  for (const rate of [44100, 48000]) for (const length of [100, Math.round(rate * .53), rate * 4]) {
    const data = spectrumFrames([new Float32Array(length)], rate), duration = length / rate;
    const width = 4096, columns = fftColumns(data, width);
    for (let row = 0; row < data.times.length; row++) {
      const cursor = timePosition(data.times[row], duration) * width;
      assert.equal(columns[Math.min(width - 1, Math.floor(cursor))], row, '窓の中心時刻と再生位置の線が同じ窓を指す');
    }
    for (let x = 0; x < width; x += 17) {
      const seconds = (x + .5) / width * duration;
      let nearest = 0;
      for (let row = 1; row < data.times.length; row++) if (Math.abs(data.times[row] - seconds) <= Math.abs(data.times[nearest] - seconds)) nearest = row;
      assert.equal(columns[x], nearest, '先頭・末尾・不均等な最後のFFT窓でも実時刻で選ぶ');
    }
  }
  assert.equal(timePosition(0, 4), 0); assert.equal(timePosition(4, 4), 1);
});

test('メル尺度は20 Hzからナイキストまで対応し、低域の表示面積を抑える', () => {
  const mel = hz => 2595 * Math.log10(1 + hz / 700);
  for (const maxHz of [4000, 22050, 24000, 96000]) {
    assert.equal(melPosition(20, maxHz), 0);
    assert.equal(melPosition(maxHz, maxHz), 1);
    for (const hz of [20, 100, 500, 1000, maxHz]) {
      const position = (mel(hz) - mel(20)) / (mel(maxHz) - mel(20));
      assert.ok(Math.abs(melPosition(hz, maxHz) - position) < 1e-12);
      assert.ok(Math.abs(melAt(position, maxHz) - hz) < 1e-8);
    }
  }
  assert.ok(Math.abs(melPosition(100, 24000) - .0298024) < 1e-6, '20〜100 Hzは高さの約3%');
});

test('メル尺度の差分画像は約0.1秒×64帯域に集計する', () => {
  const previousDocument = globalThis.document;
  let pixels;
  const canvas = { getContext: () => ({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: image => { pixels = image.data; },
  }) };
  globalThis.document = { createElement: () => canvas };
  try {
    const reference = { rate: 48000, length: 48000, times: [.5], bins: 2049, powers: new Float32Array(2049).fill(1) };
    const selected = { ...reference, powers: Float32Array.from({ length: 2049 }, (_, bin) => 10 ** (bin / 2048 * 2.4)) };
    ComparisonGraph.prototype.heatmap([reference, selected], 1);
    assert.equal(canvas.height, 64);
    for (const y of [0, 16, 32, 48, 63]) {
      const melMin = 2595 * Math.log10(1 + 20 / 700), melMax = 2595 * Math.log10(1 + 24000 / 700);
      const hzAt = position => 700 * (10 ** ((melMin + position * (melMax - melMin)) / 2595) - 1);
      const a = Math.max(1, Math.round(hzAt((63 - y) / 64) / (48000 / 4096)));
      const b = Math.max(a + 1, Math.round(hzAt((64 - y) / 64) / (48000 / 4096)));
      let power = 0;
      for (let bin = a; bin < b; bin++) power += selected.powers[bin];
      assert.deepEqual([...pixels.slice(y * 4, y * 4 + 3)], differenceColor(10 * Math.log10(power / (b - a))), '画像の帯域とメル尺度の目盛りが一致する');
    }
    const short = { rate: 48000, length: 9600, times: [.025, .075, .125, .175], bins: 65, powers: new Float32Array(65 * 4).fill(1) };
    const changing = { ...short, powers: Float32Array.from({ length: 65 * 4 }, (_, i) => i >= 65 && i < 130 ? 9 : 1) };
    ComparisonGraph.prototype.heatmap([short, changing]);
    assert.equal(canvas.width, 2, '0.2秒を2列に集計');
    assert.deepEqual([...pixels.slice(0, 3)], differenceColor(10 * Math.log10(5)), 'dB値や色ではなくパワーを平均する');
    assert.deepEqual([...pixels.slice(4, 7)], differenceColor(0), '変化を隣の時間マスへ広げない');
    const tiny = { ...short, length: 100, times: [50 / 48000], powers: new Float32Array(65).fill(1) };
    ComparisonGraph.prototype.heatmap([tiny, tiny]);
    assert.equal(canvas.width, 1);
    assert.deepEqual([...pixels.slice(0, 3)], differenceColor(0), '短い末尾も表示する');
    const sparse = { ...short, times: [.05], powers: new Float32Array(65).fill(1) };
    ComparisonGraph.prototype.heatmap([sparse, sparse]);
    assert.deepEqual([...pixels.slice(4, 7)], differenceColor(0), 'FFT窓がないマスは最も近い窓を使う');
    const full = { ...short, length: 48000 * 4 };
    ComparisonGraph.prototype.heatmap([full, full]);
    assert.equal(canvas.width, 40, '4秒でも40列だけ保持する');
  } finally { globalThis.document = previousDocument; }
});

test('シーク先も4秒境界から復号し、同じPCMをグラフに渡す', async () => {
  const player = new Player(() => {}, error => { throw error; }); clearInterval(player.timer);
  const calls = [];
  const buffer = {};
  try {
    player.context = { sampleRate: 48000, close() {} };
    player.setSource({ duration: 20, channels: 2, rate: 44100, file: {} });
    player.engine.decode = async (source, target, start, frames) => { calls.push([start, frames]); return buffer; };
    const chunk = await player.decode(player.target, 48000 * 1.6, player.revision);
    assert.deepEqual(calls, [[0, 48000 * 8]]);
    assert.equal(player.analysisChunk(player.target, 0, 48000 * 4), chunk);
    assert.equal(player.analysisChunk(player.target, 48000 * 4, 48000 * 4).buffer, buffer);
    assert.equal(calls.length, 1, '2つの分析区間でも再復号しない');
  } finally { player.dispose(); }
});

test('2つのグラフは同じFFT結果と位置を描き、差分画像を再利用する', () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  let images = 0;
  const canvas = () => {
    const context = { labels: [], images: [],
      setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, putImageData() {},
      fillText(text) { this.labels.push(text); }, measureText: text => ({ width: text.length * 6 }),
      drawImage(image) { this.images.push(image); }, createLinearGradient: () => ({ addColorStop() {} }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    };
    return { style: {}, attributes: {}, context, getContext: () => context,
      setAttribute(name, value) { this.attributes[name] = value; } };
  };
  globalThis.document = { createElement() { images++; return canvas(); } };
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const data = spectrumFrames([new Float32Array(48000 * 4)], 48000);
    const graph = Object.create(ComparisonGraph.prototype);
    graph.frequencyCanvas = canvas(); graph.canvas = canvas();
    graph.status = { textContent: '4.0–8.0 秒' };
    graph.display = { start: 4, data: [data, data] };
    graph.draw(500, 1, 'Opus');
    const image = graph.display.image;
    graph.draw(500, 2, 'Opus');
    assert.match(graph.frequencyCanvas.attributes['aria-label'], /周波数スペクトル.*4.0–8.0 秒/);
    assert.match(graph.canvas.attributes['aria-label'], /時間×周波数の差分.*4.0–8.0 秒/);
    assert.equal(images, 1, '再生位置が進んでも差分画像を作り直さない');
    assert.deepEqual(graph.canvas.context.images, [image, image]);
    assert.equal(graph.frequencyCanvas.width, 500);
    assert.equal(graph.canvas.width, 500);
    assert.ok(graph.canvas.context.labels.includes('4.0 s'));
    assert.ok(graph.canvas.context.labels.includes('8.0 s'));
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; }
});

test('次区間の先読み・余裕不足での休止と自動再開・表示保持・折りたたみ時の破棄', async () => {
  const previousDocument = globalThis.document, previousWorker = globalThis.Worker;
  const elements = Object.fromEntries(['graph', 'graph-plots', 'frequency-canvas', 'graph-canvas', 'graph-status', 'graph-selected'].map(id =>
    [id, { events: {}, addEventListener(name, fn) { this.events[name] = fn; }, hidden: true, open: false, parentElement: { clientWidth: 500 } }]));
  let decoded = 0, drawn = 0, worker, available = true, released = 0;
  globalThis.document = { hidden: false, getElementById: id => elements[id], addEventListener() {} };
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(data) { this.inputs = data.channels; }
    terminate() { this.stopped = true; }
  };
  const pcm = new Float32Array(48000 * 4);
  const player = { source: { duration: 20, channels: 1 }, position: 0, rate: 48000, totalFrames: 48000 * 20, playing: true,
    ahead: 8, scheduledEnd: 48000 * 8, buffering: false, target: { key: 'reference', reference: true }, ensureContext() {} };
  const results = [{ length: pcm.length, rate: 48000 }];
  try {
    const graph = new ComparisonGraph(() => player, () => player.target.key, async (_, target, start) => {
      if (!available) return null;
      // 再生キャッシュは分析区間より前から始まり、追加復号は分析開始位置から始まる場合。
      const leading = target.reference ? 0 : 48000;
      const samples = Float32Array.from({ length: pcm.length + leading }, (_, i) => (start - leading + i) / 1048576);
      decoded++; return { start: start - leading, buffer: { numberOfChannels: 1, getChannelData: () => samples } };
    }, () => released++);
    graph.draw = () => drawn++;
    graph.tick(); assert.equal(decoded, 0);
    elements.graph.open = true; graph.tick(); await new Promise(setImmediate);
    assert.equal(decoded, 1); assert.equal(worker.inputs.length, 1, '同一PCMは1回だけ分析');
    worker.onmessage({ data: { results } }); await new Promise(setImmediate);
    graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.display.start, 0); assert.equal(decoded, 2, '次の4秒分を先読み');
    assert.equal(graph.display.data[0].length / graph.display.data[0].rate, 4, '表示範囲は4秒');
    const beforePause = { decoded, drawn, released, display: graph.display, position: graph.display.position };
    const cancelledWorker = worker, lateResult = worker.onmessage;
    player.ahead = 2; graph.tick();
    assert.equal(graph.suspended, false, '2秒ちょうどでは休止しない');
    player.ahead = 1.99; player.position = 1.5; graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.suspended, true);
    assert.equal(cancelledWorker.stopped, true, '実行中のFFTを取り消す');
    assert.equal(released, beforePause.released + 1, 'グラフ専用の追加復号を解放する');
    assert.equal(graph.busy, false);
    assert.equal(graph.display, beforePause.display, '表示済みのグラフを残す');
    assert.equal(graph.display.position, beforePause.position, '休止中は位置の線を進めない');
    assert.equal(graph.blocks.get(0), beforePause.display, '完成済みのFFT結果を残す');
    assert.match(elements['graph-status'].textContent, /0.0–4.0 秒.*再生を優先してグラフを休止中/);
    lateResult({ data: { results } }); await new Promise(setImmediate);
    assert.equal(graph.blocks.has(4), false, '取り消したFFTの遅れた結果を採用しない');
    for (const ahead of [0, 2, 3.99]) {
      player.ahead = ahead; graph.tick(); await new Promise(setImmediate);
      assert.equal(graph.suspended, true, '4秒に回復するまでは休止を維持する');
      assert.equal(decoded, beforePause.decoded);
      assert.equal(drawn, beforePause.drawn);
      assert.equal(released, beforePause.released + 1, '休止中の各tickで取り消しを繰り返さない');
      assert.equal(player.playing, true, 'グラフの休止で再生を止めない');
    }
    player.ahead = 4; graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.suspended, false);
    assert.equal(graph.display.position, 1.5, '回復後は現在の再生位置から描画する');
    assert.equal(decoded, beforePause.decoded + 1, '次区間の分析を再開する');
    assert.notEqual(worker, cancelledWorker);
    worker.onmessage({ data: { results } }); await new Promise(setImmediate);
    player.ahead = 8;
    player.position = 4.1; available = false; graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.display.start, 4, '境界に到達したら準備済みの結果に切り替える');
    assert.equal(graph.display.data[0].length / graph.display.data[0].rate, 4, '移動後も表示範囲は4秒');
    assert.equal(elements['graph-plots'].hidden, false);
    const position = graph.display.position;
    player.position = 8.1; graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.display.start, 4, '新しい区間が未準備でも消さない');
    assert.equal(graph.display.position, position, '古い区間の再生位置を進めない');
    assert.match(elements['graph-status'].textContent, /更新待ち/);
    available = true; player.position = 19.9; graph.tick(); await new Promise(setImmediate);
    const oldWorker = worker;
    assert.equal(graph.busy, true, '末尾区間の分析結果を待っている');
    player.position = 0; graph.tick(); await new Promise(setImmediate);
    assert.equal(oldWorker.stopped, true, '再生し直しで古い分析待ちを取り消す');
    assert.notEqual(worker, oldWorker);
    assert.equal(graph.busy, true, '古い処理の完了で新しい処理の待機状態を上書きしない');
    worker.onmessage({ data: { results } }); await new Promise(setImmediate);
    player.playing = false; graph.tick();
    assert.equal(graph.display.start, 0, '再生し直し後のグラフを更新できる');
    assert.doesNotMatch(elements['graph-status'].textContent, /更新待ち/);
    available = false;
    player.target = { key: 'opus' }; graph.tick(); await new Promise(setImmediate);
    assert.equal(elements['graph-selected'].textContent, 'reference', '表示中の音源名を偽らない');
    available = true; graph.tick(); await new Promise(setImmediate);
    assert.equal(worker.inputs.length, 2);
    assert.deepEqual(worker.inputs[0][0], worker.inputs[1][0], '開始位置が異なるPCMから同じ時刻のサンプルを取り出す');
    worker.onmessage({ data: { results: [{ ...results[0], role: 'selected' }, { ...results[0], role: 'reference' }] } });
    await new Promise(setImmediate); graph.tick();
    assert.equal(graph.display.data[0].role, 'reference', '差分の分母は基準PCM');
    assert.equal(graph.display.data[1].role, 'selected', '差分の分子は選択音源');
    const beforeNext = decoded;
    player.playing = false; graph.tick(); await new Promise(setImmediate);
    assert.equal(decoded, beforeNext, '停止中は表示外の次区間を新しく分析しない');
    player.playing = true; graph.tick(); await new Promise(setImmediate);
    assert.equal(decoded, beforeNext + 2, '再生中は次の4秒を準備する');
    worker.onmessage({ data: { results: [results[0], results[0]] } }); await new Promise(setImmediate);
    graph.tick();
    assert.equal(graph.blocks.get(4).start, 4, '次の4秒をキャッシュする');
    assert.equal(graph.blocks.size, 2, 'FFT結果は現在と次の4秒だけ保持する');
    player.ahead = 1; player.buffering = true; graph.tick();
    assert.equal(graph.suspended, true, 'バッファ待ちでも休止する');
    player.scheduledEnd = player.totalFrames; player.buffering = false; graph.tick(); await new Promise(setImmediate);
    assert.equal(graph.suspended, false, '末尾まで予約済みなら残量が少なくても再開できる');
    player.scheduledEnd = 48000 * 8; graph.tick();
    assert.equal(graph.suspended, true);
    player.playing = false; graph.tick();
    assert.equal(graph.suspended, false, '一時停止中も分析と描画を再開する');
    player.playing = true; player.ahead = 8;
    player.position = 18; graph.tick(); await new Promise(setImmediate);
    worker.onmessage({ data: { results: [results[0], results[0]] } }); await new Promise(setImmediate);
    graph.tick();
    assert.equal(graph.display.start, 16, '末尾の4秒区間を表示する');
    elements.graph.open = false; elements.graph.events.toggle(); await new Promise(setImmediate);
    assert.equal(worker.stopped, true); assert.equal(graph.display, null); assert.equal(graph.busy, false);
    assert.equal(graph.input, null); assert.equal(graph.blocks.size, 0); assert.ok(released > 0);
    const before = decoded;
    elements.graph.open = true; document.hidden = true; graph.tick();
    assert.equal(decoded, before, '非表示では再開しない');
  } finally { globalThis.document = previousDocument; globalThis.Worker = previousWorker; }
});
