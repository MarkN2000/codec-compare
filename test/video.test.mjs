import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Engine } from '../audio.js';
import { defaults, chunkArgs } from '../model.js';

test('動画の最初の音声だけを解析・変換・区間再生し、音声なしと破損を案内する', async () => {
  globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
  const require = createRequire(import.meta.url);
  // 既存の公式依存コアで小さな動画を生成し、配布する音声専用コアで読み込む。
  const generator = await require('../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js')({ wasmBinary: await readFile(new URL('../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm', import.meta.url)) });
  const core = await require('../vendor/core/umd/ffmpeg-core.js')({ wasmBinary: await readFile(new URL('../vendor/core/umd/ffmpeg-core.wasm', import.meta.url)) });
  const logs = new Map();
  for (const instance of [generator, core]) instance.setLogger(({ message }) => { logs.get(instance)?.push(message); });
  const run = (instance, args) => {
    logs.set(instance, []); instance.exec('-y', ...args); const code = instance.ret; instance.reset();
    assert.equal(code, 0, logs.get(instance).slice(-6).join('\n'));
  };
  const samples = Float32Array.from({ length: 48000 * 5 }, (_, i) => .3 * Math.sin(2 * Math.PI * 1000 * i / 48000));
  generator.FS.writeFile('/sound.raw', new Uint8Array(samples.buffer));
  generator.FS.writeFile('/video.raw', new Uint8Array(16 * 16 * 3 * 6).fill(80));
  core.FS.mkdir('/input');
  const engine = new Engine(), commands = [];
  engine.mount = async blob => core.FS.writeFile('/input/audio', new Uint8Array(await blob.arrayBuffer()));
  engine.run = async (args, probe = false) => {
    commands.push({ args, probe });
    if (probe) { core.ffprobe(...args); core.reset(); }
    else run(core, args);
  };
  core.setLogger(({ message }) => { logs.get(core)?.push(message); engine.onLog?.(message); });
  engine.ffmpeg = {
    readFile: async (path, encoding) => encoding === 'utf8' ? new TextDecoder().decode(core.FS.readFile(path)) : core.FS.readFile(path),
    deleteFile: async path => core.FS.unlink(path),
  };
  const context = { sampleRate: 48000, createBuffer(channels, frames) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { getChannelData: ch => data[ch] };
  } };
  for (const ext of ['mp4', 'mov', 'webm']) {
    run(generator, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '16x16', '-framerate', '1', '-i', '/video.raw',
      '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', '/sound.raw', '-map', '0:v:0', '-map', '1:a:0', '-map', '1:a:0',
      '-c:v', ext === 'webm' ? 'libvpx' : 'libx264', '-pix_fmt', 'yuv420p', '-c:a', ext === 'webm' ? 'libvorbis' : 'aac',
      ...(ext === 'webm' ? [] : ['-aac_pns', '0']), '-ar:a:1', '32000', `/input.${ext}`]);
    const file = new File([generator.FS.readFile(`/input.${ext}`)], `動画.${ext}`, { type: 'video/' + ext });
    const source = await engine.analyze(file);
    assert.equal(source.hasVideo, true); assert.equal(source.rate, 48000); assert.equal(source.channels, 1, '最初の音声を選ぶ');
    assert.ok(source.duration >= 5 && source.duration < 5.1, '映像の6秒ではなく音声の長さを使う');
    const config = defaults('mp3', source), output = await engine.encode(source, config);
    assert.ok(output.size > 0); assert.equal(output.type, 'audio/mpeg');
    const target = { reference: true, blob: file, channels: 1 };
    await engine.mount(file);
    run(core, chunkArgs(source, target, 0, source.frames, 48000, '/input/audio', '/whole.raw'));
    const data = core.FS.readFile('/whole.raw'), whole = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    assert.equal(whole.length, source.frames, `${ext}: ${JSON.stringify(source)}`);
    const piece = (await engine.decode(source, target, 4 * 48000, 48000, context)).getChannelData(0);
    let error = 0;
    for (let i = 0; i < piece.length; i++) error = Math.max(error, Math.abs(piece[i] - whole[4 * 48000 + i]));
    assert.ok(error < .00005, `${ext}の区間再生で位置を保つ: ${error}`);
  }
  assert.ok(commands.filter(c => !c.probe).every(c => c.args.includes('-vn')), '映像は復号しない');
  run(generator, ['-v', 'error', '-i', '/input.mp4', '-itsoffset', '2', '-i', '/input.mp4', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '/offset.mp4']);
  const offsetFile = new File([generator.FS.readFile('/offset.mp4')], '音声開始が遅い動画.mp4');
  const offsetSource = await engine.analyze(offsetFile);
  assert.ok(offsetSource.duration >= 5 && offsetSource.duration < 5.1, '音声の開始時刻を長さに含めない');
  for (const codec of ['wav', 'flac', 'aac', 'opus']) {
    const encoded = await engine.encode(offsetSource, defaults(codec, offsetSource));
    const encodedSource = await engine.analyze(new File([encoded], `変換.${codec === 'aac' ? 'm4a' : codec === 'opus' ? 'ogg' : codec}`));
    assert.ok(Math.abs(encodedSource.duration - offsetSource.duration) < .1, `${codec}: ${encodedSource.duration}秒と${offsetSource.duration}秒`);
  }
  run(generator, ['-v', 'error', '-i', '/input.mp4', '-map', '0:v:0', '-c', 'copy', '/silent.mp4']);
  await assert.rejects(engine.analyze(new File([generator.FS.readFile('/silent.mp4')], '無音声.mp4')), { message: '音声が含まれていません。' });
  await assert.rejects(engine.analyze(new File(['壊れた入力'], '破損.mp4')), { message: '読み込めない形式、または破損したファイルです。' });
  run(generator, ['-v', 'error', '-i', '/input.mp4', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'ac3', '/unsupported.mp4']);
  await assert.rejects(engine.analyze(new File([generator.FS.readFile('/unsupported.mp4')], '非対応音声.mp4')), { message: '読み込めない形式、または破損したファイルです。' });
  run(generator, ['-v', 'error', '-i', '/input.mp4', '-map', '0:a:0', '-c', 'copy', '/audio.m4a']);
  assert.equal((await engine.analyze(new File([generator.FS.readFile('/audio.m4a')], '音声.m4a', { type: 'video/mp4' }))).hasVideo, false, 'MIMEや拡張子ではなく実トラックで判定する');
  run(generator, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '16x16', '-i', '/video.raw', '-frames:v', '1', '/cover.png']);
  run(generator, ['-v', 'error', '-i', '/audio.m4a', '-i', '/cover.png', '-map', '0:a:0', '-map', '1:v:0', '-c', 'copy', '-disposition:v', 'attached_pic', '/cover.m4a']);
  assert.equal((await engine.analyze(new File([generator.FS.readFile('/cover.m4a')], 'カバー付き.m4a'))).hasVideo, false, 'カバー画像付き音声を動画として表示しない');
});
