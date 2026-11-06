import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalCephalonJson, createCephalonClient, createCephalonStore, normalizeCephalonMission, signCephalonRequest } from '../lib/cephalon.js';
import { createCephalonHandler } from '../lib/cephalon-handler.js';

const credentials = { key:'a'.repeat(32), secret:'b'.repeat(64) };

test('Cephalon request canonicalization is stable and follows Go HTML escaping', () => {
  assert.equal(canonicalCephalonJson({ z:'<&>', a:{ b:2, a:1 } }), '{"a":{"a":1,"b":2},"z":"\\u003c\\u0026\\u003e"}');
  assert.equal(signCephalonRequest('/cephalon/a', credentials.secret, { z:1, a:2 }), signCephalonRequest('/cephalon/a', credentials.secret, { a:2, z:1 }));
  assert.notEqual(signCephalonRequest('/cephalon/a', credentials.secret, {}), signCephalonRequest('/cephalon/a', credentials.secret, { a:1 }));
  assert.throws(() => signCephalonRequest('https://bad.example', credentials.secret, {}), /路径/);
});

test('Cephalon client only prepares bounded paid requests and reports no-live state', () => {
  const client=createCephalonClient();
  const prepared=client.prepareMission({ type:'comfyui_advance_time', gpuVersion:'RTX4090', gpuNum:1, batchSize:1 }, credentials);
  assert.equal(prepared.url, 'https://prod.unicorn.org.cn/cephalon/user-center/v1/user/missions/batch');
  assert.equal(prepared.body.gpu_version,'RTX4090');
  assert.match(prepared.headers.Hmac,/^[0-9a-f]{64}$/);
  assert.equal(client.dryRunProbe(credentials).readyForPaidMission,false);
  assert.throws(() => normalizeCephalonMission({ type:'ssh',gpuVersion:'RTX4090',gpuNum:1 }),/暂未开放/);
  assert.throws(() => client.prepareMission({ type:'comfyui_time',gpuVersion:'A100',gpuNum:1 },credentials),/显卡/);
  assert.throws(() => client.dryRunProbe({ ...credentials, key:'x' }),/格式/);
});

const jsonResponse = (payload, { status=200, contentLength } = {}) => {
  const bytes=new TextEncoder().encode(JSON.stringify(payload));
  let sent=false;
  return {
    ok:status >= 200 && status < 300,
    status,
    headers:{ get:name=>name.toLowerCase() === 'content-length' ? String(contentLength ?? bytes.byteLength) : null },
    body:{ getReader:()=>({ read:async()=>sent ? {done:true} : (sent=true,{done:false,value:bytes}), releaseLock() {} }) },
  };
};

test('Cephalon connection test uses a bounded read-only Bearer model-list probe', async () => {
  const requests=[];
  const client=createCephalonClient({ fetchImpl:async (url, init) => {
    requests.push({url,init});
    return jsonResponse({ object:'list', data:[{id:'a'},{id:'b'}] });
  }});
  assert.deepEqual(await client.connectionTest({ serviceKey:'service-token' }),{connected:true,models:2});
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://cephalon.cloud/user-center/v1/model/models');
  assert.equal(requests[0].init.method,'GET');
  assert.equal(requests[0].init.redirect,'error');
  assert.equal(requests[0].init.headers.Authorization,'Bearer service-token');
  assert.equal('Hmac-Key' in requests[0].init.headers,false);
  assert.equal('Hmac' in requests[0].init.headers,false);
  assert.equal('body' in requests[0].init,false);
  assert.ok(requests[0].init.signal instanceof AbortSignal);

  assert.deepEqual(await client.connectionTest({}),{connected:false,reason:'service_key_required'});
  const rejected=createCephalonClient({ fetchImpl:async()=>({ok:false,status:401,body:{getReader:()=>{throw new Error('must not read response body');}}}) });
  assert.deepEqual(await rejected.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'authentication_rejected'});
  const malformed=createCephalonClient({ fetchImpl:async()=>jsonResponse({object:'list',data:{}}) });
  assert.deepEqual(await malformed.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'invalid_response'});
  const wrongObject=createCephalonClient({ fetchImpl:async()=>jsonResponse({object:'model',data:[]}) });
  assert.deepEqual(await wrongObject.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'invalid_response'});
  const oversized=createCephalonClient({ fetchImpl:async()=>jsonResponse({object:'list',data:[]}, {contentLength:1024*1024+1}) });
  assert.deepEqual(await oversized.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'invalid_response'});
  const offline=createCephalonClient({ fetchImpl:async()=>{throw new Error(credentials.secret);} });
  assert.deepEqual(await offline.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'service_unavailable'});
  const timedOut=createCephalonClient({ connectionTimeoutMs:5, fetchImpl:async(_url, init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})) });
  assert.deepEqual(await timedOut.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'service_unavailable'});
  const timedOutBody=createCephalonClient({ connectionTimeoutMs:5, fetchImpl:async(_url, init)=>({
    ok:true,
    status:200,
    headers:{get:()=>null},
    body:{getReader:()=>({
      read:()=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})),
      releaseLock() {},
    })},
  }) });
  assert.deepEqual(await timedOutBody.connectionTest({serviceKey:'service-token'}),{connected:false,reason:'service_unavailable'});
});

test('Cephalon store encrypts credentials and exposes only safe status', t => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'cephalon-test-')),db=new DatabaseSync(':memory:'),store=createCephalonStore({db,directory});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(store.status(7).configured,false);
  const status=store.save(7,credentials);
  assert.deepEqual(status,{configured:true,hasPlatformKey:true,hasServiceKey:false,updatedAt:status.updatedAt,liveGenerationEnabled:false});
  assert.equal(JSON.stringify(status).includes(credentials.secret),false);
  assert.equal(db.prepare('SELECT credentials FROM cephalon_connections').get().credentials.includes(credentials.secret),false);
  assert.equal(readFileSync(path.join(directory,'cephalon.key')).length,32);
  assert.equal(store.credentials(7).key,credentials.key);
  const encrypted=db.prepare('SELECT credentials,updated_at FROM cephalon_connections WHERE user_id=?').get(7);
  db.prepare('INSERT INTO cephalon_connections(user_id,credentials,updated_at) VALUES(?,?,?)').run(8,encrypted.credentials,encrypted.updated_at);
  assert.throws(()=>store.credentials(8),/无法读取/);
  assert.equal(store.save(7,{serviceKey:'service-token'}).hasServiceKey,true);
  assert.equal(store.credentials(7).serviceKey,'service-token');
  assert.equal(store.disconnect(7).configured,false);
});

test('Cephalon store rejects an unsafe local encryption key file', t => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'cephalon-keyfile-')),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const keyFile=path.join(directory,'cephalon.key');
  writeFileSync(keyFile,Buffer.alloc(32),{mode:0o600});
  if (process.platform !== 'win32') {
    chmodSync(keyFile,0o644);
    const store=createCephalonStore({db,directory});
    assert.throws(()=>store.save(7,credentials),/加密配置异常/);
  }
  const linkedDirectory=mkdtempSync(path.join(os.tmpdir(),'cephalon-keylink-'));
  t.after(()=>rmSync(linkedDirectory,{recursive:true,force:true}));
  const target=path.join(linkedDirectory,'elsewhere.key');
  writeFileSync(target,Buffer.alloc(32),{mode:0o600});
  symlinkSync(target,path.join(linkedDirectory,'cephalon.key'));
  const linkedDb=new DatabaseSync(':memory:'),linkedStore=createCephalonStore({db:linkedDb,directory:linkedDirectory});
  t.after(()=>linkedDb.close());
  assert.throws(()=>linkedStore.save(7,credentials),/加密配置异常/);
});

test('Cephalon handler is owner-gated and never returns stored credentials', async t => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'cephalon-handler-')),db=new DatabaseSync(':memory:'),store=createCephalonStore({db,directory}),client=createCephalonClient({fetchImpl:async()=>({ok:false,status:503})});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const requireOwner=(req,writing)=>{ if(req.user!=='zane') throw Object.assign(new Error('仅管理员可用'),{status:403}); if(writing!==Boolean(req.expectedWrite)) throw new Error('CSRF write gate not used'); return {id:1,username:'zane'}; };
  const handler=createCephalonHandler({store,client,requireOwner,readBody:async req=>req.body||{},send:(res,status,payload)=>{res.status=status;res.payload=payload;return true;}});
  await assert.rejects(()=>handler({method:'GET',user:'reader',expectedWrite:false},{},'/api/cephalon'),/管理员/);
  const get={};await handler({method:'GET',user:'zane',expectedWrite:false},get,'/api/cephalon');assert.equal(get.status,200);assert.equal(get.payload.configured,false);
  const save={};await handler({method:'POST',user:'zane',expectedWrite:true,body:credentials},save,'/api/cephalon/config');assert.equal(save.status,200);assert.equal(JSON.stringify(save.payload).includes(credentials.secret),false);
  const probe={};await handler({method:'POST',user:'zane',expectedWrite:true,body:{}},probe,'/api/cephalon/dry-run');assert.deepEqual(probe.payload,{connected:false,reason:'service_key_required'});
  const connection={};await handler({method:'POST',user:'zane',expectedWrite:true,body:{}},connection,'/api/cephalon/connection-test');assert.deepEqual(connection.payload,{connected:false,reason:'service_key_required'});
  await assert.rejects(()=>handler({method:'POST',user:'zane',expectedWrite:true,body:{key:credentials.key,secret:credentials.secret,unexpected:true}},{},'/api/cephalon/config'),/字段/);
});
