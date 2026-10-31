import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createVideoToolHandler } from '../lib/video-tools.js';

test('processing source handoff preserves original input and enforces file ownership', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'video-source-'));
  const databasePath = join(dir, 'jobs.db');
  let calls = 0;
  let expired = false;
  const handler = createVideoToolHandler({ databasePath, baseUrl:'http://127.0.0.1:8108', apiKey:'fixture-secret',
    origin:'http://localhost', getUser:req => req.user,
    fetchImpl:async (url, init) => {
      calls++;
      assert.match(url, /\/downloads\/internal-id\/files\/video\.mp4$/);
      assert.equal(init.headers.Range, undefined);
      return expired ? new Response('', {status:404}) : new Response('media', {headers:{'Content-Type':'video/mp4'}});
    } });
  t.after(() => { handler.close(); rmSync(dir, {recursive:true, force:true}); });
  const db = new DatabaseSync(databasePath);
  const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  for (const [i, owner] of ['public', 'user:alice'].entries()) {
    const job = { id:ids[i], owner, created:Date.now(), updated:Date.now(), state:'saved', kind:'download',
      input:'原始分享文案 https://www.douyin.com/video/12345', downloadId:'internal-id',
      files:[{name:'video.mp4',type:'video/mp4',kind:'video',bytes:5,label:'视频.mp4'}] };
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, owner, job.created, job.updated, JSON.stringify(job));
  }
  db.close();
  const request = user => ({ headers:{}, user:user ? {id:user} : null });
  for (const user of [null, 'alice', 'bob']) {
    const source = await handler.readSource(request(user), {jobId:ids[0],fileName:'video.mp4'});
    assert.match(source.job.input, /^原始分享文案/);
    assert.equal(source.file.name, 'video.mp4');
    assert.equal(await source.response.text(), 'media');
    assert.doesNotMatch(JSON.stringify(source.job), /internal-id|fixture-secret|owner/);
  }
  const own = await handler.readSource(request('alice'), {jobId:ids[1],fileName:'video.mp4'});
  await own.response.body.cancel();
  const before = calls;
  for (const user of [null, 'bob']) await assert.rejects(handler.readSource(request(user), {jobId:ids[1],fileName:'video.mp4'}), {status:404});
  for (const fileName of ['../video.mp4', 'cover.jpg', 'video.mp4/extra']) await assert.rejects(handler.readSource(request('alice'), {jobId:ids[1],fileName}), {status:404});
  await assert.rejects(handler.readSource({headers:{origin:'https://other.invalid'}}, {jobId:ids[0],fileName:'video.mp4'}), {status:403});
  assert.equal(calls, before);
  expired = true;
  await assert.rejects(handler.readSource(request(null), {jobId:ids[0],fileName:'video.mp4'}), {status:410});
});
