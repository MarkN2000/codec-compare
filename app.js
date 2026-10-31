import { CODECS, LIMITS, defaults, ratesFor, bitratesFor, cutoffsFor, validateConfig, description, metrics, timeLabel, sizeLabel } from './model.js';
import { Engine, Player } from './audio.js';
import { clearPCM } from './pcm-cache.js';
import { ComparisonGraph } from './graph.js';

const $ = id => document.getElementById(id);
const actionIcons = {
  edit: '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path fill="currentColor" d="m924.8 625.7l-65.5-56c3.1-19 4.7-38.4 4.7-57.8s-1.6-38.8-4.7-57.8l65.5-56a32.03 32.03 0 0 0 9.3-35.2l-.9-2.6a443.7 443.7 0 0 0-79.7-137.9l-1.8-2.1a32.12 32.12 0 0 0-35.1-9.5l-81.3 28.9c-30-24.6-63.5-44-99.7-57.6l-15.7-85a32.05 32.05 0 0 0-25.8-25.7l-2.7-.5c-52.1-9.4-106.9-9.4-159 0l-2.7.5a32.05 32.05 0 0 0-25.8 25.7l-15.8 85.4a351.9 351.9 0 0 0-99 57.4l-81.9-29.1a32 32 0 0 0-35.1 9.5l-1.8 2.1a446 446 0 0 0-79.7 137.9l-.9 2.6c-4.5 12.5-.8 26.5 9.3 35.2l66.3 56.6c-3.1 18.8-4.6 38-4.6 57.1c0 19.2 1.5 38.4 4.6 57.1L99 625.5a32.03 32.03 0 0 0-9.3 35.2l.9 2.6c18.1 50.4 44.9 96.9 79.7 137.9l1.8 2.1a32.12 32.12 0 0 0 35.1 9.5l81.9-29.1c29.8 24.5 63.1 43.9 99 57.4l15.8 85.4a32.05 32.05 0 0 0 25.8 25.7l2.7.5a449.4 449.4 0 0 0 159 0l2.7-.5a32.05 32.05 0 0 0 25.8-25.7l15.7-85a350 350 0 0 0 99.7-57.6l81.3 28.9a32 32 0 0 0 35.1-9.5l1.8-2.1c34.8-41.1 61.6-87.5 79.7-137.9l.9-2.6c4.5-12.3.8-26.3-9.3-35M788.3 465.9c2.5 15.1 3.8 30.6 3.8 46.1s-1.3 31-3.8 46.1l-6.6 40.1l74.7 63.9a370 370 0 0 1-42.6 73.6L721 702.8l-31.4 25.8c-23.9 19.6-50.5 35-79.3 45.8l-38.1 14.3l-17.9 97a377.5 377.5 0 0 1-85 0l-17.9-97.2l-37.8-14.5c-28.5-10.8-55-26.2-78.7-45.7l-31.4-25.9l-93.4 33.2c-17-22.9-31.2-47.6-42.6-73.6l75.5-64.5l-6.5-40c-2.4-14.9-3.7-30.3-3.7-45.5c0-15.3 1.2-30.6 3.7-45.5l6.5-40l-75.5-64.5c11.3-26.1 25.6-50.7 42.6-73.6l93.4 33.2l31.4-25.9c23.7-19.5 50.2-34.9 78.7-45.7l37.9-14.3l17.9-97.2c28.1-3.2 56.8-3.2 85 0l17.9 97l38.1 14.3c28.7 10.8 55.4 26.2 79.3 45.8l31.4 25.8l92.8-32.9c17 22.9 31.2 47.6 42.6 73.6L781.8 426zM512 326c-97.2 0-176 78.8-176 176s78.8 176 176 176s176-78.8 176-176s-78.8-176-176-176m79.2 255.2A111.6 111.6 0 0 1 512 614c-29.9 0-58-11.7-79.2-32.8A111.6 111.6 0 0 1 400 502c0-29.9 11.7-58 32.8-79.2C454 401.6 482.1 390 512 390s58 11.6 79.2 32.8A111.6 111.6 0 0 1 624 502c0 29.9-11.7 58-32.8 79.2"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M5 16.25a.75.75 0 0 1 .75.75v2c0 .138.112.25.25.25h12a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2A1.75 1.75 0 0 1 18 20.75H6A1.75 1.75 0 0 1 4.25 19v-2a.75.75 0 0 1 .75-.75" clip-rule="evenodd"/><path fill="currentColor" d="M10.738 3.75a.99.99 0 0 0-.988.906a37 37 0 0 0-.082 5.27q-.37.02-.74.047l-1.49.109a.76.76 0 0 0-.585 1.167a15.6 15.6 0 0 0 4.032 4.258l.597.429a.89.89 0 0 0 1.036 0l.597-.429a15.6 15.6 0 0 0 4.032-4.258a.76.76 0 0 0-.585-1.167l-1.49-.109a42 42 0 0 0-.74-.047a37 37 0 0 0-.081-5.27a.99.99 0 0 0-.989-.906z"/></svg>',
};
let source = null, patterns = [], session = 0, encoding = false, encoder = null, editing = null, draft = null;
let playback = {}, player = makePlayer();
let graphDecoder = null, graphBusy = false;
let graphChunks = [], graphDecodeCost = 0;
const graph = new ComparisonGraph(() => player, () => {
  const pattern = patterns.find(p => p.id === playback.selected);
  return pattern ? `${CODECS[pattern.config.codec].name} · ${description(pattern.config)}` : '基準PCM';
}, readGraphChunk, releaseGraphDecoder);
function releaseGraphDecoder(clear = false) {
  if (!clear && !graphBusy) return;
  graphDecoder?.terminate(); graphDecoder = null; graphBusy = false;
  if (clear) graphChunks = [];
}
function preparedGraphChunk(target, start, frames) {
  return graphChunks.find(c => c.blob === target.blob && c.start <= start && c.end >= start + frames);
}
async function readGraphChunk(instance, target, start, frames) {
  const cached = instance.analysisChunk(target, start, frames);
  if (cached) return cached;
  const prepared = preparedGraphChunk(target, start, frames);
  if (prepared) return prepared;
  if (instance.playing && target.key === instance.target.key && (instance.busy || start < instance.scheduledEnd || instance.ahead < 6)) return null;
  if (instance !== player || !source || encoder || encoding || graphBusy ||
    patterns.some(p => p.state === 'queued') || instance.requested || !instance.canEncode ||
    (instance.playing && instance.ahead < 4 && instance.scheduledEnd !== instance.totalFrames)) return null;
  const engine = graphDecoder ||= new Engine();
  const revision = instance.revision;
  graphBusy = true;
  try {
    // ponytail: 先頭復号の時間は区間長に比例しない。実測はバッチ選択だけに使い、通常の先読み内で必ず開始できる条件にする。
    const batchAhead = Math.min(7, Math.max(6, graphDecodeCost / 1000 * 2 + 2));
    const seconds = instance.playing ? (instance.ahead >= batchAhead ? 8 : 4) : 16;
    const count = Math.min(instance.totalFrames - start, Math.max(frames, instance.rate * seconds));
    const begin = performance.now();
    const buffer = await engine.decode(instance.source, target, start, count, instance.context);
    if (engine !== graphDecoder || instance !== player || revision !== instance.revision) return null;
    const elapsed = performance.now() - begin;
    graphDecodeCost = elapsed * Math.min(1, instance.rate * 4 / count);
    graph.stats.decodeMs = elapsed; graph.stats.decodes++;
    const chunk = { key: target.key, blob: target.blob, start, end: start + count, buffer };
    graphChunks = [...graphChunks.filter(c => c.blob !== target.blob), chunk].slice(-2);
    if (!instance.playing && target.key === instance.target.key) instance.cache = [
      ...instance.cache.filter(c => c.key === target.key && c.end > instance.frame && c.start !== start), chunk,
    ].sort((a, b) => a.start - b.start).slice(0, 2);
    return chunk;
  } catch (error) { if (!engine.closed) throw error; return null; }
  finally { if (graphDecoder === engine) graphBusy = false; }
}
function message(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function failure(error) { message(error instanceof Error ? error.message : String(error)); }
function makePlayer() {
  const instance = new Player(state => {
    playback = state;
    $('play-icon').setAttribute('d', state.playing ? 'M5 3H10V21H5ZM14 3H19V21H14Z' : 'M6 3 21 12 6 21Z');
    $('play').setAttribute('aria-label', state.playing ? '一時停止' : '再生');
    $('play').setAttribute('aria-busy', String(state.buffering));
    render();
  }, failure);
  instance.readPrepared = preparedGraphChunk;
  instance.loop = $('loop').getAttribute('aria-pressed') === 'true';
  return instance;
}
function status(pattern) {
  if (playback.pending === pattern.id) return '切替準備中';
  if (playback.selected === pattern.id && playback.buffering) return '再生準備中';
  if (pattern.state === 'queued') return '変換待ち';
  if (pattern.state === 'encoding') return `変換中 ${pattern.progress || 0}%`;
  if (pattern.state === 'error') return '変換失敗';
  return '';
}
function render() {
  if (!source) return;
  const focused = document.activeElement?.dataset.focus;
  $('patterns').replaceChildren();
  const reference = { id: 'reference', name: '基準音源（PCM変換済み）', state: 'ready', detail: `${source.rate.toLocaleString()} Hz · 24 bit · ${source.channels === 1 ? 'モノラル' : 'ステレオ'}`, size: source.frames * source.channels * 3 };
  for (const pattern of [reference, ...patterns]) {
    const isReference = pattern.id === 'reference', name = isReference ? pattern.name : CODECS[pattern.config.codec].name;
    const accessibleName = name + (pattern.config?.codec === 'g711' ? ` ${CODECS.g711.laws.find(([law]) => law === pattern.config.law)[1]}` : '');
    const row = document.createElement('div');
    row.className = `cc-row${playback.selected === pattern.id ? ' cc-selected' : ''}`;
    row.innerHTML = '<label class="cc-identity"><input type="radio" name="preview"><span class="cc-label"><span class="cc-codec"><span class="name"></span><span class="cc-state"></span></span><span class="cc-sub"></span></span></label><div class="cc-metrics"><span class="cc-metric size"></span><span class="cc-metric rate"></span><span class="cc-metric cc-ratio"></span></div><div class="cc-actions"></div>';
    row.querySelector('.name').textContent = name;
    row.querySelector('.cc-state').textContent = status(pattern);
    row.querySelector('.cc-sub').textContent = isReference ? pattern.detail : description(pattern.config);
    row.querySelector('.cc-sub').title = pattern.error || '';
    const radio = row.querySelector('input');
    radio.value = pattern.id;
    radio.dataset.focus = `${pattern.id}-select`;
    radio.setAttribute('aria-label', `${accessibleName}を試聴`);
    radio.checked = playback.selected === pattern.id;
    radio.disabled = pattern.state !== 'ready';
    radio.addEventListener('change', () => player.select(isReference ? null : pattern));
    const size = isReference ? pattern.size : pattern.blob?.size;
    if (size !== undefined) {
      const m = metrics(size, source);
      row.querySelector('.size').textContent = `${isReference ? 'PCM換算 ' : ''}${sizeLabel(size)}`;
      if (isReference) row.querySelector('.size').title = '24 bit PCMに展開した場合の容量（ヘッダーなし）。入力ファイルの容量とは異なります。';
      row.querySelector('.rate').textContent = `${m.bitrate.toFixed(1)} kbps`;
      row.querySelector('.cc-ratio').append(document.createTextNode(`${m.ratio.toFixed(1)}% `));
      const small = document.createElement('small');
      small.textContent = `削減 ${Number(m.saved.toFixed(1)).toFixed(1)}%`;
      row.querySelector('.cc-ratio').append(small);
    } else {
      for (const el of row.querySelectorAll('.cc-metric')) el.textContent = '—';
    }
    if (!isReference) {
      for (const [action, label] of [['edit', '設定を変更'], ['download', 'ダウンロード'], ['remove', '削除']]) {
        const button = document.createElement('button');
        button.className = 'cc-icon';
        if (actionIcons[action]) button.innerHTML = actionIcons[action];
        else button.textContent = '×';
        button.setAttribute('aria-label', `${accessibleName}：${label}`);
        button.title = label;
        button.dataset.focus = `${pattern.id}-${action}`;
        button.disabled = action === 'download' && !pattern.blob;
        button.addEventListener('click', () => act(action, pattern));
        row.querySelector('.cc-actions').append(button);
      }
    }
    $('patterns').append(row);
  }
  if (focused) [...$('patterns').querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focused)?.focus({ preventScroll: true });
}
async function loadFile(file) {
  if (!file) return;
  if (!file.size || file.size > LIMITS.input) { failure(Error('音源は0バイトより大きく、512 MiB以下のファイルを選択してください。')); return; }
  const current = ++session;
  graphDecodeCost = 0;
  graph.reset();
  encoder?.terminate();
  player.dispose();
  clearPCM();
  source = null;
  patterns = patterns.map(({ id, config }) => ({ id, config: { ...config }, state: 'queued' }));
  encoding = false;
  player = makePlayer();
  $('editor').hidden = true;
  editing = draft = null;
  $('patterns').replaceChildren();
  for (const id of ['play', 'seek', 'add']) $(id).disabled = true;
  $('filename').textContent = file.name;
  $('filename').title = file.name;
  $('source-info').textContent = '音源を解析中…';
  $('seek').value = 0;
  $('duration').textContent = '00:00';
  message('音声エンジンを読み込み、音源を解析しています…');
  const engine = encoder = new Engine();
  try {
    const result = await engine.analyze(file);
    if (current !== session) return;
    source = result;
    $('source-info').replaceChildren();
    for (const text of [`${source.rate.toLocaleString()} Hz`, source.bits ? `${source.bits} bit` : '非可逆圧縮', source.originalChannels === 1 ? 'モノラル' : source.originalChannels === 2 ? 'ステレオ' : `${source.originalChannels} ch → ステレオ`, `入力 ${sizeLabel(file.size)}`]) {
      const span = document.createElement('span'); span.textContent = text; $('source-info').append(span);
    }
    $('seek').max = source.duration;
    $('duration').textContent = timeLabel(source.duration);
    for (const id of ['play', 'seek', 'add']) $(id).disabled = false;
    player.setSource(source);
    message();
  } catch (error) { if (current === session) { failure(error); $('source-info').textContent = '読み込めませんでした。音源を変更してください。'; } }
  finally { engine.terminate(); if (encoder === engine) encoder = null; }
  if (current === session && source) queue();
}
function field(key, label, options, value = draft[key]) {
  const wrapper = document.createElement('label'); wrapper.className = 'cc-field';
  wrapper.append(document.createTextNode(label));
  const select = document.createElement('select'); select.name = key;
  for (const item of options) { const [v, text] = Array.isArray(item) ? item : [item, item]; select.add(new Option(String(text), String(v))); }
  select.value = String(value);
  select.disabled = options.length === 1;
  wrapper.append(select); $('fields').append(wrapper);
  select.addEventListener('change', () => {
    const wasDefault = draft.bitrate === defaults(draft.codec, draft).bitrate;
    if (key === 'codec') draft = defaults(select.value, source);
    else draft[key] = ['mode', 'law'].includes(key) ? select.value : Number(select.value);
    if (wasDefault && ['rate', 'channels'].includes(key)) draft.bitrate = defaults(draft.codec, draft).bitrate;
    const bits = bitratesFor(draft);
    if (bits.length && !bits.includes(draft.bitrate)) draft.bitrate = bits.reduce((a, b) => Math.abs(b - draft.bitrate) < Math.abs(a - draft.bitrate) ? b : a);
    if (key === 'rate' && !cutoffsFor(draft).includes(draft.cutoff)) draft.cutoff = 0;
    if (['codec', 'mode', 'rate', 'channels', 'frameDuration'].includes(key)) { fields(); $('fields').querySelector(`[name="${key}"]`).focus(); }
  });
}
function fields() {
  $('fields').replaceChildren();
  const c = CODECS[draft.codec];
  field('codec', '形式', Object.entries(CODECS).map(([id, codec]) => [id, codec.name]));
  if (c.laws) field('law', '圧伸方式', c.laws);
  if (c.modes) field('mode', 'モード', c.modes);
  if (c.frameDurations) field('frameDuration', 'フレーム長', c.frameDurations.map(n => [n, `${n} ms`]));
  if (c.bits && !(draft.codec === 'mp3' && draft.mode === 'VBR')) field('bitrate', draft.codec === 'aac' ? '平均ビットレート' : 'ビットレート', bitratesFor(draft).map(n => [n, `${n} kbps`]));
  if (c.qualities && (draft.codec === 'vorbis' || draft.mode === 'VBR')) field('quality', draft.codec === 'mp3' ? '品質（0が最高）' : '品質（10が最高）', c.qualities);
  field('rate', 'サンプルレート', ratesFor(draft.codec, source.rate).map(n => [n, `${n.toLocaleString()} Hz${n === source.rate ? '（元音源）' : ''}`]));
  if (c.cutoffs) field('cutoff', 'カットオフ', cutoffsFor(draft).map(n => [n, n ? `${n.toLocaleString()} Hz` : '自動']), draft.cutoff ?? 0);
  field('channels', 'チャンネル', (c.channels || [1, 2]).map(n => [n, n === 1 ? 'モノラル' : 'ステレオ']));
  if (c.depths) field('depth', 'ビット深度', c.depths.map(n => [n, `${n} bit`]));
  if (c.levels) field('level', '圧縮レベル', c.levels);
}
function openEditor(pattern = null) {
  editing = pattern;
  draft = pattern ? { ...pattern.config } : defaults('opus', source);
  $('editor-title').textContent = pattern ? 'パターンを編集' : 'パターンを追加';
  $('editor').hidden = false;
  fields();
  $('fields').querySelector('select').focus();
}
function act(action, pattern) {
  if (action === 'edit') { openEditor(pattern); return; }
  if (action === 'download') {
    const url = URL.createObjectURL(pattern.blob), link = document.createElement('a');
    link.href = url;
    link.download = `${source.file.name.replace(/\.[^.]*$/, '')}-${pattern.config.codec}${pattern.config.codec === 'g711' ? `-${pattern.config.law}` : ''}-${pattern.id}.${CODECS[pattern.config.codec].ext}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  if ([playback.selected, playback.pending].includes(pattern.id)) { player.pause(); player.select(null); }
  if (pattern.state === 'encoding') encoder?.terminate();
  if (pattern.blob) clearPCM(pattern.blob);
  patterns = patterns.filter(p => p !== pattern);
  if (editing === pattern) closeEditor();
  render();
}
async function queue() {
  if (encoding || !source || !player.canEncode) return;
  const pattern = patterns.find(p => p.state === 'queued');
  if (!pattern) return;
  releaseGraphDecoder(true);
  encoding = true;
  const current = session, config = pattern.config, engine = encoder = new Engine();
  pattern.state = 'encoding';
  let lastProgress = -1;
  engine.onProgress = seconds => {
    if (current !== session || pattern.config !== config) return;
    const progress = Math.min(99, Math.max(0, Math.floor(seconds / source.duration * 100)));
    if (progress === lastProgress) return;
    lastProgress = pattern.progress = progress;
    const radio = [...$('patterns').querySelectorAll('input')].find(el => el.value === pattern.id);
    if (radio) radio.closest('.cc-row').querySelector('.cc-state').textContent = status(pattern);
  };
  render();
  try {
    const blob = await engine.encode(source, config);
    if (current !== session || !patterns.includes(pattern) || pattern.config !== config) { clearPCM(blob); return; }
    if (source.file.size + patterns.reduce((n, p) => n + (p.blob?.size || 0), 0) + blob.size > LIMITS.total) {
      clearPCM(blob);
      throw Error('合計保持量が1 GiBを超えます。不要なパターンを削除してください。');
    }
    pattern.blob = blob;
    pattern.state = 'ready';
  } catch (error) {
    if (current === session && patterns.includes(pattern) && pattern.config === config) {
      pattern.state = 'error'; pattern.error = error.message; failure(error);
    }
  } finally {
    engine.terminate();
    if (encoder === engine) encoder = null;
    if (current === session) { encoding = false; render(); }
  }
}
function closeEditor() { $('editor').hidden = true; editing = null; $('add').focus(); }
$('editor').addEventListener('submit', event => {
  event.preventDefault();
  try {
    validateConfig(draft, source);
    if (editing) {
      if ([playback.selected, playback.pending].includes(editing.id)) { player.pause(); player.select(null); }
      if (editing.state === 'encoding') encoder?.terminate();
      if (editing.blob) clearPCM(editing.blob);
      Object.assign(editing, { config: { ...draft }, state: 'queued', blob: null, error: null, progress: 0 });
    } else patterns.push({ id: crypto.randomUUID(), config: { ...draft }, state: 'queued' });
    closeEditor(); message(); render(); queue();
  } catch (error) { failure(error); }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', closeEditor);
$('editor').addEventListener('keydown', event => { if (event.key === 'Escape') closeEditor(); });
$('add').addEventListener('click', () => openEditor());
$('change').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => { loadFile($('file').files[0]); $('file').value = ''; });
$('play').addEventListener('click', () => { if (player.playing) player.pause(); else player.play().catch(failure); });
$('loop').addEventListener('click', () => {
  player.loop = !player.loop;
  $('loop').setAttribute('aria-pressed', String(player.loop));
  $('loop').title = `ループ再生：${player.loop ? 'オン' : 'オフ'}`;
});
let seeking = false;
$('seek').addEventListener('input', () => { seeking = true; $('position').textContent = timeLabel(Number($('seek').value)); });
$('seek').addEventListener('change', () => { player.seek(Number($('seek').value)); seeking = false; });
document.addEventListener('dragover', event => { event.preventDefault(); document.querySelector('.cc-player').classList.add('cc-drag'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.querySelector('.cc-player').classList.remove('cc-drag'); });
document.addEventListener('drop', event => {
  event.preventDefault(); document.querySelector('.cc-player').classList.remove('cc-drag');
  if (event.dataTransfer.files.length !== 1) message('音源は1ファイルずつ選択してください。');
  else loadFile(event.dataTransfer.files[0]);
});
setInterval(() => {
  if (!seeking) { $('position').textContent = timeLabel(player.position); $('seek').value = player.position; }
  queue();
  graph.tick();
}, 150);
window.addEventListener('pagehide', event => { graph.reset(); if (!event.persisted) { encoder?.terminate(); player.dispose(); clearPCM(); } else player.pause(); });
