import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('private repository guides and their media require matching workspace access', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'omnihub-private-guides-'));
  const guideDir = path.join(dataDir, 'repository-guides', 'private');
  const filename = 'media-1234567890abcdef12345678.webp';
  const guide = {
    schemaVersion: 1, key: 'owner/repo', status: 'partial', reason: '官方文档仍在补充。',
    checkedAt: '2026-10-25', tested: false, sourceUrl: 'https://github.com/owner/repo',
    summary: '私有工作区仓库说明。', intro: '只在保存它的工作区内提供。', requirements: '',
    platforms: [], steps: [{ title: '阅读 README', text: '先阅读仓库的官方 README。' }],
    example: null, cautions: [], references: [],
    media: [{ url: `/assets/repository-guides/${filename}`, alt: '仓库操作图', sourceUrl: 'https://github.com/owner/repo/blob/main/README.md' }],
  };
  await mkdir(guideDir, { recursive: true });
  await writeFile(path.join(guideDir, 'owner~repo.json'), JSON.stringify(guide));
  await writeFile(path.join(guideDir, filename), Buffer.from('RIFF\x04\x00\x00\x00WEBP'));
  await writeFile(path.join(guideDir, 'media-aaaaaaaaaaaaaaaaaaaaaaaa.webp'), Buffer.from('RIFF\x04\x00\x00\x00WEBP'));
  const setup = `
    import { db } from './lib/db.js';
    import { replaceRepositoryAssets } from './lib/knowledge-store.js';
    db.prepare("INSERT INTO users (id,username,password_hash,salt) VALUES (1,'zane','unused','unused'),(2,'viewer','unused','unused')").run();
    db.prepare("INSERT INTO sessions (token,user_id) VALUES ('owner-session',1),('viewer-session',2)").run();
    replaceRepositoryAssets(1,[{key:'owner/repo',owner:'owner',name:'repo',repositoryUrl:'https://github.com/owner/repo',topics:[],sourcePosts:[],targetLinks:[]}]);
    db.close();
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', setup], {
    cwd: root, env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, stdio: 'pipe',
  });
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), OMNIHUB_DATA_DIR: dataDir, OMNIHUB_CONTENT_WORKER: 'false', OMNIHUB_X_BOOKMARK_SYNC: 'false', OMNIHUB_X_WATCH_ENABLED: 'false', OMNIHUB_MEDIA_WORKER: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await request('/')).ok) { ready = true; break; } } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, stderr);
    const owner = { Cookie: 'omnihub_session=owner-session' };
    const viewer = { Cookie: 'omnihub_session=viewer-session' };
    const guidePath = '/api/repositories/owner/repo/guide';
    assert.equal((await request(guidePath)).status, 404);
    assert.equal((await request(`${guidePath}?scope=public`, { headers: owner })).status, 404);
    assert.equal((await request(`${guidePath}?scope=mine`, { headers: viewer })).status, 404);
    const response = await request(`${guidePath}?scope=mine`, { headers: owner });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.media[0].url, `/api/repositories/owner/repo/guide-media/${filename}`);
    const media = await request(`${result.media[0].url}?scope=mine`, { headers: owner });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/webp');
    assert.equal(media.headers.get('cache-control'), 'no-store');
    assert.equal((await media.arrayBuffer()).byteLength, 12);
    assert.equal((await request(`${result.media[0].url}?scope=mine`, { method: 'HEAD', headers: owner })).status, 200);
    assert.equal((await request(`/api/repositories/owner/repo/guide-media/media-aaaaaaaaaaaaaaaaaaaaaaaa.webp?scope=mine`, { headers: owner })).status, 404);
    assert.equal((await request(`/api/repositories/owner/repo/guide-media/%2e%2e%2fapp.db?scope=mine`, { headers: owner })).status, 404);
    assert.equal((await request(`${result.media[0].url}?scope=mine`, { headers: viewer })).status, 404);
    assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT|Cannot write headers after/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
