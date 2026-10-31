import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Engine } from '../audio.js';
import { LIMITS, defaults, CODECS, chunkArgs, needsPCM } from '../model.js';
import { storedPCM, clearPCM } from '../pcm-cache.js';

test('一時PCMを直接保存し、実WASMの区間復号と一致させ、共有・上限・削除・保存失敗を扱う', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const files = new Map(), held = [], writes = [], warnings = [], warn = console.warn;
  let deny = false, quota = false;
  const dir = {
    async *entries() { yield* files.entries(); },
    async removeEntry(name) { assert.ok(!files.get(name)?.locked, '書込み終了後に削除する'); files.delete(name); },
    async getFileHandle(name) {
      if (deny) throw Error('空き容量なし');
      if (!files.has(name)) files.set(name, { parts: [], length: 0, locked: false });
      const state = files.get(name);
      return {
        async createSyncAccessHandle() {
          assert.equal(state.locked, false); state.locked = true;
          return {
            truncate(length) { state.parts = []; state.length = length; },
            write(buffer, { at }) { if (quota) throw Object.assign(Error('空き容量なし'), { name: 'QuotaExceededError' }); state.parts.push({ at, bytes: buffer.slice() }); state.length = Math.max(state.length, at + buffer.length); return buffer.length; },
            flush() {}, close() { state.locked = false; },
          };
        },
        async getFile() {
          assert.equal(state.locked, false);
          const bytes = new Uint8Array(state.length);
          for (const part of state.parts) bytes.set(part.bytes, part.at);
          return new File([bytes], name);
        },
      };
    },
  };
  const old = `${Date.now() - 86400001}-1-2-3-4-1.wav`, active = `${Date.now() - 86400001}-5-6-7-8-1.wav`;
  files.set(old, {}); files.set(active, {}); held.push({ name: `kikikurabe-pcm:${active.slice(0, active.lastIndexOf('-'))}` });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) },
    locks: { request(name, cb) { held.push({ name }); return Promise.resolve(cb()); }, query: async () => ({ held }) },
  } });
  console.warn = (...args) => warnings.push(args);
  try {
    globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
    const create = createRequire(import.meta.url)('../vendor/core/umd/ffmpeg-core.js');
    const core = await create({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
    const text = await readFile(new URL('../pcm-worker.js', import.meta.url), 'utf8');
    const scope = vm.createContext({ Uint8Array, Number, Error });
    vm.runInContext(text.slice(text.indexOf('export function pipePCM'), text.indexOf('const original')).replace('export ', ''), scope);
    scope.pipePCM(core.FS, { write: buffer => buffer.length }, '/limited', 4);
    assert.throws(() => core.FS.writeFile('/limited', new Uint8Array(5)), { errno: 51 });
    core.FS.unlink('/limited');
    scope.pipePCM(core.FS, { write: () => 0 }, '/short', 100);
    assert.throws(() => core.FS.writeFile('/short', new Uint8Array(5)), { errno: 29 });
    core.FS.unlink('/short');
    let logs = [], output, engine;
    core.setLogger(({ message }) => { logs.push(message); engine?.onLog?.(message); });
    const run = args => { logs = []; core.exec(...args); const ret = core.ret; core.reset(); assert.equal(ret, 0, logs.slice(-4).join('\n')); };
    core.FS.mkdir('/input');
    const source = { rate: 44100, channels: 2, frames: 44100 * 9 + 123, file: {}, codec: 'pcm_s16le' };
    source.duration = source.frames / source.rate;
    const samples = Float32Array.from({ length: source.frames * 2 }, (_, i) => .3 * Math.sin(i * .027) + .1 * Math.sin(i * .119));
    core.FS.writeFile('/source.raw', new Uint8Array(samples.buffer));
    run(['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '/source.raw', '/source.wav']);
    source.file = new File([core.FS.readFile('/source.wav')], 'source.wav');
    scope.pipePCM(core.FS, { write() { throw Object.assign(Error('空き容量なし'), { name: 'QuotaExceededError' }); } }, '/quota', LIMITS.output);
    core.exec('-v', 'error', '-i', '/source.wav', '-c:a', 'pcm_f32le', '-f', 'wav', '/quota');
    assert.equal(core.ret, 1, '容量不足をWASM外への例外にせず、FFmpegが後始末して終了する');
    core.reset(); core.FS.unlink('/quota');
    engine = new Engine();
    engine.mount = async blob => { core.FS.writeFile('/input/audio', new Uint8Array(await blob.arrayBuffer())); };
    engine.run = async (args, probe = false) => {
      writes.push(args);
      if (probe) { core.ffprobe(...args); core.reset(); }
      else run(args);
    };
    engine.ffmpeg = {
      readFile: async (path, encoding) => encoding === 'utf8' ? new TextDecoder().decode(core.FS.readFile(path)) : core.FS.readFile(path), deleteFile: async path => core.FS.unlink(path),
      async mount(type, { file, limit }) {
        assert.equal(type, 'PCM'); output = await file.createSyncAccessHandle(); output.truncate(0);
        core.FS.mkdir('/preview'); scope.pipePCM(core.FS, output, '/preview/audio.wav', limit); return true;
      },
      async unmount() {
        assert.ok((core.FS.lookupPath('/preview/audio.wav').node.contents?.byteLength || 0) === 0, 'MEMFSに全量PCMを蓄積しない');
        output.flush(); output.close(); core.FS.unlink('/preview/audio.wav'); core.FS.rmdir('/preview');
      },
    };
    const context = rate => ({ sampleRate: rate, createBuffer(channels, frames) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { numberOfChannels: channels, getChannelData: ch => data[ch] };
    } });
    for (const codec of ['sbc', 'lc3', 'g722', 'adpcm']) {
      const config = defaults(codec, source);
      core.FS.writeFile('/input/audio', core.FS.readFile('/source.wav'));
      const blob = await engine.encode(source, config), target = { ...config, blob };
      const input = new File([blob], `input.${CODECS[codec].ext}`);
      await engine.mount(input);
      run(['-v', 'info', ...(codec === 'sbc' ? ['-f', 'sbc'] : []), '-i', '/input/audio', '-af', 'ashowinfo', '-f', 'null', '-']);
      const expectedFrames = logs.reduce((n, line) => n + Number(line.match(/\bnb_samples:(\d+)/)?.[1] || 0), 0);
      const beforeAnalyze = writes.length;
      const analyzed = await engine.analyze(input);
      assert.equal(analyzed.frames, expectedFrames, `${codec}の保存PCMヘッダーから元と同じサンプル数を取得`);
      assert.equal(analyzed.duration, expectedFrames / config.rate);
      assert.equal(writes.slice(beforeAnalyze).filter(args => args.includes('-i')).length, 1, '入力の全量復号は保存の1回だけ');
      assert.ok(!writes.slice(beforeAnalyze).some(args => args.includes('ashowinfo')), '全量の読み捨て計測をしない');
      const beforeReuse = writes.length;
      assert.equal((await engine.analyze(input)).frames, expectedFrames);
      assert.equal(writes.slice(beforeReuse).filter(args => args.includes('-i')).length, 0, '保存済み入力の再解析でも復号し直さない');
      assert.ok((await engine.encode(analyzed, defaults('opus', analyzed))).size > 0, `${codec}入力の解析後も別形式へ変換できる`);
      const simultaneous = new File([blob], `another.${CODECS[codec].ext}`), beforeNext = writes.length;
      assert.equal((await engine.analyze(simultaneous)).frames, expectedFrames);
      assert.ok(!writes.slice(beforeNext).some(args => args.includes('ashowinfo')), '完了した保存は実容量で計上し、別入力の予約を妨げない');
      await clearPCM(simultaneous);
      await clearPCM(input);
      const first = await engine.preparePCM(source, target);
      const before = writes.length;
      assert.equal(await engine.preparePCM(source, target), first, '準備済みPCMを共有する');
      assert.equal(writes.length, before);
      assert.ok(!files.has(old)); assert.ok(files.has(active), '別ページが使用中の保存を消さない');
      assert.equal(new DataView(await first.slice(0, 12).arrayBuffer()).getUint32(0), 0x52494646, 'float WAVヘッダーを書き戻せる');
      for (const rate of [44100, 48000]) for (const start of [0, rate * 4, Math.round(source.duration * rate) - 4000]) {
        const frames = 4000;
        await engine.mount(blob);
        run(chunkArgs(source, target, start, frames, rate, '/input/audio', '/direct.raw'));
        const bytes = core.FS.readFile('/direct.raw'); core.FS.unlink('/direct.raw');
        const expected = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const actual = await engine.decode(source, target, start, frames, context(rate));
        let error = 0;
        for (let i = 0; i < Math.min(frames, expected.length / target.channels); i++) for (let ch = 0; ch < target.channels; ch++) error = Math.max(error, Math.abs(actual.getChannelData(ch)[i] - expected[i * target.channels + ch]));
        assert.ok(error < .0000002, `${codec} ${rate} Hz 位置${start}の誤差: ${error}`);
        assert.ok(writes.at(-1).includes('-ss'), '後半も一時PCMをシークして取り出す');
      }
      await clearPCM(blob);
      t.diagnostic(`${codec}: 2レート×3位置で、先頭からの復号と一致`);
    }
    const sbcConfig = defaults('sbc', source);
    const fallbackBlob = await engine.encode(source, sbcConfig);
    const fallbackInput = new File([fallbackBlob], 'fallback.sbc');
    quota = true;
    const beforeFailure = writes.length;
    const failedAnalysis = await engine.analyze(fallbackInput);
    quota = false;
    assert.ok(failedAnalysis.frames > 0);
    assert.equal(writes.slice(beforeFailure).filter(args => args.includes('ashowinfo')).length, 1, '保存失敗時だけ従来の計測へ戻る');
    const measured = await engine.analyze(fallbackInput);
    assert.equal(measured.frames, failedAnalysis.frames, '途中で失敗した保存のサンプル数を混ぜない');
    await clearPCM(fallbackInput); await clearPCM(fallbackBlob);
    // 入力が対象形式の場合は、基準の24 bit量子化も保存時に一度だけ適用する。
    const config = defaults('sbc', source);
    core.FS.writeFile('/input/audio', core.FS.readFile('/source.wav'));
    const blob = await engine.encode(source, config);
    const referenceSource = { ...source, codec: 'sbc', rate: config.rate };
    const reference = { reference: true, channels: 2, blob };
    assert.equal(needsPCM(referenceSource, reference), true);
    const pcm = await engine.preparePCM(referenceSource, reference);
    assert.ok(pcm, warnings.map(args => args.join(' ')).join('\n'));
    await engine.mount(blob); run(chunkArgs(referenceSource, reference, 48000 * 4, 48000, 48000, '/input/audio', '/direct.raw'));
    const bytes = core.FS.readFile('/direct.raw'), expected = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const actual = await engine.decode(referenceSource, reference, 48000 * 4, 48000, context(48000));
    for (let i = 0; i < 48000; i++) for (let ch = 0; ch < 2; ch++) assert.ok(Math.abs(actual.getChannelData(ch)[i] - expected[i * 2 + ch]) < .0000002);
    const count = files.size;
    assert.equal(await storedPCM({}, '上限', LIMITS.output + 1, () => assert.fail('書き込まない')), null);
    assert.equal(files.size, count);
    deny = true;
    const failed = {};
    assert.equal(await storedPCM(failed, '失敗', 1000, () => assert.fail('書き込まない')), null);
    deny = false;
    assert.equal(await storedPCM(failed, '失敗', 1000, () => assert.fail('失敗を毎区間繰り返さない')), null);
    await clearPCM();
    assert.deepEqual([...files.keys()], [active]);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = warn;
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  }
});
