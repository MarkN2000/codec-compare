export const LIMITS = { input: 256 * 1024 ** 2, output: 128 * 1024 ** 2, total: 512 * 1024 ** 2 };
const commonRates = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
export const CODECS = {
  opus: { name: 'Opus', ext: 'ogg', mime: 'audio/ogg', encoder: 'libopus', rates: [8000, 12000, 16000, 24000, 48000], modes: ['VBR', 'CBR'], bits: [32, 48, 64, 96, 128, 160, 192, 256], defaultRate: 48000 },
  mp3: { name: 'MP3', ext: 'mp3', mime: 'audio/mpeg', encoder: 'libmp3lame', rates: commonRates.filter(n => n <= 48000), modes: ['CBR', 'VBR'], bits: [32, 48, 64, 96, 128, 160, 192, 256, 320], qualities: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  aac: { name: 'AAC', ext: 'm4a', mime: 'audio/mp4', encoder: 'aac', rates: commonRates.filter(n => n <= 96000), bits: [32, 48, 64, 96, 128, 160, 192, 256, 320] },
  vorbis: { name: 'Vorbis', ext: 'ogg', mime: 'audio/ogg', encoder: 'libvorbis', rates: commonRates.filter(n => n <= 96000), qualities: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  adpcm: { name: 'IMA ADPCM', ext: 'wav', mime: 'audio/wav', encoder: 'adpcm_ima_wav', rates: commonRates },
  flac: { name: 'FLAC', ext: 'flac', mime: 'audio/flac', encoder: 'flac', rates: commonRates, depths: [16, 24], levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  wav: { name: 'PCM WAV', ext: 'wav', mime: 'audio/wav', rates: commonRates, depths: [16, 24] },
};
export function ratesFor(codec, sourceRate) {
  const rates = CODECS[codec].rates;
  return ['flac', 'wav', 'adpcm'].includes(codec) ? [...new Set([...rates, sourceRate])].sort((a, b) => a - b) : rates;
}
export function defaults(codec, source) {
  const c = CODECS[codec], rates = ratesFor(codec, source.rate);
  return { codec, rate: rates.includes(source.rate) ? source.rate : (c.defaultRate || Math.min(48000, rates.at(-1))), channels: source.channels, depth: 24, mode: c.modes?.[0], bitrate: 128, quality: codec === 'mp3' ? 2 : 4, level: 5 };
}
export function bitratesFor(c) {
  return CODECS[c.codec].bits?.filter(n => c.codec !== 'mp3' || (c.rate < 32000 ? n <= 160 : n >= 32)) || [];
}
export function validateConfig(c, source) {
  const codec = CODECS[c.codec];
  if (!codec || !ratesFor(c.codec, source.rate).includes(c.rate) || ![1, 2].includes(c.channels)) throw Error('音声の設定が不正です。');
  if (codec.depths && !codec.depths.includes(c.depth)) throw Error('ビット深度を選択してください。');
  if (codec.modes && !codec.modes.includes(c.mode)) throw Error('圧縮モードを選択してください。');
  if (codec.bits && !(c.codec === 'mp3' && c.mode === 'VBR') && !bitratesFor(c).includes(c.bitrate)) throw Error('ビットレートを選択してください。');
  if (codec.qualities && (c.codec === 'vorbis' || c.mode === 'VBR') && !codec.qualities.includes(c.quality)) throw Error('品質を選択してください。');
  if (codec.levels && !codec.levels.includes(c.level)) throw Error('圧縮レベルを選択してください。');
}
export function commonFilter(source) {
  // ponytail: aeval は毎サンプル評価。高レートで遅い場合は24 bit量子化専用フィルターへ置換する。
  return `aformat=channel_layouts=${source.channels === 1 ? 'mono' : 'stereo'},aeval='clip(floor(val(ch)*8388608+0.5),-8388608,8388607)/8388608':c=same`;
}
export function encodeArgs(source, c, input = '/input/audio', output = `/output.${CODECS[c.codec].ext}`) {
  validateConfig(c, source);
  const codec = CODECS[c.codec];
  const args = ['-v', 'error', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-af', commonFilter(source), '-ar', String(c.rate), '-ac', String(c.channels), '-c:a', codec.encoder || `pcm_s${c.depth}le`];
  if (c.codec === 'opus') args.push('-b:a', `${c.bitrate}k`, '-vbr', c.mode === 'VBR' ? 'on' : 'off');
  if (c.codec === 'mp3') args.push(...(c.mode === 'VBR' ? ['-q:a', String(c.quality)] : ['-b:a', `${c.bitrate}k`]));
  if (c.codec === 'aac') args.push('-b:a', `${c.bitrate}k`);
  if (c.codec === 'vorbis') args.push('-q:a', String(c.quality));
  if (c.codec === 'flac') args.push('-sample_fmt', c.depth === 24 ? 's32' : 's16', '-bits_per_raw_sample', String(c.depth), '-compression_level', String(c.level));
  args.push('-fs', String(LIMITS.output), output);
  return args;
}
export function samePreview(c, source) {
  return ['flac', 'wav'].includes(c.codec) && c.rate === source.rate && c.channels === source.channels && c.depth === 24;
}
export function chunkArgs(source, target, start, frames, rate, input = '/input/audio', output = '/chunk.f32') {
  // 先頭からの時刻を維持してリサンプルし、整数サンプル位置で切る。シーク前に1秒の助走を取る。
  // ponytail: ADPCM/WAVのシークはブロック境界でずれるため先頭から読み捨てる。
  // 長時間音源では復号コストが増える。改善時はWAVのブロック位置を索引化する。
  const adpcm = target.codec === 'adpcm' || (target.reference && source.codec?.startsWith('adpcm'));
  const seek = adpcm ? 0 : Math.max(0, Math.floor(start / rate) - 1);
  const filters = [target.reference ? commonFilter(source) : '', `aresample=${rate}`, `atrim=start_sample=${start - seek * rate}:end_sample=${start - seek * rate + frames}`, 'asetpts=PTS-STARTPTS'].filter(Boolean);
  return ['-v', 'error', '-ss', String(seek), '-i', input, '-map', '0:a:0', '-vn', '-af', filters.join(','), '-t', String(frames / rate), '-ac', String(target.channels), '-c:a', 'pcm_f32le', '-f', 'f32le', output];
}
export function metrics(bytes, source) {
  const ratio = bytes / (source.frames * source.channels * 3) * 100;
  return { ratio, saved: 100 - ratio, bitrate: bytes * 8 / source.duration / 1000 };
}
export function description(c) {
  const parts = [];
  if (c.codec === 'mp3' && c.mode === 'VBR') parts.push(`VBR 品質 ${c.quality}`);
  else if (CODECS[c.codec].bits) parts.push(`${c.bitrate} kbps${c.mode ? ` ${c.mode}` : '（平均）'}`);
  if (c.codec === 'vorbis') parts.push(`品質 ${c.quality}`);
  if (c.codec === 'flac') parts.push(`レベル ${c.level}`);
  parts.push(`${c.rate.toLocaleString()} Hz`);
  if (CODECS[c.codec].depths) parts.push(`${c.depth} bit`);
  parts.push(c.channels === 1 ? 'モノラル' : 'ステレオ');
  return parts.join(' · ');
}
export function timeLabel(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}
export function sizeLabel(bytes) { return `${(bytes / 1000 ** 2).toFixed(2)} MB`; }
