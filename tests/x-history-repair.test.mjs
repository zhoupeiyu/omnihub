import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { historyDigest, repairHistoryRow, validateHistoryPlan, mergeHistoryMedia } from '../lib/x-history-repair.js';
import { createSourceArticleReader } from '../lib/x-source-articles.js';
import { isContentlessXBookmark } from '../lib/x-content.js';

const original={id:1,user_id:1,source:'x',external_id:'101',title:'https://t.co/example',content:'https://t.co/example',
  media:'[]',links:'[]',metrics:JSON.stringify({custom:'keep'}),ai_extract:JSON.stringify({xOmission:{reason:'no_readable_content'}}),
  ai_type:'',status:'ignored',visibility:'unreviewed'};
const source={externalId:'101',url:'https://x.com/i/status/101',author:'@author',title:'Recovered article',content:'immutable capture',links:['https://x.com/i/article/1'],media:[],
  metrics:{article:{title:'Recovered article',body:'Full article',plainText:'Full article'}},hasRecoveredContent:true};

test('recovery restores only automatic empty omissions and preserves original captures and visibility',()=>{
  const row=repairHistoryRow(original,source,'20261025');
  assert.equal(row.status,'pending'); assert.equal(row.title,'Recovered article');
  assert.equal(row.content,original.content); assert.equal(row.visibility,original.visibility);
  assert.equal(JSON.parse(row.metrics).custom,'keep');
  assert.equal(JSON.parse(row.ai_extract).xOmission,undefined);
  assert.equal(JSON.parse(row.ai_extract).xOmissionRestored.reason,'no_readable_content');
  assert.equal(isContentlessXBookmark(row),false);
  for(const ai_extract of ['{}',JSON.stringify({xOmission:{reason:'manual'}})])
    assert.equal(repairHistoryRow({...original,ai_extract},source,'20261025').status,'ignored');
  assert.equal(repairHistoryRow(original,{...source,hasRecoveredContent:false},'20261025').status,'ignored');
});

test('metadata-only, malformed or URL-only supplements do not hide missing content',()=>{
  for(const metrics of ['{}','broken',JSON.stringify({article:{title:'Only a title'}}),JSON.stringify({recoveredPost:{text:'https://t.co/a'}})])
    assert.equal(isContentlessXBookmark({...original,metrics}),true);
});

test('media enrichment merges new MP4 variants without replacing old media or archive references',()=>{
  const old={type:'video',preview_image_url:'https://pbs.twimg.com/poster.jpg',archive:{sha:'keep'},variants:[{url:'https://video.twimg.com/old.mp4'}]};
  const fresh={type:'video',preview_image_url:'https://pbs.twimg.com/poster.jpg?name=orig',variants:[{url:'https://video.twimg.com/new.mp4'}]};
  const media=mergeHistoryMedia([old],[fresh]);assert.equal(media.length,1);assert.equal(media[0].variants.length,2);
  assert.deepEqual(media[0].archive,{sha:'keep'});assert.equal(old.variants.length,1);
});

test('plans reject stale baselines, wrong owners, malformed stored data and duplicate source IDs',()=>{
  const plan={version:1,batch:'20261025',userId:1,baseline:historyDigest([original]),sources:[source]};
  assert.equal(validateHistoryPlan(plan,1,[original]).size,1);
  assert.throws(()=>validateHistoryPlan(plan,2,[original]));
  assert.throws(()=>validateHistoryPlan(plan,1,[{...original,content:'edited'}]),/baseline/);
  assert.throws(()=>validateHistoryPlan({...plan,sources:[source,source]},1,[original]));
  assert.throws(()=>repairHistoryRow({...original,metrics:'broken'},source,'20261025'));
});

test('original-article catalogue is owner-only, hides archived entries and avoids curation duplicates',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE inbox(id INTEGER,user_id INTEGER,source TEXT,external_id TEXT,author TEXT,url TEXT,updated_at TEXT,status TEXT,metrics TEXT); CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT)');
    const add=db.prepare("INSERT INTO inbox VALUES(?,?,'x',?,'@author','https://x.com/author/status/101','now',?,?)");
    for(const [id,user,status]of [[1,1,'pending'],[2,2,'pending'],[3,1,'ignored'],[4,1,'pending']])add.run(id,user,String(id),status,JSON.stringify(source.metrics));
    db.prepare("INSERT INTO library_curation VALUES(1,'source','4')").run();
    const reader=createSourceArticleReader(db);
    assert.deepEqual(reader.list(1),[]);assert.equal(reader.get(1,1),null);
    assert.deepEqual(reader.list(1,{privateAccess:true}).map(row=>row.id),['archive-1']);
    assert.equal(reader.get(1,2,{privateAccess:true}),null);assert.equal(reader.get(1,3,{privateAccess:true}),null);
    assert.equal(reader.get(1,4,{privateAccess:true}),null);assert.equal(reader.get(1,1,{privateAccess:true}).body,'Full article');
    assert.equal('body' in reader.list(1,{privateAccess:true})[0],false);
    assert.deepEqual(reader.list(1,{privateAccess:true,excludeSourceIds:[1]}),[]);
  } finally {db.close();}
});

test('a partial refresh cannot erase recovered originals or restore unreadable rows',()=>{
 const saved={...original,metrics:JSON.stringify({article:{body:'Long saved original'},custom:'keep'})};
 const refreshed=repairHistoryRow(saved,{...source,metrics:{article:{title:'Preview',body:''}}},'20261025');
 assert.equal(JSON.parse(refreshed.metrics).article.body,'Long saved original');
 const empty=repairHistoryRow(original,{...source,metrics:{article:{title:'Preview',body:''}}},'20261025');
 assert.equal(empty.status,'ignored');
 const reviewed=repairHistoryRow(original,{...source,review:{title:'New classification',type:'knowledge',topic:'software'}},'20261025');
 assert.equal(JSON.parse(reviewed.ai_extract).xReviewPrevious['20261025'].title,original.title);
 assert.throws(()=>repairHistoryRow({...original,visibility:'public'},{...source,review:{title:'New',type:'knowledge',topic:'software'}},'20261025'));
});

import {mkdtempSync,readFileSync,writeFileSync,rmSync}from'node:fs';
import {spawnSync}from'node:child_process';
import os from'node:os';import path from'node:path';
test('CLI dry run rolls back; apply backs up, inserts privately, and rejects a stale retry',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'omnihub-history-cli-')),file=path.join(dir,'app.db'),planFile=path.join(dir,'plan.json');
 const db=new DatabaseSync(file);
 try {
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES(1,'tester');
   CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT,url TEXT,author TEXT,content TEXT,
   media TEXT,links TEXT,metrics TEXT,ai_type TEXT,ai_extract TEXT,status TEXT,visibility TEXT,dispatched_to TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
   CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT,data TEXT,revision INTEGER,origin TEXT,updated_at TEXT);
   CREATE TABLE library_curation_history(user_id INTEGER,asset_type TEXT,asset_key TEXT,actor_id INTEGER,revision INTEGER,origin TEXT,before_data TEXT,after_data TEXT,created_at TEXT);`);
  const plan={version:1,batch:'20261025',username:'tester',userId:1,baseline:historyDigest([]),sources:[source]};
  writeFileSync(planFile,JSON.stringify(plan));
  const run=(name,apply=false)=>spawnSync(process.execPath,[new URL('../scripts/repair-x-history.mjs',import.meta.url).pathname,'--database',file,'--plan',planFile,'--report',path.join(dir,name+'.json'),...(apply?['--apply']:[])],{encoding:'utf8'});
  const dry=run('dry');assert.equal(dry.status,0,dry.stderr);assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n,0);
  const apply=run('apply',true);assert.equal(apply.status,0,apply.stderr);
  assert.equal(db.prepare('SELECT visibility FROM inbox').get().visibility,'private');
  const report=JSON.parse(readFileSync(path.join(dir,'apply.json'))),backup=new DatabaseSync(report.backup,{readOnly:true});
  assert.equal(backup.prepare('SELECT count(*) AS n FROM inbox').get().n,0);backup.close();
  const retry=run('retry',true);assert.notEqual(retry.status,0);assert.match(retry.stderr,/baseline changed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('subsequent recovery batches preserve earlier evidence and repeat batches fail closed',()=>{
 const first=repairHistoryRow({...original,metrics:JSON.stringify({article:{body:'old'}})},
  {...source,metrics:{article:{body:'new full text'},sourceAudit:{batch:'20261025'}}},'20261025');
 const second=repairHistoryRow(first,{...source,metrics:{article:{body:'new full text and more'},sourceAudit:{batch:'20261026'}}},'20261026');
 assert.deepEqual(JSON.parse(second.metrics).recoveryPrevious['20261025'],JSON.parse(first.metrics).recoveryPrevious['20261025']);
 assert.equal(JSON.parse(second.metrics).recoveryPrevious['20261026'].article.body,'new full text');
 assert.throws(()=>repairHistoryRow(first,source,'20261025'),/already applied/);
});
