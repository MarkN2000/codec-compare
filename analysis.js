// 4秒分だけを扱う分析Worker。左右は波形を足さず、パワーを平均する。
export const FFT_SIZE = 4096;
const HOP = FFT_SIZE / 2, BINS = HOP + 1;
const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
const reverse = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let value = 0;
  for (let bit = 0; bit < 12; bit++) { value = value * 2 + (i & 1); i >>= 1; }
  return value;
});
const cos = Float64Array.from({ length: HOP }, (_, i) => Math.cos(2 * Math.PI * i / FFT_SIZE));
const sin = Float64Array.from({ length: HOP }, (_, i) => -Math.sin(2 * Math.PI * i / FFT_SIZE));

export function spectrumFrames(channels, rate) {
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
        const scale = bin === 0 || bin === HOP ? 1 : 4;
        powers[row * BINS + bin] += (real[bin] ** 2 + imag[bin] ** 2) * scale / Math.max(1e-30, weight ** 2) / channels.length;
      }
    }
  }
  return { powers, times, bins: BINS, rate, length };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try {
      const results = data.channels.map(channels => spectrumFrames(channels, data.rate));
      self.postMessage({ results }, results.flatMap(r => [r.powers.buffer, r.times.buffer]));
    } catch (error) { self.postMessage({ error: error.message }); }
  };
}
