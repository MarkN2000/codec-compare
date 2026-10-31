import { melAt, melPosition } from './analysis.js';
import { AnalysisCache } from './analysis-cache.js';
export { melAt, melPosition };
const frequencyTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
function frequencyLabel(hz) { return hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(hz); }

export function averageSpectrum(data, seconds) {
  const result = new Float32Array(data.bins);
  let count = 0, nearest = 0;
  for (let row = 0; row < data.times.length; row++) {
    if (Math.abs(data.times[row] - seconds) < Math.abs(data.times[nearest] - seconds)) nearest = row;
    if (Math.abs(data.times[row] - seconds) > .25) continue;
    const weight = data.weights?.[row] || 1;
    count += weight;
    for (let bin = 0; bin < data.bins; bin++) result[bin] += data.powers[row * data.bins + bin] * weight;
  }
  for (let bin = 0; bin < data.bins; bin++) result[bin] = 10 * Math.log10(Math.max(1e-12,
    count ? result[bin] / count : data.powers[nearest * data.bins + bin]));
  return result;
}

// 両方が無音相当の帯域は強調しない。0除算を避け、表示は±24 dBに固定する。
export function bandDifference(reference, selected) {
  if (Math.max(reference, selected) < 1e-9) return 0;
  return Math.max(-24, Math.min(24, 10 * Math.log10(Math.max(1e-12, selected) / Math.max(1e-12, reference))));
}

export function timePosition(seconds, duration) { return Math.max(0, Math.min(1, seconds / duration)); }

export function fftColumns(data, width) {
  const duration = data.length / data.rate, columns = new Uint32Array(width);
  let row = 0;
  for (let x = 0; x < width; x++) {
    const seconds = (x + .5) / width * duration;
    while (row + 1 < data.times.length && Math.abs(data.times[row + 1] - seconds) <= Math.abs(data.times[row] - seconds)) row++;
    columns[x] = row;
  }
  return columns;
}

export function differenceColor(db) {
  const stops = [[33, 102, 172], [103, 169, 207], [247, 247, 247], [244, 165, 80], [178, 24, 43]];
  const value = (Math.max(-24, Math.min(24, db)) + 24) / 12;
  const index = Math.min(3, Math.floor(value)), mix = value - index;
  return stops[index].map((v, i) => Math.round(v * (1 - mix) + stops[index + 1][i] * mix));
}

export class ComparisonGraph {
  constructor(getPlayer, getLabel, readChunk, releaseDecoder) {
    this.getPlayer = getPlayer;
    this.getLabel = getLabel;
    this.readChunk = readChunk;
    this.releaseDecoder = releaseDecoder;
    this.panel = document.getElementById('graph');
    this.plots = document.getElementById('graph-plots');
    this.frequencyCanvas = document.getElementById('frequency-canvas');
    this.canvas = document.getElementById('graph-canvas');
    this.cursor = document.getElementById('graph-cursor');
    this.status = document.getElementById('graph-status');
    this.generation = 0;
    this.blocks = new Map();
    this.cache = new AnalysisCache();
    this.stats = { fftMs: 0, fftWallMs: 0, prepareMs: 0, readMs: 0, drawMs: 0, decodeMs: 0, decodes: 0, analyses: 0, pauses: 0, retries: 0 };
    this.panel.addEventListener('toggle', () => { if (!this.active) this.reset(); this.tick(); });
    document.addEventListener('visibilitychange', () => { if (!this.active) this.reset(); else this.tick(); });
  }
  get active() { return this.panel.open && !document.hidden; }
  cancelAnalysis(clearDecoder = true) {
    this.generation++;
    this.busy = false;
    this.worker?.terminate();
    this.worker = null;
    this.cancel?.();
    this.cancel = null;
    this.releaseDecoder?.(clearDecoder);
  }
  reset(keepDisplay = false) {
    this.cancelAnalysis(!keepDisplay);
    this.suspended = false;
    this.blocks.clear();
    this.cache.protected.clear();
    this.key = '';
    this.drawn = '';
    this.error = '';
    this.retryAt = 0; this.failures = 0; this.warm = 0;
    this.lastDraw = 0;
    if (!keepDisplay) { this.display = null; this.heatDisplay = null; this.background = null; this.backgroundKey = ''; this.source = null; this.plots.hidden = true; }
  }
  tick() {
    const player = this.getPlayer();
    if (!this.active) return;
    if (!player.source) { this.reset(); this.status.textContent = '音源を選択すると比較できます。'; return; }
    const start = Math.floor(Math.max(0, Math.min(player.position, player.source.duration - 1 / player.rate)) / 4) * 4;
    const blob = player.target.blob || player.source.file || player.source;
    const key = this.cache.key(blob, player.rate, 0);
    if (this.source !== player.source || this.key !== key || start < this.wanted || start > this.wanted + 4) {
      this.reset(this.source === player.source); this.source = player.source; this.key = key;
    }
    this.wanted = start;
    const horizon = player.playing && (player.ahead < 6 || this.stats.prepareMs > 2000) ? 4 : 12;
    this.cache.protected = new Set([blob, player.source.file || player.source].flatMap(file =>
      [0, 4, 8, 12].map(offset => this.cache.key(file, player.rate, start + offset))));
    if (player.playing && (player.buffering || (player.scheduledEnd !== player.totalFrames && player.ahead < (this.suspended ? 4 : 2)))) {
      if (!this.suspended) {
        this.suspended = true; this.stats.pauses++;
        this.worker?.postMessage({ paused: true }); this.releaseDecoder?.();
      }
      const shown = this.display;
      const range = shown ? `${shown.start.toFixed(1)}–${(shown.start + shown.data[0].length / shown.data[0].rate).toFixed(1)} 秒 · ` : '';
      this.status.textContent = `${range}再生を優先してグラフを休止中`;
      return;
    }
    if (this.suspended) { this.worker?.postMessage({ paused: false }); this.suspended = false; }
    try { player.ensureContext(); }
    catch (error) { this.status.textContent = error.message; return; }
    for (const time of this.blocks.keys()) if (time < start || time > start + horizon) this.blocks.delete(time);
    const label = this.getLabel();
    const current = this.blocks.get(start);
    if (current) {
      this.display = current; current.label = label; current.position = Math.min(player.position - start, current.data[0].length / player.rate);
    }
    const shown = this.display;
    document.getElementById('graph-selected').textContent = shown?.label || label;
    if (shown) {
      const end = shown.start + shown.data[0].length / shown.data[0].rate;
      this.status.textContent = `${shown.start.toFixed(1)}–${end.toFixed(1)} 秒${shown.reference ? ' · 基準と同じPCM' : ''}${current ? '' : ' · 更新待ち'}${this.error ? ` · ${this.error}` : ''}`;
      const width = Math.round(this.plots.parentElement.clientWidth);
      const signature = `${shown.start}:${shown.position.toFixed(2)}:${width}:${shown.label}:${Boolean(current)}`;
      const now = performance.now();
      if (this.drawn !== signature && (this.lastDraw === 0 || now - this.lastDraw >= 250 || !player.playing)) {
        this.drawn = signature;
        this.plots.hidden = false;
        const begin = performance.now();
        this.draw(width, shown.position, shown.label);
        this.stats.drawMs = performance.now() - begin;
        this.lastDraw = now;
      }
      this.drawPosition?.(shown.position);
    } else {
      this.status.textContent = this.error || 'グラフを準備中（圧縮・再生の準備を優先）…';
    }
    let next = -1;
    for (let time = start; time <= start + horizon && time < player.source.duration; time += 4) {
      if (!this.blocks.has(time)) { next = time; break; }
    }
    if (next < 0 && !player.playing) next = Math.max(start + horizon + 4, this.warm);
    if (!this.busy && performance.now() >= this.retryAt && next >= 0 && next < player.source.duration) this.prepare(player, next, label);
  }
  async prepare(player, seconds, label) {
    this.busy = true;
    const begin = performance.now();
    const generation = this.generation, target = player.target;
    const valid = () => generation === this.generation && this.active && this.getPlayer() === player;
    const start = Math.round(seconds * player.rate), frames = Math.min(player.totalFrames - start, player.rate * 4);
    const reference = { key: 'reference', reference: true, channels: player.source.channels, blob: player.source.file || player.source };
    const targets = target.reference ? [reference] : [target, reference];
    try {
      const results = [];
      for (let i = 0; i < targets.length; i++) {
        const key = this.cache.key(targets[i].blob || targets[i], player.rate, seconds);
        const cached = await this.cache.get(key);
        if (!valid()) return;
        if (cached) { results.push(cached); continue; }
        if (this.suspended) return;
        const readBegin = performance.now();
        const chunk = await this.readChunk(player, targets[i], start, frames);
        this.stats.readMs = performance.now() - readBegin;
        if (!valid() || !chunk) return;
        const fftBegin = performance.now();
        const channels = Array.from({ length: chunk.buffer.numberOfChannels }, (_, ch) =>
          chunk.buffer.getChannelData(ch).slice(start - chunk.start, start - chunk.start + frames));
        this.worker ||= new Worker(new URL('./analysis.js', import.meta.url), { type: 'module' });
        const result = await new Promise((resolve, reject) => {
          this.cancel = () => resolve(null);
          this.worker.onmessage = ({ data }) => {
            if (data.error) reject(Error(data.error));
            else { this.stats.fftMs = data.elapsedMs || 0; this.stats.analyses++; resolve(data.results[0]); }
          };
          this.worker.onerror = () => reject(Error('分析に失敗しました。再試行します。'));
          this.worker.postMessage({ channels: [channels], rate: player.rate }, channels.map(c => c.buffer));
          if (this.suspended) this.worker.postMessage({ paused: true });
        });
        if (!valid() || !result) return;
        this.stats.fftWallMs = performance.now() - fftBegin;
        this.cancel = null;
        this.cache.put(key, result);
        results.push(result);
      }
      if (seconds >= this.wanted && seconds <= this.wanted + 12) this.blocks.set(seconds, { start: seconds, label, reference: target.reference, position: 0,
        data: results.length === 1 ? [results[0], results[0]] : [results[1], results[0]] });
      this.warm = Math.max(this.warm, seconds + 4);
      this.stats.prepareMs = performance.now() - begin;
      this.error = ''; this.failures = 0; this.retryAt = 0;
    } catch (error) {
      if (valid()) {
        this.error = `グラフ：${error.message}（再試行待ち）`;
        this.retryAt = performance.now() + Math.min(30, 2 ** ++this.failures) * 1000;
        this.stats.retries++; this.worker?.terminate(); this.worker = null;
      }
    } finally { if (generation === this.generation) this.busy = false; }
  }
  draw(width, position, label) {
    const height = 210;
    const { data, start } = this.display;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    for (const [spectrum, canvas] of [[true, this.frequencyCanvas], [false, this.canvas]]) {
      if (canvas.width !== pixelWidth || canvas.height !== height * ratio) {
        canvas.width = pixelWidth; canvas.height = height * ratio;
      }
      canvas.style.height = `${height}px`;
      canvas.setAttribute('aria-label', `${spectrum ? '周波数スペクトル' : '時間×周波数の差分'}。基準PCMと${label}、${this.status.textContent}。${spectrum ? '共通の尺度で表示。' : '約0.1秒×64帯域の差分。青は減少、白は変化なし、赤は増加。'}`);
      if (!spectrum && this.heatDisplay === this.display && this.heatWidth === pixelWidth) continue;
      if (!spectrum) { this.heatDisplay = this.display; this.heatWidth = pixelWidth; }
      const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
      ctx.font = '11px sans-serif'; ctx.lineWidth = 1; ctx.textAlign = 'left';
      const left = 40, right = width - 12, plotWidth = right - left, maxHz = data[0].rate / 2;
      if (spectrum) {
        const top = 16, bottom = height - 27, plotHeight = bottom - top;
        const backgroundKey = `${pixelWidth}:${ratio}:${maxHz}`;
        if (this.backgroundKey !== backgroundKey) {
        ctx.fillStyle = '#5c7288'; ctx.fillText('dBFS', 0, 10);
        for (let db = 0; db >= -120; db -= 30) {
          const y = top - db / 120 * plotHeight;
          ctx.strokeStyle = '#e5edf4'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
          ctx.fillText(String(db), 4, y + 4);
        }
        let lastLabel = -Infinity;
        for (const hz of [...frequencyTicks.filter(hz => hz < maxHz), maxHz]) {
          const x = left + melPosition(hz, maxHz) * plotWidth;
          ctx.strokeStyle = '#e5edf4'; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
          const edge = hz === maxHz, text = frequencyLabel(hz);
          const labelLeft = edge ? x - ctx.measureText(text).width : x - ctx.measureText(text).width / 2;
          if (labelLeft < lastLabel + 8 || (!edge && right - x < 32)) continue;
          ctx.textAlign = edge ? 'right' : 'center'; ctx.fillText(text, x, height - 6);
          lastLabel = edge ? x : x + ctx.measureText(text).width / 2;
        }
        this.background = document.createElement('canvas');
        this.background.width = canvas.width; this.background.height = canvas.height;
        this.background.getContext('2d').drawImage(canvas, 0, 0);
        this.backgroundKey = backgroundKey;
        this.binPositions = Float32Array.from({ length: data[0].bins }, (_, bin) => melPosition(bin * maxHz / (data[0].bins - 1), maxHz) * plotWidth);
        } else ctx.drawImage(this.background, 0, 0, width, height);
        ctx.textAlign = 'left';
        for (let line = 0; line < 2; line++) {
          const values = averageSpectrum(data[line], position);
          ctx.strokeStyle = line ? '#0875d1' : '#728394'; ctx.lineWidth = line ? 1.5 : 2;
          ctx.beginPath();
          const step = maxHz / (values.length - 1), first = 20 / step;
          const firstDb = values[Math.floor(first)] * (1 - first % 1) + values[Math.ceil(first)] * (first % 1);
          ctx.moveTo(left, top + Math.min(120, Math.max(0, -firstDb)) / 120 * plotHeight);
          // FFTの全ビンを描く。座標だけをメル尺度にし、ピークや分析値を間引かない。
          for (let bin = Math.ceil(first); bin < values.length; bin++) {
            const x = this.binPositions[bin], db = values[bin];
            const y = top + Math.min(120, Math.max(0, -db)) / 120 * plotHeight;
            ctx.lineTo(left + x, y);
          }
          ctx.stroke();
        }
      } else {
        const duration = data[0].length / data[0].rate;
        const top = 8, h = 144;
        ctx.imageSmoothingEnabled = false;
        this.display.image ||= this.heatmap(data);
        ctx.drawImage(this.display.image, left, top, plotWidth, h);
        ctx.fillStyle = '#5c7288';
        let lastLabelY = Infinity;
        for (const hz of [20, 500, 1000, 2000, 5000, 10000, maxHz].filter(hz => hz <= maxHz)) {
          const y = top + (1 - melPosition(hz, maxHz)) * h;
          const labelY = Math.max(top + 8, Math.min(top + h, y + 4));
          if (lastLabelY - labelY < 13 || (hz !== maxHz && labelY < top + 21)) continue;
          ctx.fillText(frequencyLabel(hz), 0, labelY); lastLabelY = labelY;
        }
        for (let n = 0; n <= 2; n++) {
          ctx.textAlign = n === 2 ? 'right' : n === 0 ? 'left' : 'center';
          ctx.fillText(`${(start + duration * n / 2).toFixed(1)} s`, left + plotWidth * n / 2, top + h + 15);
        }
        const gradient = ctx.createLinearGradient(left, 0, right, 0);
        for (let i = 0; i <= 4; i++) gradient.addColorStop(i / 4, `rgb(${differenceColor(i * 12 - 24).join(',')})`);
        ctx.fillStyle = gradient; ctx.fillRect(left, 184, plotWidth, 6);
        ctx.fillStyle = '#5c7288'; ctx.fillText('−24 dB 減少', left, 207);
        ctx.textAlign = 'center'; ctx.fillText('0', left + plotWidth / 2, 207);
        ctx.textAlign = 'right'; ctx.fillText('+24 dB 増加', right, 207);
      }
    }
    this.plotWidth = width;
    this.drawPosition(position);
  }
  drawPosition(position) {
    if (this.cursor && this.display && this.plotWidth) this.cursor.style.left = `${40 + timePosition(position, this.display.data[0].length / this.display.data[0].rate) * (this.plotWidth - 52)}px`;
  }
  heatmap([reference, selected], width = Math.max(1, Math.ceil(reference.length / reference.rate * 10))) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 64;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    const columns = fftColumns(reference, width);
    for (let y = 0; y < 64; y++) for (let x = 0; x < width; x++) {
      const index = columns[x] * 64 + 63 - y;
      const color = differenceColor(bandDifference(reference.bands[index], selected.bands[index]));
      image.data.set([...color, 255], (y * width + x) * 4);
    }
    ctx.putImageData(image, 0, 0); return canvas;
  }
}
