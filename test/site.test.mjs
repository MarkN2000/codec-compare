import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

test('公開ビルドでHTML・依存モジュール・FFT Workerの版を揃える', async () => {
  await promisify(execFile)(process.execPath, ['scripts/site.mjs', 'build']);
  const built = name => readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8');
  const html = await built('index.html');
  const version = html.match(/src="\.\/app\.js\?v=([a-f0-9]{12})"/)?.[1];
  assert.ok(version, '入口のJavaScriptに版情報を付ける');
  assert.ok(html.includes(`./style.css?v=${version}`));
  for (const name of ['app.js', 'audio.js', 'graph.js', 'analysis.js', 'analysis-cache.js']) {
    const script = await built(name);
    for (const match of script.matchAll(/(["'])\.\/(?:model|audio|graph|analysis|analysis-cache)\.js([^"']*)\1/g)) {
      assert.equal(match[2], `?v=${version}`, `${name}の依存先も同じ版を使う`);
    }
  }
  assert.ok((await built('graph.js')).includes(`new URL('./analysis.js?v=${version}'`), 'FFT Workerも旧キャッシュを使わない');
  assert.ok((await built('graph.js')).includes(`'./analysis-cache.js?v=${version}'`));
});
