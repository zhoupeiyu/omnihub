import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { discoveryRequest, discoveryPath, discoveryResult, discoveryExport } from '../lib/video-discovery.js';
import { createVideoToolHandler, extractVideoLink } from '../lib/video-tools.js';

const requestSpec = value => discoveryRequest(value, extractVideoLink);
test('discovery accepts only explicit platform operations and bounded platform inputs', () => {
  const sample = { operation:'comments',platform:'douyin',text:'原文\nhttps://www.douyin.com/video/123' };
  assert.equal(requestSpec(sample).discoveryQuery.url,'https://www.douyin.com/video/123');
  for (const input of [
    {...sample,platform:'bilibili'}, {...sample,operation:'search-posts'},
    {...sample,operation:'../admin'}, {...sample,sort:'new'},
    {...sample,operation:'replies',commentId:'../secret'},
    {...sample,text:'http://127.0.0.1/video/1'},
    {...sample,operation:'live',text:'https://www.douyin.com/video/1'},
    {...sample,operation:'music-posts',resourceId:'1&identity=admin'},
  ]) assert.throws(()=>requestSpec(input));
  const q=requestSpec({operation:'search-posts',platform:'bilibili',text:'花园 & identity=admin'});
  const path=new URL(discoveryPath(q),'http://localhost');
  assert.equal(path.searchParams.get('keyword'),'花园 & identity=admin');
  assert.equal(path.searchParams.has('identity'),false);
  assert.equal(requestSpec({operation:'live',platform:'bilibili',text:'https://live.bilibili.com/6'}).discoveryQuery.url,'https://live.bilibili.com/6');
  assert.equal(requestSpec({operation:'music',platform:'douyin',text:'12345'}).discoveryQuery.music_id,'12345');
});

test('normalization drops raw/private data, unsafe links and prevents cursor loops', () => {
  const job={operation:'comments',platform:'douyin'};
  const item={platform:'douyin',comment_id:'123',text:'=HYPERLINK("bad")',author:{nickname:'author',token:'secret'},raw:{secret:true},web_url:'javascript:alert(1)',digg_count:2};
  discoveryResult(job,{items:[item,{...item,comment_id:'private',is_private:true}],cursor:'next',has_more:true});
  assert.equal(job.discovery.items.length,1);assert.equal(job.discovery.items[0].url,'');
  assert.equal(job.discovery.hasMore,true);assert.equal(JSON.stringify(job.discovery).includes('secret'),false);
  discoveryResult(job,{items:[item],cursor:'next',has_more:true});
  assert.equal(job.discovery.items.length,1);assert.equal(job.discovery.hasMore,false);
  assert.match(discoveryExport(job,'csv'),/"'=HYPERLINK/);
  assert.equal(JSON.parse(discoveryExport(job,'json')).operation,'comments');
  const music={operation:'music',platform:'douyin'};
  discoveryResult(music,{platform:'douyin',music_id:'123',title:'song'});
  assert.equal(music.discovery.detail.isLive,undefined);
});

async function fixture(t) {
  const tasks=new Map(),calls=[];let moreFails=true,seq=0;
  const handler=createVideoToolHandler({baseUrl:'http://127.0.0.1:8108',apiKey:'test-secret',origin:'http://localhost',refreshIntervalMs:0,getUser:req=>req.headers['x-user']?{id:req.headers['x-user']}:null,
    fetchImpl:async(url)=>{const u=new URL(url);calls.push(u);
      if(u.pathname.startsWith('/api/v1/tasks/')) return Response.json({data:tasks.get(u.pathname.split('/').pop())});
      const task_id=`task-${++seq}`,more=u.searchParams.has('cursor');
      const items=[{platform:'douyin',comment_id:more?'2':'1',text:more?'second':'first',author:{nickname:'reader'},reply_count:2}];
      tasks.set(task_id,more&&moreFails?{state:'failed',error:{code:'RATE_LIMITED'}}:{state:'done',data:{items,cursor:more?null:'next-page',has_more:!more}});
      if(more)moreFails=false;
      return Response.json({data:{task_id,state:'queued'}});
    }});
  const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost').pathname));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));handler.close();});
  async function request(path,{user,body}={}) {
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/tools/video${path}`,{method:body?'POST':'GET',headers:{...(user?{'x-user':user}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify({visibility:user?'private':'public',...body}):undefined});
    return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
  }
  return {request,calls};
}

test('discovery jobs preserve input and ownership through polling, paging, retry and exports',async t=>{
  const f=await fixture(t),input='  评论\nhttps://www.douyin.com/video/123  ';
  const created=await f.request('/jobs',{user:'alice',body:{kind:'discovery',operation:'comments',platform:'douyin',text:input}});
  assert.equal(created.status,202);assert.equal(created.data.state,'browsing');assert.equal(created.data.input,input);
  const path='/jobs/'+created.data.id;
  let current=await f.request(path,{user:'alice'});assert.equal(current.data.state,'ready');assert.equal(current.data.discovery.items.length,1);
  assert.equal((await f.request(path,{user:'bob'})).status,404);
  assert.equal((await f.request(path+'/export.json')).status,404);
  assert.equal((await f.request(path+'/export.csv',{user:'bob'})).status,404);
  assert.equal((await f.request(path+'/more',{user:'alice',body:{visibility:'public'}})).status,409);
  await f.request(path+'/more',{user:'alice',body:{}});
  current=await f.request(path,{user:'alice'});assert.equal(current.data.state,'ready');assert.equal(current.data.discovery.items.length,1);assert.ok(current.data.error);assert.equal(current.data.discovery.hasMore,true);
  await f.request(path+'/more',{user:'alice',body:{}});
  current=await f.request(path,{user:'alice'});assert.equal(current.data.discovery.items.length,2);assert.equal(current.data.error,'');
  const exported=await f.request(path+'/export.json',{user:'alice'});assert.equal(exported.data.input,input);assert.equal(exported.data.items.length,2);
  const retry=await f.request(path+'/retry',{user:'alice',body:{}});assert.equal(retry.data.operation,'comments');assert.equal(retry.data.input,input);
  assert.equal(f.calls.at(-1).searchParams.get('refresh'),'true');assert.equal(f.calls.at(-1).searchParams.has('cursor'),false);
});

test('public discovery may be read but retry is recorded under the current account',async t=>{
  const f=await fixture(t);
  const original=await f.request('/jobs',{body:{kind:'discovery',operation:'comments',platform:'douyin',text:'https://www.douyin.com/video/123'}});
  const path='/jobs/'+original.data.id;
  assert.equal((await f.request(path,{user:'alice'})).data.visibility,'public');
  const derived=await f.request(path+'/retry',{user:'alice',body:{}});
  assert.equal(derived.data.visibility,'private');assert.equal((await f.request('/jobs/'+derived.data.id)).status,404);
});
