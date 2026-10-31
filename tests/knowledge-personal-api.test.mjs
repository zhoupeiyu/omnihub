import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('knowledge saves and reading history are private, authenticated and visibility checked', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'omnihub-knowledge-personal-'));
  process.env.OMNIHUB_DATA_DIR = dataDir;
  process.env.OMNIHUB_CONTENT_WORKER = 'false';
  process.env.OMNIHUB_X_BOOKMARK_SYNC = 'false';
  process.env.OMNIHUB_X_WATCH_ENABLED = 'false';
  const {db} = await import('../lib/db.js');
  const {handleApi} = await import('../lib/api.js');
  db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(1,'zane','fixture','fixture'),(2,'alice','fixture','fixture'),(3,'bob','fixture','fixture')").run();
  db.prepare("INSERT INTO sessions(token,user_id) VALUES('alice-test',2),('bob-test',3),('owner-test',1)").run();
  db.prepare("INSERT INTO inbox(id,user_id,source,external_id,title,content,visibility) VALUES(101,1,'x','101','Source','Evidence','public')").run();
  const id = Number(db.prepare("INSERT INTO knowledge(user_id,title,summary,body,status,subject_id,verification_status) VALUES(1,'Skill guide','Useful guide','## Usage\nInstructions','ready','skill-test','verified')").run().lastInsertRowid);
  db.prepare('INSERT INTO knowledge_sources(knowledge_id,inbox_id,external_id,citation_key) VALUES(?,101,\'101\',\'S:101\')').run(id);
  const server = http.createServer((req,res) => handleApi(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dataDir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, user, body, headers={}) => fetch(base+route, {method:body ? 'PUT':'GET',
    headers:{...(user ? {cookie:`omnihub_session=${user}-test`}:{}),...(body ? {'content-type':'application/json'}:{}),...headers},
    body:body ? JSON.stringify(body):undefined});
  const route = `/api/knowledge-library/${id}/personal?scope=public`;
  const list = '/api/knowledge-library/personal?scope=public';
  assert.equal((await request(list)).status,401);
  assert.equal((await request(route,null,{saved:true})).status,401);
  assert.equal((await request(route,'alice',{saved:true},{origin:'https://evil.example'})).status,403);
  assert.equal((await request(route,'alice',{saved:'true'})).status,400);
  assert.equal((await request(route,'alice',{userId:3,saved:true})).status,400);
  assert.equal((await request('/api/knowledge-library/999999/personal','alice',{saved:true})).status,404);
  const savedResponse = await request(route,'alice',{saved:true});
  assert.equal(savedResponse.status,200);
  assert.equal(savedResponse.headers.get('cache-control'),'no-store');
  const saved = await savedResponse.json();
  assert.equal(saved.id,String(id)); assert.ok(saved.savedAt); assert.equal(saved.readAt,null);
  const repeated = await (await request(route,'alice',{saved:true})).json();
  assert.equal(repeated.savedAt,saved.savedAt);
  assert.deepEqual(await (await request(list,'bob')).json(),[]);
  assert.deepEqual(await (await request('/api/knowledge-library/personal?scope=mine','alice')).json(),[]);
  const read = await (await request(route,'alice',{read:true})).json();
  assert.ok(read.readAt); assert.equal(read.savedAt,saved.savedAt);
  const unsaved = await (await request(route,'alice',{saved:false})).json();
  assert.equal(unsaved.savedAt,null); assert.equal(unsaved.readAt,read.readAt);
  await request(route,'alice',{saved:true});
  assert.equal((await (await request(list,'alice')).json()).length,1);
  const publicRows = await (await request('/api/knowledge-library?scope=public')).json();
  assert.ok(publicRows.length); assert.equal(JSON.stringify(publicRows).includes('savedAt'),false);
  // A title hit must survive the 200-result cap even when many body hits precede it.
  for (let index=0; index<205; index++) {
    const articleId = db.prepare("INSERT INTO knowledge(user_id,title,body,status,subject_id,verification_status) VALUES(1,?,'relevance-boundary','ready',?,'verified')")
      .run(index===204 ? 'relevance-boundary' : `Earlier body hit ${index}`,`rank-${index}`).lastInsertRowid;
    db.prepare("INSERT INTO knowledge_sources(knowledge_id,inbox_id,external_id,citation_key) VALUES(?,101,'101','S:101')").run(articleId);
  }
  const search = await (await request('/api/knowledge-library/search?scope=public&q=relevance-boundary')).json();
  assert.equal(search.total,205); assert.equal(search.results.length,200); assert.equal(search.truncated,true);
  assert.equal(search.results[0].score,100);
  db.prepare("UPDATE inbox SET visibility='private' WHERE id=101").run();
  assert.deepEqual(await (await request(list,'alice')).json(),[]);
  assert.equal((await request(route,'alice',{saved:true})).status,404);
  assert.equal((await request(`/api/knowledge-library/${id}/personal?scope=mine`,'owner',{saved:true})).status,200);
  assert.deepEqual(await (await request(list,'bob')).json(),[]);
});
