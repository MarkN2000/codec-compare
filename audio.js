import { LIMITS, CODECS, commonFilter, encodeArgs, chunkArgs, samePreview } from './model.js';

// 各インスタンスは1件ずつ処理する。変換用と再生用の2つだけを生成する。
export class Engine {
  constructor() { this.logs = []; this.blob = null; }
  async load() {
    if (!this.loading) this.loading = (async () => {
      const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
      if (this.closed) throw Error('処理を取り消しました。');
      this.ffmpeg = new FFmpeg();
      this.ffmpeg.on('log', ({ message }) => {
        this.logs.push(message);
        if (this.logs.length > 12) this.logs.shift();
        this.onLog?.(message);
      });
      this.ffmpeg.on('progress', ({ time }) => this.onProgress?.(time / 1000000));
      await this.ffmpeg.load({ coreURL: new URL('./vendor/core/ffmpeg-core.js', import.meta.url).href, wasmURL: new URL('./vendor/core/ffmpeg-core.wasm', import.meta.url).href });
      await this.ffmpeg.createDir('/input');
    })();
    return this.loading;
  }
  async mount(blob) {
    await this.load();
    if (this.blob === blob) return;
    if (this.blob) await this.ffmpeg.unmount('/input');
    this.blob = null;
    if (!await this.ffmpeg.mount('WORKERFS', { blobs: [{ name: 'audio', data: blob }] }, '/input')) throw Error('ファイル参照の初期化に失敗しました。');
    this.blob = blob;
  }
  async run(args, probe = false) {
    this.logs = [];
    const result = await this.ffmpeg[probe ? 'ffprobe' : 'exec'](args);
    // core 0.12.10のffprobeは正常終了でも-1を返す。直後のJSON解析で出力を検証する。
    if (result !== 0 && !(probe && result === -1)) throw Error(`音声処理に失敗しました。${this.logs.filter(s => !s.startsWith('Aborted')).slice(-3).join(' ')}`);
  }
  async analyze(file) {
    if (!file.size || file.size > LIMITS.input) throw Error('0バイトのファイル、または256 MiBを超える入力は扱えません。');
    await this.mount(file);
    await this.run(['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', '-o', '/probe.json', '/input/audio'], true);
    const info = JSON.parse(await this.ffmpeg.readFile('/probe.json', 'utf8')).streams?.[0];
    await this.ffmpeg.deleteFile('/probe.json');
    const rate = Number(info?.sample_rate), originalChannels = Number(info?.channels);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(originalChannels) || originalChannels < 1) throw Error('対応する音声がありません。8～192 kHzの音源を選択してください。');
    let frames = 0;
    this.onLog = message => { const match = message.match(/\bnb_samples:(\d+)/); if (match) frames += Number(match[1]); };
    try { await this.run(['-v', 'info', '-i', '/input/audio', '-map', '0:a:0', '-vn', '-af', 'ashowinfo', '-f', 'null', '-']); }
    finally { this.onLog = null; }
    if (!frames) throw Error('音声サンプルを読み取れませんでした。');
    return { file, codec: info.codec_name, rate, channels: Math.min(2, originalChannels), originalChannels, bits: Number(info.bits_per_raw_sample || info.bits_per_sample) || null, frames, duration: frames / rate };
  }
  async encode(source, config) {
    const codec = CODECS[config.codec], path = `/output.${codec.ext}`;
    if (config.codec === 'wav' && source.duration * config.rate * config.channels * config.depth / 8 >= LIMITS.output - 65536) throw Error('この設定の出力は128 MiBを超えます。サンプルレートやビット深度を下げてください。');
    await this.mount(source.file);
    try {
      await this.run(encodeArgs(source, config));
      const data = await this.ffmpeg.readFile(path);
      if (data.length >= LIMITS.output - 65536) throw Error('出力上限の128 MiBに達したため、生成を取り消しました。');
      return new Blob([data], { type: codec.mime });
    } finally { await this.ffmpeg.deleteFile(path).catch(() => {}); }
  }
  terminate() { this.closed = true; this.ffmpeg?.terminate(); this.blob = null; }
}

export class Player {
  constructor(onChange, onError) {
    this.onChange = onChange;
    this.onError = onError;
    this.engine = new Engine();
    this.revision = 0;
    this.nodes = new Set();
    this.cache = [];
    this.playing = false;
    this.buffering = false;
    this.anchorFrame = 0;
    this.chunkSeconds = 8;
    this.timer = setInterval(() => this.pump(), 100);
  }
  setSource(source) {
    this.pause();
    this.revision++;
    this.engine.terminate();
    this.engine = new Engine();
    this.source = source;
    this.target = { id: 'reference', key: 'reference', reference: true, channels: source.channels, blob: source.file };
    this.requested = null;
    this.cache = [];
    this.anchorFrame = 0;
    this.chunkSeconds = 8;
    this.emit();
  }
  get rate() { return this.context?.sampleRate || 48000; }
  get totalFrames() { return Math.round((this.source?.duration || 0) * this.rate); }
  get frame() {
    return this.playing && !this.buffering ? Math.min(this.totalFrames, this.scheduledEnd, Math.max(this.anchorFrame, this.anchorFrame + Math.floor((this.context.currentTime - this.anchorTime) * this.rate))) : this.anchorFrame;
  }
  get position() { return this.frame / this.rate; }
  get ahead() { return this.playing && !this.buffering ? Math.max(0, (this.scheduledEnd - this.frame) / this.rate) : 0; }
  get canEncode() { return !this.playing || (!this.buffering && this.ahead >= 2); }
  emit() { this.onChange?.({ playing: this.playing, buffering: this.buffering, selected: this.target?.id, pending: this.requested?.id }); }
  async play() {
    if (!this.source) return;
    const revision = this.revision;
    const seconds = this.position;
    this.context ||= new AudioContext();
    await this.context.resume();
    if (revision !== this.revision) return;
    this.anchorFrame = Math.round(seconds * this.rate);
    if (this.anchorFrame >= this.totalFrames) this.anchorFrame = 0;
    this.playing = true;
    this.buffering = true;
    this.emit();
    this.pump();
  }
  stopNodes(at = this.context?.currentTime || 0) {
    if (this.bus) {
      this.bus.gain.cancelScheduledValues(at);
      this.bus.gain.setValueAtTime(this.bus.gain.value, at);
      this.bus.gain.linearRampToValueAtTime(0, at + 0.005);
      const oldBus = this.bus;
      setTimeout(() => oldBus.disconnect(), Math.max(0, (at - this.context.currentTime + 0.01) * 1000));
    }
    for (const node of this.nodes) { try { node.stop(at + 0.005); } catch {} }
    this.nodes.clear();
    this.bus = null;
  }
  pause() {
    this.anchorFrame = this.frame;
    this.playing = false;
    this.buffering = false;
    this.revision++;
    this.stopNodes();
    this.emit();
  }
  seek(seconds) {
    if (!this.source) return;
    this.revision++;
    this.stopNodes();
    this.anchorFrame = Math.round(Math.max(0, Math.min(seconds, this.source.duration)) * this.rate);
    this.cache = [];
    this.buffering = this.playing;
    this.emit();
    this.pump();
  }
  select(pattern) {
    if (!this.source) return;
    const shared = !pattern || samePreview(pattern.config, this.source);
    const target = { id: pattern?.id || 'reference', key: shared ? 'reference' : pattern.id, reference: shared, codec: pattern?.config.codec, channels: shared ? this.source.channels : pattern.config.channels, blob: shared ? this.source.file : pattern.blob };
    if (!target.blob) return;
    if (!this.playing || target.key === this.target.key) {
      this.target = target;
      this.requested = null;
      this.cache = this.cache.filter(c => c.key === target.key);
    } else this.requested = target.id === this.target.id ? null : target;
    this.emit();
    this.pump();
  }
  async decode(target, start, revision) {
    const frames = Math.min(this.totalFrames - start, Math.round(this.chunkSeconds * this.rate));
    const engine = this.engine, begin = performance.now();
    await engine.mount(target.blob);
    await engine.run(chunkArgs(this.source, target, start, frames, this.rate));
    const data = await engine.ffmpeg.readFile('/chunk.f32');
    await engine.ffmpeg.deleteFile('/chunk.f32');
    if (revision !== this.revision) return null;
    const samples = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const received = samples.length / target.channels;
    if (received < frames - 2) throw Error('必要な再生区間を復号できませんでした。この音源では正確な区間再生に対応できません。');
    const buffer = this.context.createBuffer(target.channels, frames, this.rate);
    for (let ch = 0; ch < target.channels; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < Math.min(frames, received); i++) out[i] = samples[i * target.channels + ch];
    }
    // ponytail: 前回の復号時間だけで調整する。上限16秒。継続的に間に合わない場合は待機する。
    this.chunkSeconds = Math.max(4, Math.min(16, Math.ceil((performance.now() - begin) / 1000 * 4)));
    const chunk = { key: target.key, start, end: start + frames, buffer };
    this.cache.push(chunk);
    return chunk;
  }
  schedule(chunk, start, when) {
    const node = this.context.createBufferSource();
    node.buffer = chunk.buffer;
    node.connect(this.bus);
    this.nodes.add(node);
    node.onended = () => { node.disconnect(); this.nodes.delete(node); };
    node.start(when, (start - chunk.start) / this.rate, (chunk.end - start) / this.rate);
    this.scheduledEnd = chunk.end;
    this.endTime = when + (chunk.end - start) / this.rate;
  }
  begin(chunk, start, when) {
    this.bus = this.context.createGain();
    this.bus.connect(this.context.destination);
    this.bus.gain.setValueAtTime(0, when);
    this.bus.gain.linearRampToValueAtTime(1, when + 0.005);
    this.anchorFrame = start;
    this.anchorTime = when;
    this.buffering = false;
    this.schedule(chunk, start, when);
  }
  async pump() {
    if (this.busy || !this.playing || !this.source || !this.context) return;
    this.busy = true;
    const revision = this.revision;
    try {
      let pos = this.frame;
      if (pos >= this.totalFrames) { this.pause(); this.anchorFrame = this.totalFrames; return; }
      this.cache = this.cache.filter(c => c.key === this.target.key && c.end > pos);
      if (!this.buffering && this.context.currentTime >= this.endTime) {
        this.anchorFrame = this.scheduledEnd;
        this.buffering = true;
        this.stopNodes();
        this.emit();
      }
      if (this.buffering) {
        pos = this.anchorFrame;
        const chunk = this.cache.find(c => c.start <= pos && c.end > pos) || await this.decode(this.target, pos, revision);
        if (!chunk || revision !== this.revision) return;
        this.begin(chunk, pos, this.context.currentTime + 0.025);
        this.emit();
      }
      // 選択中の次区間を先に準備する。切替先の復号で現在の再生を止めない。
      if (this.scheduledEnd < this.totalFrames && this.cache.filter(c => c.key === this.target.key && c.end > this.frame).length < 2) {
        const start = this.scheduledEnd;
        const chunk = this.cache.find(c => c.start === start && c.key === this.target.key) || await this.decode(this.target, start, revision);
        if (!chunk || revision !== this.revision) return;
        if (this.endTime > this.context.currentTime + 0.01) this.schedule(chunk, start, this.endTime);
        else {
          this.anchorFrame = start;
          this.buffering = true;
          this.emit();
          return;
        }
      }
      if (this.requested) {
        const target = this.requested;
        const start = Math.max(0, this.frame - Math.round(this.rate * 0.1));
        const chunk = await this.decode(target, start, revision);
        if (!chunk || revision !== this.revision || this.requested !== target) return;
        const when = this.context.currentTime + 0.025;
        const switchFrame = this.frame + Math.round((when - this.context.currentTime) * this.rate);
        if (switchFrame + this.rate * 0.1 >= chunk.end || when >= this.endTime) return;
        this.stopNodes(when - 0.005);
        this.target = target;
        this.requested = null;
        this.cache = [chunk];
        this.begin(chunk, switchFrame, when);
        this.emit();
      }
    } catch (error) {
      if (revision === this.revision) { this.pause(); this.requested = null; this.onError?.(error); }
    } finally { this.busy = false; }
  }
  dispose() { this.pause(); clearInterval(this.timer); this.engine.terminate(); this.context?.close(); }
}
