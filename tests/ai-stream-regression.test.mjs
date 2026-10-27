import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('browser SSE reports upstream failure without synthesizing a completion',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'omnihub-ai-stream-'));process.env.OMNIHUB_DATA_DIR=dir;
  const {db}=await import('../lib/db.js');
  db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(1,'fixture','x','x')").run();
  const {aiConnections,aiProvider}=await import('../lib/ai-service.js');
  const {streamChatToClient}=await import('../lib/ai.js');
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const c=aiConnections.save(1,{name:'test',provider:'custom',protocol:'responses',baseUrl:'https://api.example.com/v1',apiKey:'fixture',model:'model'});
  aiConnections.recordTest(1,c.id,c.revision,{state:'ready',message:'ok',latencyMs:1});aiConnections.assign(1,'chat',c.id);
  const run=async()=>{let out='';await streamChatToClient(1,[{role:'user',content:'test'}],{writeHead(){},write(x){out+=x;},end(){}});return out;};
  aiProvider.stream=async function*(){yield {delta:'partial'};throw Object.assign(new Error('upstream interrupted'),{status:502});};
  const failed=await run();assert.match(failed,/partial/);assert.match(failed,/error/);assert.ok(!failed.includes('[DONE]'));
  aiProvider.stream=async function*(){yield {delta:'finished'};yield {done:true};};
  const success=await run();assert.equal(success.split('[DONE]').length,2);
});
