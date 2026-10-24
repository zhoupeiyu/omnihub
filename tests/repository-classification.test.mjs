import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { parseReview, buildClassificationPlan, applyClassificationPlan } from '../lib/repository-classification.js';
import { REVIEW_ROWS, REVIEW_FINDINGS } from '../lib/repository-classification-review.js';
import { CLASSIFICATION_VERSION, isValidClassification } from '../public/repository-taxonomy.js';

test('every reviewed repository has explicit valid uses and forms', () => {
  const review = parseReview();
  assert.equal(review.size,597);
  for (let i=1;i<=597;i++) assert.ok(isValidClassification(review.get(i)),`row ${i}`);
  assert.deepEqual(review.get(487).uses,['design.ui']);
  assert.deepEqual(review.get(540).uses,['agent.accounts']);
  assert.ok(review.get(262).uses.includes('content.publishing'));
  assert.ok(review.get(322).uses.includes('knowledge.reading'));
  assert.ok(review.get(360).forms.includes('mcp'));
  assert.ok(review.get(429).uses.includes('video.drama'));
  assert.ok(REVIEW_FINDINGS[487].summary.includes('不是写作 Skill'));
});

test('missing, duplicate, and invalid review entries fail closed', () => {
  const lines = REVIEW_ROWS.trim().split('\n');
  assert.throws(()=>parseReview(lines.slice(1).join('\n')),/Incomplete/);
  assert.throws(()=>parseReview([...lines,lines[0]].join('\n')),/Invalid/);
  assert.throws(()=>parseReview('1|anything.other|tool',1),/Invalid/);
  assert.throws(()=>parseReview('1|agent.coding|anything',1),/Invalid/);
  assert.throws(()=>parseReview('1|agent.coding,agent.coding|tool',1),/Duplicate/);
  assert.throws(()=>buildClassificationPlan([],{rows:[]},{userId:8}),/keyset changed/);
  assert.throws(()=>buildClassificationPlan([],{rows:[]}),/Explicit user/);
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE repository_assets(id INTEGER PRIMARY KEY,user_id INTEGER,repo_key TEXT,
    description TEXT,repository_url TEXT,topics TEXT,metadata TEXT,updated_at TEXT,personal_note TEXT);
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,visibility TEXT);
    INSERT INTO inbox VALUES(1,'private');`);
  const insert=db.prepare('INSERT INTO repository_assets VALUES(?,?,?,?,?,?,?,?,?)');
  for (const [id,userId] of [[1,8],[2,8],[3,9]]) insert.run(id,userId,`owner/repo${id}`,'Original introduction','https://github.com/owner/repo','["existing"]','{"github":{"found":true}}','2026-09-01','Personal note');
  const plan=[1,2].map(id=>({id,key:`owner/repo${id}`,userId:8,
    previousMetadata:'{"github":{"found":true}}',
    reviewedSource:{description:'Original introduction',url:'https://github.com/owner/repo',topics:'["existing"]'},
    metadata:{github:{found:true},classification:{version:CLASSIFICATION_VERSION,uses:['agent.coding'],forms:['skill']}}}));
  return {db,plan};
}

test('classification updates metadata only and preserves other users and visibility', () => {
  const {db,plan}=fixture();
  try {
    const before=db.prepare('SELECT * FROM repository_assets').all();
    applyClassificationPlan(db,plan);
    const after=db.prepare('SELECT * FROM repository_assets').all();
    for(let i=0;i<3;i++) {
      const {metadata,...original}=before[i];
      const {metadata:changed,...stored}=after[i];
      assert.deepEqual(stored,original);
      if(i===2) assert.equal(changed,metadata);
      else {
        assert.equal(JSON.parse(changed).github.found,true);
        assert.ok(isValidClassification(JSON.parse(changed).classification));
      }
    }
    assert.equal(db.prepare('SELECT visibility FROM inbox').get().visibility,'private');
    const next=plan.map(item=>({...item,previousMetadata:JSON.stringify(item.metadata)}));
    applyClassificationPlan(db,next);
    assert.deepEqual(db.prepare('SELECT * FROM repository_assets').all(),after);
  } finally {db.close();}
});

test('stale sources, metadata, or user ownership roll back the whole batch', () => {
  for (const sql of ["UPDATE repository_assets SET description='Changed' WHERE id=2",
    "UPDATE repository_assets SET metadata='{}' WHERE id=2",'UPDATE repository_assets SET user_id=9 WHERE id=2']) {
    const {db,plan}=fixture();
    try {
      db.exec(sql);
      const before=db.prepare('SELECT * FROM repository_assets').all();
      assert.throws(()=>applyClassificationPlan(db,plan),/changed during review/);
      assert.deepEqual(db.prepare('SELECT * FROM repository_assets').all(),before);
    } finally {db.close();}
  }
});
