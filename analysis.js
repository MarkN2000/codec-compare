// 4秒分だけを扱う分析Worker。左右は波形を足さず、パワーを平均する。
export const FFT_SIZE = 1024;
// ponytail: 実行回数を増やさない代わりに窓の間の瞬間的な変化を見落とす。全時間を覆う必要が出たらHOPを1024以下にする。
const HOP = 2048, HALF = FFT_SIZE / 2, BINS = HALF + 1;
export function melAt(position, maxHz) { return 720 * ((maxHz + 700) / 720) ** position - 700; }
export function melPosition(hz, maxHz) { return Math.log((hz + 700) / 720) / Math.log((maxHz + 700) / 720); }
const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
const reverse = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let value = 0;
  for (let bit = 0; bit < 10; bit++) { value = value * 2 + (i & 1); i >>= 1; }
  return value;
});
const cos = Float64Array.from({ length: HALF }, (_, i) => Math.cos(2 * Math.PI * i / FFT_SIZE));
const sin = Float64Array.from({ length: HALF }, (_, i) => -Math.sin(2 * Math.PI * i / FFT_SIZE));

export function* spectrumSteps(channels, rate) {
  const length = channels[0]?.length;
  if (![1, 2].includes(channels.length) || !Number.isFinite(rate) || rate < 8000 || rate > 192000 ||
    !length || length > rate * 4 || channels.some(c => !(c instanceof Float32Array) || c.length !== length)) throw Error('分析する区間が不正です。');
  const rows = Math.max(1, Math.ceil((length - FFT_SIZE) / HOP) + 1);
  const powers = new Float32Array(rows * BINS), times = new Float32Array(rows);
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  const used = Math.min(length, FFT_SIZE);
  let weight = 0;
  for (let i = 0; i < used; i++) weight += window[i];
  for (let row = 0; row < rows; row++) {
    const start = Math.min(row * HOP, Math.max(0, length - FFT_SIZE));
    times[row] = (start + used / 2) / rate;
    for (const samples of channels) {
      for (let i = 0; i < FFT_SIZE; i++) {
        real[reverse[i]] = i < used ? samples[start + i] * window[i] : 0;
        imag[i] = 0;
      }
      for (let size = 2; size <= FFT_SIZE; size *= 2) {
        const half = size / 2, step = FFT_SIZE / size;
        for (let base = 0; base < FFT_SIZE; base += size) {
          for (let j = 0; j < half; j++) {
            const a = base + j, b = a + half, k = j * step;
            const re = real[b] * cos[k] - imag[b] * sin[k];
            const im = real[b] * sin[k] + imag[b] * cos[k];
            real[b] = real[a] - re; imag[b] = imag[a] - im;
            real[a] += re; imag[a] += im;
          }
        }
      }
      for (let bin = 0; bin < BINS; bin++) {
        const scale = bin === 0 || bin === HALF ? 1 : 4;
        powers[row * BINS + bin] += (real[bin] ** 2 + imag[bin] ** 2) * scale / Math.max(1e-30, weight ** 2) / channels.length;
      }
    }
    if (row % 4 === 3) yield;
  }
  return { powers, times, bins: BINS, rate, length };
}

export function spectrumFrames(channels, rate) {
  const steps = spectrumSteps(channels, rate);
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

// 周波数のビンは落とさず、同じ時刻の窓を約0.1秒へまとめて保存する。
export function compactFrames(data) {
  const { bins, rate, length } = data;
  const rows = Math.min(data.times.length, Math.max(1, Math.ceil(length / rate * 10)));
  const powers = new Float32Array(rows * bins), bands = new Float32Array(rows * 64);
  const times = new Float32Array(rows), weights = new Uint16Array(rows);
  let cursor = 0, nearest = 0;
  for (let row = 0; row < rows; row++) {
    const center = (row + .5) / rows * length / rate, end = (row + 1) / rows * length / rate;
    while (nearest + 1 < data.times.length && Math.abs(data.times[nearest + 1] - center) <= Math.abs(data.times[nearest] - center)) nearest++;
    const begin = cursor;
    while (cursor < data.times.length && data.times[cursor] < end) cursor++;
    const a = cursor > begin ? begin : nearest, b = cursor > begin ? cursor : nearest + 1;
    weights[row] = b - a;
    for (let i = a; i < b; i++) {
      times[row] += data.times[i] / weights[row];
      for (let bin = 0; bin < bins; bin++) powers[row * bins + bin] += data.powers[i * bins + bin] / weights[row];
    }
    for (let band = 0; band < 64; band++) {
      const step = rate / 2 / (bins - 1);
      const first = Math.min(bins - 1, Math.max(1, Math.round(melAt(band / 64, rate / 2) / step)));
      const last = Math.min(bins, Math.max(first + 1, Math.round(melAt((band + 1) / 64, rate / 2) / step)));
      for (let bin = first; bin < last; bin++) bands[row * 64 + band] += powers[row * bins + bin] / (last - first);
    }
  }
  return { powers, bands, times, weights, bins, rate, length };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let paused = false;
  const yieldTask = ms => new Promise(resolve => setTimeout(resolve, ms));
  self.onmessage = async ({ data }) => {
    if ('paused' in data) { paused = data.paused; return; }
    try {
      const results = [];
      let elapsedMs = 0;
      for (const channels of data.channels) {
        const steps = spectrumSteps(channels, data.rate);
        let step;
        do {
          while (paused) await yieldTask(20);
          const begin = performance.now();
          step = steps.next(); elapsedMs += performance.now() - begin;
          if (!step.done) await yieldTask(0);
        } while (!step.done);
        const begin = performance.now();
        results.push(compactFrames(step.value)); elapsedMs += performance.now() - begin;
      }
      self.postMessage({ results, elapsedMs }, results.flatMap(r => [r.powers.buffer, r.times.buffer, r.bands.buffer, r.weights.buffer]));
    } catch (error) { self.postMessage({ error: error.message }); }
  };
}
