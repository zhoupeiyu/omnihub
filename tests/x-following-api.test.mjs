import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('following management uses owner/CSRF gates, cached GETs and atomic paused additions',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'omnihub-following-api-'));
  process.env.OMNIHUB_DATA_DIR=dir;process.env.OMNIHUB_X_WATCH_ENABLED='false';process.env.SOCIALDATA_API_KEY='fixture-only';process.env.OMNIHUB_SOCIALDATA_MONTH_USD='5.90';
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async url=>{
    calls++;
    if(url==='https://api.socialdata.tools/twitter/user/zane9588')return new Response(JSON.stringify({id_str:'1234567890123456789',screen_name:'zane9588',friends_count:1}));
    if(url==='https://api.socialdata.tools/twitter/user/1234567890123456789/following')return new Response(JSON.stringify({users:[{id_str:'222',screen_name:'example',name:'示例作者'}],next_cursor:null}));
    throw new Error('Unexpected provider request');
  };
  const {db}=await import('../lib/db.js');const {handleApi}=await import('../lib/api.js');
  db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(1,'zane','fixture','fixture'),(2,'reader','fixture','fixture')").run();
  db.prepare("INSERT INTO sessions(token,user_id) VALUES('owner-fixture',1),('reader-fixture',2)").run();
  const server=http.createServer(async(req,res)=>{if(!await handleApi(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{globalThis.fetch=originalFetch;await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(route,{token,body,origin,site}={})=>originalFetch(base+route,{method:body?'POST':'GET',headers:{...(token?{cookie:`omnihub_session=${token}`}:{ }),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{}),...(site?{'sec-fetch-site':site}:{})},body:body?JSON.stringify(body):undefined});
  const follow={handle:'zane9588',action:'load',generation:'',page:0};
  const batch={handles:['@example'],group:'行业研究',intervalMinutes:30};
  for(const [route,body] of [['/api/x-watch/media/1',undefined],['/api/x-watch/media/retry',{}],['/api/x-watch/posts',undefined],['/api/x-watch/hot',undefined],['/api/x-watch/following',undefined],['/api/x-watch/following',follow],['/api/x-watch/accounts/batch',batch]]){
    assert.equal((await request(route,{body})).status,401);
    assert.equal((await request(route,{body,token:'reader-fixture'})).status,403);
    if(body){
      assert.equal((await request(route,{body,token:'owner-fixture',origin:'https://evil.example'})).status,403);
      assert.equal((await request(route,{body,token:'owner-fixture',site:'cross-site'})).status,403);
    }
  }
  assert.equal(calls,0);
  let result=await request('/api/x-watch/following',{token:'owner-fixture'});
  assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await result.json()).users.length,0);assert.equal(calls,0);
  result=await request('/api/x-watch/following',{token:'owner-fixture',body:follow});assert.equal(result.status,200);
  const cache=await result.json();assert.equal(cache.users[0].handle,'example');assert.equal(calls,2);
  assert.ok(!JSON.stringify(cache).includes('fixture-only'));
  await request('/api/x-watch/following',{token:'owner-fixture'});
  await request('/api/x-watch/following',{token:'owner-fixture',body:follow});assert.equal(calls,2);
  result=await request('/api/x-watch/accounts/batch',{token:'owner-fixture',body:batch});assert.equal(result.status,200);
  const added=await result.json();assert.equal(added.added,1);assert.equal(added.state.accounts[0].enabled,false);assert.equal(added.state.dailyRequests,0);
  assert.equal(db.prepare('SELECT count(*) n FROM inbox').get().n,0);assert.equal(calls,2);
  assert.equal(added.state.dailyBudgetUsd,0);
  assert.equal((await request('/api/x-watch/media/999',{token:'owner-fixture'})).status,404);
  assert.equal((await request('/api/x-watch/media/retry',{token:'owner-fixture',body:{}})).status,200);
  assert.equal(calls,2);
});
