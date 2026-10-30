import { cp, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'style.css', 'app.js', 'audio.js', 'model.js', 'graph.js', 'analysis.js', 'icon.svg', 'ogp.png']) {
  await cp(resolve(root, name), resolve(output, name));
}
for (const [pkg, destination] of [['ffmpeg', 'ffmpeg'], ['core', 'core']]) {
  await mkdir(resolve(output, 'vendor', destination), { recursive: true });
  const patched = resolve(root, 'vendor/core/esm');
  const from = pkg === 'core' && existsSync(patched) ? patched : resolve(root, 'node_modules', '@ffmpeg', pkg, 'dist', 'esm');
  await cp(from, resolve(output, 'vendor', destination), { recursive: true });
}
if (existsSync(resolve(root, 'vendor/core/licenses'))) await cp(resolve(root, 'vendor/core/licenses'), resolve(output, 'licenses'), { recursive: true });
await writeFile(resolve(output, '.nojekyll'), '');
console.log('dist/ に静的サイトを生成しました。');

if (process.argv[2] === 'serve') {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.wav': 'audio/wav' };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const live = ['index.html', 'style.css', 'app.js', 'audio.js', 'model.js', 'graph.js', 'analysis.js'];
      const name = path === '/' ? 'index.html' : path.slice(1);
      const base = live.includes(name) ? root : output;
      const target = resolve(base, name);
      if (!target.startsWith(base + sep)) { response.writeHead(403).end(); return; }
      const info = await stat(target);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end('Not found'); }
  });
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
}
