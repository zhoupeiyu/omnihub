import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {planXImages, prepareXImages} from '../lib/x-cos-archive.js';

test('curated and pipeline previews track publication changes without stale authorization', async t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'omnihub-prompt-access-'));
  process.env.OMNIHUB_DATA_DIR=dir;
  process.env.OMNIHUB_X_MEDIA_ARCHIVE=path.join(dir,'archive');
  const {db}=await import('../lib/db.js');
  db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(1,'zane','fixture','fixture')").run();
  db.prepare("INSERT INTO sessions(token,user_id) VALUES('fixture-owner',1)").run();
  for(const id of [1,2,3])db.prepare("INSERT INTO inbox(id,user_id,source,external_id,title,url,content,visibility,media) VALUES(?,1,'x',?,'提示词素材',?,'原始收藏正文','public',?)")
    .run(id,String(id),`https://x.com/fixture/status/${id}`,JSON.stringify([{type:'photo',url:`https://pbs.twimg.com/media/fixture-${id}.png`}]));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=','base64');
  await prepareXImages(planXImages(db.prepare('SELECT * FROM inbox').all()),process.env.OMNIHUB_X_MEDIA_ARCHIVE,
    {fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  const {handleApi}=await import('../lib/api.js');
  const {contentStore}=await import('../lib/content-runtime.js');
  contentStore.seed(1);
  const snapshot=contentStore.latest(2);
  db.prepare('INSERT INTO content_results VALUES(?,?,?,?,?,?,?,?)').run(snapshot.snapshotId,contentStore.version,'prompt',80,'ready',
    JSON.stringify({kind:'prompt',assets:['prompt']}),JSON.stringify({title:'生成图片',summary:'流水线提示词',promptText:'画一只猫',promptCategory:'图像生成',topics:[],sections:[],limitations:[]}),Date.now());
  const job=db.prepare('SELECT id FROM content_jobs WHERE snapshot_id=? AND version=?').get(snapshot.snapshotId,contentStore.version);
  contentStore.publish(1,job.id);
  const server=http.createServer(async(req,res)=>{if(!await handleApi(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(route,options={})=>fetch(base+route,options);
  const data={type:'prompt',title:'整理后的画图提示词',summary:'',body:'',promptText:'画一只猫',promptCategory:'图像生成',tags:[],relatedSourceIds:[]};
  const curate=(revision,next)=>request('/api/library-classification/source/1',{method:'PUT',headers:{'content-type':'application/json',cookie:'omnihub_session=fixture-owner'},body:JSON.stringify({revision,data:next})});
  assert.equal((await curate(0,data)).status,200);
  const prompts=await(await request('/api/prompt-library')).json();assert.equal(prompts.length,2);
  const curated=prompts.find(p=>p.curated),pipeline=prompts.find(p=>p.pipeline);assert.ok(curated);assert.ok(pipeline);
  const paths=[curated.media[0].url,pipeline.media[0].url];
  const etags=[];
  for(const p of paths){const r=await request(p);assert.equal(r.status,200);etags.push(r.headers.get('etag'));await r.arrayBuffer();assert.equal((await request(p,{method:'HEAD'})).status,200);}
  assert.equal((await request(paths[0],{headers:{'If-None-Match':etags[0]}})).status,304);
  assert.equal((await request('/api/x-bookmarks')).status,401);
  assert.equal((await curate(1,{...data,type:'source'})).status,200);
  assert.equal((await request(paths[0],{headers:{'If-None-Match':etags[0]}})).status,401);
  assert.equal((await curate(2,data)).status,200);
  assert.equal((await request(paths[0])).status,200);
  assert.equal((await curate(3,{...data,relatedSourceIds:[3]})).status,200);
  assert.equal((await request(paths[0])).status,200);
  // An external connection must invalidate the cache too (PRAGMA data_version).
  const other=new DatabaseSync(path.join(dir,'app.db'));
  other.prepare("UPDATE inbox SET visibility='private' WHERE id=3").run();other.close();
  assert.equal((await request(paths[0],{headers:{'If-None-Match':etags[0]}})).status,401);
  db.prepare("UPDATE inbox SET visibility='public' WHERE id=3").run();
  assert.equal((await request(paths[0])).status,200);
  db.prepare("UPDATE inbox SET status='ignored' WHERE id=1").run();
  assert.equal((await request(paths[0],{method:'HEAD',headers:{'If-None-Match':etags[0]}})).status,401);
  db.prepare('DELETE FROM content_publications WHERE user_id=1').run();
  assert.equal((await request(paths[1],{headers:{'If-None-Match':etags[1]}})).status,401);
  contentStore.publish(1,job.id);
  assert.equal((await request(paths[1])).status,200);
  db.prepare("UPDATE inbox SET status='ignored' WHERE id=2").run();
  assert.equal((await request(paths[1],{headers:{'If-None-Match':etags[1]}})).status,401);
});
