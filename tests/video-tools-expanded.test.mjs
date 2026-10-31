import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createVideoToolHandler, extractBatchLinks, extractCollectionLink } from '../lib/video-tools.js';

const content = id => ({ platform:'douyin', content_id:id, title:`作品 ${id}`, author:{nickname:'花园作者'}, duration_ms:5200, media:{video:{url:'https://media.invalid/file'}} });
async function fixture(t, options={}) {
  const calls=[]; const tasks=new Map(); let seq=0; let expired=false; let failMore=Boolean(options.failMore);
  const handler=createVideoToolHandler({baseUrl:'http://127.0.0.1:8108',apiKey:'secret',origin:'http://localhost',transcription:options.transcription ?? true,refreshIntervalMs:0,
    getUser:req=>req.headers['x-user'] ? {id:req.headers['x-user']} : null,
    fetchImpl:async(url,init)=>{
      calls.push({url,body:init.body ? JSON.parse(init.body):null});
      const parsed=new URL(url); let data;
      if(parsed.pathname==='/api/v1/parse') {
        const task_id=`task-${++seq}`; const id=JSON.parse(init.body).url.match(/(\d+)\/?$/)?.[1] || '1';
        tasks.set(task_id,options.content ? options.content(id) : content(id)); data={task_id};
      } else if(/\/user\/(posts|mixes|collections)$|\/(mix|collection)\/posts$/.test(parsed.pathname)) {
        const task_id=`task-${++seq}`;
        const groups=/\/user\/(mixes|collections)$/.test(parsed.pathname);
        const more=parsed.searchParams.get('cursor');
        tasks.set(task_id,more && failMore ? {failed:true} : {items:groups ? [{platform:'douyin',mix_id:'900',name:'春日花园',item_count:2}] : [content(more ? '2':'1'),content('1')],cursor:more ? null:'page2',has_more:!more}); if(more)failMore=false; data={task_id};
      } else if(parsed.pathname.startsWith('/api/v1/tasks/')) { const result=tasks.get(parsed.pathname.split('/').pop()); data=result?.failed ? {state:'failed',error:{code:'RATE_LIMITED'}} : {state:'done',data:result}; }
      else if(parsed.pathname==='/api/v1/downloads') data={download_id:`download-${++seq}`};
      else if(parsed.pathname.includes('/files/')) return expired ? new Response('',{status:410}) : new Response('video-bytes',{headers:{'Content-Type':'video/mp4'}});
      else if(parsed.pathname.startsWith('/api/v1/downloads/')) data={state:'done',on_disk:true,files:[{name:'video.mp4',state:'done',kind:'video',content_type:'video/mp4',bytes:11}]};
      else if(parsed.pathname==='/api/v1/transcriptions') data={transcription_id:`transcript-${++seq}`};
      else if(parsed.pathname.startsWith('/api/v1/transcriptions/')) data={state:'done',text:'第一次做花园，这九个设计不能少。',duration_ms:5200,model:'FunASR'};
      else throw Error('Unexpected fixture route '+parsed.pathname);
      return Response.json({data});
    }});
  const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost').pathname));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));handler.close();});
  async function request(path,{user,body,method=body ? 'POST':'GET'}={}) {
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/tools/video${path}`,{method,headers:{...(user ? {'X-User':user}:{}),...(body ? {'Content-Type':'application/json'}:{})},body:body ? JSON.stringify({visibility:user ? 'private':'public',...body}):undefined});
    return {status:r.status,data:r.headers.get('content-type')?.includes('json') ? await r.json():await r.text(),headers:r.headers};
  }
  async function settle(id,user) {let r;for(let n=0;n<6;n++){r=await request('/jobs/'+id,{user});if(!['parsing','saving','transcribing','browsing','queued'].includes(r.data.state))return r.data;}return r.data;}
  return {request,settle,calls,expire:()=>{expired=true;}};
}

test('batch validates all links before use, deduplicates and rejects unsafe URLs',()=>{
  assert.equal(extractBatchLinks('A https://www.douyin.com/video/1\nB https://www.douyin.com/video/2\nhttps://www.douyin.com/video/1').length,2);
  assert.throws(()=>extractBatchLinks('https://www.douyin.com/video/1\nhttp://127.0.0.1/video/2'));
  assert.throws(()=>extractBatchLinks(Array.from({length:21},(_,i)=>`https://www.douyin.com/video/${i}`).join('\n')));
  assert.equal(extractCollectionLink('https://www.douyin.com/collection/123').mode,'mix');
  assert.equal(extractCollectionLink('https://space.bilibili.com/42/favlist?fid=123').resourceId,'123');
  assert.equal(extractCollectionLink('https://www.tiktok.com/@user/collection/Test-123').mode,'collection');
  for(const url of ['http://127.0.0.1/user/a','https://u:p@www.douyin.com/user/a','https://www.douyin.com:99/user/a','https://www.douyin.com/search/a','ftp://www.douyin.com/user/a']) assert.throws(()=>extractCollectionLink(url));
  assert.throws(()=>extractCollectionLink('https://www.douyin.com/user/a',{mode:'collections'}));
  assert.throws(()=>extractCollectionLink('https://www.douyin.com/user/a',{mode:'mix',resourceId:'../secrets'}));
});

test('watch and snapshot HTTP routes enforce scope and keep private results isolated',async t=>{
  const f=await fixture(t,{content:id=>({...content(id),stats:{play_count:10,digg_count:2}})});
  const stale=await f.request('/watchlists',{body:{visibility:'private',text:'https://www.douyin.com/user/test'}});
  assert.equal(stale.status,409);
  const created=await f.request('/watchlists',{user:'a',body:{text:'https://www.douyin.com/user/test'}});
  assert.equal(created.status,201);assert.equal(created.data.enabled,false);
  const id=created.data.id;
  assert.equal((await f.request('/watchlists/'+id,{user:'b'})).status,404);
  const checked=await f.request(`/watchlists/${id}/run`,{user:'a',body:{}});
  assert.equal(checked.status,200);assert.equal(checked.data.newItems.length,1);
  assert.equal((await f.request(`/watchlists/${id}/items`,{user:'a'})).data.items.length,1);
  const shot=await f.request('/snapshots',{user:'a',body:{text:'https://www.douyin.com/video/2'}});
  assert.equal(shot.status,201);
  assert.equal((await f.request('/snapshots',{user:'b'})).data.recent.length,0);
  assert.equal((await f.request('/snapshots?platform=douyin&contentId=2',{user:'a'})).data.snapshots.length,1);
  const pub=await f.request('/watchlists',{body:{text:'https://www.douyin.com/user/public'}});
  assert.equal((await f.request('/watchlists/'+pub.data.id,{method:'PATCH',body:{enabled:true}})).status,403);
});

test('batch preserves exact original text and retries only one chosen child',async t=>{
  const f=await fixture(t); const text='  视频一 https://www.douyin.com/video/1\n视频二 https://www.douyin.com/video/2  ';
  const created=await f.request('/batch',{user:'alice',body:{text}});
  assert.equal(created.status,202); assert.equal(created.data.jobs.length,2);
  for(const job of created.data.jobs) assert.equal(job.input,text);
  assert.equal((await f.request('/jobs',{user:'bob'})).data.jobs.length,0);
  await f.settle(created.data.jobs[0].id,'alice');
  const retry=await f.request('/jobs/'+created.data.jobs[0].id+'/retry',{user:'alice',body:{}});
  assert.equal(retry.status,202); assert.equal(retry.data.input,text); assert.equal(retry.data.url,'https://www.douyin.com/video/1');
  const last=f.calls.filter(c=>c.url.includes('/parse?')).at(-1);
  assert.match(last.url,/refresh=true/); assert.equal(last.body.url,'https://www.douyin.com/video/1');
  assert.equal((await f.request('/jobs/'+retry.data.id,{user:'bob'})).status,404);
});

test('download to transcript handoff preserves the chosen batch child, input and ownership',async t=>{
  const f=await fixture(t);const original='先看 https://www.douyin.com/video/1\n再看 https://www.douyin.com/video/2';
  const batch=await f.request('/batch',{body:{text:original}});
  const source=await f.settle(batch.data.jobs[1].id);
  const parseCalls=f.calls.filter(c=>c.url.includes('/parse?')).length;
  const handoff=await f.request('/jobs/'+source.id+'/transcribe',{user:'alice',body:{}});
  assert.equal(handoff.status,202);assert.equal(handoff.data.visibility,'private');assert.equal(handoff.data.input,original);
  assert.equal(handoff.data.url,'https://www.douyin.com/video/2');assert.equal(handoff.data.content.contentId,'2');
  const duplicate=await f.request('/jobs/'+source.id+'/transcribe',{user:'alice',body:{}});
  assert.equal(duplicate.data.id,handoff.data.id);
  const job=await f.settle(handoff.data.id,'alice');assert.equal(job.state,'transcribed');
  assert.equal(f.calls.filter(c=>c.url.includes('/parse?')).length,parseCalls);
  assert.deepEqual(f.calls.find(c=>c.url.endsWith('/downloads')).body,{platform:'douyin',content_id:'2',skip_existing:true});
  assert.equal((await f.request('/jobs/'+job.id)).status,404);
  assert.equal((await f.request('/jobs/'+job.id,{user:'bob'})).status,404);
  assert.equal((await f.request('/jobs/'+source.id+'/transcribe',{user:'alice',body:{}})).status,200);
  const guest=await f.request('/jobs/'+source.id+'/transcribe',{body:{}});
  assert.equal(guest.data.visibility,'public');assert.notEqual(guest.data.id,job.id);
});

test('transcript handoff rejects private sources, stale scope and unsupported content',async t=>{
  const f=await fixture(t);
  const created=await f.request('/jobs',{user:'alice',body:{text:'https://www.douyin.com/video/1'}});
  const job=await f.settle(created.data.id,'alice');
  assert.equal((await f.request('/jobs/'+job.id+'/transcribe',{body:{}})).status,404);
  assert.equal((await f.request('/jobs/'+job.id+'/transcribe',{user:'bob',body:{}})).status,404);
  assert.equal((await f.request('/jobs/'+job.id+'/transcribe',{user:'alice',body:{visibility:'public'}})).status,409);
  assert.equal((await f.request('/jobs',{user:'alice'})).data.jobs.length,1);
  const scenarios=[
    {transcription:false},
    {content:id=>({...content(id),duration_ms:600001})},
    {content:id=>({...content(id),media:{images:[{url:'https://media.invalid/image'}]}})},
  ];
  for(const options of scenarios) {
    const current=await fixture(t,options);const source=await current.request('/jobs',{body:{text:'https://www.douyin.com/video/1'}});
    await current.settle(source.data.id);
    assert.equal((await current.request('/jobs/'+source.data.id+'/transcribe',{body:{}})).status,options.transcription===false ? 503:422);
    assert.equal((await current.request('/jobs')).data.jobs.length,1);
  }
});

test('transcription pipelines parse, download and text with account isolation and TXT export',async t=>{
  const f=await fixture(t);
  const created=await f.request('/jobs',{user:'alice',body:{kind:'transcript',text:'原文\nhttps://www.douyin.com/video/3'}});
  const job=await f.settle(created.data.id,'alice');
  assert.equal(job.state,'transcribed'); assert.match(job.transcript.text,/花园/);
  assert.equal(job.input,'原文\nhttps://www.douyin.com/video/3');
  assert.doesNotMatch(JSON.stringify(job),/transcriptionId|downloadId|taskId|media.invalid|secret/);
  assert.equal((await f.request('/jobs/'+job.id+'/transcript.txt')).status,404);
  assert.equal((await f.request('/jobs/'+job.id+'/transcript.txt',{user:'bob'})).status,404);
  const txt=await f.request('/jobs/'+job.id+'/transcript.txt',{user:'alice'});
  assert.equal(txt.status,200);assert.equal(txt.data,job.transcript.text); assert.match(txt.headers.get('content-disposition'),/^attachment/);
  assert.equal((await f.request('/jobs?view=library&type=text&q=九个',{user:'alice'})).data.jobs.length,1);
  assert.equal((await f.request('/jobs?view=library',{user:'bob'})).data.jobs.length,0);
  assert.equal((await f.request('/jobs?view=library')).data.jobs.length,0);
  assert.equal((await f.request('/jobs/'+job.id+'/files/video.mp4',{user:'alice'})).status,200);
});

test('disabled transcription and stale private scopes fail without publishing',async t=>{
  const f=await fixture(t,{transcription:false});
  assert.equal((await f.request('/status')).data.features.transcription,false);
  assert.equal((await f.request('/jobs',{body:{text:'https://www.douyin.com/video/1',kind:'transcript'}})).status,503);
  assert.equal((await f.request('/batch',{body:{text:'https://www.douyin.com/video/1',visibility:'private'}})).status,409);
  assert.equal((await f.request('/jobs')).data.jobs.length,0); assert.equal(f.calls.length,0);
});

test('failed collection pagination retains the first page and supports explicit retry',async t=>{
  const f=await fixture(t,{failMore:true});
  const created=await f.request('/jobs',{body:{kind:'collection',mode:'posts',text:'https://www.douyin.com/user/test'}});
  let job=await f.settle(created.data.id);
  await f.request('/jobs/'+job.id+'/more',{body:{}});
  job=await f.settle(job.id);
  assert.equal(job.state,'ready'); assert.equal(job.collection.items.length,1); assert.equal(job.collection.cursor,'page2'); assert.ok(job.error);
  assert.equal((await f.request('/jobs/'+job.id+'/more',{body:{}})).status,202);
  job=await f.settle(job.id); assert.equal(job.state,'ready'); assert.equal(job.collection.items.length,2); assert.equal(job.error,'');
  const last=f.calls.filter(c=>c.url.includes('/user/posts?')).at(-1); assert.match(last.url,/refresh=true/);
});

test('collection browsing preserves input, deduplicates pagination, supports groups and privacy',async t=>{
  const f=await fixture(t);
  const original='作者主页\nhttps://www.douyin.com/user/test';
  const created=await f.request('/jobs',{user:'alice',body:{kind:'collection',mode:'posts',text:original}});
  let job=await f.settle(created.data.id,'alice');
  assert.equal(job.state,'ready'); assert.equal(job.collection.items.length,1); assert.equal(job.collection.hasMore,true);
  assert.equal((await f.request('/jobs/'+job.id+'/more',{user:'bob',body:{}})).status,404);
  assert.equal((await f.request('/jobs/'+job.id+'/more',{user:'alice',body:{}})).status,202);
  job=await f.settle(job.id,'alice'); assert.equal(job.collection.items.length,2); assert.equal(job.collection.hasMore,false); assert.equal(job.input,original);
  assert.equal(job.collection.items[0].url,'https://www.douyin.com/video/1');
  const groups=await f.request('/jobs',{body:{kind:'collection',mode:'mixes',text:original}});
  const groupJob=await f.settle(groups.data.id);
  assert.equal(groupJob.collection.groups[0].id,'900'); assert.equal(groupJob.visibility,'public');
  assert.equal((await f.request('/jobs?kind=collection')).data.jobs.length,1);
  const selected=await f.request('/jobs',{body:{kind:'collection',mode:'mix',platform:'douyin',resourceId:'900',text:original}});
  assert.equal((await f.settle(selected.data.id)).collection.items.length,1);
});

 test('expired source media preserves durable transcript and TXT access',async t=>{
  const f=await fixture(t);const created=await f.request('/jobs',{user:'alice',body:{kind:'transcript',text:'https://www.douyin.com/video/7'}});
  const job=await f.settle(created.data.id,'alice');assert.equal(job.state,'transcribed');f.expire();
  assert.equal((await f.request('/jobs/'+job.id+'/files/video.mp4',{user:'alice'})).status,410);
  assert.equal((await f.request('/jobs/'+job.id,{user:'alice'})).data.state,'transcribed');
  assert.equal((await f.request('/jobs/'+job.id+'/transcript.txt',{user:'alice'})).data,job.transcript.text);
  assert.equal((await f.request('/jobs?view=library&type=text',{user:'alice'})).data.jobs.length,1);
});

 test('saving a larger batch queues overflow instead of stopping midway',async t=>{
  const f=await fixture(t); const jobs=[];
  for(let n=10;n<16;n++){const created=await f.request('/jobs',{body:{text:`https://www.douyin.com/video/${n}`}});jobs.push(await f.settle(created.data.id));}
  const states=[];for(const job of jobs){const r=await f.request('/jobs/'+job.id+'/save',{body:{}});assert.equal(r.status,202);states.push(r.data.state);}
  assert.deepEqual(states,['saving','saving','saving','saving','queued','queued']);
  assert.equal((await f.request('/jobs/'+jobs[5].id+'/save',{body:{}})).data.state,'queued');
  const deadline=Date.now()+12000;let all;
  do {await new Promise(r=>setTimeout(r,150));all=(await f.request('/jobs')).data.jobs;}while(all.some(j=>j.state!=='saved')&&Date.now()<deadline);
  assert.equal(all.filter(j=>j.state==='saved').length,6);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/downloads')).length,6);
});
