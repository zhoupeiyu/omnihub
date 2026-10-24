import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContentStore } from '../lib/content-store.js';
import { createContentPipeline } from '../lib/content-pipeline.js';
import { createLocalModelQueue } from '../lib/local-model-queue.js';

function fixture(t,budget) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES(1,'zane'),(2,'reader');
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT DEFAULT '',url TEXT DEFAULT '',author TEXT DEFAULT '',content TEXT DEFAULT '',media TEXT DEFAULT '[]',links TEXT DEFAULT '[]',metrics TEXT DEFAULT '{}',visibility TEXT DEFAULT 'private',status TEXT DEFAULT 'pending');
    CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT);`);
  let time=1_800_000_000_000;
  const store=createContentStore(db,{now:()=>time});
  const queue=createLocalModelQueue({db,store,now:()=>time,budget});
  const add=(id,userId)=>db.prepare("INSERT INTO inbox(id,user_id,source,external_id,title,content) VALUES(?,?, 'x', ?, '收藏', '保留原文后再整理。')").run(id,userId,String(id));
  return {db,store,queue,add};
}

test('a second account is local-only by default and cannot fall through to the shared remote model', async t => {
  const f=fixture(t);f.add(20,2);f.store.seed(2);f.store.setEnabled(2,true);
  assert.equal(f.store.localMode(2),true);
  let remoteCalls=0;
  const pipeline=createContentPipeline({store:f.store,model:{identity:()=> 'remote',call:async()=>{remoteCalls++;throw new Error('must not call');}}});
  await pipeline.run(2);
  assert.equal(remoteCalls,0);
  assert.equal(f.store.status(2).recent[0].state,'protected');
});

test('local devices and queued source material remain isolated by user id', async t => {
  const f=fixture(t);f.add(10,1);f.add(20,2);
  for(const userId of [1,2]) {
    f.store.seed(userId);f.store.allowLocalSources(userId,[userId===1?10:20]);
    f.queue.configure(userId,{enabled:true,model:'fixture-model'});
  }
  const first=f.queue.issueDevice(1),second=f.queue.issueDevice(2);
  const deviceOne=f.queue.authenticate(first.deviceToken),deviceTwo=f.queue.authenticate(second.deviceToken);
  const pipeline=createContentPipeline({store:f.store,model:f.queue.model});
  await pipeline.run(1);await pipeline.run(2);
  const one=f.queue.claim(deviceOne),two=f.queue.claim(deviceTwo);
  assert.ok(one,JSON.stringify(f.queue.status(1)));
  assert.ok(two,JSON.stringify(f.queue.status(2)));
  assert.equal(one.input.id,10);assert.equal(two.input.id,20);
  assert.throws(()=>f.queue.heartbeat(deviceTwo,one.id,{leaseToken:one.leaseToken,requestKey:one.requestKey}),error=>error.status===409);
  assert.equal(f.queue.status(1).devices.length,1);
  assert.equal(f.queue.status(2).devices.length,1);
});

test('one account local calls do not exhaust another account or zane remote quota, and status is user-scoped', async t => {
  const f=fixture(t,{daily:1,hourly:1});f.add(20,2);f.store.seed(2);f.store.allowLocalSources(2,[20]);
  f.queue.configure(2,{enabled:true,model:'fixture-model'});
  const device=f.queue.authenticate(f.queue.issueDevice(2).deviceToken);
  const localPipeline=createContentPipeline({store:f.store,model:f.queue.model});
  await localPipeline.run(2);assert.ok(f.queue.claim(device));

  // zane keeps the existing remote path; the other user's local call must not
  // consume its separate provider quota.
  f.add(10,1);f.store.seed(1);f.store.configure(1,{includePrivate:true,sampleSize:0});f.store.setEnabled(1,true);
  const remoteJob=f.store.claim(1);assert.ok(remoteJob);f.store.reserve(remoteJob,{daily:1,hourly:1});
  assert.equal(f.store.status(1).callsToday,1);
  assert.equal(f.store.status(2).callsToday,1);
});

test('a removed or nonexistent account cannot receive a local curation device', t => {
  const f=fixture(t);
  assert.throws(()=>f.queue.issueDevice(999),error=>error.status===403);
  const issued=f.queue.issueDevice(2);f.db.prepare('DELETE FROM users WHERE id=2').run();
  assert.throws(()=>f.queue.authenticate(issued.deviceToken),error=>error.status===401);
});
