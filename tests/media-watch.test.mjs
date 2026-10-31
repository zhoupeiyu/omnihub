import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMediaWatchStore } from '../lib/media-watch.js';

const HOUR = 60 * 60 * 1000;
const post = (id, metrics = { play_count:10, digg_count:2, comment_count:1 }) => ({ platform:'douyin',content_id:String(id),title:`作品 ${id}`,author:{nickname:'作者'},duration_ms:1000,media:{video:{url:'https://media.test/x.mp4'}},stats:metrics,web_url:`https://www.douyin.com/video/${id}` });

function fixture({ taskState = 'done', initialItems = [post('1'),post('2')], parseContent = post('1') } = {}) {
  let stamp = 1_700_000_000_000;
  const calls=[]; let taskCalls=0; let items=initialItems;
  const db = new DatabaseSync(':memory:');
  const store = createMediaWatchStore({ db, now:()=>stamp, pollLimit:3, wait:async()=>{},
    extractCollectionLink:(text,options={})=>({url:String(text),platform:options.platform || 'douyin',mode:options.mode || 'posts',resourceId:''}),
    extractVideoLink:text=>({url:String(text),platform:'douyin'}),
    normalizeVideoContent:(raw,platform)=>{if(raw.platform!==platform || !raw.media) throw Error('bad'); return {platform,contentId:raw.content_id,title:raw.title,author:raw.author.nickname,duration:raw.duration_ms,hasVideo:true,imageCount:0};},
    contentUrl:raw=>raw.web_url,
    upstream:async (path,body)=>{calls.push({path,body}); if(path.includes('/tasks/')) {taskCalls+=1; if(taskState==='pending') return {state:'queued'}; if(taskState==='failed') return {state:'failed'}; return {state:'done',data:path.endsWith('/parse-task') ? parseContent : {items,cursor:null,has_more:false}};} if(path.startsWith('/api/v1/parse')) return {task_id:'parse-task'}; return {task_id:'list-task'};}
  });
  return {store,db,calls,setItems:value=>{items=value;},advance:ms=>{stamp+=ms;},stamp:()=>stamp,taskCalls:()=>taskCalls};
}
const alice={owner:'user:alice',scope:'private'}; const bob={owner:'user:bob',scope:'private'}; const guest={owner:'public',scope:'public'};

test('watch creation is paused, owner-isolated and bounded',()=>{
  const f=fixture(); const one=f.store.create(alice,{text:'https://www.douyin.com/user/a'});
  assert.equal(one.state,'paused'); assert.equal(one.enabled,false); assert.equal(one.intervalMs,6*HOUR);
  assert.equal(f.store.list(bob).length,0); assert.throws(()=>f.store.get(bob,one.id),/找不到/);
  for(let i=0;i<4;i++) f.store.create(alice,{text:`https://www.douyin.com/user/${i}`});
  assert.throws(()=>f.store.create(alice,{text:'https://www.douyin.com/user/limit'}),/最多关注 5/);
  const publicWatch=f.store.create(guest,{text:'https://www.douyin.com/user/public'});
  assert.equal(publicWatch.visibility,'public'); assert.throws(()=>f.store.update(guest,publicWatch.id,{enabled:true}),/公开关注/);
});

test('manual run records new items and snapshots without treating partial pages as deletion',async()=>{
  const f=fixture(); const watch=f.store.create(alice,{text:'https://www.douyin.com/user/a'});
  const first=await f.store.run(alice,watch.id); assert.equal(first.newItems.length,2); assert.equal(f.store.items(alice,watch.id).length,2);
  assert.match(f.calls.find(call=>call.path.includes('/user/posts')).path,/refresh=true/);
  assert.doesNotMatch(f.calls.find(call=>call.path.includes('/user/posts')).path,/cursor=/);
  f.setItems([post('2',{play_count:11,digg_count:3}),post('3')]); f.advance(6*HOUR);
  const second=await f.store.run(alice,watch.id); assert.deepEqual(second.newItems.map(item=>item.contentId),['3']);
  assert.equal(f.store.items(alice,watch.id).length,3);
  assert.equal(f.store.snapshots(alice,{platform:'douyin',contentId:'2'}).length,2);
  const collectionCalls=f.calls.filter(call=>call.path.includes('/user/posts'));
  assert.equal(collectionCalls.length,2); assert.doesNotMatch(collectionCalls[1].path,/cursor=/);
});

test('manual runs and scheduled ticks share one lease, then survive a fresh store using the same db',async()=>{
  const f=fixture(); const watch=f.store.create(alice,{text:'https://www.douyin.com/user/a'});
  f.store.update(alice,watch.id,{enabled:true});
  const manual=f.store.run(alice,watch.id);
  await assert.rejects(f.store.run(alice,watch.id),/正在检查/);
  const scheduled=await f.store.tick(); assert.equal(scheduled.length,0);
  await manual; assert.equal(f.store.items(alice,watch.id).length,2);
  f.advance(6*HOUR);
  const resumed=createMediaWatchStore({db:f.db,now:()=>f.stamp(),pollLimit:2,wait:async()=>{},extractCollectionLink:()=>{throw Error('not used');},extractVideoLink:t=>({url:t,platform:'douyin'}),normalizeVideoContent:(raw,p)=>({platform:p,contentId:raw.content_id,title:raw.title,author:'作者',duration:1,hasVideo:true,imageCount:0}),contentUrl:raw=>raw.web_url,upstream:async path=>path.includes('/tasks/')?{state:'done',data:{items:[post('1'),post('4')],has_more:false,cursor:null}}:{task_id:'resume'}});
  const result=await resumed.tick(); assert.equal(result.length,1); assert.equal(resumed.items(alice,watch.id).length,3);
});

test('failed or deleted watches never erase results or revive after an in-flight response',async()=>{
  const f=fixture({taskState:'failed'}); const watch=f.store.create(alice,{text:'https://www.douyin.com/user/a'});
  await assert.rejects(f.store.run(alice,watch.id),/平台暂时限制/); assert.equal(f.store.get(alice,watch.id).lastError.length>0,true);
  const f2=fixture(); const active=f2.store.create(alice,{text:'https://www.douyin.com/user/a'}); f2.store.update(alice,active.id,{enabled:true});
  const pending=f2.store.tick(); f2.store.remove(alice,active.id); await pending;
  assert.throws(()=>f2.store.get(alice,active.id),/找不到/);
});

test('pausing during an in-flight task stays paused, auto watches expire, and cleanup bounds snapshots',async()=>{
  let release; const f=fixture();
  const original=f.store.run; // Keep the store implementation under test; delay only the injected upstream task.
  const blocking=createMediaWatchStore({db:f.db,now:()=>f.stamp(),pollLimit:2,wait:async()=>{},extractCollectionLink:(text,options={})=>({url:text,platform:'douyin',mode:options.mode||'posts',resourceId:''}),extractVideoLink:t=>({url:t,platform:'douyin'}),normalizeVideoContent:(raw,p)=>({platform:p,contentId:raw.content_id,title:raw.title,author:'作者',duration:1,hasVideo:true,imageCount:0}),contentUrl:raw=>raw.web_url,upstream:async path=>path.includes('/tasks/') ? await new Promise(resolve=>{release=()=>resolve({state:'done',data:{items:[post('9')],has_more:false,cursor:null}});}) : {task_id:'blocked'}});
  const watch=blocking.create(alice,{text:'https://www.douyin.com/user/a'}); blocking.update(alice,watch.id,{enabled:true});
  const running=blocking.run(alice,watch.id); await Promise.resolve(); f.advance(3*60*1000); await assert.rejects(blocking.run(alice,watch.id),/正在检查/); blocking.update(alice,watch.id,{enabled:false}); release(); await running;
  assert.equal(blocking.get(alice,watch.id).state,'paused'); assert.equal(blocking.get(alice,watch.id).enabled,false);
  blocking.update(alice,watch.id,{enabled:true}); f.advance(31*24*HOUR); await blocking.tick(); assert.equal(blocking.get(alice,watch.id).state,'expired');
  for(let i=0;i<205;i++){f.advance(6*HOUR); await f.store.snapshot(alice,{text:'https://www.douyin.com/video/1'});}
  assert.equal(f.store.snapshots(alice,{platform:'douyin',contentId:'1',limit:300}).length,200);
  f.advance(31*24*HOUR); f.store.cleanup(); assert.equal(f.store.snapshots(alice,{platform:'douyin',contentId:'1'}).length,0);
  void original;
});

test('content snapshots are read only by their owner and do not fabricate a history',async()=>{
  const f=fixture(); const snapshot=await f.store.snapshot(alice,{text:'https://www.douyin.com/video/1'});
  assert.equal(f.calls.find(call=>call.path.startsWith('/api/v1/parse')).path,'/api/v1/parse?wait=0&refresh=true');
  assert.equal(snapshot.content.contentId,'1'); assert.equal(snapshot.content.url,'https://www.douyin.com/video/1');
  assert.equal(snapshot.stored,true); assert.equal(f.store.snapshots(alice,{platform:'douyin',contentId:'1'}).length,1);
  assert.equal(f.store.snapshots(bob,{platform:'douyin',contentId:'1'}).length,0);
  assert.deepEqual(f.store.recentSnapshots(alice),[{platform:'douyin',contentId:'1',title:'作品 1',url:'https://www.douyin.com/video/1',lastObservedAt:f.stamp()}]);
  assert.deepEqual(f.store.recentSnapshots(bob),[]);
  const again=await f.store.snapshot(alice,{text:'https://www.douyin.com/video/1'});
  assert.equal(again.stored,false); assert.equal(again.reason,'recent'); assert.equal(again.lastObservedAt,f.stamp()); assert.equal(f.store.snapshots(alice,{platform:'douyin',contentId:'1'}).length,1);
});

test('snapshot metrics preserve missing values and accept a real zero',async()=>{
  for (const metrics of [{play_count:null,digg_count:'',comment_count:undefined},{play_count:0,digg_count:'0',comment_count:0}]) {
    const f=fixture({parseContent:post('1',metrics)}); const result=await f.store.snapshot(alice,{text:'https://www.douyin.com/video/1'});
    if (metrics.play_count === null) { assert.equal(result.stored,false); assert.equal(result.reason,'no_metrics'); assert.equal(result.lastObservedAt,null); }
    else { assert.equal(result.stored,true); assert.equal(result.reason,'stored'); const [saved]=f.store.snapshots(alice,{platform:'douyin',contentId:'1'}); assert.deepEqual(saved.metrics,{playCount:0,diggCount:0,commentCount:0,shareCount:null,collectCount:null}); }
  }
});

test('item retention is explicit and deleted watch cleanup removes its item rows',()=>{
  const f=fixture(); const watch=f.store.create(alice,{text:'https://www.douyin.com/user/a'});
  for(let index=0;index<5001;index+=1) f.db.prepare('INSERT INTO media_watch_items VALUES(?,?,?,?,?)').run(watch.id,`douyin:${index}`,JSON.stringify({contentId:String(index)}),f.stamp(),f.stamp());
  f.store.cleanup();
  assert.equal(f.store.items(alice,watch.id,{limit:6000}).length,200); // API deliberately caps a response page.
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_watch_items WHERE watch_id=?').get(watch.id).n,5000);
  assert.equal(f.store.get(alice,watch.id).seenTruncated,true);
  f.store.remove(alice,watch.id); f.advance(31*24*HOUR); f.store.cleanup();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_watch_items WHERE watch_id=?').get(watch.id).n,0);
});
