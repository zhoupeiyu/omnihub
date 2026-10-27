import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAiConnectionStore, normalizeAiUrl } from '../lib/ai-connections.js';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    CREATE TABLE ai_config(user_id INTEGER PRIMARY KEY,base_url TEXT,api_key TEXT,model TEXT);`);
  return {db,store:createAiConnectionStore(db)};
}
const input={name:'我的 GPT',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'secret-fixture',model:'fixture-model'};

test('connections are multiple, owner scoped, and never return credentials',t=>{
  const {store}=fixture(t),a=store.save(1,input),b=store.save(1,{...input,name:'第二账号'}),c=store.save(2,input);
  assert.equal(store.list(1).length,2);assert.equal(store.list(2).length,1);
  assert.equal(store.get(2,a.id),undefined);
  assert.ok(!JSON.stringify(store.list(1)).includes('secret-fixture'));
  assert.throws(()=>store.save(2,{...input,revision:a.revision},a.id),{status:404});
  assert.throws(()=>store.remove(2,a.id),{status:404});
  assert.throws(()=>store.assign(2,'chat',a.id),{status:404});
  assert.notEqual(b.id,c.id);
});
test('tests gate assignments, edits invalidate evidence, and stale probes cannot bless changed credentials',t=>{
  const {store}=fixture(t),a=store.save(1,input);
  assert.throws(()=>store.assign(1,'chat',a.id),{status:400});
  store.recordTest(1,a.id,a.revision,{state:'ready',message:'ok',latencyMs:20});store.assign(1,'chat',a.id);store.assign(1,'curation',a.id);
  assert.equal(store.selected(1).id,a.id);
  assert.throws(()=>store.remove(1,a.id),{status:409});
  const renamed=store.save(1,{...a,name:'新名字',apiKey:''},a.id);assert.equal(renamed.testState,'ready');
  const changed=store.save(1,{...renamed,model:'other',apiKey:''},a.id);assert.equal(changed.testState,'untested');
  assert.throws(()=>store.recordTest(1,a.id,a.revision,{state:'ready',message:'ok',latencyMs:20}),{status:409});
  assert.throws(()=>store.save(1,{...changed,baseUrl:'https://other.example/v1',apiKey:''},a.id),{status:400});
  store.assign(1,'chat','');store.assign(1,'curation','');store.remove(1,a.id);assert.equal(store.list(1).length,0);
});
test('legacy migration is one-time and does not restore an unassigned route on restart',t=>{
  const {db}=fixture(t);db.prepare("DELETE FROM schema_migrations WHERE name='ai-multiple-connections-v1'").run();
  db.prepare('INSERT INTO ai_config VALUES(?,?,?,?)').run(1,input.baseUrl,input.apiKey,input.model);
  const store=createAiConnectionStore(db);assert.equal(store.list(1).length,1);assert.equal(store.selected(1).api_key,input.apiKey);
  store.assign(1,'chat','');assert.equal(createAiConnectionStore(db).selected(1),undefined);
  store.remove(1,'legacy-1');assert.equal(createAiConnectionStore(db).list(1).length,0);
});
test('URLs forbid credentials, insecure transport and internal literals',()=>{
  for(const url of ['http://api.openai.com/v1','https://user:secret@api.openai.com/v1','https://api.openai.com/v1?key=x','https://127.0.0.1/v1','https://[::1]/v1','https://service.internal/v1','https://api.openai.com:9000/v1'])assert.throws(()=>normalizeAiUrl(url));
  assert.equal(normalizeAiUrl('https://api.openai.com/v1/responses'),'https://api.openai.com/v1');
});
