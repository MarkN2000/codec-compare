import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gameCandidates, shuffled, ListeningGame } from '../game.js';
import { defaults, encodeArgs } from '../model.js';

const source = { rate: 48000, channels: 2, frames: 48000 * 60, duration: 60 };
const pattern = (id, codec, changes = {}) => ({ id, state: 'ready', blob: { size: 960000 }, config: { ...defaults(codec, source), ...changes } });

test('聴き当ては完成済みだけを使い、同じ設定・可逆PCM条件を重複出題しない', () => {
  const patterns = [pattern('opus', 'opus'), pattern('same', 'opus'), pattern('low', 'opus', { bitrate: 48 }),
    pattern('cbr', 'opus', { mode: 'CBR' }), pattern('cut', 'opus', { cutoff: 12000 }),
    pattern('wav24', 'wav'), pattern('flac24', 'flac'), pattern('flac24-high', 'flac', { level: 12 }),
    pattern('flac16', 'flac', { depth: 16 }), pattern('wav16', 'wav', { depth: 16 }),
    pattern('mono', 'flac', { channels: 1 }), pattern('rate', 'flac', { rate: 44100 }),
    { ...pattern('queued', 'mp3'), state: 'queued' }, { ...pattern('failed', 'mp3'), state: 'error' }, { ...pattern('missing', 'mp3'), blob: null }];
  assert.deepEqual(gameCandidates(patterns).map(p => p.id), ['opus', 'low', 'cbr', 'cut', 'wav24', 'flac16', 'mono', 'rate']);
  const input = [0, 1, 2, 3];
  assert.deepEqual(shuffled(input, () => 0), [1, 2, 3, 0]);
  assert.deepEqual(shuffled(input, () => .999), input);
  assert.deepEqual(input, [0, 1, 2, 3], '選択肢の並びを出題順の変更で書き換えない');
});

test('準備・バッファ待ち・切り替え中は説明行を表示せず、ボタンで状態を伝える', () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    return nodes.get(selector);
  };
  const game = { active: true, phase: 'answered', listen: 'correct', preparing: false, error: '',
    player: { position: 12, loop: false, playing: false }, stage: { querySelector: node, querySelectorAll: () => [] } };
  const tick = () => ListeningGame.prototype.tick.call(game);
  for (const state of [{ preparing: true }, { buffering: true }, { requested: {} }]) {
    game.preparing = Boolean(state.preparing); game.player.buffering = Boolean(state.buffering); game.player.requested = state.requested;
    tick();
    assert.equal(node('#game-status').hidden, true, '準備中に高さを増やす説明行を出さない');
    assert.equal(node('#game-status').textContent, '');
    assert.equal(node('#game-play').attributes['aria-busy'], 'true', '固定サイズのボタンでスピナーを表示する');
    assert.equal(node('#game-play').attributes['aria-label'], '音声を準備中');
  }
  game.player.requested = null; tick();
  assert.equal(node('#game-play').attributes['aria-busy'], 'false');
  assert.equal(node('#game-play').attributes['aria-label'], '再生');
  game.error = '音声を準備できませんでした。'; tick();
  assert.equal(node('#game-status').hidden, false); assert.equal(node('#game-status').textContent, game.error);
  assert.equal(node('#game-retry').hidden, false, 'エラー時の再試行は残す');
});

test('聴き当ての準備・採点・再試行・終了は既存Playerを使い、遅い結果を持ち越さない', async () => {
  const previousDocument = globalThis.document, nodes = new Map(), classes = new Set();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {},
      showModal() { this.open = true; }, close() { this.open = false; }, querySelector: selector => node(selector), querySelectorAll: () => [] });
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } };
  const patterns = [pattern('normal', 'opus'), pattern('other', 'mp3')], calls = [];
  let release, wait = null, activeDecodes = 0, maxDecodes = 0, failed = false;
  const player = { source, target: { id: 'normal' }, position: 12.345, loop: true, revision: 0, busy: false, playing: true,
    get frame() { return Math.round(this.position * 48000); }, get totalFrames() { return 60 * 48000; },
    pause() { this.playing = false; this.revision++; }, select(p) { this.target = { id: p?.id || 'reference' }; }, seek(seconds) { this.position = seconds; this.revision++; }, ensureContext() {},
    async decode(target, start, revision) {
      calls.push({ target: target.id, start }); activeDecodes++; maxDecodes = Math.max(maxDecodes, activeDecodes);
      try { if (wait) await wait; if (failed) throw Error('設定を含む内部エラー'); return revision === this.revision ? {} : null; }
      finally { activeDecodes--; }
    } };
  let opened = 0, closed = 0, renders = 0, ticks = 0;
  try {
    const game = new ListeningGame(() => player, () => patterns, () => opened++, () => closed++);
    game.renderQuestion = () => renders++; game.tick = () => ticks++;
    game.open(); assert.equal(opened, 1); assert.ok(classes.has('cc-game-open')); assert.equal(player.playing, false);
    assert.ok(node('game-stage').innerHTML.includes('基準PCM比 5.6%'), '実サイズと基準PCMから選択肢の数値を求める');
    await game.start([0, 0]); assert.equal(game.phase, 'setup', '1択・重複選択では開始しない');
    await game.start([0, 1]); assert.equal(game.preparing, false);
    assert.equal(calls[0].target, game.items[game.order[0]].id); assert.equal(calls[0].start, Math.round(12.345 * 48000));
    ListeningGame.prototype.renderQuestion.call(game);
    assert.ok(node('game-stage').innerHTML.includes('data-listen="reference"'), '出題中も基準音源を選べる');
    assert.ok(!node('game-stage').innerHTML.includes('data-listen="selected"'), '出題中は選んだ音を表示しない');
    const prepare = game.prepare.bind(game); let preparation;
    game.prepare = () => preparation = prepare();
    const listen = value => node('game-stage').listeners.click({ target: { closest: () => ({ dataset: { listen: value } }) } });
    listen('reference'); await preparation;
    assert.equal(player.target.id, 'reference'); assert.equal(player.position, 12.345); assert.equal(player.playing, false);
    assert.equal(calls.at(-1).target, 'reference', '基準の準備・再試行はPCM音源を復号する');
    player.playing = true; const decodes = calls.length;
    listen('correct'); assert.equal(player.target.id, game.items[game.order[0]].id);
    assert.equal(player.playing, true); assert.equal(player.position, 12.345);
    assert.equal(calls.length, decodes, '再生中の切り替えは既存Playerの同期切り替えに任せる');
    player.pause(); listen('reference'); await preparation;
    const beforeEnd = calls.length;
    node('game-stage').listeners.change({ target: { id: 'game-seek', value: '60' } });
    assert.equal(player.position, 60); assert.equal(calls.length, beforeEnd, '停止中に末尾へシークしても勝手に先頭へ戻さない');
    player.seek(12.345);
    game.selected = game.order[0]; await game.answer(); game.answer(); assert.equal(game.score, 1, '基準を聴いて回答しても採点し、連打では二重採点しない');
    assert.equal(game.listen, 'correct'); assert.equal(player.target.id, game.items[game.order[0]].id, '答え合わせは正解の音へ戻す');
    ListeningGame.prototype.renderQuestion.call(game);
    assert.ok(!node('game-stage').innerHTML.includes('data-listen="selected"'), '正解時は選んだ音を省く');
    listen('reference'); await preparation;
    await game.next(); assert.equal(game.listen, 'correct'); assert.equal(player.target.id, game.items[game.order[1]].id, '次の問題は問題の音へ戻す');
    game.selected = 1 - game.order[1]; game.answer();
    ListeningGame.prototype.renderQuestion.call(game);
    assert.ok(node('game-stage').innerHTML.includes('data-listen="selected"') && node('game-stage').innerHTML.includes('data-listen="reference"'), '誤答時は正解・選んだ音・基準の3択');
    listen('selected'); await preparation; assert.equal(player.target.id, game.items[game.selected].id);
    listen('reference'); await preparation; assert.equal(player.target.id, 'reference');
    await game.next();
    assert.equal(game.phase, 'result'); assert.ok(node('game-stage').innerHTML.includes('2問中 <strong>1</strong> 問正解'));
    game.setup(); await game.start([0, 1]);
    game.selected = 1 - game.order[0]; game.answer(); game.listen = 'selected'; failed = true;
    await game.prepare(); assert.ok(game.error); assert.ok(!game.error.includes('内部エラー'), '答えにつながるエラー詳細を見せない');
    failed = false; player.target = { id: 'normal' };
    await game.prepare(); assert.equal(player.target.id, game.items[game.selected].id, '再試行でも選んだ音を準備する');
    wait = new Promise(resolve => { release = resolve; });
    const pending = game.prepare(); assert.equal(player.busy, true);
    const superseded = game.prepare();
    player.position = 33; player.loop = false;
    game.close(); const lastRender = renders, lastTick = ticks;
    release(); await Promise.all([pending, superseded]);
    assert.equal(player.busy, false); assert.equal(maxDecodes, 1, '復号Workerを並列使用しない');
    assert.equal(renders, lastRender); assert.equal(ticks, lastTick, '終了後の結果でゲーム画面を更新しない');
    assert.equal(player.target.id, 'normal'); assert.equal(player.position, 12.345); assert.equal(player.loop, true); assert.equal(player.playing, false);
    assert.equal(closed, 1); assert.ok(!classes.has('cc-game-open')); assert.equal(game.pool, null);
    game.open(); node('game').listeners.close(); assert.equal(game.active, true, '前のcloseイベントで新しいゲームを閉じない');
    node('game').listeners.cancel({ preventDefault() {} }); assert.equal(game.active, false, 'Escapeで復元して終了する');
  } finally { globalThis.document = previousDocument; }
});

test('同じ選択肢として扱うFLACとWAVは、実WASMで16／24 bit・レート・チャンネルを変えてもPCMが一致する', async () => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const core = await createRequire(import.meta.url)('../vendor/core/umd/ffmpeg-core.js')({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  let logs = []; core.setLogger(({ message }) => logs.push(message));
  const run = args => { logs = []; core.exec('-y', ...args); const code = core.ret; core.reset(); assert.equal(code, 0, logs.slice(-4).join('\n')); };
  const input = { rate: 44100, channels: 2, originalChannels: 2, codec: 'pcm_f32le', duration: 8000 / 44100, frames: 8000 };
  const samples = Float32Array.from({ length: input.frames * 2 }, (_, i) => .6 * Math.sin(i * .061) + .2 * Math.sin(i * .177));
  core.FS.writeFile('/input.raw', new Uint8Array(samples.buffer));
  run(['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '/input.raw', '/input.wav']);
  for (const rate of [44100, 48000]) for (const channels of [1, 2]) for (const depth of [16, 24]) {
    const pcm = [];
    for (const codec of ['flac', 'wav']) {
      run(encodeArgs(input, { ...defaults(codec, input), rate, channels, depth }, '/input.wav', `/encoded.${codec}`));
      run(['-v', 'error', '-i', `/encoded.${codec}`, '-c:a', 'pcm_f32le', '-f', 'f32le', '/decoded.raw']);
      pcm.push(core.FS.readFile('/decoded.raw'));
    }
    assert.deepEqual(pcm[0], pcm[1], `${rate} Hz・${channels} ch・${depth} bitの全サンプルが一致`);
  }
});
