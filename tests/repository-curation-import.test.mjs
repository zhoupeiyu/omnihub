import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CLASSIFICATION_VERSION } from '../public/repository-taxonomy.js';
import { applyRepositoryCurationImport, prepareRepositoryCurationImport } from '../lib/repository-curation-import.js';

const reviewedAt = '2026-10-25T10:47:41Z';
const originalMetadata = JSON.stringify({github:{found:true},custom:{keep:'yes'},classification:{linkStatus:'verified',sourceEvidence:['archive']}});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE);
    CREATE TABLE repository_assets(
      id INTEGER PRIMARY KEY,user_id INTEGER,repo_key TEXT,description TEXT,metadata TEXT,updated_at TEXT,
      personal_status TEXT,personal_note TEXT,source_links TEXT,UNIQUE(user_id,repo_key));
    CREATE TABLE library_curation(user_id INTEGER,asset_type TEXT,asset_key TEXT,data TEXT,revision INTEGER,origin TEXT,updated_at TEXT,
      PRIMARY KEY(user_id,asset_type,asset_key));
    INSERT INTO users VALUES(1,'zane'),(2,'other');`);
  const insert = db.prepare('INSERT INTO repository_assets VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(1,1,'owner/one','Old one',originalMetadata,'2026-10-24T10:00:00Z','to_review','private note','["https://example.test"]');
  insert.run(2,1,'owner/two','Old two',originalMetadata,'2026-10-24T10:00:00Z','saved','another note','[]');
  insert.run(3,2,'owner/other','Other',originalMetadata,'2026-10-24T10:00:00Z','to_review','other note','[]');
  return db;
}

function entry(key, description, expected = {}) {
  return { key, expected:{description:expected.description ?? (key === 'owner/one' ? 'Old one' : 'Old two'),metadata:expected.metadata ?? originalMetadata,updatedAt:expected.updatedAt ?? '2026-10-24T10:00:00Z'},
    description,classification:{version:CLASSIFICATION_VERSION,uses:['agent.coding'],forms:['skill']},
    sourceUrl:`https://github.com/${key}/blob/${'a'.repeat(40)}/README.md`,sourceRevision:'a'.repeat(40) };
}

function packet(entries = [entry('owner/one','中文新介绍一'),entry('owner/two','中文新介绍二')]) {
  return {format:'omnihub-repository-curation-v1',username:'zane',reviewedAt,entries};
}

test('curation import writes only reviewed fields and preserves unrelated repository data',t=>{
  const db=fixture();t.after(()=>db.close());
  const beforeOther=db.prepare("SELECT * FROM repository_assets WHERE repo_key='owner/other'").get();
  const plan=prepareRepositoryCurationImport(db,packet());
  const result=applyRepositoryCurationImport(db,plan);
  assert.equal(result.written,2);assert.deepEqual(result.quickCheck,['ok']);
  const row=db.prepare("SELECT * FROM repository_assets WHERE repo_key='owner/one'").get();
  const meta=JSON.parse(row.metadata);
  assert.equal(row.description,'中文新介绍一');assert.equal(row.updated_at,reviewedAt);
  assert.equal(row.personal_status,'to_review');assert.equal(row.personal_note,'private note');assert.equal(row.source_links,'["https://example.test"]');
  assert.deepEqual(meta.github,{found:true});assert.deepEqual(meta.custom,{keep:'yes'});
  assert.deepEqual(meta.classification.uses,['agent.coding']);assert.equal(meta.descriptionProvenance,'official_github');
  assert.equal(meta.classification.linkStatus,'verified');assert.deepEqual(meta.classification.sourceEvidence,['archive']);
  assert.deepEqual(db.prepare("SELECT * FROM repository_assets WHERE repo_key='owner/other'").get(),beforeOther);
});

test('stale changes roll back the entire packet',t=>{
  const db=fixture();t.after(()=>db.close());
  const plan=prepareRepositoryCurationImport(db,packet());
  db.prepare("UPDATE repository_assets SET description='Changed later' WHERE repo_key='owner/two'").run();
  assert.throws(()=>applyRepositoryCurationImport(db,plan),/changed during import/);
  assert.equal(db.prepare("SELECT description FROM repository_assets WHERE repo_key='owner/one'").get().description,'Old one');
  assert.equal(db.prepare("SELECT description FROM repository_assets WHERE repo_key='owner/two'").get().description,'Changed later');
});

test('invalid packets, duplicates, stale snapshots, and manual conflicts fail closed',t=>{
  const db=fixture();t.after(()=>db.close());
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([entry('owner/one','中文新介绍一'),entry('owner/one','中文新介绍二')])),/Duplicate/);
  const invalid=entry('owner/one','中文新介绍一');invalid.classification.uses=['unknown.topic'];
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([invalid])),/Invalid classification/);
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([entry('owner/one','中文新介绍一',{updatedAt:'stale'})])),/Reviewed repository changed/);
  db.prepare("INSERT INTO library_curation VALUES(1,'repository','owner/one','{\"uses\":[\"video.editing\"],\"forms\":[\"app\"]}',1,'manual',?)").run(reviewedAt);
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([entry('owner/one','中文新介绍一')])),/Manual classification/);
});

test('source URL accepts canonical GitHub case but rejects credentials and non-default ports',t=>{
  const db=fixture();t.after(()=>db.close());
  const uppercase=entry('owner/one','中文新介绍一');
  uppercase.sourceUrl=`https://github.com/OWNER/ONE/blob/${'a'.repeat(40)}/README.md`;
  assert.equal(prepareRepositoryCurationImport(db,packet([uppercase])).plans.length,1);
  const credentials=entry('owner/one','中文新介绍一');credentials.sourceUrl=`https://user:secret@github.com/owner/one/blob/${'a'.repeat(40)}/README.md`;
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([credentials])),/Official GitHub source is invalid/);
  const port=entry('owner/one','中文新介绍一');port.sourceUrl=`https://github.com:8443/owner/one/blob/${'a'.repeat(40)}/README.md`;
  assert.throws(()=>prepareRepositoryCurationImport(db,packet([port])),/Official GitHub source is invalid/);
});
