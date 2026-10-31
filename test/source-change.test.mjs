import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { LIMITS, defaults } from '../model.js';

test('音源変更で設定だけを保持し、解析後の自動変換・失敗・連続変更を扱う', async () => {
  // 実際の読み込み・キュー関数を使い、DOMと重い音声処理だけを置き換える。
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const elements = new Map(), engines = [], errors = [], releases = [];
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const config = { ...defaults('opus', { rate: 44100, channels: 2 }), bitrate: 192, cutoff: 12000 };
  const player = () => ({ canEncode: true, dispose() {}, setSource(source) { this.source = source; } });
  const context = vm.createContext({
    LIMITS, source: { file: { size: 10 } }, session: 0, encoding: true, graphBusy: false,
    patterns: [{ id: 'a', config, state: 'encoding', blob: { size: 99 }, progress: 50, error: '古いエラー' },
      { id: 'b', config: { ...defaults('g711', { rate: 44100, channels: 2 }), law: 'alaw' }, state: 'ready', blob: { size: 88 } }],
    player: player(), makePlayer: player, graph: { reset() {} }, encoder: null, editing: {}, draft: {},
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {}, querySelectorAll: () => [] }); return elements.get(id); },
    document: { createElement: () => ({}) }, render() {}, message() {}, failure: error => errors.push(error.message),
    sizeLabel: size => String(size), timeLabel: seconds => String(seconds), releaseGraphDecoder: clear => releases.push(clear),
    Engine: class {
      constructor() { engines.push(this); this.done = deferred(); }
      analyze(file) { this.file = file; return this.done.promise; }
      encode(source, config) { this.source = source; this.config = config; return this.done.promise; }
      terminate() { this.closed = true; }
    },
  });
  for (const [start, end] of [['async function loadFile(', 'function field('], ['async function queue(', 'function closeEditor(']]) {
    vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
  }
  const settle = () => new Promise(setImmediate);
  const source = name => ({ file: { name, size: 10 }, rate: 48000, channels: 1, originalChannels: 1, frames: 48000, duration: 1 });
  const first = source('新しい音源.wav');
  const loading = context.loadFile(first.file);
  assert.equal(context.source, null);
  assert.equal(context.patterns.length, 2);
  assert.equal(context.patterns[0].config.bitrate, 192);
  assert.equal(context.patterns[0].config.rate, 48000);
  assert.equal(context.patterns[0].config.channels, 2, '新音源がモノラルでも前の設定を保持');
  assert.equal(context.patterns[0].config.cutoff, 12000, '音源変更でも手動のカットオフを保持');
  assert.equal(context.patterns[1].config.codec, 'g711');
  assert.equal(context.patterns[1].config.law, 'alaw', 'G.711の圧伸方式も音源変更で維持');
  assert.equal(context.patterns[0].blob, undefined);
  assert.equal(context.patterns[0].progress, undefined);
  await context.queue(); assert.equal(engines.length, 1, '解析中は変換を始めない');
  context.graphBusy = true;
  engines[0].done.resolve(first); await loading;
  assert.equal(engines[0].closed, true);
  assert.equal(engines[1].source, first, '解析後すぐに新音源を変換');
  assert.equal(context.encoding, true, 'グラフの追加復号より変換を優先する');
  assert.equal(releases.at(-1), true, '変換用Workerを作る前に、待機中のグラフWorkerも解放する');
  engines[1].done.reject(Error('出力上限')); await settle();
  assert.equal(context.patterns[0].state, 'error');
  const next = context.queue(); engines[2].done.resolve({ size: 20 }); await next;
  assert.equal(context.patterns[1].state, 'ready', '1行の失敗で他の変換を止めない');
  const broken = context.loadFile({ name: '壊れた音源', size: 10 });
  engines[3].done.reject(Error('読めません')); await broken;
  assert.equal(context.patterns.length, 2, '読み込みに失敗しても設定を残す');
  assert.equal(context.source, null);
  const old = source('先に選んだ音源'), latest = source('最後に選んだ音源');
  const oldLoad = context.loadFile(old.file), latestLoad = context.loadFile(latest.file);
  assert.equal(engines[4].closed, true);
  engines[4].done.resolve(old); await oldLoad;
  assert.equal(context.source, null, '古い解析結果を採用しない');
  engines[5].done.resolve(latest); await latestLoad;
  const encoding = engines[6];
  const replacement = source('変換中に変更した音源'), replacementLoad = context.loadFile(replacement.file);
  encoding.done.resolve({ size: 777 }); await settle();
  assert.equal(context.patterns[0].blob, undefined, '旧音源の変換結果を混ぜない');
  engines[7].done.resolve(replacement); await replacementLoad;
  engines[8].done.resolve({ size: 30 }); await settle();
  const count = engines.length;
  await context.loadFile(undefined);
  assert.equal(engines.length, count, 'ファイル選択キャンセルは何も変えない');
  assert.equal(context.patterns[0].blob.size, 30);
  assert.deepEqual(errors, ['出力上限', '読めません']);
});
