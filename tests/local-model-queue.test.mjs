import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContentStore } from '../lib/content-store.js';
import { createContentPipeline } from '../lib/content-pipeline.js';
import { createLocalModelQueue } from '../lib/local-model-queue.js';

function fixture(t,budget={daily:40,hourly:12}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);INSERT INTO users VALUES(1,'zane'),(2,'reader');
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT DEFAULT '',url TEXT DEFAULT '',
      author TEXT DEFAULT '',content TEXT DEFAULT '',media TEXT DEFAULT '[]',links TEXT DEFAULT '[]',metrics TEXT DEFAULT '{}',
      visibility TEXT DEFAULT 'private',status TEXT DEFAULT 'pending');
    CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT);`);
  let time=1_800_000_000_000;
  const store=createContentStore(db,{now:()=>time}),queue=createLocalModelQueue({db,store,now:()=>time,budget});
  const pipeline=createContentPipeline({store,model:queue.model});
  const add=id=>db.prepare('INSERT INTO inbox(id,user_id,source,external_id,title,content) VALUES(?,1,\'x\',?,\'收藏整理\',\'先保存原文，再根据用途整理收藏。\')').run(id,String(id));
  const connect=()=>{const pairing=queue.issueDevice(1);return {...pairing,device:queue.authenticate(pairing.deviceToken)};};
  const enable=()=>queue.configure(1,{enabled:true,model:'fixture-model'});
  const allow=(id=1)=>{add(id);store.allowLocalSources(1,[id]);};
  return {db,store,queue,pipeline,add,connect,enable,allow,advance:ms=>{time+=ms;}};
}
const classify={kind:'method',assets:['method'],confidence:.99,sufficiency:'complete',reason:'有完整整理步骤'};
const answer=(task,value)=>({requestKey:task.requestKey,leaseToken:task.leaseToken,model:'fixture-model',value});
const editorial=task=>({title:'保存原文并按用途整理收藏',summary:'先保留原始内容，再按用途归类。',problem:'如何整理收藏',topics:['收藏整理'],uses:['管理收藏'],
  scores:Object.fromEntries(['substance','novelty','evidence','relevance','actionability'].map(k=>[k,7])),
  scoreReasons:Object.fromEntries(['substance','novelty','evidence','relevance','actionability'].map(k=>[k,'原文列出了操作步骤'])),
  promptText:'',promptCategory:'其他',sections:[{heading:'操作方法',text:'先保存原文，再按用途整理。',evidence:[{sourceId:task.input.sources[0].id,quote:task.input.sources[0].content}]}],limitations:[]});

test('offline waiting is durable, new-only and does not consume calls or exhaust attempts',async t=>{
  const f=fixture(t);f.add(99);f.allow();f.enable();
  for(let i=0;i<12;i++)await f.pipeline.run(1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM local_model_tasks').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM content_calls').get().n,0);
  assert.equal(f.db.prepare('SELECT attempts FROM content_jobs').get().attempts,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM content_jobs').get().n,1);
  assert.equal(f.store.resultFor(99),null);
});

test('classification, editing, verification and grouping reuse existing pipeline and remain private',async t=>{
  const f=fixture(t);f.allow();f.enable();const {device}=f.connect();
  await f.pipeline.run(1);
  for(const stage of ['classify','editorial','verify']) {
    const task=f.queue.claim(device);assert.equal(task.stage,stage);
    assert.equal(f.queue.claim(device),null);
    const value=stage==='classify'?classify:stage==='editorial'?editorial(task):{supported:true,confidence:.99,issues:[]};
    const body=answer(task,value);
    f.queue.complete(device,task.id,body);
    await f.pipeline.run(1);
    assert.equal(f.queue.complete(device,task.id,body).replayed,true);
  }
  assert.equal(f.store.status(1).recent[0].state,'done');
  assert.equal(f.store.resultFor(1).kind,'method');
  assert.equal(f.store.knowledge(1,{publicOnly:false}).length,1);
  assert.equal(f.store.knowledge(1).length,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM content_calls').get().n,3);
  assert.equal(f.db.prepare('SELECT content,visibility FROM inbox WHERE id=1').get().visibility,'private');
});

test('device tokens are scoped, hashed, expiring and revocable; leases serialize workers',async t=>{
  const f=fixture(t);f.allow();f.enable();const a=f.connect(),b=f.connect();await f.pipeline.run(1);
  assert(!f.db.prepare('SELECT token_hash FROM local_model_devices').get().token_hash.includes(a.deviceToken));
  assert.ok(f.queue.issueDevice(2).deviceToken);
  assert.throws(()=>f.queue.authenticate('wrong'),e=>e.status===401);
  const task=f.queue.claim(a.device);assert.equal(f.queue.claim(b.device),null);
  assert.throws(()=>f.queue.complete(b.device,task.id,answer(task,classify)),e=>e.status===409);
  f.queue.revoke(1,a.id);assert.throws(()=>f.queue.authenticate(a.deviceToken),e=>e.status===401);
  const next=f.queue.claim(b.device);assert.equal(next.id,task.id);assert.notEqual(next.leaseToken,task.leaseToken);
  f.advance(91*86400_000);assert.throws(()=>f.queue.authenticate(b.deviceToken),e=>e.status===401);
});

test('changed, deleted and manually curated sources reject late model completion',async t=>{
  for(const change of ['edit','manual','delete','pause']) {
    const f=fixture(t);f.allow();f.enable();const {device}=f.connect();await f.pipeline.run(1);const task=f.queue.claim(device);
    if(change==='edit')f.db.exec("UPDATE inbox SET content='新的原文内容' WHERE id=1");
    if(change==='manual')f.db.exec("INSERT INTO library_curation VALUES(1,'source','1')");
    if(change==='delete')f.db.exec('DELETE FROM inbox WHERE id=1');
    if(change==='pause')f.queue.configure(1,{enabled:false,model:'fixture-model'});
    assert.throws(()=>f.queue.complete(device,task.id,answer(task,classify)),e=>e.status===409,change);
    assert.equal(f.store.resultFor(1),null);
    if(change==='delete')assert.equal(f.db.prepare('SELECT input_json FROM local_model_tasks').get().input_json,'{}');
  }
});

test('budgets count actual leased stages and schema-invalid responses never enter receipts',async t=>{
  const f=fixture(t,{daily:1,hourly:1});f.allow();f.enable();const {device}=f.connect();await f.pipeline.run(1);
  const task=f.queue.claim(device);
  assert.throws(()=>f.queue.complete(device,task.id,answer(task,{kind:'made_up'})),e=>e.status===400);
  f.queue.complete(device,task.id,answer(task,classify));await f.pipeline.run(1);
  assert.equal(f.queue.claim(device),null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM content_receipts').get().n,1);
});

test('lease expiration, completion replay conflicts and fail replay are bounded',async t=>{
  const f=fixture(t);f.allow();f.enable();const {device}=f.connect();await f.pipeline.run(1);
  const first=f.queue.claim(device);f.advance(11*60_000);
  assert.throws(()=>f.queue.heartbeat(device,first.id,answer(first,classify)),e=>e.status===409);
  const second=f.queue.claim(device);assert.notEqual(first.leaseToken,second.leaseToken);
  f.queue.fail(device,second.id,{...answer(second,classify),code:'upstream'});
  assert.equal(f.queue.fail(device,second.id,{...answer(second,classify),code:'upstream'}).replayed,true);
  f.advance(6*60_000);const third=f.queue.claim(device);f.queue.complete(device,third.id,answer(third,classify));
  assert.throws(()=>f.queue.complete(device,third.id,answer(third,{...classify,confidence:.9})),e=>e.code==='idempotency_conflict');
});

test('pausing invalidates an active lease and resuming reuses the waiting task',async t=>{
  const f=fixture(t);f.allow();f.enable();const {device}=f.connect();await f.pipeline.run(1);
  const first=f.queue.claim(device);f.queue.configure(1,{enabled:false,model:'fixture-model'});
  assert.equal(f.queue.claim(device),null);
  f.enable();await f.pipeline.run(1);
  const second=f.queue.claim(device);assert.equal(second.id,first.id);assert.notEqual(second.leaseToken,first.leaseToken);
  assert.throws(()=>f.queue.complete(device,first.id,answer(first,classify)),e=>e.status===409);
});

test('marking a private source alone never authorizes remote model processing',async t=>{
  const f=fixture(t);f.allow();f.store.setEnabled(1,true);
  let calls=0;const remote={identity:()=> 'remote-fixture',call:async()=>{calls++;throw new Error('must not call');}};
  await createContentPipeline({store:f.store,model:remote}).run(1);
  assert.equal(calls,0);assert.equal(f.store.localMode(1),false);
});

test('a local device loses access if it is reassigned or its account identity changes', async t=>{
  const f=fixture(t);f.allow();f.enable();const {device,deviceToken}=f.connect();
  await f.pipeline.run(1);
  f.db.prepare('UPDATE local_model_devices SET user_id=2 WHERE id=?').run(device.id);
  assert.throws(()=>f.queue.authenticate(deviceToken),e=>e.status===401);
  assert.throws(()=>f.queue.claim({...device,userId:2}),e=>e.status===401);
  f.db.prepare('UPDATE local_model_devices SET user_id=1 WHERE id=?').run(device.id);
  f.db.prepare("UPDATE users SET username='former-owner' WHERE id=1").run();
  assert.throws(()=>f.queue.authenticate(deviceToken),e=>e.status===401);
  assert.throws(()=>f.queue.claim(device),e=>e.status===401);
});

test('switching models back recreates stale work; explicit retry releases exhausted tasks',async t=>{
  const f=fixture(t);f.allow();f.enable();const {device}=f.connect();await f.pipeline.run(1);
  const original=f.queue.claim(device);
  f.queue.configure(1,{enabled:true,model:'another-model'});
  f.enable();await f.pipeline.run(1);
  const replacement=f.queue.claim(device);assert.notEqual(original.id,replacement.id);
  f.db.prepare("UPDATE local_model_tasks SET state='failed' WHERE id=?").run(replacement.id);
  const jobId=f.db.prepare('SELECT job_id FROM local_model_tasks WHERE id=?').get(replacement.id).job_id;
  assert.equal(f.store.retry(1,jobId),true);
  await f.pipeline.run(1);
  const retry=f.queue.claim(device);assert.notEqual(retry.id,replacement.id);
  assert.equal(retry.stage,'classify');
});
