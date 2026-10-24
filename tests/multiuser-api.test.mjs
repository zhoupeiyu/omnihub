import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {planXImages, prepareXImages} from '../lib/x-cos-archive.js';

test('personal accounts isolate originals, media, edits, devices and derived libraries without sharing paid services', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omnihub-multiuser-api-'));
  process.env.OMNIHUB_DATA_DIR = dir;
  process.env.OMNIHUB_X_MEDIA_ARCHIVE = path.join(dir, 'archive');
  process.env.OMNIHUB_X_BOOKMARK_X_USER_ID = '99999999999999';
  const {db} = await import('../lib/db.js');
  for (const [id, name] of [[1,'zane'], [2,'alice'], [3,'bob']]) {
    db.prepare('INSERT INTO users(id,username,password_hash,salt) VALUES(?,?,?,?)').run(id,name,'fixture','fixture');
    db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(`fixture-${name}`,id);
    db.prepare("INSERT INTO inbox(id,user_id,source,external_id,title,url,content,visibility,media) VALUES(?,?,'x',?,?,?,?,?,?)")
      .run(id,id,String(id),name,`https://x.com/example/status/${id}`,`private-${name}`,id===1?'public':'private',
        JSON.stringify([{type:'photo',url:`https://pbs.twimg.com/media/fixture-${id}.png`}]));
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=','base64');
  await prepareXImages(planXImages(db.prepare('SELECT * FROM inbox').all()),process.env.OMNIHUB_X_MEDIA_ARCHIVE,
    {fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  const {handleApi} = await import('../lib/api.js');
  const {contentStore} = await import('../lib/content-runtime.js');
  const server = http.createServer(async(req,res)=>{await handleApi(req,res,new URL(req.url,'http://localhost').pathname);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, user, body, method=body?'POST':'GET', extra={})=>fetch(base+route,{method,
    headers:{...(user?{cookie:`omnihub_session=fixture-${user}`}:{ }),...(body?{'content-type':'application/json'}:{}),...extra},
    body:body?JSON.stringify(body):undefined});
  const json = async(route,user)=>(await request(route,user)).json();
  const data = {type:'prompt',title:'整理后的提示词',summary:'',body:'',promptText:'画一只猫',promptCategory:'图像生成',tags:[],relatedSourceIds:[]};
  for (const [id,user] of [[1,'zane'],[2,'alice'],[3,'bob']]) {
    const me = await json('/api/me',user);
    assert.equal(me.personalAccess,true);assert.equal(me.fullAccess,user==='zane');
    const rows = await json('/api/x-bookmarks',user);
    assert.deepEqual(rows.map(row=>row.id),[id]);
    const media = JSON.parse(rows[0].media)[0].url;
    assert.equal((await request(media,user)).status,200);
    assert.equal((await request(media,user=== 'alice'?'bob':'alice')).status,404);
    assert.equal((await request(media)).status,401);
    assert.equal((await request(`/api/library-classification/source/${id}`,user,{revision:0,data},'PUT')).status,200);
    assert.deepEqual((await json('/api/prompt-library?scope=mine',user)).map(row=>row.sourceInboxId),[id]);
    const connections = await json('/api/account/connections',user);
    assert.equal(connections.user.id,id);assert.equal(connections.chatgpt.canConnect,false);
    assert.equal(connections.chatgpt.supportsImageGeneration,false);
    const xStatus = await json('/api/account/x',user);
    assert.equal(xStatus.sync.xUserId,'');
    assert.ok(!JSON.stringify(xStatus).includes('99999999999999'));
    assert.equal((await request('/api/local-curation/settings',user)).status,200);
  }
  // Only published administrator derivatives are public, never another user's originals.
  for (const user of [undefined,'zane','alice','bob']) {
    assert.deepEqual((await json('/api/prompt-library?scope=public',user)).map(row=>row.sourceInboxId),[1]);
    const publicPrompt = (await json('/api/prompt-library?scope=public',user))[0];
    assert.equal((await request(publicPrompt.media[0].url,user)).status,200);
    assert.equal(publicPrompt.sourceContent,undefined);
  }
  for (const route of ['/api/inbox/1','/api/library-classification/source/1','/api/content-pipeline/results/1']) {
    assert.equal((await request(route,'alice')).status,404);
  }
  assert.equal((await request('/api/library-classification/source/2','alice',{revision:1,data:{...data,relatedSourceIds:[1]}},'PUT')).status,404);
  assert.equal((await request('/api/library-classification/source/2','alice',{revision:1,data},'PUT',{origin:'https://evil.example'})).status,403);
  assert.equal((await request('/api/inbox','alice',{source:'x',content:'hello'},'POST',{'content-type':'text/plain'})).status,415);
  const created = await (await request('/api/inbox','alice',{source:'x',externalId:'4',content:'new-private',userId:1,visibility:'public'})).json();
  assert.equal(db.prepare('SELECT user_id FROM inbox WHERE id=?').get(created.id).user_id,2);
  assert.notEqual(db.prepare('SELECT visibility FROM inbox WHERE id=?').get(created.id).visibility,'public');
  assert.equal(contentStore.localMode(2),true);
  assert.ok(db.prepare('SELECT 1 FROM content_local_sources WHERE user_id=2 AND inbox_id=?').get(created.id));
  const manual = await (await request('/api/inbox','alice',{source:'manual',content:'A saved note'})).json();
  assert.equal(manual.processingQueued,false);
  assert.equal((await request(`/api/inbox/${manual.id}/ignore`,'alice',{})).status,200);
  const forged = await (await request('/api/inbox','alice',{source:'x',externalId:'5',content:'guessed-image',
    media:[{type:'photo',url:'https://pbs.twimg.com/media/fixture-3.png'}]})).json();
  assert.equal(JSON.parse(forged.media)[0].url,'https://pbs.twimg.com/media/fixture-3.png');
  const bobMedia = JSON.parse((await json('/api/x-bookmarks','bob'))[0].media)[0].url;
  assert.equal((await request(bobMedia.replace('/3/',`/${forged.id}/`),'alice')).status,404);
  assert.equal((await request('/api/content-pipeline','alice',{action:'publish',jobId:1})).status,403);
  for (const route of ['/api/x-watch','/api/x-watch/following','/api/ai-config','/api/media/config'])
    assert.equal((await request(route,'alice')).status,403);
  assert.equal((await request('/api/inbox/1/analyze','alice',{})).status,403);
  const aDevice = await (await request('/api/local-curation/devices','alice',{label:'Alice device'})).json();
  const bDevice = await (await request('/api/local-curation/devices','bob',{label:'Bob device'})).json();
  const aStatus = await json('/api/local-curation/settings','alice');
  assert.equal(aStatus.devices.length,1);assert.equal(aStatus.devices[0].id,aDevice.id);
  assert.ok(!JSON.stringify(aStatus).includes(bDevice.id));
  assert.ok(!JSON.stringify(aStatus).includes(aDevice.deviceToken));
  await request(`/api/local-curation/devices/${aDevice.id}/revoke`,'bob',{});
  assert.equal(db.prepare('SELECT revoked_at FROM local_model_devices WHERE id=?').get(aDevice.id).revoked_at,0);
  for (const route of ['/api/account/connections','/api/account/x','/api/inbox','/api/local-curation/settings','/api/prompt-library?scope=mine'])
    assert.equal((await request(route)).status,401);
  assert.equal((await request('/api/prompt-library?scope=another','alice')).status,400);
  const before = db.prepare('SELECT count(*) n FROM x_account_connection_reads').get().n;
  assert.equal(before,0);
});
