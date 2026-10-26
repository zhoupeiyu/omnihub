import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function port() { const server=net.createServer(); await new Promise(done=>server.listen(0,'127.0.0.1',done)); const value=server.address().port; await new Promise(done=>server.close(done)); return value; }
test('inbox list is owner-scoped, body-free, and search finds archived article text', async t => {
  const data=await mkdtemp(path.join(os.tmpdir(),'omnihub-inbox-list-')); const listen=await port(); const base=`http://127.0.0.1:${listen}`;
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(listen),OMNIHUB_DATA_DIR:data},stdio:'ignore'});
  t.after(async()=>{child.kill(); await rm(data,{recursive:true,force:true});});
  const request=(route,{method='GET',cookie='',body}={})=>fetch(base+route,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  for(let i=0;i<80;i+=1){ try { if((await request('/')).ok) break; } catch {} await new Promise(done=>setTimeout(done,25)); }
  const register=async username=>{const response=await request('/api/register',{method:'POST',body:{username,password:'test-password-123'}});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
  const alice=await register('alice'), bob=await register('bob');
  const saved=await request('/api/inbox/import',{method:'POST',cookie:alice,body:{items:[{source:'x',externalId:'article',title:'Only a link',content:'https://t.co/a',links:['https://x.com/i/article/42'],metrics:{article:{body:'private archived article source phrase',plainText:'private archived article source phrase'}}}]}}); assert.equal(saved.status,200);
  const list=await request('/api/inbox/list',{cookie:alice}); assert.equal(list.status,200); const rows=await list.json(); assert.equal(rows.length,1); assert.equal('content' in rows[0],false); assert.equal(rows[0].hasArticle,true); assert.equal(rows[0].articleLink,'https://x.com/i/article/42');
  const search=await request('/api/inbox/search?q=archived%20article%20source%20phrase',{cookie:alice}); assert.deepEqual((await search.json()).ids,[rows[0].id]);
  assert.equal((await request('/api/inbox/list',{cookie:bob})).status,200); assert.deepEqual(await (await request('/api/inbox/list',{cookie:bob})).json(),[]); assert.equal((await request('/api/inbox/search?q=archived',{cookie:bob})).status,200); assert.deepEqual((await (await request('/api/inbox/search?q=archived',{cookie:bob})).json()).ids,[]);
  assert.equal((await request(`/api/inbox/${rows[0].id}`,{cookie:bob})).status,404);
});
