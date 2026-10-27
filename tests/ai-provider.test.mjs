import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiProvider, publicAiAddress, validateAiMessages } from '../lib/ai-provider.js';

const c={protocol:'chat-completions',model:'fixture',base_url:'https://provider.example/v1',api_key:'private-fixture'};
const messages=[{role:'system',content:'Instructions'},{role:'user',content:'Hello'}];
const sse=events=>new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));
const fixtures={
  'chat-completions':[{choices:[{delta:{content:'你好'}}]},{choices:[{delta:{},finish_reason:'stop'}]}],
  responses:[{type:'response.output_text.delta',delta:'你好'},{type:'response.completed',response:{model:'fixture',usage:{output_tokens:2}}}],
  anthropic:[{type:'message_start',message:{model:'fixture'}},{type:'content_block_delta',delta:{type:'text_delta',text:'你好'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}],
};
for(const protocol of Object.keys(fixtures))test(`${protocol}: sends the correct endpoint and completes only at a terminal event`,async()=>{
  let options,url;
  const provider=createAiProvider({fetchImpl:async(u,o)=>{url=u;options=o;return sse(fixtures[protocol]);}});
  const result=await provider.complete({...c,protocol},messages);
  assert.equal(result.reply,'你好');assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.equal(body.tools,undefined);assert.equal(body.model,'fixture');
  if(protocol==='responses'){assert.match(url,/\/responses$/);assert.equal(body.store,false);assert.equal(body.input[0].role,'developer');}
  if(protocol==='anthropic'){assert.match(url,/\/messages$/);assert.equal(options.headers['x-api-key'],c.api_key);assert.equal(body.system,'Instructions');assert.equal(body.messages.length,1);}
  if(protocol==='chat-completions')assert.match(url,/\/chat\/completions$/);
});
for(const protocol of Object.keys(fixtures))test(`${protocol}: premature EOF is a failure, not a successful reply`,async()=>{
  const provider=createAiProvider({fetchImpl:async()=>sse(fixtures[protocol].slice(0,1))});
  await assert.rejects(provider.complete({...c,protocol},messages),{code:'invalid_result'});
});
test('rejects tool requests, partial responses, length limits and upstream errors without leaking bodies',async()=>{
  for(const [protocol,event] of [
    ['chat-completions',{choices:[{delta:{tool_calls:[{name:'shell'}]}}]}],
    ['chat-completions',{choices:[{finish_reason:'length'}]}],
    ['responses',{type:'response.incomplete'}],
    ['responses',{type:'response.failed',response:{error:{message:'secret-fixture'}}}],
    ['anthropic',{type:'content_block_start',content_block:{type:'tool_use'}}],
  ])await assert.rejects(createAiProvider({fetchImpl:async()=>sse([event])}).complete({...c,protocol},messages),{code:'invalid_result'});
  for(const status of [401,403,404,429,500])await assert.rejects(createAiProvider({fetchImpl:async()=>new Response('secret-fixture',{status})}).complete(c,messages),e=>e.status===502&&!e.message.includes('secret-fixture'));
});
test('chunk boundaries preserve UTF-8 and reject oversize output and bad messages',async()=>{
  const bytes=new TextEncoder().encode(fixtures['chat-completions'].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  const p=createAiProvider({fetchImpl:async()=>new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}))});
  assert.equal((await p.complete(c,messages)).reply,'你好');
  await assert.rejects(createAiProvider({fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1))}).complete(c,messages));
  for(const input of [[],[{role:'tool',content:'x'}],[{role:'user',content:{}}],[{role:'user',content:'x'.repeat(300*1024)}]])assert.throws(()=>validateAiMessages(input));
});
test('model catalogs expose only usable ids and network targets exclude internal ranges',async()=>{
  const p=createAiProvider({fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'first'},{id:'hidden',visibility:'hidden'}]}))});
  assert.deepEqual(await p.models(c),[{id:'first',name:'first'}]);
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.2','192.168.0.1','100.100.100.200','0.0.0.0'])assert.equal(publicAiAddress(ip),false);
  assert.equal(publicAiAddress('8.8.8.8'),true);
});
