import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMediaProcessingHandler } from '../lib/media-processing.js';

async function fixture(t, { submitFails = false, submitState = 'queued', sourceSize = 5, finalState = 'saved', workerError = '', subtitles = null } = {}) {
  const calls = []; let serial = 0;
  const handler = createMediaProcessingHandler({ baseUrl: 'http://127.0.0.1:8110', apiKey: 'secret', origin: 'http://localhost', refreshIntervalMs: 0,
    getUser: req => req.headers['x-user'] ? { id: req.headers['x-user'] } : null,
    sourceReader: async (_req, { jobId, fileName }) => {
      if (jobId.endsWith('ffff')) throw Object.assign(new Error('找不到这条记录。'), { status: 404 });
      return { job: { id: jobId, input: '原始作品链接' }, file: { name: fileName, type: 'video/mp4', bytes: sourceSize }, response: new Response('video', { headers: sourceSize === 0 ? {} : { 'content-length': String(sourceSize) } }) };
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init }); assert.equal(init.headers.Authorization, 'Bearer secret');
      if (url.endsWith('/health')) return Response.json({ available: true, features: { ffmpeg: true, backgroundRemoval: false, downloader: true }, platforms: ['youtube.com','vimeo.com','x.com','instagram.com','soundcloud.com'] });
      if (url.includes('/v1/uploads')) return Response.json({ id: 'source-' + (++serial), state: 'saved', content: { title: '素材' }, files: [{ name: 'clip.mp4', type: 'video/mp4', bytes: 5 }] });
      if (url.includes('/files/')) return new Response(init.method === 'HEAD' ? null : 'file', { status: init.headers.Range ? 206 : 200, headers: { 'content-length': '4', 'accept-ranges': 'bytes', ...(init.headers.Range ? { 'content-range': 'bytes 0-3/4' } : {}) } });
      if (/\/v1\/jobs\/[\w-]+$/.test(url) && !init.method) return Response.json({ id:url.split('/').at(-1), state:finalState, error:workerError, subtitles, files:finalState === 'saved' ? subtitles ? [{name:'subtitles.vtt',type:'text/vtt',bytes:4},{name:'subtitles.srt',type:'application/x-subrip',bytes:4}] : [{ name:'out.mp3', type:'audio/mpeg', bytes:4 }] : [] });
      if (url.endsWith('/v1/jobs')) { if (submitFails) throw new Error('lost response'); return Response.json({ id:JSON.parse(init.body).requestId, state:submitState, files:[] }); }
      throw new Error(url);
    } });
  const server = http.createServer((req, res) => handler(req, res, decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); handler.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, { method = 'GET', user, body, raw, headers = {} } = {}) {
    const h = { ...(user ? { 'X-User': user } : {}), ...(raw ? { 'Content-Type': 'video/mp4' } : body ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const response = await fetch(base + '/api/tools/media' + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined), duplex: raw ? 'half' : undefined });
    const data = method === 'HEAD' ? null : response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    return { response, data };
  }
  return { request, calls };
}

const source = { engine: 'video', jobId: '11111111-1111-4111-8111-111111111111', fileName: 'clip.mp4' };

test('status, upload and private ownership', async t => {
  const f = await fixture(t); const status = await f.request('/status');
  assert.equal(status.data.available, true); assert.equal(status.data.scope, 'public'); assert.equal(status.data.maxUploadMB, 100);
  assert.deepEqual(status.data.platforms, ['youtube', 'vimeo', 'x', 'instagram', 'soundcloud']);
  assert.equal((await f.request('/uploads?name=a.mp4&visibility=private', { method: 'POST', raw: 'x' })).response.status, 409);
  assert.equal((await f.request('/uploads?name=a.mp4&visibility=public', { method: 'POST', raw: 'x', headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  const uploaded = await f.request('/uploads?name=clip.mp4&visibility=private', { method: 'POST', user: 'a', raw: 'video' });
  assert.equal(uploaded.response.status, 201); assert.equal(uploaded.data.engine, 'media'); assert.equal(uploaded.data.workerId, undefined);
  assert.equal((await f.request('/jobs/' + uploaded.data.id, { user: 'b' })).response.status, 404);
  assert.equal((await f.request('/jobs', { user: 'a' })).data.jobs.length, 1);
});

test('cross-origin and private source blocked; original input preserved for authorized source', async t => {
  const f = await fixture(t);
  const blocked = await f.request('/jobs', { method: 'POST', user: 'a', body: { visibility: 'private', operation: 'audio', source, options: { format: 'mp3' } }, headers: { Origin: 'https://evil.test' } });
  assert.equal(blocked.response.status, 403);
  const denied = await f.request('/jobs', { method: 'POST', user: 'b', body: { visibility: 'private', operation: 'audio', source: { ...source, jobId: '11111111-1111-4111-8111-ffffffffffff' }, options: { format: 'mp3' } } });
  assert.equal(denied.response.status, 404);
  const created = await f.request('/jobs', { method: 'POST', user: 'a', body: { visibility: 'private', operation: 'audio', source, options: { format: 'mp3' } } });
  assert.equal(created.response.status, 202); assert.equal(created.data.input, '原始作品链接'); assert.equal(created.data.workerId, undefined);
  const uploadCall = f.calls.find(x => x.url.includes('/v1/uploads'));
  assert.equal(uploadCall.init.headers['Content-Type'], 'video/mp4');
  assert.equal((await f.request('/jobs/' + created.data.id, { user: 'b' })).response.status, 404);
  assert.equal((await f.request('/jobs/' + created.data.id + '/files/out.mp3', { user: 'b' })).response.status, 404);
});

test('download accepts only fixed single-item HTTPS hosts', async t => {
  const f = await fixture(t);
  for (const text of ['http://youtube.com/watch?v=x', 'https://example.com/a', 'https://youtube.com/playlist?list=a', 'https://u:p@youtube.com/watch?v=x', 'file:///x']) {
    assert.equal((await f.request('/jobs', { method: 'POST', body: { visibility: 'public', operation: 'download', text } })).response.status, 400);
  }
  const share = '请看这条作品 https://www.youtube.com/watch?v=abc';
  const job = await f.request('/jobs', { method: 'POST', body: { visibility: 'public', operation: 'download', text: share } });
  assert.equal(job.response.status, 202); assert.equal(job.data.input, share);
  const submitted = JSON.parse(f.calls.findLast(x => x.url.endsWith('/v1/jobs')).init.body);
  assert.equal(submitted.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(submitted.requestId, job.data.id);
});

test('gallery preserves input and private ownership without reading a source', async t => {
  const f = await fixture(t);
  for (const url of ['https://127.0.0.1/a/test', 'https://imgur.com.evil.test/a/test', 'https://imgur.com/a/test?token=secret', 'http://imgur.com/a/test']) {
    assert.equal((await f.request('/jobs', {method:'POST',body:{visibility:'public',operation:'gallery',url}})).response.status,400);
  }
  const created=await f.request('/jobs',{method:'POST',user:'a',body:{visibility:'private',operation:'gallery',url:'https://imgur.com/a/F4hz2'}});
  assert.equal(created.response.status,202); assert.equal(created.data.input,'https://imgur.com/a/F4hz2');
  assert.equal(f.calls.some(call=>call.url.includes('/v1/uploads')),false);
  const submitted=JSON.parse(f.calls.findLast(call=>call.url.endsWith('/v1/jobs')).init.body);
  assert.equal(submitted.operation,'gallery');assert.equal(submitted.sourceId,undefined);
  assert.equal((await f.request('/jobs/'+created.data.id,{user:'b'})).response.status,404);
});

test('edit accepts only bounded declarative controls', async t => {
  const f=await fixture(t);
  for(const options of [{filter:'movie=/etc/passwd'},{rotation:45},{speed:10},{mute:'true'},{volume:3},{aspect:'2:3'},{fit:'stretch'}]) {
    assert.equal((await f.request('/jobs',{method:'POST',body:{visibility:'public',operation:'edit',source,options}})).response.status,400);
  }
  const created=await f.request('/jobs',{method:'POST',body:{visibility:'public',operation:'edit',source,options:{aspect:'9:16',rotation:90,speed:2,mute:true,volume:0.5,fit:'pad'}}});
  assert.equal(created.response.status,202);
  const sent=JSON.parse(f.calls.findLast(call=>call.url.endsWith('/v1/jobs')).init.body);
  assert.deepEqual(sent.options,{aspect:'9:16',fit:'pad',rotation:90,speed:2,mute:true,volume:0.5});
});

test('concat checks every source owner and preserves ordered source references', async t => {
  const f=await fixture(t);
  assert.equal((await f.request('/jobs',{method:'POST',body:{visibility:'public',operation:'concat',sources:[source]}})).response.status,400);
  const denied=await f.request('/jobs',{method:'POST',user:'a',body:{visibility:'private',operation:'concat',sources:[source,{...source,jobId:'11111111-1111-4111-8111-ffffffffffff'}]}});
  assert.equal(denied.response.status,404);
  const created=await f.request('/jobs',{method:'POST',user:'a',body:{visibility:'private',operation:'concat',sources:[source,source]}});
  assert.equal(created.response.status,202);assert.deepEqual(created.data.sources,[source,source]);
  const submitted=JSON.parse(f.calls.findLast(call=>call.url.endsWith('/v1/jobs')).init.body);
  assert.equal(submitted.sourceId,undefined);assert.equal(submitted.sources.length,2);
  assert.equal((await f.request('/jobs/'+created.data.id,{user:'b'})).response.status,404);
});

test('file range and HEAD proxy only saved listed files', async t => {
  const f = await fixture(t);
  const job = await f.request('/jobs', { method: 'POST', body: { visibility: 'public', operation: 'download', text: 'https://youtu.be/abc' } });
  assert.equal((await f.request('/jobs/' + job.data.id + '/files/out.mp3')).response.status, 404);
  await f.request('/jobs/' + job.data.id);
  const got = await f.request('/jobs/' + job.data.id + '/files/out.mp3', { headers: { Range: 'bytes=0-3' } });
  assert.equal(got.response.status, 206); assert.equal(got.data, 'file');
  const head = await f.request('/jobs/' + job.data.id + '/files/out.mp3', { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assert.equal(f.calls.findLast(x => x.url.includes('/files/')).init.method, 'HEAD');
  assert.equal((await f.request('/jobs/' + job.data.id + '/files/out.mp3', { headers: { Range: 'bytes=0-1,3-4' } })).response.status, 416);
});

test('unknown submit outcome cannot be blindly retried', async t => {
  const f = await fixture(t, { submitFails: true });
  const job = await f.request('/jobs', { method: 'POST', body: { visibility: 'public', operation: 'download', text: 'https://youtu.be/abc' } });
  assert.equal(job.response.status, 202); assert.equal(job.data.state, 'submission-unknown');
  const retry = await f.request('/jobs/' + job.data.id + '/retry', { method: 'POST', body: { visibility: 'public' } });
  assert.equal(retry.response.status, 409);
  assert.equal(f.calls.filter(x => x.url.endsWith('/v1/jobs')).length, 1);
  const recovered = await f.request('/jobs/' + job.data.id);
  assert.equal(recovered.data.state, 'saved');
  assert.equal(recovered.data.workerId, undefined);
});

test('retrying public failed job gives signed-in user a private copy', async t => {
  const f = await fixture(t, { submitState: 'failed' });
  const job = await f.request('/jobs', { method:'POST', body:{ visibility:'public', operation:'download', text:'https://youtu.be/abc' } });
  const retry = await f.request('/jobs/' + job.data.id + '/retry', { method:'POST', user:'a', body:{ visibility:'private' } });
  assert.equal(retry.response.status, 202); assert.equal(retry.data.visibility, 'private');
  assert.equal((await f.request('/jobs/' + retry.data.id, { user:'b' })).response.status, 404);
  assert.equal((await f.request('/jobs/' + retry.data.id)).response.status, 404);
  assert.equal((await f.request('/jobs', { user:'a' })).data.jobs.length, 1);
});

test('source without Content-Length streams through guarded upload', async t => {
  const f = await fixture(t, { sourceSize:0 });
  const job = await f.request('/jobs', { method:'POST', user:'a', body:{ visibility:'private', operation:'audio', source, options:{ format:'mp3' } } });
  assert.equal(job.response.status, 202);
  assert.equal(job.data.input, '原始作品链接');
});

test('oversized video source is rejected before worker upload', async t => {
  const f = await fixture(t, { sourceSize:100 * 1024 * 1024 + 1 });
  const job = await f.request('/jobs', { method:'POST', user:'a', body:{ visibility:'private', operation:'audio', source, options:{ format:'mp3' } } });
  assert.equal(job.response.status, 413);
  assert.equal(f.calls.some(call => call.url.includes('/v1/uploads')), false);
});

test('public uploaded source can produce a private derivative', async t => {
  const f = await fixture(t);
  const upload = await f.request('/uploads?name=clip.mp4&visibility=public', { method:'POST', raw:'video' });
  const derivative = await f.request('/jobs', { method:'POST', user:'a', body:{ visibility:'private', operation:'audio', source:{ engine:'media', jobId:upload.data.id, fileName:'clip.mp4' }, options:{ format:'mp3' } } });
  assert.equal(derivative.response.status, 202);
  assert.equal(derivative.data.visibility, 'private');
  assert.equal((await f.request('/jobs/' + derivative.data.id)).response.status, 404);
});

test('download failures explain access and format limits without exposing worker output', async t => {
  for (const [workerError, expected] of [
    ['Sign in to confirm you’re not a bot https://private.test/?secret=hidden', /登录或验证/],
    ['The web client only works when logged-in', /登录或验证/],
    ['没有可安全下载的单文件媒体格式。', /暂不支持下载/],
    ['ERROR: This video is unavailable /var/lib/private/path', /无法访问/],
    ['Traceback /var/lib/private/path secret=hidden', /媒体处理失败/],
  ]) {
    const f = await fixture(t, { finalState:'failed', workerError });
    const created = await f.request('/jobs', { method:'POST', body:{ visibility:'public', operation:'download', text:'https://youtu.be/abc' } });
    const settled = await f.request('/jobs/' + created.data.id);
    assert.match(settled.data.error, expected);
    assert.doesNotMatch(settled.data.error, /hidden|private|Traceback/);
  }
});

test('timed subtitles preserve exact timing and private file access without allowing model paths', async t => {
  const f = await fixture(t, { subtitles: { language:'zh', segments:[{start:0.25,end:1.5,text:'你好',secret:'hidden'},{start:-1,end:2,text:'bad'}] } });
  const invalid = await f.request('/jobs', {method:'POST',user:'a',body:{visibility:'private',operation:'subtitles',source,options:{modelDir:'/etc'}}});
  assert.equal(invalid.response.status,400);
  const created = await f.request('/jobs', {method:'POST',user:'a',body:{visibility:'private',operation:'subtitles',source,options:{language:'zh',targetLanguage:'en',burnIn:false}}});
  assert.equal(created.response.status,202);
  const final = await f.request('/jobs/'+created.data.id,{user:'a'});
  assert.deepEqual(final.data.subtitles.segments,[{start:0.25,end:1.5,text:'你好'}]);
  assert.equal(final.data.transcript.text,'你好');assert.equal(final.data.files.length,2);
  const url='/jobs/'+created.data.id+'/files/subtitles.vtt?inline=1';
  assert.equal((await f.request(url)).response.status,404);
  assert.equal((await f.request(url,{user:'b'})).response.status,404);
  const allowed=await f.request(url,{user:'a'});assert.equal(allowed.response.headers.get('content-type'),'text/vtt');
  assert.equal((await f.request('/jobs?view=library&type=text',{user:'a'})).data.jobs.length,1);
  const separate=await f.request('/jobs',{method:'POST',user:'a',body:{visibility:'private',operation:'separate',source,options:{command:'bad'}}});
  assert.equal(separate.response.status,400);
});
