import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {exportRepositoryRelease,validateRepositoryRelease,importRepositoryRelease} from '../lib/repository-release.js';
import {CLASSIFICATION_VERSION} from '../public/repository-taxonomy.js';

function fixture(userId, sourceId, {withRepo=false,archived=false}={}) {
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE);
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT,url TEXT,author TEXT,content TEXT,media TEXT,links TEXT,metrics TEXT,ai_type TEXT,ai_confidence REAL,ai_summary TEXT,ai_extract TEXT,status TEXT,dispatched_to TEXT,created_at TEXT,updated_at TEXT,visibility TEXT);
    CREATE TABLE repository_assets(id INTEGER PRIMARY KEY,user_id INTEGER,repo_key TEXT,owner TEXT,name TEXT,repository_url TEXT,description TEXT,topics TEXT,personal_status TEXT,personal_note TEXT,source_post_count INTEGER,target_link_count INTEGER,metadata TEXT,created_at TEXT,updated_at TEXT,UNIQUE(user_id,repo_key));
    CREATE TABLE repository_sources(repository_id INTEGER REFERENCES repository_assets(id),inbox_id INTEGER REFERENCES inbox(id),external_id TEXT,PRIMARY KEY(repository_id,inbox_id));
    CREATE TABLE repository_links(repository_id INTEGER REFERENCES repository_assets(id),url TEXT,kind TEXT,PRIMARY KEY(repository_id,url));`);
  db.prepare('INSERT INTO users VALUES(?,?)').run(userId,'zane');
  db.prepare(`INSERT INTO inbox VALUES(?,?,'x','100','Source','https://x.com/a/status/100','@a','Original content','[]','[]','{}','resource',1,'','{}',?,'','2026-09-01','2026-09-01',?)`).run(sourceId,userId,archived?'ignored':'pending',archived?'unreviewed':'public');
  if(withRepo) {
    db.prepare(`INSERT INTO repository_assets VALUES(1,?,'owner/tool','owner','tool','https://github.com/owner/tool','Original description','[]','to_review','Private note',1,1,?,'2026-09-01','2026-09-01')`).run(userId,JSON.stringify({classification:{version:CLASSIFICATION_VERSION,uses:['agent.coding'],forms:['tool']}}));
    db.prepare('INSERT INTO repository_sources VALUES(1,?,?)').run(sourceId,'100');
    db.exec("INSERT INTO repository_links VALUES(1,'https://github.com/owner/tool','repository')");
  }
  return db;
}

test('release maps owner and source IDs while preserving original inbox rows',()=>{
  const local=fixture(8,1000,{withRepo:true}),target=fixture(3,77);
  try {
    const packet=exportRepositoryRelease(local,'zane');
    const before=target.prepare('SELECT * FROM inbox').all();
    assert.equal(validateRepositoryRelease(target,packet).userId,3);
    const result=importRepositoryRelease(target,packet);
    assert.equal(result.repositories,1);assert.equal(result.publicRepositories,1);
    assert.equal(target.prepare('SELECT user_id FROM repository_assets').get().user_id,3);
    assert.equal(target.prepare('SELECT inbox_id FROM repository_sources').get().inbox_id,77);
    assert.deepEqual(target.prepare('SELECT * FROM inbox').all(),before);
    assert.throws(()=>importRepositoryRelease(target,packet),/already has/);
    assert.equal(target.prepare('SELECT count(*) AS n FROM repository_assets').get().n,1);
  } finally {local.close();target.close();}
});

test('missing public sources and changed visibility abort without writes',()=>{
  for(const change of ["DELETE FROM inbox","UPDATE inbox SET visibility='private'","UPDATE inbox SET content='Edited online'"]) {
    const local=fixture(8,1000,{withRepo:true}),target=fixture(3,77);
    try {
      const packet=exportRepositoryRelease(local,'zane');target.exec(change);
      const before=target.prepare('SELECT * FROM inbox').all();
      assert.throws(()=>importRepositoryRelease(target,packet),/Missing source|Source changed/);
      assert.deepEqual(target.prepare('SELECT * FROM inbox').all(),before);
      assert.equal(target.prepare('SELECT count(*) AS n FROM repository_assets').get().n,0);
    } finally {local.close();target.close();}
  }
});

test('only missing unreviewed ignored sources can be restored, still hidden',()=>{
  const local=fixture(8,1000,{withRepo:true,archived:true}),target=fixture(3,77);
  try {
    target.exec('DELETE FROM inbox');
    const result=importRepositoryRelease(target,exportRepositoryRelease(local,'zane'));
    assert.equal(result.archivedSourcesAdded,1);assert.equal(result.publicRepositories,0);
    assert.deepEqual({...target.prepare('SELECT user_id,status,visibility FROM inbox').get()},{user_id:3,status:'ignored',visibility:'unreviewed'});
  } finally {local.close();target.close();}
});
