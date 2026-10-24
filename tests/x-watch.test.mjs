import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createXWatch,normalizeWatchedPost} from '../lib/x-watch.js';
import {createWatchProcessor} from '../lib/x-watch-processor.js';

const config={handle:'example',group:'行业研究',intervalMinutes:30,includeReplies:false,includeReposts:false,enabled:true,dailyRequests:10,dailyBudgetUsd:1};
const tweet=(id,more={})=>({id_str:String(id),full_text:'原始公开帖子',user:{screen_name:'example'},tweet_created_at:'2026-09-29T01:00:00Z',...more});
const response=(tweets,next_cursor='')=>new Response(JSON.stringify({tweets,next_cursor}));
function fixture(t,fetchImpl,env={OMNIHUB_X_WATCH_ENABLED:'true',SOCIALDATA_API_KEY:'fixture',OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);INSERT INTO users VALUES(1,'zane'),(2,'reader');CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,content TEXT,UNIQUE(user_id,source,external_id));");
  let now=Date.parse('2026-09-29T02:00:00Z');
  return {db,store:createXWatch(db,{fetchImpl,env,now:()=>now}),advance:ms=>{now+=ms;}};
}

test('saving configuration is owner-only and default off without service authorization',async t=>{
  let requests=0;const {store}=fixture(t,()=>{requests++;},{});
  assert.throws(()=>store.configure(2,{...config,enabled:false}),e=>e.status===403);
  assert.throws(()=>store.configure(1,config),e=>e.status===409);
  store.configure(1,{...config,enabled:false});
  assert.equal((await store.collect(1)).state,'disabled');assert.equal(requests,0);
  assert.throws(()=>store.configure(1,{...config,handle:'example OR from:other'}),e=>e.status===400);
});

test('pagination persists backlog; only a completed scan advances the watermark',async t=>{
  const urls=[];let page=0;
  const {db,store,advance}=fixture(t,url=>{urls.push(url);return Promise.resolve(page++===0?response([tweet(102)],'page2'):response([tweet(101)]));});
  store.configure(1,config);
  assert.equal((await store.collect(1)).backlog,true);
  assert.equal(db.prepare('SELECT last_id FROM x_watch_accounts').get().last_id,'');
  advance(60001);assert.equal((await store.collect(1)).backlog,false);
  assert.equal(db.prepare('SELECT last_id FROM x_watch_accounts').get().last_id,'102');
  assert.equal(store.posts(1).length,2);assert.equal(db.prepare('SELECT count(*) n FROM inbox').get().n,0);
  assert.equal(new URL(urls[1]).searchParams.get('cursor'),'page2');
  assert.equal(new URL(urls[0]).searchParams.get('query'),new URL(urls[1]).searchParams.get('query'));
});

test('errors keep cursor and budget counts failed requests; no credentials returned',async t=>{
  const {db,store,advance}=fixture(t,async()=>new Response('upstream secret', {status:500}));
  store.configure(1,{...config,dailyRequests:1});
  assert.equal((await store.collect(1)).state,'error');advance(1800001);
  assert.equal((await store.collect(1)).state,'budget');
  assert.equal(db.prepare('SELECT last_id FROM x_watch_accounts').get().last_id,'');
  assert.ok(!JSON.stringify(store.status(1)).includes('fixture'));
});

test('readable provider errors settle the shared monthly reservation to zero',async t=>{
  const {db,store}=fixture(t,async()=>new Response('{}',{status:429}));
  store.configure(1,{...config,dailyRequests:1});
  assert.equal((await store.collect(1)).state,'error');
  assert.equal(store.status(1).monthlyEstimatedCostUsd,0);
  assert.deepEqual({...db.prepare('SELECT estimated_micros,final_micros,state FROM x_provider_costs').get()},
    {estimated_micros:40000,final_micros:0,state:'final'});
});

test('explicit bookmarks reuse the X ID and never overwrite existing originals',async t=>{
  const {db,store}=fixture(t,async()=>response([tweet(102)]));store.configure(1,config);await store.collect(1);
  db.prepare("INSERT INTO inbox VALUES(1,1,'x','102','更完整的原始收藏')").run();
  const save=post=>{const r=db.prepare("INSERT OR IGNORE INTO inbox(user_id,source,external_id,content) VALUES(1,'x',?,?)").run(post.externalId,post.content);
    return {id:db.prepare("SELECT id FROM inbox WHERE external_id=?").get(post.externalId).id,created:r.changes>0};};
  assert.equal(store.bookmark(1,store.posts(1)[0].id,save).created,false);
  assert.equal(store.bookmark(1,store.posts(1)[0].id,save).created,false);
  assert.equal(db.prepare('SELECT content FROM inbox').get().content,'更完整的原始收藏');
  assert.equal(db.prepare('SELECT count(*) n FROM x_watch_bookmarks').get().n,1);
  assert.throws(()=>store.bookmark(2,1,save),e=>e.status===403);
});

test('concurrent polls have a single lease and paused configuration invalidates an in-flight result',async t=>{
  let release;const {store}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));store.configure(1,config);
  const first=store.collect(1);assert.equal((await store.collect(1)).state,'idle');
  const a=store.status(1).accounts[0];store.configure(1,{...config,id:a.id,revision:a.revision,enabled:false});
  release(response([tweet(102)]));assert.equal((await first).state,'stale');assert.equal(store.posts(1).length,0);
});

test('media-only originals survive; private users and unrelated handles are excluded',()=>{
  const media={extended_entities:{media:[{type:'photo',media_url_https:'https://pbs.twimg.com/media/example.jpg'}]}};
  assert.equal(normalizeWatchedPost(tweet(1,{full_text:'',...media}),'example').media.length,1);
  assert.equal(normalizeWatchedPost(tweet(1,{user:{screen_name:'other'}}),'example'),null);
  assert.equal(normalizeWatchedPost(tweet(1,{user:{screen_name:'example',protected:true}}),'example'),null);
  assert.throws(()=>normalizeWatchedPost(tweet('not-an-id'),'example'));
});

test('zero dollar budget fails closed even for legacy enabled accounts',async t=>{
  let calls=0;const {db,store}=fixture(t,async()=>{calls++;return response([]);});
  assert.throws(()=>store.configure(1,{...config,dailyBudgetUsd:0}),e=>e.status===409);
  for(const value of [-1,NaN,Infinity,'1',0.001,21])assert.throws(()=>store.configure(1,{...config,dailyBudgetUsd:value}),e=>e.status===400);
  store.configure(1,{...config,enabled:false,dailyBudgetUsd:0});
  db.prepare('UPDATE x_watch_accounts SET enabled=1').run();
  assert.equal((await store.collect(1)).state,'budget');assert.equal(calls,0);
});

test('stale account forms cannot restore a previously lowered shared budget',t=>{
  const {store}=fixture(t,async()=>response([]));store.configure(1,config);store.configure(1,{...config,handle:'another'});
  const stale=store.status(1),first=stale.accounts[0],second=stale.accounts[1];
  store.configure(1,{...config,id:first.id,revision:first.revision,settingsRevision:stale.settingsRevision,dailyBudgetUsd:0.04});
  assert.throws(()=>store.configure(1,{...config,id:second.id,revision:second.revision,handle:second.handle,settingsRevision:stale.settingsRevision,enabled:false}),e=>e.status===409);
  assert.equal(store.status(1).dailyBudgetUsd,0.04);assert.equal(store.status(1).accounts[1].enabled,true);
  const fresh=store.status(1);store.configure(1,{...config,id:second.id,revision:second.revision,handle:second.handle,settingsRevision:fresh.settingsRevision,dailyBudgetUsd:0.04,enabled:false});
  assert.equal(store.status(1).accounts[1].enabled,false);
});

test('unreadable billed responses stop further collection for the rolling window',async t=>{
  let calls=0;const {store,advance}=fixture(t,async()=>{calls++;return new Response('invalid json');});
  store.configure(1,config);assert.equal((await store.collect(1)).state,'error');
  advance(3600000);assert.equal(store.status(1).costUncertain,true);assert.equal((await store.collect(1)).state,'budget');assert.equal(calls,1);
  advance(86400000);assert.equal(store.status(1).costUncertain,false);
});

test('shared rolling budget reserves before fetch, settles all returned items, and expires',async t=>{
  let release;const {store,advance}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));
  store.configure(1,{...config,dailyBudgetUsd:0.04});
  store.configure(1,{...config,handle:'another',dailyBudgetUsd:0.04});
  const pending=store.collect(1);
  assert.equal(store.status(1).estimatedCostUsd,0.04);
  assert.equal((await store.collect(1)).state,'budget');
  release(response([tweet(1),tweet(2,{user:{screen_name:'other'}})]));await pending;
  assert.equal(store.status(1).estimatedCostUsd,0.0004);
  assert.equal((await store.collect(1)).state,'budget');
  advance(86400001);assert.equal(store.status(1).budgetRemaining,0.04);
});

test('paused in-flight requests still settle their cost',async t=>{
  let release;const {store}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));
  store.configure(1,config);const request=store.collect(1);
  const a=store.status(1).accounts[0];store.configure(1,{...config,id:a.id,revision:a.revision,enabled:false});
  release(response([tweet(1)]));assert.equal((await request).state,'stale');
  assert.equal(store.status(1).estimatedCostUsd,0.0002);
});

test('initial query looks back seven days and video captures a downloadable MP4',async t=>{
  let url;const {store}=fixture(t,async value=>{url=new URL(value);return response([]);});
  store.configure(1,config);await store.collect(1);assert.match(url.searchParams.get('query'),/since:2026-09-22/);
  const post=normalizeWatchedPost(tweet(1,{extended_entities:{media:[{type:'video',media_url_https:'https://pbs.twimg.com/media/test.jpg',
    video_info:{variants:[{content_type:'application/x-mpegURL',url:'https://video.twimg.com/test.m3u8'},{content_type:'video/mp4',bitrate:800000,url:'https://video.twimg.com/high.mp4'},
      {content_type:'video/mp4',bitrate:200000,url:'https://video.twimg.com/low.mp4'}]}}]}}),'example');
  assert.equal(post.media[0].url,'https://video.twimg.com/low.mp4');
});

test('hot topics need multiple participants and old backfill is not made hot',async t=>{
  const {store}=fixture(t,async()=>response([tweet(102),tweet(101,{tweet_created_at:'2026-01-01T00:00:00Z'})]));
  store.configure(1,config);await store.collect(1);
  let row=store.pendingAnalysis(1);store.saveAnalysis(1,row,{title:'事件',summary:'摘要'},'ready');
  row=store.pendingAnalysis(1);store.saveAnalysis(1,row,{title:'旧事件',summary:'摘要'},'ready');
  assert.equal(store.hot(1).length,0);
});

test('malformed items do not trap a cursor and repeated failed cursors restart safely',async t=>{
  let broken=false;
  const {db,store,advance}=fixture(t,async()=>broken?new Response('expired',{status:400}):response([tweet(102),tweet(103,{tweet_created_at:'invalid'})],'cursor'));
  store.configure(1,config);assert.equal((await store.collect(1)).added,1);
  broken=true;
  for(let i=0;i<3;i++){advance(4*3600000);await store.collect(1);}
  const row=db.prepare('SELECT pending,last_id FROM x_watch_accounts').get();assert.equal(row.pending,'{}');assert.equal(row.last_id,'');
});

test('analysis leases prevent duplicate paid work and invalid verification is not cached',async t=>{
  const {db,store}=fixture(t,async()=>response([tweet(102)]));store.configure(1,config);await store.collect(1);
  let release,calls=0;
  const model={identity:()=> 'fixture',async call(stage){calls++;
    if(stage==='watch')return new Promise(resolve=>{release=()=>resolve({value:{title:'中文测试',summary:'原始公开帖子',claimType:'opinion',
      evidenceQuote:'原始公开帖子',topics:['研究'],sameEventConfidence:0,eventId:null,unsafeExtra:'must not escape'}});});
    return {value:{supported:true,issues:[]}};
  }};
  const first=createWatchProcessor({store,model}).run(1);
  assert.equal((await createWatchProcessor({store,model}).run(1)).state,'idle');assert.equal(calls,1);
  release();assert.equal((await first).state,'review');
  assert.equal(db.prepare('SELECT count(*) n FROM x_watch_receipts').get().n,1);
  assert.ok(!db.prepare('SELECT response FROM x_watch_receipts').get().response.includes('unsafeExtra'));
  store.retryAnalysis(1,store.posts(1)[0].id);
  const fixed={identity:()=> 'fixture',async call(){calls++;return {value:{supported:true,confidence:.95,issues:[]}};}};
  assert.equal((await createWatchProcessor({store,model:fixed}).run(1)).state,'ready');assert.equal(calls,3);
});

test('changed event roots revoke old grouping instead of mixing unrelated events',async t=>{
  const {db,store}=fixture(t,async()=>response([tweet(102),tweet(101)]));store.configure(1,config);await store.collect(1);
  const root=store.pendingAnalysis(1);store.saveAnalysis(1,root,{title:'事件',summary:'摘要'},'ready');
  const child=store.pendingAnalysis(1);store.saveAnalysis(1,child,{title:'同事件',summary:'摘要'},'ready',root.id);
  assert.equal(store.posts(1).find(p=>p.id===child.id).eventId,root.id);
  db.prepare("UPDATE x_watch_posts SET content_hash='changed' WHERE id=?").run(root.id);
  assert.equal(store.posts(1).find(p=>p.id===child.id).eventId,child.id);
});
