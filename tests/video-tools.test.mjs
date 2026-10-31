import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoToolHandler, extractVideoLink, normalizeVideoContent } from '../lib/video-tools.js';

const content = { platform: 'douyin', content_id: '12345', title: '示例视频', author: { nickname: '测试作者' }, duration_ms: 12500, media: { video: {url:'https://example.invalid/media'} } };
test('link validation accepts share text and rejects SSRF, credentials and non-content routes', () => {
  assert.equal(extractVideoLink('分享视频 https://v.douyin.com/AbCd/。 打开看看').platform, 'douyin');
  assert.equal(extractVideoLink('https://www.bilibili.com/video/BV1xx411c7mD/').platform, 'bilibili');
  assert.equal(extractVideoLink('https://www.tiktok.com/@sample/video/12345').platform, 'tiktok');
  for (const url of ['http://127.0.0.1/video/1','http://169.254.169.254/video/1','https://www.douyin.com.evil.test/video/1',
    'https://u:p@www.douyin.com/video/1','https://www.douyin.com:1234/video/1','https://www.douyin.com/search/1',
    'https://www.douyin.com/user/1','https://b23.tv/ https://v.douyin.com/x/','file:///etc/passwd']) assert.throws(() => extractVideoLink(url));
  assert.throws(() => normalizeVideoContent({...content, platform:'bilibili'},'douyin'));
  assert.equal(normalizeVideoContent(content, 'douyin').title, '示例视频');
});

async function fixture(t, options = {}) {
  const calls = [];
  let stored = true;
  let release;
  const handler = createVideoToolHandler({ databasePath:options.databasePath, baseUrl:'http://127.0.0.1:8108', apiKey:'private-fixture-key', origin:'http://localhost',
    getUser: req => req.headers['x-test-user'] ? {id:req.headers['x-test-user']} : null,
    fetchImpl: async (url, init) => {
      calls.push({url,init});
      assert.equal(init.headers.Authorization,'Bearer private-fixture-key');
      if (url.includes('/files/')) return new Response('test-media', {status:init.headers.Range ? 206 : 200,headers:{'Content-Type':'video/mp4','Content-Length':'10','Accept-Ranges':'bytes',...(init.headers.Range ? {'Content-Range':'bytes 0-9/10'} : {})}});
      if (url.includes('/parse?')) return options.parseFailure ? Response.json({error:{code:'UPSTREAM_FAILURE',message:'internal-token'}},{status:502}) : Response.json({data:{task_id:'task-1',state:'queued'}});
      if (url.includes('/tasks/')) return Response.json({data:options.task || {state:'done',data:content}});
      if (url.endsWith('/downloads') && init.body) {
        if (options.delaySave) await new Promise(resolve => {release = resolve;});
        return Response.json({data:{download_id:'download-1',task_id:'task-2'}});
      }
      if (url.includes('/downloads/')) return Response.json({data:{state:'done',on_disk:stored,files:[
        {name:'video.mp4',export_name:'示例视频.mp4',state:'done',content_type:'video/mp4',bytes:10},
        {name:'post.json',state:'done',content_type:'application/json',bytes:20},
        {name:'active.svg',state:'done',content_type:'image/svg+xml',bytes:20},
        {name:'../secret.mp4',state:'done',content_type:'video/mp4',bytes:20},
      ]}});
      throw new Error('Unexpected path');
    } });
  const server = http.createServer((req,res) => handler(req,res,decodeURIComponent(new URL(req.url,'http://localhost').pathname)));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); handler.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { cookie, user, method='GET', body, headers={} } = {}) {
    if (path === '/jobs' && method === 'POST' && body && typeof body === 'object') body = {visibility:user ? 'private' : 'public', ...body};
    const response = await fetch(base+'/api/tools/video'+path,{method,headers:{...(cookie ? {Cookie:cookie}:{}),...(user ? {'X-Test-User':user}:{}),
      ...(body !== undefined ? {'Content-Type':'application/json'}:{}),...headers},body:body === undefined ? undefined : JSON.stringify(body)});
    const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    return {response,payload,cookie:response.headers.get('set-cookie')?.split(';')[0] || cookie};
  }
  return {request,calls,release:()=>release?.(), expire:()=>{stored=false;}};
}
async function parsedJob(f, user) {
  const created=await f.request('/jobs',{method:'POST',body:{text:'https://www.douyin.com/video/12345'},user});
  assert.equal(created.response.status,202);
  const parsed=await f.request('/jobs/'+created.payload.id,{cookie:created.cookie,user});
  assert.equal(parsed.payload.state,'parsed');
  return {...parsed,id:created.payload.id};
}

test('anonymous records are public, with parsing, preparing, byte streaming and MIME allowlist', async t => {
  const f=await fixture(t);
  const job=await parsedJob(f);
  assert.match(job.cookie,/omnihub_video=[a-f0-9]{64}/);
  assert.equal((await f.request('/jobs/'+job.id)).response.status,200);
  assert.equal((await f.request('/jobs/'+job.id,{user:'alice'})).response.status,200);
  assert.equal((await f.request('/jobs')).payload.jobs[0].id,job.id);
  assert.equal((await f.request('/jobs')).payload.scope,'public');
  assert.equal(job.payload.visibility,'public');
  assert.doesNotMatch(JSON.stringify(job.payload),/private-fixture-key|task-1|owner|example.invalid/);
  const prepared=await f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},cookie:job.cookie});
  assert.equal(prepared.payload.state,'saving');
  const saved=await f.request('/jobs/'+job.id,{cookie:job.cookie});
  assert.equal(saved.payload.state,'saved'); assert.equal(saved.payload.files.length,1);
  const file=await f.request('/jobs/'+job.id+'/files/video.mp4',{cookie:job.cookie,headers:{Range:'bytes=0-9'}});
  assert.equal(file.response.status,206); assert.equal(file.payload,'test-media');
  assert.match(file.response.headers.get('content-disposition'),/^attachment;/);
  assert.equal(file.response.headers.get('cache-control'),'private, no-store');
  const inline=await f.request('/jobs/'+job.id+'/files/video.mp4?inline=1',{cookie:job.cookie});
  assert.match(inline.response.headers.get('content-disposition'),/^inline;/);
  assert.equal((await f.request('/jobs/'+job.id+'/files/video.mp4')).response.status,200);
  assert.equal((await f.request('/jobs/'+job.id+'/files/post.json',{cookie:job.cookie})).response.status,404);
  assert.equal((await f.request('/jobs/'+job.id+'/files/video.mp4',{cookie:job.cookie,headers:{Range:'bytes=0-1,3-4'}})).response.status,416);
  await f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},cookie:job.cookie});
  assert.equal(f.calls.filter(c=>c.url.endsWith('/downloads')).length,1);
  f.expire();
  assert.equal((await f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},cookie:job.cookie})).payload.state,'saving');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/downloads')).length,2);
});

test('signed-in ownership is separate from guests and from other accounts',async t=>{
  const f=await fixture(t), job=await parsedJob(f,'alice');
  assert.equal((await f.request('/jobs/'+job.id,{cookie:job.cookie})).response.status,404);
  assert.equal((await f.request('/jobs/'+job.id,{cookie:job.cookie,user:'bob'})).response.status,404);
  assert.equal((await f.request('/jobs/'+job.id,{user:'alice'})).response.status,200);
  assert.equal((await f.request('/jobs',{user:'alice'})).payload.scope,'private');
  assert.equal((await f.request('/jobs',{user:'bob'})).payload.jobs.length,0);
  assert.equal((await f.request('/jobs')).payload.jobs.length,0);
  for (const user of [undefined,'bob']) {
    assert.equal((await f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},user})).response.status,404);
    assert.equal((await f.request('/jobs/'+job.id+'/files/video.mp4',{user})).response.status,404);
  }
});

test('original input survives reading and a retry bypasses stored downloads without rewriting history',async t=>{
  const f=await fixture(t);
  const text='  复制打开抖音\nhttps://www.douyin.com/video/12345 看看这条视频。  ';
  const first=await f.request('/jobs',{method:'POST',body:{text}});
  assert.equal(first.payload.input,text);
  const retry=await f.request('/jobs',{method:'POST',body:{text,retry:true},user:'alice'});
  assert.notEqual(first.payload.id,retry.payload.id);
  assert.equal(retry.payload.visibility,'private');
  await f.request('/jobs/'+retry.payload.id,{user:'alice'});
  await f.request('/jobs/'+retry.payload.id+'/save',{method:'POST',body:{},user:'alice'});
  assert.equal(JSON.parse(f.calls.find(c=>c.url.endsWith('/downloads')).init.body).skip_existing,false);
  assert.equal((await f.request('/jobs/'+first.payload.id)).payload.input,text);
  assert.equal((await f.request('/jobs')).payload.jobs.length,1);
  assert.doesNotMatch(JSON.stringify(retry.payload),/refreshFiles|owner|taskId/);
});

test('legacy guest history stays private and exposes only its saved URL as the input fallback',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'video-legacy-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'jobs.db');
  const f=await fixture(t,{databasePath});
  const token='a'.repeat(64), owner='guest:'+createHash('sha256').update(token).digest('hex');
  const id='11111111-1111-4111-8111-111111111111';
  const job={id,owner,created:Date.now(),updated:Date.now(),state:'parsed',url:'https://www.douyin.com/video/12345',platform:'douyin',files:[]};
  const db=new DatabaseSync(databasePath);
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(id,owner,job.created,job.updated,JSON.stringify(job)); db.close();
  assert.equal((await f.request('/jobs/'+id)).response.status,404);
  assert.equal((await f.request('/jobs',{user:'alice'})).payload.jobs.length,0);
  const mine=await f.request('/jobs',{cookie:'omnihub_video='+token});
  assert.equal(mine.payload.jobs[0].id,id);
  assert.equal(mine.payload.jobs[0].visibility,'legacy-private');
  assert.equal(mine.payload.jobs[0].input,job.url);
  assert.deepEqual((await f.request('/jobs')).payload.jobs,[]);
});

test('cross-site writes and malformed bodies are rejected before platform access',async t=>{
  const f=await fixture(t);
  for (const headers of [{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'}]) {
    assert.equal((await f.request('/jobs',{method:'POST',body:{text:'https://v.douyin.com/x/'},headers})).response.status,403);
  }
  assert.equal((await f.request('/jobs',{method:'POST',body:null})).response.status,400);
  assert.equal((await f.request('/jobs',{method:'POST',body:{text:'x'.repeat(9000)}})).response.status,413);
  assert.equal(f.calls.length,0);
});

test('expired login and stale clients cannot silently publish private input',async t=>{
  const f=await fixture(t);
  for (const visibility of ['private',null]) {
    assert.equal((await f.request('/jobs',{method:'POST',body:{text:'https://v.douyin.com/abc/',visibility}})).response.status,409);
  }
  assert.equal((await f.request('/jobs',{method:'POST',user:'alice',body:{text:'https://v.douyin.com/abc/',visibility:'public'}})).response.status,409);
  assert.equal(f.calls.length,0);
});

test('concurrent save clicks submit only one upstream download',async t=>{
  const f=await fixture(t,{delaySave:true}), job=await parsedJob(f);
  const one=f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},cookie:job.cookie});
  while (!f.calls.some(c=>c.url.endsWith('/downloads'))) await new Promise(resolve=>setTimeout(resolve,5));
  const two=await f.request('/jobs/'+job.id+'/save',{method:'POST',body:{},cookie:job.cookie});
  assert.equal(two.payload.state,'saving'); f.release(); await one;
  assert.equal(f.calls.filter(c=>c.url.endsWith('/downloads')).length,1);
});

test('platform failures are readable and do not leak upstream detail or credentials',async t=>{
  const f=await fixture(t,{task:{state:'failed',error:{code:'IDENTITY_POOL_EXHAUSTED',message:'private-token internal host'}}});
  const created=await f.request('/jobs',{method:'POST',body:{text:'https://v.douyin.com/abc/'}});
  const failed=await f.request('/jobs/'+created.payload.id,{cookie:created.cookie});
  assert.equal(failed.payload.state,'failed'); assert.match(failed.payload.error,/平台/);
  assert.doesNotMatch(JSON.stringify(failed.payload),/private-token|internal host/);
});

test('submission failures still return a recoverable record with the original input',async t=>{
  const f=await fixture(t,{parseFailure:true});
  const text='原始分享 https://v.douyin.com/abc/';
  const created=await f.request('/jobs',{method:'POST',body:{text}});
  assert.equal(created.payload.state,'failed');
  assert.equal(created.payload.input,text);
  assert.doesNotMatch(JSON.stringify(created.payload),/internal-token/);
  assert.equal((await f.request('/jobs')).payload.jobs[0].input,text);
});

test('changing guest cookie does not bypass the IP queue limit',async t=>{
  const f=await fixture(t,{task:{state:'running'}});
  for(let i=0;i<4;i++) assert.equal((await f.request('/jobs',{method:'POST',body:{text:'https://v.douyin.com/abc/'}})).response.status,202);
  assert.equal((await f.request('/jobs',{method:'POST',body:{text:'https://v.douyin.com/abc/'}})).response.status,429);
});
