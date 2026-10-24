import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');

test('native image flow: private users/devices, fenced execution, recovery and no provider submission',async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'omnihub-native-api-'));
  const socket=createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r)); const port=socket.address().port; await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),OMNIHUB_DATA_DIR:dir},stdio:'ignore'});
  let sql;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {try {ready=(await fetch(base)).ok;} catch{} if(ready)break; await new Promise(r=>setTimeout(r,30));}
    assert.ok(ready);
    sql=new DatabaseSync(path.join(dir,'app.db'));
    const json=(url,body,headers={},method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:method==='GET'?undefined:JSON.stringify(body||{})});
    async function user(name) {
      const r=await json('/api/register',{username:name,password:'test-password-private'}); assert.equal(r.status,200); return {Cookie:r.headers.get('set-cookie').split(';')[0]};
    }
    const alice=await user('alice'), bob=await user('bob');
    assert.equal((await json('/api/local-image/pair',{})).status,401);
    assert.equal((await json('/api/local-image/pair',{}, {...alice,Origin:'https://attacker.invalid'})).status,403);
    async function pair(owner,label,activate=true) {
      const result=await json('/api/local-image/pair',{label},owner); assert.equal(result.status,200);
      const {code}=await result.json();
      const response=await json('/api/local-image/exchange',{code}); assert.equal(response.status,200);
      const device=await response.json();
      assert.equal((await json('/api/local-image/exchange',{code})).status,400);
      assert.equal(sql.prepare('SELECT count(*) AS n FROM local_image_devices WHERE token_hash=?').get(device.deviceToken).n,0);
      const headers={Authorization:`Bearer ${device.deviceToken}`};
      if(activate) assert.equal((await json('/api/local-image/status',null,headers,'GET')).status,200);
      return {...device,headers};
    }
    const a=await pair(alice,'Mac A'), b=await pair(bob,'Mac B');
    const input={requestKey:'native-request-001',prompt:'A blue cup',acceptCodexUsage:true};
    const pending=await pair(alice,'Unfinished pairing',false);
    assert.equal(sql.prepare('SELECT is_default FROM local_image_devices WHERE id=?').get(a.deviceId).is_default,1);
    assert.equal((await json('/api/local-image/jobs',{...input,deviceId:pending.deviceId},alice)).status,409);
    assert.equal((await json(`/api/local-image/devices/${pending.deviceId}/default`,{},alice)).status,409);
    const bobId=sql.prepare("SELECT id FROM users WHERE username='bob'").get().id;
    const foreignPrompt=Number(sql.prepare("INSERT INTO prompts(user_id,title,text) VALUES (?,'Private','secret')").run(bobId).lastInsertRowid);
    const foreignInbox=Number(sql.prepare("INSERT INTO inbox(user_id,content) VALUES (?,'private source')").run(bobId).lastInsertRowid);
    assert.equal((await json('/api/local-image/jobs',{...input,sourceType:'prompt',sourceId:foreignPrompt},alice)).status,404);
    assert.equal((await json('/api/local-image/jobs',{...input,sourceType:'inbox',sourceId:foreignInbox},alice)).status,404);
    assert.equal((await json('/api/local-image/jobs',{...input,deviceId:b.deviceId},alice)).status,409);
    assert.equal((await json('/api/local-image/jobs',{...input,referenceAssetIds:['x']},alice)).status,400);
    assert.equal((await json('/api/local-image/jobs',{...input,provider:'claude'},alice)).status,400);
    assert.equal((await json('/api/local-image/jobs',{...input,acceptCodexUsage:false},alice)).status,400);
    const created=await json('/api/local-image/jobs',input,alice); assert.equal(created.status,201); const job=await created.json();
    assert.equal(job.status,'local_queued');assert.equal(job.remoteId,'');
    assert.equal((await (await json('/api/local-image/jobs',input,alice)).json()).id,job.id);
    assert.equal((await (await json('/api/local-image/claim',{},b.headers)).json()).task,null);
    assert.equal((await json('/api/local-image/claim',{},alice)).status,401);
    const claim=()=>json('/api/local-image/claim',{},a.headers).then(r=>r.json());
    const parallel=await Promise.all([claim(),claim()]);
    assert.equal(parallel.filter(r=>r.task).length,1); const first=parallel.find(r=>r.task).task;
    sql.prepare('UPDATE local_image_tasks SET lease_until=0 WHERE job_id=?').run(job.id);
    const current=(await claim()).task; assert.notEqual(current.leaseToken,first.leaseToken);
    const action=(type,token=current.leaseToken)=>json(`/api/local-image/tasks/${job.id}/${type}`,{leaseToken:token},a.headers);
    assert.equal((await action('start',first.leaseToken)).status,409);
    assert.equal((await action('start')).status,200);
    assert.equal((await action('start')).status,409);
    sql.prepare('UPDATE local_image_tasks SET lease_until=0 WHERE job_id=?').run(job.id);
    assert.equal((await claim()).task,null);
    assert.equal(sql.prepare('SELECT status FROM media_jobs WHERE id=?').get(job.id).status,'needs_review');
    const upload=(headers,bytes=PNG)=>fetch(`${base}/api/local-image/tasks/${job.id}/complete`,{method:'POST',headers:{...headers,'Content-Type':'image/png','x-image-lease':current.leaseToken},body:bytes});
    assert.equal((await upload(b.headers)).status,409);
    assert.equal((await upload(a.headers,Buffer.from('not image'))).status,415);
    const completed=await Promise.all([upload(a.headers),upload(a.headers)]);
    assert.deepEqual(completed.map(r=>r.status),[200,200]);
    const result=await completed[0].json(); assert.equal(result.status,'success');assert.ok(result.assetId);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM media_assets WHERE job_id=?').get(job.id).n,1);
    const assetUrl=`/api/media/assets/${result.assetId}/file`;
    assert.equal((await fetch(base+assetUrl)).status,401);
    assert.equal((await fetch(base+assetUrl,{headers:bob})).status,404);
    assert.deepEqual(Buffer.from(await (await fetch(base+assetUrl,{headers:alice})).arrayBuffer()),PNG);
    assert.equal((await (await json('/api/media/jobs',null,bob,'GET')).json()).length,0);
    assert.equal((await json('/api/local-image/devices/'+a.deviceId+'/revoke',{},bob)).status,404);
    assert.equal((await json('/api/local-image/devices/'+a.deviceId+'/revoke',{},alice)).status,200);
    assert.equal((await upload(a.headers)).status,401);
    assert.equal((await claim()).error,'设备授权已失效，请重新配对');
    const a2=await pair(alice,'Mac C');
    const a3=await pair(alice,'Mac D');
    assert.equal(sql.prepare('SELECT is_default FROM local_image_devices WHERE id=?').get(a2.deviceId).is_default,1);
    sql.prepare('UPDATE local_image_devices SET expires_at=0 WHERE id=?').run(a2.deviceId);
    const next=await (await json('/api/local-image/jobs',{...input,requestKey:'native-cancel-002'},alice)).json();
    assert.equal(sql.prepare('SELECT device_id FROM local_image_tasks WHERE job_id=?').get(next.id).device_id,a3.deviceId);
    assert.equal((await json(`/api/local-image/jobs/${next.id}/cancel`,{},alice)).status,200);
    assert.equal((await (await json('/api/local-image/claim',{},a3.headers)).json()).task,null);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM media_jobs WHERE module='codex-local' AND remote_id<>''").get().n,0);
  } finally {
    sql?.close(); child.kill('SIGTERM'); await new Promise(r=>child.exitCode!==null?r():child.once('exit',r)); await rm(dir,{recursive:true,force:true});
  }
});
