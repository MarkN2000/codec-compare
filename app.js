import { CODECS, LIMITS, defaults, ratesFor, bitratesFor, validateConfig, description, metrics, timeLabel, sizeLabel } from './model.js';
import { Engine, Player } from './audio.js';

const $ = id => document.getElementById(id);
let source = null, patterns = [], session = 0, encoding = false, encoder = null, editing = null, draft = null;
let playback = {}, player = makePlayer();
function message(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function failure(error) { message(error instanceof Error ? error.message : String(error)); }
function makePlayer() {
  return new Player(state => {
    playback = state;
    $('play').textContent = state.playing ? 'Ⅱ' : '▶';
    $('play').setAttribute('aria-label', state.playing ? '一時停止' : '再生');
    $('play').setAttribute('aria-busy', String(state.buffering));
    render();
  }, failure);
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
  const reference = { id: 'reference', name: '基準音源', state: 'ready', detail: `${source.rate.toLocaleString()} Hz · 24 bit · ${source.channels === 1 ? 'モノラル' : 'ステレオ'}`, size: source.frames * source.channels * 3 };
  for (const pattern of [reference, ...patterns]) {
    const isReference = pattern.id === 'reference', name = isReference ? pattern.name : CODECS[pattern.config.codec].name;
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
    radio.setAttribute('aria-label', `${name}を試聴`);
    radio.checked = playback.selected === pattern.id;
    radio.disabled = pattern.state !== 'ready';
    radio.addEventListener('change', () => player.select(isReference ? null : pattern));
    const size = isReference ? pattern.size : pattern.blob?.size;
    if (size !== undefined) {
      const m = metrics(size, source);
      row.querySelector('.size').textContent = sizeLabel(size);
      row.querySelector('.rate').textContent = `${m.bitrate.toFixed(1)} kbps`;
      row.querySelector('.cc-ratio').append(document.createTextNode(`${m.ratio.toFixed(1)}% `));
      const small = document.createElement('small');
      small.textContent = `削減 ${Number(m.saved.toFixed(1)).toFixed(1)}%`;
      row.querySelector('.cc-ratio').append(small);
    } else {
      for (const el of row.querySelectorAll('.cc-metric')) el.textContent = '—';
    }
    if (!isReference) {
      for (const [action, label, symbol] of [['edit', '設定を変更', '⚙'], ['download', 'ダウンロード', '↓'], ['remove', '削除', '×']]) {
        const button = document.createElement('button');
        button.className = 'cc-icon';
        button.textContent = symbol;
        button.setAttribute('aria-label', `${name}：${label}`);
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
  if (!file.size || file.size > LIMITS.input) { failure(Error('音源は0バイトより大きく、256 MiB以下のファイルを選択してください。')); return; }
  const current = ++session;
  encoder?.terminate();
  player.dispose();
  source = null;
  patterns = [];
  encoding = false;
  player = makePlayer();
  $('editor').hidden = true;
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
    for (const text of [`${source.rate.toLocaleString()} Hz`, source.bits ? `${source.bits} bit` : '非可逆圧縮', source.originalChannels === 1 ? 'モノラル' : source.originalChannels === 2 ? 'ステレオ' : `${source.originalChannels} ch → ステレオ`, sizeLabel(file.size)]) {
      const span = document.createElement('span'); span.textContent = text; $('source-info').append(span);
    }
    $('seek').max = source.duration;
    $('duration').textContent = timeLabel(source.duration);
    for (const id of ['play', 'seek', 'add']) $(id).disabled = false;
    player.setSource(source);
    message();
  } catch (error) { if (current === session) { failure(error); $('source-info').textContent = '読み込めませんでした。音源を変更してください。'; } }
  finally { engine.terminate(); if (encoder === engine) encoder = null; }
}
function field(key, label, options, value = draft[key]) {
  const wrapper = document.createElement('label'); wrapper.className = 'cc-field';
  wrapper.append(document.createTextNode(label));
  const select = document.createElement('select'); select.name = key;
  for (const item of options) { const [v, text] = Array.isArray(item) ? item : [item, item]; select.add(new Option(String(text), String(v))); }
  select.value = String(value);
  wrapper.append(select); $('fields').append(wrapper);
  select.addEventListener('change', () => {
    if (key === 'codec') draft = defaults(select.value, source);
    else draft[key] = ['mode'].includes(key) ? select.value : Number(select.value);
    if (!bitratesFor(draft).includes(draft.bitrate)) draft.bitrate = bitratesFor(draft).at(-1);
    if (['codec', 'mode', 'rate'].includes(key)) { fields(); $('fields').querySelector(`[name="${key}"]`).focus(); }
  });
}
function fields() {
  $('fields').replaceChildren();
  const c = CODECS[draft.codec];
  field('codec', '形式', Object.entries(CODECS).map(([id, codec]) => [id, codec.name]));
  if (c.modes) field('mode', 'モード', c.modes);
  if (c.bits && !(draft.codec === 'mp3' && draft.mode === 'VBR')) field('bitrate', draft.codec === 'aac' ? '平均ビットレート' : 'ビットレート', bitratesFor(draft).map(n => [n, `${n} kbps`]));
  if (c.qualities && (draft.codec === 'vorbis' || draft.mode === 'VBR')) field('quality', draft.codec === 'mp3' ? '品質（0が最高）' : '品質（10が最高）', c.qualities);
  field('rate', 'サンプルレート', ratesFor(draft.codec, source.rate).map(n => [n, `${n.toLocaleString()} Hz${n === source.rate ? '（元音源）' : ''}`]));
  field('channels', 'チャンネル', [[1, 'モノラル'], [2, 'ステレオ']]);
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
    link.download = `${source.file.name.replace(/\.[^.]*$/, '')}-${pattern.config.codec}-${pattern.id}.${CODECS[pattern.config.codec].ext}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  if ([playback.selected, playback.pending].includes(pattern.id)) { player.pause(); player.select(null); }
  if (pattern.state === 'encoding') encoder?.terminate();
  patterns = patterns.filter(p => p !== pattern);
  if (editing === pattern) closeEditor();
  render();
}
async function queue() {
  if (encoding || !source || !player.canEncode) return;
  const pattern = patterns.find(p => p.state === 'queued');
  if (!pattern) return;
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
    if (current !== session || !patterns.includes(pattern) || pattern.config !== config) return;
    if (source.file.size + patterns.reduce((n, p) => n + (p.blob?.size || 0), 0) + blob.size > LIMITS.total) throw Error('合計保持量が512 MiBを超えます。不要なパターンを削除してください。');
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
}, 150);
window.addEventListener('pagehide', event => { if (!event.persisted) { encoder?.terminate(); player.dispose(); } else player.pause(); });
