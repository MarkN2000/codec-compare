export const LIMITS = { input: 512 * 1024 ** 2, output: 512 * 1024 ** 2, total: 1024 ** 3 };
const commonRates = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
const commonCutoffs = [0, 3400, 4000, 6000, 7000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22050, 24000, 32000, 40000, 44100, 48000];
export const CODECS = {
  opus: { name: 'Opus', ext: 'ogg', mime: 'audio/ogg', encoder: 'libopus', rates: [8000, 12000, 16000, 24000, 48000], modes: ['VBR', 'CBR'], bits: [6, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 160, 192, 256], defaultRate: 48000, defaultBitrate: 128, cutoffs: [0, 4000, 6000, 8000, 12000, 20000] },
  mp3: { name: 'MP3', ext: 'mp3', mime: 'audio/mpeg', encoder: 'libmp3lame', rates: commonRates.filter(n => n <= 48000), modes: ['CBR', 'VBR'], bits: [32, 48, 64, 96, 128, 160, 192, 256, 320], defaultBitrate: 192, qualities: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], cutoffs: commonCutoffs },
  aac: { name: 'AAC', ext: 'm4a', mime: 'audio/mp4', encoder: 'aac', rates: commonRates.filter(n => n <= 96000), bits: [32, 48, 64, 96, 128, 160, 192, 256, 320], defaultBitrate: 256, cutoffs: commonCutoffs },
  vorbis: { name: 'Vorbis', ext: 'ogg', mime: 'audio/ogg', encoder: 'libvorbis', rates: commonRates.filter(n => n <= 96000), qualities: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cutoffs: commonCutoffs },
  lc3: { name: 'LC3', ext: 'lc3', mime: 'application/octet-stream', encoder: 'liblc3', rates: [8000, 16000, 24000, 32000, 48000], modes: ['CBR'], bits: [16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 256], frameDurations: [7.5, 10] },
  sbc: { name: 'SBC', ext: 'sbc', mime: 'audio/sbc', encoder: 'sbc', rates: [16000, 32000, 44100, 48000], modes: ['CBR'], bits: [64, 96, 128, 160, 192, 256, 320] },
  g722: { name: 'G.722', ext: 'wav', mime: 'audio/wav', encoder: 'g722', rates: [16000], channels: [1], modes: ['CBR'], bits: [64] },
  g711: { name: 'G.711', ext: 'wav', mime: 'audio/wav', rates: [8000], channels: [1], modes: ['CBR'], bits: [64], laws: [['mulaw', 'μ-law'], ['alaw', 'A-law']] },
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
  const config = { codec, rate: rates.includes(source.rate) ? source.rate : (c.defaultRate || Math.min(48000, rates.at(-1))), channels: c.channels?.[0] || source.channels, depth: 24, mode: c.modes?.[0], bitrate: c.defaultBitrate ? c.defaultBitrate * source.channels / 2 : c.bits?.[0], quality: codec === 'mp3' ? 2 : 4, level: 5, cutoff: 0, frameDuration: c.frameDurations?.at(-1), law: c.laws?.[0][0] };
  if (codec === 'sbc') config.bitrate = config.rate === 44100 ? (config.channels === 1 ? 193 : 328) : config.rate === 48000 ? (config.channels === 1 ? 198 : 345) : bitratesFor(config).at(-1);
  if (codec === 'lc3') config.bitrate = ({ 8000: 24, 16000: 32, 24000: 48, 32000: 64, 48000: 96 })[config.rate] * config.channels;
  if (c.bits && !bitratesFor(config).includes(config.bitrate)) config.bitrate = bitratesFor(config).at(-1);
  return config;
}
export function bitratesFor(c) {
  let bits = CODECS[c.codec].bits || [];
  if (c.codec === 'sbc' && c.rate >= 44100) bits = c.channels === 1
    ? [...bits.filter(n => n <= 256), ...(c.rate === 44100 ? [127, 193] : [132, 198])].sort((a, b) => a - b)
    : [128, 192, c.rate === 44100 ? 229 : 237, 256, 320, c.rate === 44100 ? 328 : 345];
  if (c.codec === 'lc3') bits = [...bits, (c.frameDuration === 7.5 ? 124.8 : 124) * c.channels].sort((a, b) => a - b);
  return bits.filter(n => (c.codec !== 'mp3' || (c.rate < 32000 ? n <= 160 : n >= 32)) &&
    (c.codec !== 'sbc' || n <= c.rate * c.channels * 8 / 1000) &&
    (c.codec !== 'lc3' || (n <= 128 * c.channels && n * c.frameDuration / 8 / c.channels >= 20 && n * c.frameDuration / 8 / c.channels <= 400)));
}
export function cutoffsFor(c) { return CODECS[c.codec]?.cutoffs?.filter(hz => hz <= c.rate / 2) || []; }
export function validateConfig(c, source) {
  const codec = CODECS[c.codec];
  if (!codec || !ratesFor(c.codec, source.rate).includes(c.rate) || !(codec.channels || [1, 2]).includes(c.channels)) throw Error('音声の設定が不正です。');
  if (codec.depths && !codec.depths.includes(c.depth)) throw Error('ビット深度を選択してください。');
  if (codec.modes && !codec.modes.includes(c.mode)) throw Error('圧縮モードを選択してください。');
  if (codec.laws && !codec.laws.some(([law]) => law === c.law)) throw Error('圧伸方式を選択してください。');
  if (codec.frameDurations && !codec.frameDurations.includes(c.frameDuration)) throw Error('フレーム長を選択してください。');
  if (codec.bits && !(c.codec === 'mp3' && c.mode === 'VBR') && !bitratesFor(c).includes(c.bitrate)) throw Error('ビットレートを選択してください。');
  if (codec.qualities && (c.codec === 'vorbis' || c.mode === 'VBR') && !codec.qualities.includes(c.quality)) throw Error('品質を選択してください。');
  if (codec.levels && !codec.levels.includes(c.level)) throw Error('圧縮レベルを選択してください。');
  if ((c.cutoff ?? 0) !== 0 && !cutoffsFor(c).includes(c.cutoff)) throw Error('この形式・サンプルレートで選べるカットオフを指定してください。');
}
export function commonFilter(source) {
  // ponytail: aeval は毎サンプル評価。高レートで遅い場合は24 bit量子化専用フィルターへ置換する。
  return `aformat=sample_fmts=dblp:channel_layouts=${source.channels === 1 ? 'mono' : 'stereo'},aeval='clip(floor(val(ch)*8388608+0.5),-8388608,8388607)/8388608':c=same`;
}
export function codecDelay(c) {
  if (c.codec === 'lc3') return Math.round(c.rate * (c.frameDuration === 7.5 ? .004 : .0025));
  if (c.codec === 'g722') return 22;
  return c.codec === 'sbc' ? 73 : 0;
}
export function encodeArgs(source, c, input = '/input/audio', output = `/output.${CODECS[c.codec].ext}`) {
  validateConfig(c, source);
  const codec = CODECS[c.codec];
  const delay = codecDelay(c), padding = delay + (c.codec === 'sbc' ? 127 : 0);
  const filter = commonFilter(source) + (delay && c.codec !== 'lc3' ? `,aresample=${c.rate},apad=pad_len=${padding}` : '');
  const args = ['-v', 'error', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-af', filter, '-ar', String(c.rate), '-ac', String(c.channels), '-c:a', c.codec === 'g711' ? `pcm_${c.law}` : codec.encoder || `pcm_s${c.depth}le`];
  if (c.codec === 'opus') args.push('-b:a', `${c.bitrate}k`, '-vbr', c.mode === 'VBR' ? 'on' : 'off');
  if (c.codec === 'mp3') args.push(...(c.mode === 'VBR' ? ['-q:a', String(c.quality)] : ['-b:a', `${c.bitrate}k`]));
  if (c.codec === 'aac') args.push('-b:a', `${c.bitrate}k`);
  if (['g722', 'g711'].includes(c.codec)) args.push('-b:a', `${c.bitrate}k`);
  if (c.codec === 'sbc') {
    const bitpool = Math.round((c.bitrate * 1000 * 128 / c.rate - 32 - 32 * c.channels - (c.channels === 2 ? 8 : 0)) / 16);
    // 128kでJoint Stereo／8サブバンドを選ばせ、実レートは-q:aのビットプールで指定する。
    args.push('-b:a', '128k', '-q:a', String(bitpool), '-sbc_delay', '0.013');
  }
  if (c.codec === 'lc3') args.push('-b:a', `${c.bitrate}k`, '-frame_duration', String(c.frameDuration));
  if (c.codec === 'vorbis') args.push('-q:a', String(c.quality));
  if (c.codec === 'flac') args.push('-sample_fmt', c.depth === 24 ? 's32' : 's16', '-bits_per_raw_sample', String(c.depth), '-compression_level', String(c.level));
  if (c.cutoff) args.push('-cutoff', String(c.cutoff));
  args.push('-fs', String(LIMITS.output), output);
  return args;
}
export function samePreview(c, source) {
  return ['flac', 'wav'].includes(c.codec) && c.rate === source.rate && c.channels === source.channels && c.depth === 24;
}
export function needsPCM(source, target) {
  return ['adpcm', 'g722', 'sbc', 'lc3'].includes(target.codec) || (target.reference && (source.codec?.startsWith('adpcm') || ['sbc', 'lc3'].includes(source.codec)));
}
export function chunkArgs(source, target, start, frames, rate, input = '/input/audio', output = '/chunk.f32') {
  // 先頭からの時刻を維持してリサンプルし、整数サンプル位置で切る。シーク前に1秒の助走を取る。
  // ponytail: 一時PCMの作成・保存不可時は先頭から予測状態と時刻を揃える。
  // 保存不可の環境では後半ほど遅くなる。改善時は状態付きの区間索引を導入する。
  const fromStart = needsPCM(source, target);
  const seek = fromStart ? 0 : Math.max(0, Math.floor(start / rate) - 1);
  const delay = target.reference ? 0 : codecDelay(target);
  const filters = [target.reference ? commonFilter(source) : '', delay ? `atrim=start_sample=${delay},asetpts=PTS-STARTPTS` : '', `aresample=${rate}`, `atrim=start_sample=${start - seek * rate}:end_sample=${start - seek * rate + frames}`, 'asetpts=PTS-STARTPTS'].filter(Boolean);
  return ['-v', 'error', ...(fromStart ? [] : ['-ss', String(seek)]), ...((target.reference ? source.codec : target.codec) === 'sbc' ? ['-f', 'sbc'] : []), '-i', input, '-map', '0:a:0', '-vn', '-af', filters.join(','), '-t', String(frames / rate), '-ac', String(target.channels), '-c:a', 'pcm_f32le', '-f', 'f32le', output];
}
export function metrics(bytes, source) {
  const ratio = bytes / (source.frames * source.channels * 3) * 100;
  return { ratio, saved: 100 - ratio, bitrate: bytes * 8 / source.duration / 1000 };
}
export function description(c) {
  const parts = [];
  if (c.codec === 'g711') parts.push(CODECS.g711.laws.find(([law]) => law === c.law)[1]);
  if (c.codec === 'mp3' && c.mode === 'VBR') parts.push(`VBR 品質 ${c.quality}`);
  else if (CODECS[c.codec].bits) parts.push(`${c.bitrate} kbps${c.mode ? ` ${c.mode}` : '（平均）'}`);
  if (c.codec === 'vorbis') parts.push(`品質 ${c.quality}`);
  if (c.codec === 'flac') parts.push(`レベル ${c.level}`);
  if (c.codec === 'lc3') parts.push(`${c.frameDuration} ms`);
  parts.push(`${c.rate.toLocaleString()} Hz`);
  if (CODECS[c.codec].depths) parts.push(`${c.depth} bit`);
  if (c.cutoff) parts.push(`カットオフ ${c.cutoff.toLocaleString()} Hz`);
  parts.push(c.channels === 1 ? 'モノラル' : 'ステレオ');
  return parts.join(' · ');
}
export function timeLabel(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}
export function sizeLabel(bytes) { return `${(bytes / 1000 ** 2).toFixed(2)} MB`; }
