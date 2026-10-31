import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Player } from '../audio.js';
import { ComparisonGraph } from '../graph.js';
import { defaults, validateConfig } from '../model.js';

test('停止中にグラフが準備した現在・次区間を、復号し直さず連続予約する', async () => {
  let now = 0;
  const starts = [];
  const context = { sampleRate: 48000, get currentTime() { return now; }, destination: {}, resume: async () => {}, close() {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, stop() {}, start(when, offset, seconds) { starts.push({ when, offset, seconds }); } }) };
  const player = new Player(() => {}, error => { throw error; }); clearInterval(player.timer);
  try {
    player.setSource({ duration: 60, rate: 48000, channels: 2, file: {} }); player.context = context;
    const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
    const scope = vm.createContext({ source: player.source, player, encoder: null, encoding: false, graphBusy: false, graphDecoder: null,
      graphChunks: [], graphDecodeCost: 0, patterns: [], graph: { stats: { decodes: 0 } }, performance,
      Engine: class { async decode() { return {}; } terminate() {} } });
    vm.runInContext(app.slice(app.indexOf('function releaseGraphDecoder('), app.indexOf('function message(')), scope);
    await scope.readGraphChunk(player, player.target, 0, 4 * 48000);
    await scope.readGraphChunk(player, player.target, 16 * 48000, 4 * 48000);
    assert.equal(player.cache.length, 2);
    player.engine.decode = async () => { throw Error('準備済みの区間を復号し直してはいけない'); };
    for (const position of [0, 8]) {
      now = position; player.pause();
      const before = starts.length;
      await player.play(); await new Promise(setImmediate);
      assert.equal(starts.length, before + 2, '再生開始・再開の時点で次区間も予約する');
      assert.equal(starts[before + 1].when, starts[before].when + starts[before].seconds, '区間の間に隙間を作らない');
      assert.equal(player.scheduledEnd, 32 * 48000);
    }
    player.pause(); player.seek(0);
    player.cache = [{ key: 'reference', start: 0, end: 16 * 48000, buffer: {} },
      { key: 'reference', start: 12 * 48000, end: 28 * 48000, buffer: {} }];
    const beforeOverlap = starts.length;
    await player.play(); await new Promise(setImmediate);
    assert.equal(starts.length, beforeOverlap + 2);
    assert.equal(starts[beforeOverlap + 1].offset, 4, '重なる準備済み区間も予約済みの末尾から使う');
    assert.equal(starts[beforeOverlap + 1].when, starts[beforeOverlap].when + starts[beforeOverlap].seconds);
  } finally { player.dispose(); }
});

test('削除・再変換で対象のPCMとBlobを解放し、他パターンと遅い処理の整合性を保つ', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  for (const mode of ['remove', 'edit']) {
    const blob = {}, other = { blob: {} }, removed = { id: 'old', state: 'ready', blob, config: defaults('opus', { rate: 48000, channels: 2 }) };
    let finish, submit, pauses = 0, clears = 0;
    const graph = { generation: 0, cancelAnalysis: ComparisonGraph.prototype.cancelAnalysis };
    const instance = { source: {}, rate: 48000, totalFrames: 60 * 48000, revision: 0, context: {}, playing: false, canEncode: true,
      frame: 0, cache: [], target: { key: 'reference' }, analysisChunk: () => null, keepReference() {} };
    const scope = vm.createContext({ source: instance.source, player: instance, graph, encoder: null, encoding: false, graphBusy: false, graphDecoder: null,
      graphChunks: [other], graphDecodeCost: 0, performance, patterns: [removed], editing: mode === 'edit' ? removed : null,
      playback: { selected: mode === 'edit' ? 'old' : 'reference' }, draft: removed.config, validateConfig,
      clearPCM(value) { assert.equal(value, blob); clears++; }, render() {}, closeEditor() {}, message() {}, queue() {}, failure(error) { throw error; },
      $: () => ({ addEventListener(type, callback) { submit = callback; } }),
      Engine: class { decode() { this.blob = { temporaryPCM: true }; return new Promise(resolve => { finish = resolve; }); } terminate() { this.closed = true; } } });
    instance.pause = () => { pauses++; }; instance.select = () => { scope.playback.selected = 'reference'; };
    vm.runInContext(app.slice(app.indexOf('function releaseGraphDecoder('), app.indexOf('function message(')), scope);
    graph.releaseDecoder = clear => scope.releaseGraphDecoder(clear);
    vm.runInContext(app.slice(app.indexOf('function discardPreview('), app.indexOf('async function queue(')), scope);
    vm.runInContext(app.slice(app.indexOf("$('editor').addEventListener('submit'"), app.indexOf('for (const button of document.querySelectorAll')), scope);
    const pending = scope.readGraphChunk(instance, { key: 'old', blob }, 0, 4 * 48000);
    const decoder = scope.graphDecoder;
    scope.graphChunks.push({ blob });
    if (mode === 'remove') scope.act('remove', removed);
    else submit({ preventDefault() {} });
    assert.equal(clears, 1); assert.equal(decoder.closed, true); assert.equal(scope.graphDecoder, null);
    assert.deepEqual([...scope.graphChunks], [other], '他パターンの準備済みPCMは残す');
    finish({}); assert.equal(await pending, null, '遅れて完了した復号結果をキャッシュへ戻さない');
    assert.deepEqual([...scope.graphChunks], [other]);
    if (mode === 'remove') assert.equal(scope.patterns.length, 0);
    else { assert.equal(pauses, 1); assert.equal(removed.blob, null); assert.equal(removed.state, 'queued'); }
  }
});
