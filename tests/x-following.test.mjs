import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createXFollowing,normalizeXHandle} from '../lib/x-following.js';
import {createXWatch} from '../lib/x-watch.js';
import {createXProviderBudget} from '../lib/x-provider-budget.js';

const user=(id,handle,more={})=>({id_str:String(id),screen_name:handle,name:`Name ${handle}`,friends_count:3,...more});
const response=value=>new Response(JSON.stringify(value));
function setup(t,fetchImpl,env={SOCIALDATA_API_KEY:'fixture',OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);INSERT INTO users VALUES(1,'zane'),(2,'reader');");
  let time=Date.parse('2026-09-29T12:00:00Z');
  return {db,store:createXFollowing(db,{fetchImpl,env,now:()=>time}),advance:ms=>time+=ms};
}
const loadInput=(store,action='load',handle='zane9588')=>{const s=store.status(1);return {handle,action,generation:s.generation,page:s.pages};};

test('handles accept usernames and actual profile URLs, never arbitrary or tweet URLs',()=>{
  for(const value of ['@Alice','ALICE','https://x.com/Alice','twitter.com/alice/','https://mobile.twitter.com/alice?s=20'])assert.equal(normalizeXHandle(value),'alice');
  for(const value of ['',null,'https://x.com/alice/status/1','https://x.com.evil.test/alice','https://x.com@evil.test/alice','https://x.com:444/alice','home','alice OR from:bob','https://x.com/i'])assert.throws(()=>normalizeXHandle(value),e=>e.status===400);
});

test('cache reads are owner-only, provider-free and independent of the polling enable switch',async t=>{
  let calls=0;const {store}=setup(t,()=>{calls++;},{});
  assert.equal(store.status(1).available,false);assert.equal(store.status(1).handle,'zane9588');
  assert.throws(()=>store.status(2),e=>e.status===403);
  await assert.rejects(()=>store.load(2,{}),e=>e.status===403);
  await assert.rejects(()=>store.load(1,loadInput(store)),e=>e.status===409);
  assert.equal(calls,0);
});

test('pagination keeps large IDs, deduplicates, resumes from cache, and never refetches replayed pages',async t=>{
  const urls=[];const {store,db}=setup(t,async(url,options)=>{
    urls.push(url);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer fixture');
    if(url.endsWith('/zane9588'))return response(user('1729591119699124560','zane9588'));
    if(!url.includes('cursor='))return response({users:[user(2,'alice',{profile_image_url_https:'javascript:bad'}),user(3,'bob')],next_cursor:'next|1'});
    return response({users:[user(3,'bob'),user(4,'carol',{protected:true})],next_cursor:null});
  });
  const firstInput=loadInput(store);let state=await store.load(1,firstInput);
  assert.equal(state.users.length,2);assert.equal(state.complete,false);assert.equal(state.users[0].avatar,'');
  assert.equal(state.monthlyEstimatedCostUsd,0.0006);
  await store.load(1,firstInput);assert.equal(urls.length,2);
  assert.ok(urls[1].includes('/1729591119699124560/following'));
  const nextInput=loadInput(store);state=await store.load(1,nextInput);
  assert.equal(state.complete,true);assert.equal(state.users.length,3);assert.equal(state.users[2].protected,true);
  assert.equal(state.monthlyEstimatedCostUsd,0.001);
  assert.ok(urls[2].endsWith('cursor=next%7C1'));
  await store.load(1,nextInput);await store.load(1,loadInput(store));assert.equal(urls.length,3);
  assert.equal(db.prepare('SELECT count(*) n FROM x_following_requests').get().n,3);
  assert.ok(!JSON.stringify(state).includes('fixture'));
});

test('31-day SocialData cap is shared by watch polling and following-list reads',async t=>{
  let followingCalls=0;
  const env={SOCIALDATA_API_KEY:'fixture',OMNIHUB_X_WATCH_ENABLED:'true',OMNIHUB_SOCIALDATA_MONTH_USD:'0.04'};
  const {db,store:following}=setup(t,async()=>{followingCalls++;return response(user(1,'zane9588'));},env);
  const watch=createXWatch(db,{env,fetchImpl:async()=>new Response(JSON.stringify({tweets:[],next_cursor:''}))});
  watch.configure(1,{handle:'example',group:'test',intervalMinutes:30,includeReplies:false,includeReposts:false,enabled:true,dailyRequests:1,dailyBudgetUsd:0.04});
  assert.equal((await watch.collect(1)).state,'ok');
  assert.equal(watch.status(1).monthlyEstimatedCostUsd,0.0002);
  await assert.rejects(()=>following.load(1,loadInput(following)),error=>error.status===409&&error.message.includes('共享费用上限'));
  assert.equal(followingCalls,1);
  assert.equal(following.status(1).monthlyEstimatedCostUsd,0.0004);
});

test('shared cap accepts only plain decimal values up to USD 5.90',t=>{
  for(const value of ['',0,'-1','abc','1e3','0x10','5.901','5.91','590',Infinity]){
    const db=new DatabaseSync(':memory:');
    assert.equal(createXProviderBudget(db,{env:{OMNIHUB_SOCIALDATA_MONTH_USD:value}}).status().configured,false,String(value));db.close();
  }
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  assert.deepEqual(createXProviderBudget(db,{env:{OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'}}).status(),
    {configured:true,limitUsd:5.9,spentUsd:0,remainingUsd:5.9});
});

test('profile failures never reserve an unsent following page and readable errors settle to zero',async t=>{
  let calls=0;const {db,store}=setup(t,async()=>{calls++;return new Response('{}',{status:404});});
  await assert.rejects(()=>store.load(1,loadInput(store)),error=>error.status===502);
  assert.equal(calls,1);
  assert.deepEqual(db.prepare('SELECT service,estimated_micros,final_micros,state FROM x_provider_costs').all().map(row=>({...row})),
    [{service:'following-profile',estimated_micros:200,final_micros:0,state:'final'}]);
});

test('protected profiles charge only their profile lookup and migration stays idempotent',async t=>{
  let calls=0;const {db,store}=setup(t,async()=>{calls++;return response(user(1,'zane9588',{protected:true}));});
  await assert.rejects(()=>store.load(1,loadInput(store)),error=>error.status===409);
  assert.equal(calls,1);assert.equal(store.status(1).monthlyEstimatedCostUsd,0.0002);
  const before=db.prepare('SELECT count(*) n FROM x_provider_costs').get().n;
  createXFollowing(db,{env:{SOCIALDATA_API_KEY:'fixture',OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'}});
  assert.equal(db.prepare('SELECT count(*) n FROM x_provider_costs').get().n,before);
});

test('in-flight requests have a database lease and no overlapping paid requests',async t=>{
  let release,calls=0;const {store}=setup(t,async url=>{
    calls++;
    if(url.endsWith('/zane9588'))return new Promise(resolve=>{release=()=>resolve(response(user(1,'zane9588')));});
    return response({users:[],next_cursor:''});
  });
  const first=store.load(1,loadInput(store));
  await assert.rejects(()=>store.load(1,loadInput(store)),e=>e.status===409);
  assert.equal(calls,1);release();assert.equal((await first).complete,true);assert.equal(calls,2);
});

test('refresh failure retains cached accounts and hides upstream bodies; retries are bounded',async t=>{
  let broken=false,calls=0;const {store,advance}=setup(t,async url=>{
    calls++;if(broken)return new Response('Bearer fixture secret upstream body',{status:402});
    return response(url.endsWith('/zane9588')?user(1,'zane9588'):{users:[user(2,'alice')],next_cursor:''});
  });
  await store.load(1,loadInput(store));
  await assert.rejects(()=>store.load(1,loadInput(store,'refresh')),e=>e.status===429);assert.equal(calls,2);
  advance(600001);broken=true;
  await assert.rejects(()=>store.load(1,loadInput(store,'refresh')),e=>e.message.includes('余额不足')&&!e.message.includes('fixture'));
  assert.equal(store.status(1).users.length,1);assert.equal(store.status(1).loading,false);
  for(let i=0;i<37;i++)await assert.rejects(()=>store.load(1,loadInput(store,'refresh')));
  assert.equal(store.status(1).requestsToday,39);
  const count=calls;await assert.rejects(()=>store.load(1,loadInput(store,'refresh')),e=>e.status===429);assert.equal(calls,count);
});

test('cursor cycles stop without destroying cached users',async t=>{
  let page=0;const {store}=setup(t,async url=>response(url.endsWith('/zane9588')?user(1,'zane9588'):
    {users:[user(2,'alice')],next_cursor:['a','b','a'][page++]}));
  await store.load(1,loadInput(store));await store.load(1,loadInput(store));
  const stopped=await store.load(1,loadInput(store));
  assert.equal(stopped.pages,3);assert.equal(stopped.users.length,1);
  assert.equal(stopped.complete,false);assert.equal(stopped.limited,true);assert.equal(stopped.stopReason,'repeated_cursor');
  assert.equal(stopped.hasMore,false);
  await store.load(1,loadInput(store));assert.equal(page,3);
});

test('malformed user entries are skipped and a page is not charged repeatedly',async t=>{
  let calls=0;const {store}=setup(t,async url=>{calls++;return response(url.endsWith('/zane9588')?user(1,'zane9588'):
    {users:[user(2,'alice'),null,{id_str:'3'},user(4,'bob')],next_cursor:''});});
  const state=await store.load(1,loadInput(store));assert.equal(state.users.length,2);assert.equal(state.skipped,2);assert.equal(state.complete,true);
  await store.load(1,loadInput(store));assert.equal(calls,2);
});

test('overflowing a cache cap saves a bounded partial list instead of recharging the same page',async t=>{
  let calls=0;const {store,db}=setup(t,async url=>{calls++;return response(url.endsWith('/zane9588')?user(1,'zane9588'):
    {users:Array.from({length:200},(_,i)=>user(10000+i,`extra${i}`)),next_cursor:'more'});});
  await store.load(1,loadInput(store));
  const saved=Array.from({length:4900},(_,i)=>({id:String(i+100),handle:`person${i}`}));
  db.prepare('UPDATE x_following_cache SET users=?,next_cursor=? WHERE user_id=1').run(JSON.stringify(saved),'next');
  const state=await store.load(1,loadInput(store));assert.equal(state.users.length,5000);assert.equal(state.complete,false);assert.equal(state.limited,true);assert.equal(state.stopReason,'user_limit');
  await store.load(1,loadInput(store));assert.equal(calls,3);
});

test('batch additions are atomic, paused, idempotent and preserve existing account settings and budget',t=>{
  const {db}=setup(t,()=>{throw new Error('No external request expected');});
  const watch=createXWatch(db,{env:{OMNIHUB_X_WATCH_ENABLED:'true',SOCIALDATA_API_KEY:'fixture',OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'}});
  watch.configure(1,{handle:'alice',group:'original',intervalMinutes:60,includeReplies:true,includeReposts:true,enabled:true,dailyRequests:9,dailyBudgetUsd:1});
  const input={handles:['https://x.com/ALICE','@Bob','bob'],group:'AI',intervalMinutes:30};
  let result=watch.addAccounts(1,input);assert.equal(result.added,1);assert.equal(result.skipped,1);
  assert.equal(result.state.dailyRequests,9);assert.equal(result.state.accounts[0].enabled,true);assert.equal(result.state.accounts[0].group,'original');
  assert.equal(result.state.accounts[1].enabled,false);
  assert.equal(watch.addAccounts(1,input).added,0);
  assert.throws(()=>watch.addAccounts(2,input),e=>e.status===403);
  assert.throws(()=>watch.addAccounts(1,{...input,handles:['carol','invalid handle']}),e=>e.status===400);
  assert.throws(()=>watch.addAccounts(1,{...input,enabled:true}),e=>e.status===400);
  assert.equal(watch.status(1).accounts.length,2);
});
