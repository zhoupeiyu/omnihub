import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContentStore } from '../lib/content-store.js';
import { createContentPipeline } from '../lib/content-pipeline.js';
import { contentScore, validateArticle } from '../lib/content-policy.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES(1,'zane'),(2,'reader');
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT DEFAULT '',
      url TEXT DEFAULT '',author TEXT DEFAULT '',content TEXT DEFAULT '',media TEXT DEFAULT '[]',links TEXT DEFAULT '[]',
      metrics TEXT DEFAULT '{}',visibility TEXT DEFAULT 'public',status TEXT DEFAULT 'pending');
    CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT,data TEXT,origin TEXT,revision INTEGER);`);
  let now = 1_800_000_000_000;
  const store = createContentStore(db, {now: () => now});
  const add = (id, {user=1, source='x', visibility='public', content='先备份原文，再按用途整理收藏。'}={}) => {
    db.prepare('INSERT INTO inbox(id,user_id,source,external_id,title,content,visibility) VALUES(?,?,?,?,?,?,?)')
      .run(id,user,source,String(id),'收藏整理步骤',content,visibility);
  };
  return {db, store, add, advance: ms => {now += ms;}};
}
function article(source) {
  return {title:'按用途整理收藏',summary:'先备份，再按用途整理。',problem:'如何整理收藏',topics:['知识管理'],
    uses:['整理收藏'],assets:['method'],scores:Object.fromEntries(['substance','novelty','evidence','relevance','actionability'].map(k=>[k,6])),
    scoreReasons:Object.fromEntries(['substance','novelty','evidence','relevance','actionability'].map(k=>[k,'原文提供了操作步骤。'])),
    promptText:'',promptCategory:'其他',sections:[{heading:'操作步骤',text:'先备份原文，再按用途整理收藏。',
      evidence:[{sourceId:source.id,quote:source.content}]}],limitations:[]};
}
function model({onCall=()=>{}, incomplete=false}={}) {
  return {identity:()=> 'fixture',async call(stage,input) {
    onCall(stage,input);
    const value = ['classify','classify_detail'].includes(stage) ? {kind:'method',assets:['method'],sufficiency:incomplete?'incomplete':'complete',confidence:.98}
      : stage==='editorial' ? article(input.sources[0])
      : stage==='verify' ? {supported:true,confidence:.99,issues:[]}
      : stage==='group' ? {groupId:null,relation:'new',confidence:.99}
      : { ...article(input.sources[0]),sections:input.sources.map(s=>({heading:'步骤',text:s.content,evidence:[{sourceId:s.id,quote:s.content}]})) };
    return {value,model:'fixture',usage:{input_tokens:10,output_tokens:20}};
  }};
}

test('personal bookmarks are scoped per owner; AIHOT public imports remain excluded', t => {
  const {db,store,add}=fixture(t);
  add(1);add(2,{source:'feed:aihot'});add(3,{user:2});add(4,{source:'feed'});
  store.seed(1);store.sync();store.sync();
  assert.equal(db.prepare('SELECT count(*) n FROM content_jobs').get().n,3);
  assert.equal(db.prepare('SELECT count(*) n FROM content_snapshots').get().n,3);
  store.setEnabled(2,true);
  assert.equal(store.localMode(2),true);
  assert.equal(store.claim(2),null);
  assert.equal(store.claim(1),null);
});

test('deleting an original erases retained material without blocking deletion or losing billing counts',async t=>{
  const {db,store,add}=fixture(t);add(1);store.seed(1);store.setEnabled(1,true);
  await createContentPipeline({store,model:model()}).run(1);
  const calls=db.prepare('SELECT count(*) n FROM content_calls').get().n;
  db.exec('DELETE FROM inbox WHERE id=1');
  assert.equal(store.resultFor(1),null);assert.deepEqual(store.knowledge(1,{publicOnly:false}),[]);
  assert.equal(db.prepare('SELECT raw_json FROM content_snapshots').get().raw_json,'{}');
  assert.equal(db.prepare('SELECT count(*) n FROM content_receipts').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM content_calls').get().n,calls);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('all constituent results must be explicitly published before a synthesis becomes public',async t=>{
  const {store,add}=fixture(t);add(1);add(2);store.seed(1);store.setEnabled(1,true);
  const base=model();const grouped={...base,async call(stage,input){
    if(stage==='group')return {value:{groupId:input.candidates[0].id,relation:'same_problem',confidence:.99}};
    return base.call(stage,input);
  }};
  await createContentPipeline({store,model:grouped,budget:{daily:30,hourly:30}}).run(1,{limit:2});
  const jobs=store.status(1).recent;
  store.publish(1,jobs[0].id);assert.equal(store.knowledge(1).some(item=>item.type==='knowledge'),false);
  store.publish(1,jobs[1].id);assert.equal(store.knowledge(1).filter(item=>item.type==='knowledge').length,1);
});

test('lease expiration retries instead of hiding an otherwise eligible source',t=>{
  const {store,add,advance}=fixture(t);add(1);store.seed(1);store.setEnabled(1,true);
  const job=store.claim(1);advance(11*60000);
  let failure;try{store.assertLive(job);}catch(error){failure=error;}
  assert.equal(failure.code,'lease_expired');store.fail(job,failure);
  assert.equal(store.status(1).recent[0].state,'retry');
});

test('ambiguous types can produce grounded draft scores without public library promotion',async t=>{
  const {store,add}=fixture(t);add(1);store.seed(1);store.setEnabled(1,true);
  const base=model();const uncertain={...base,async call(stage,input){
    if(['classify','classify_detail'].includes(stage))return {value:{kind:'method',assets:['method'],sufficiency:'complete',confidence:.7}};
    return base.call(stage,input);
  }};
  await createContentPipeline({store,model:uncertain}).run(1);
  assert.equal(store.resultFor(1,{includeReview:true}).score,60);
  assert.equal(store.status(1).recent[0].state,'review');assert.deepEqual(store.knowledge(1),[]);
});

test('changing a rules version pauses processing until the owner explicitly enables it',t=>{
  const {db,store,add}=fixture(t);add(1);store.seed(1);store.setEnabled(1,true);
  const changed=createContentStore(db,{version:'changed-rules'});changed.sync();
  assert.equal(changed.enabled(1),false);assert.equal(changed.claim(1),null);
  changed.setEnabled(1,true);assert.ok(changed.claim(1));
});

test('unsupported drafts get exactly one repair and remain review-only when still unsupported',async t=>{
  const {store,add}=fixture(t);add(1);store.seed(1);store.setEnabled(1,true);
  const base=model();let edits=0,checks=0;
  const failing={...base,async call(stage,input){
    if(stage==='editorial')edits++;
    if(stage==='verify'){checks++;return {value:{supported:false,confidence:.96,issues:['结论缺少材料支持']}};}
    return base.call(stage,input);
  }};
  await createContentPipeline({store,model:failing,budget:{daily:10,hourly:10}}).run(1);
  // An unchanged repair reuses the failed verification rather than paying twice.
  assert.equal(edits,2);assert.equal(checks,1);assert.equal(store.status(1).recent[0].state,'review');
  assert.equal(store.resultFor(1,{includeReview:true}).article.verification.supported,false);
  assert.deepEqual(store.knowledge(1),[]);
});

test('legacy local inbox foreign keys are migrated without losing job history',t=>{
  const {db,store,add}=fixture(t);add(1);store.seed(1);
  db.exec(`DROP TRIGGER content_capture_insert;DROP TRIGGER content_capture_update;DROP TRIGGER content_forget_deleted;
    PRAGMA foreign_keys=OFF;DROP INDEX content_snapshots_item;
    CREATE TABLE old_snapshots(id INTEGER PRIMARY KEY,inbox_id INTEGER NOT NULL REFERENCES inbox(id),user_id INTEGER NOT NULL REFERENCES users(id),raw_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO old_snapshots SELECT * FROM content_snapshots;DROP TABLE content_snapshots;ALTER TABLE old_snapshots RENAME TO content_snapshots;
    PRAGMA foreign_keys=ON;`);
  createContentStore(db);db.exec('DELETE FROM inbox WHERE id=1');
  assert.equal(db.prepare('SELECT count(*) n FROM content_jobs').get().n,1);
  assert.equal(db.prepare('SELECT raw_json FROM content_snapshots').get().raw_json,'{}');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('private processing requires explicit scope and never implies publication', async t => {
  const {store,add}=fixture(t);add(1,{visibility:'private'});
  store.seed(1);store.setEnabled(1,true);assert.equal(store.claim(1),null);
  store.configure(1,{includePrivate:true});store.sync();
  await createContentPipeline({store,model:model(),budget:{daily:20,hourly:20}}).run(1);
  assert.equal(store.resultFor(1)?.state,'ready');
  assert.equal(store.knowledge(1,{publicOnly:false}).length,1);
  assert.equal(store.knowledge(1,{publicOnly:true}).length,0);
  assert.throws(()=>store.publish(1,store.status(1).recent[0].id),e=>e.status===409);
});

test('ready derivatives require explicit publication; hiding a source revokes public access', async t => {
  const {db,store,add}=fixture(t);add(1);
  store.seed(1);store.setEnabled(1,true);
  await createContentPipeline({store,model:model()}).run(1);
  assert.equal(store.knowledge(1,{publicOnly:true}).length,0);
  assert.equal(store.knowledge(1,{publicOnly:false}).length,1);
  assert.equal(store.publish(1,store.status(1).recent[0].id),true);
  assert.equal(store.knowledge(1,{publicOnly:true}).length,1);
  db.prepare("UPDATE inbox SET visibility='private' WHERE id=1").run();
  assert.equal(store.knowledge(1,{publicOnly:true}).length,0);
});

test('manual classification is untouched while separate scores can be generated', async t => {
  const {db,store,add}=fixture(t);add(1);
  db.prepare("INSERT INTO library_curation VALUES(1,'source','1',?,'manual',1)").run(JSON.stringify({type:'source'}));
  const before=JSON.stringify(db.prepare('SELECT * FROM library_curation').all());
  store.seed(1);store.setEnabled(1,true);
  await createContentPipeline({store,model:model()}).run(1);
  assert.equal(store.resultFor(1)?.score,60);
  assert.equal(store.knowledge(1,{publicOnly:false}).length,0);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM library_curation').all()),before);
});

test('incremental snapshots are immutable and unchanged ingestion spends no further calls', async t => {
  const {db,store,add}=fixture(t);add(1);let calls=0;
  store.seed(1);store.setEnabled(1,true);
  const pipeline=createContentPipeline({store,model:model({onCall:()=>calls++})});
  await pipeline.run(1);const firstCalls=calls;
  db.prepare("UPDATE inbox SET content=content WHERE id=1").run();
  await pipeline.run(1);assert.equal(calls,firstCalls);
  db.prepare("UPDATE inbox SET metrics=? WHERE id=1").run(JSON.stringify({likes:9000,retweets:300}));
  await pipeline.run(1);assert.equal(calls,firstCalls);
  db.prepare("UPDATE inbox SET content='先备份原文，再按用途整理收藏。最后核对引用。' WHERE id=1").run();
  await pipeline.run(1);
  assert.ok(calls>firstCalls);
  assert.equal(db.prepare('SELECT count(*) n FROM content_snapshots').get().n,2);
  assert.equal(store.snapshot(1).content,'先备份原文，再按用途整理收藏。');
  assert.equal(store.knowledge(1,{publicOnly:false}).length,1);
});

test('incomplete material is retained for review and is never given a fake zero score', async t => {
  const {db,store,add}=fixture(t);add(1,{content:'https://example.org'});
  store.seed(1);store.setEnabled(1,true);
  await createContentPipeline({store,model:model({incomplete:true})}).run(1);
  assert.equal(store.resultFor(1,{includeReview:true}).score,null);
  assert.equal(db.prepare('SELECT count(*) n FROM inbox').get().n,1);
  assert.equal(store.status(1).counts.review,1);
});

test('sample limit pauses after the requested number of sources', async t => {
  const {store,add}=fixture(t);add(1);add(2);add(3);
  store.seed(1);store.configure(1,{sampleSize:2});store.setEnabled(1,true);
  await createContentPipeline({store,model:model(),budget:{daily:100,hourly:100}}).run(1,{limit:10});
  assert.equal(store.status(1).counts.done,2);
  assert.equal(store.enabled(1),false);
});

test('calls are budgeted and successful earlier stages are reused after retry', async t => {
  const {store,add,advance}=fixture(t);add(1);const stages=[];
  store.seed(1);store.setEnabled(1,true);
  const pipeline=createContentPipeline({store,model:model({onCall:s=>stages.push(s)}),budget:{daily:50,hourly:1}});
  await pipeline.run(1);assert.deepEqual(stages,['classify']);
  advance(3600_001);await pipeline.run(1);assert.deepEqual(stages,['classify','editorial']);
});

test('score validation, exact citations and secondary assets are enforced',()=>{
  const s={id:1,content:'先备份原文，再按用途整理收藏。'};
  const a=article(s);a.scores.evidence=11;
  assert.throws(()=>contentScore('method',a.scores,a.scoreReasons));
  a.scores.evidence=6;a.sections[0].evidence[0].quote='不存在的证据';
  assert.throws(()=>validateArticle(a,[s],{editorial:true,kind:'method'}));
});
