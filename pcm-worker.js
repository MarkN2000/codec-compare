// 公式Workerの通信を使い、PCMの出力だけをOPFSへ直接流す。WASMコアは変更しない。
import './vendor/ffmpeg/worker.js';
import createCore from './vendor/core/ffmpeg-core.js';
let core, output;
export default async function create(options) { core = await createCore(options); return core; }

export function pipePCM(fs, handle, path, limit) {
  fs.writeFile(path, new Uint8Array());
  const node = fs.lookupPath(path).node;
  node.stream_ops = {
    ...node.stream_ops,
    read(stream, buffer, offset, length, position) { return handle.read(buffer.subarray(offset, offset + length), { at: position }); },
    write(stream, buffer, offset, length, position) {
      // EmscriptenのENOSPC=51／EIO=29をlibcへ返し、容量不足でもFFmpegが後始末して終了できるようにする。
      try {
        if (!Number.isSafeInteger(position) || position < 0 || position + length > limit) throw new fs.ErrnoError(51);
        const written = handle.write(buffer.subarray(offset, offset + length), { at: position });
        if (written !== length) throw new fs.ErrnoError(29);
        node.usedBytes = Math.max(node.usedBytes, position + written);
        return written;
      } catch (error) {
        if (error.name === 'ErrnoError') throw error;
        throw new fs.ErrnoError(error.name === 'QuotaExceededError' ? 51 : 29);
      }
    },
  };
}

const original = self.onmessage;
self.onmessage = async event => {
  const { id, type, data } = event.data;
  if (!(type === 'MOUNT' && data.fsType === 'PCM') && !(type === 'UNMOUNT' && data.mountPoint === '/preview')) return original(event);
  let handle;
  try {
    if (type === 'MOUNT') {
      if (data.mountPoint !== '/preview' || output || !Number.isSafeInteger(data.options.limit) || data.options.limit <= 0) throw Error('一時PCMの出力先が不正です。');
      handle = await data.options.file.createSyncAccessHandle();
      handle.truncate(0);
      core.FS.mkdir('/preview');
      pipePCM(core.FS, handle, '/preview/audio.wav', data.options.limit);
      output = handle;
    } else {
      try { output?.flush(); }
      finally { output?.close(); output = null; core.FS.unlink('/preview/audio.wav'); core.FS.rmdir('/preview'); }
    }
    self.postMessage({ id, type, data: true });
  } catch (error) {
    if (handle && output !== handle) {
      handle.close();
      try { core.FS.unlink('/preview/audio.wav'); core.FS.rmdir('/preview'); } catch {}
    }
    self.postMessage({ id, type: 'ERROR', data: String(error) });
  }
};
