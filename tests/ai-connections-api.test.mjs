import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('each signed-in account configures and calls only its own tested AI service',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'omnihub-ai-api-'));process.env.OMNIHUB_DATA_DIR=dir;
  const {db}=await import('../lib/db.js');
  for(const [id,name] of [[1,'alice'],[2,'bob']]){
    db.prepare('INSERT INTO users(id,username,password_hash,salt) VALUES(?,?,?,?)').run(id,name,'x','x');
    db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run('fixture-'+name,id);
  }
  const {handleApi}=await import('../lib/api.js');
  const {aiProvider,aiConnections}=await import('../lib/ai-service.js');
  const server=http.createServer(async(req,res)=>handleApi(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(route,user,method='GET',body,origin=base)=>fetch(base+route,{method,headers:{...(user?{cookie:'omnihub_session=fixture-'+user}:{}),...(body?{'content-type':'application/json'}:{}),origin},body:body?JSON.stringify(body):undefined});
  const input={name:'我的服务',provider:'anthropic',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',apiKey:'secret-alice',model:'model'};
  assert.equal((await request('/api/ai/connections')).status,401);
  assert.equal((await request('/api/ai/connections','alice','POST',input,'https://attacker.example')).status,403);
  const c=await (await request('/api/ai/connections','alice','POST',input)).json();
  assert.equal(c.hasKey,true);assert.ok(!JSON.stringify(c).includes('secret-alice'));
  const bob=await (await request('/api/ai/connections','bob')).json();assert.deepEqual(bob.connections,[]);assert.deepEqual(bob.routes,{});
  const target='/api/ai/connections/'+c.id;
  for(const [method,suffix] of [['PUT',''],['DELETE',''],['POST','/test'],['POST','/models']])assert.equal((await request(target+suffix,'bob',method,input)).status,404);
  assert.equal((await request('/api/ai/routes','alice','PUT',{purpose:'chat',connectionId:c.id})).status,400);
  let seen=[];
  aiProvider.complete=async(connection,messages)=>{seen.push([connection.user_id,connection.api_key,messages]);return {reply:'{"ok":true}',model:connection.model};};
  const result=await (await request(target+'/test','alice','POST',{})).json();assert.equal(result.testState,'ready');
  assert.equal((await request('/api/ai/routes','alice','PUT',{purpose:'chat',connectionId:c.id})).status,200);
  assert.equal((await request('/api/ai/routes','bob','PUT',{purpose:'chat',connectionId:c.id})).status,404);
  assert.equal((await (await request('/api/me','alice')).json()).hasAiConfig,true);
  assert.equal((await (await request('/api/me','bob')).json()).hasAiConfig,false);
  assert.equal((await request('/api/ai/chat','alice','POST',{messages:[{role:'user',content:'Hello'}]})).status,200);
  assert.equal((await request('/api/ai/chat','bob','POST',{messages:[{role:'user',content:'Hello'}]})).status,400);
  assert.ok(seen.every(([id,key])=>id===1&&key==='secret-alice'));
  assert.equal((await request(target,'alice','DELETE',{})).status,409);
  const edited=await (await request(target,'alice','PUT',{...c,apiKey:'',model:'changed'})).json();assert.equal(edited.testState,'untested');
  assert.equal((await request('/api/ai/chat','alice','POST',{messages:[{role:'user',content:'Hello'}]})).status,400);
  aiProvider.complete=async()=>({reply:'not JSON',model:'changed'});
  assert.equal((await (await request(target+'/test','alice','POST',{})).json()).testState,'failed');
  assert.equal(aiConnections.get(1,c.id).api_key,'secret-alice');
  assert.equal((await request('/api/media/config','alice')).status,403,'shared media access must remain restricted');
});
