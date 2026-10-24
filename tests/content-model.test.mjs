import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentModel} from '../lib/content-model.js';
import {classifyPipelineSource} from '../lib/typesafe.js';
const configLoader=()=>({url:'https://example.invalid/v1/messages',model:'fixture',token:'fixture',provider:'fixture',bearer:true});

test('text JSON is accepted and any unexpected tool request is rejected',async()=>{
  let sent;
  const model=createContentModel({configLoader,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({supported:true,confidence:.95,issues:[]})}]}));}});
  assert.equal((await model.call('verify',{})).value.supported,true);
  assert.equal(sent.tools,undefined);assert.ok(sent.messages[0].content.includes('No repository, filesystem, shell'));
  const bad=createContentModel({configLoader,fetchImpl:async()=>new Response(JSON.stringify({content:[{type:'tool_use',name:'Bash',input:{command:'echo test'}}]}))});
  await assert.rejects(bad.call('verify',{}),e=>e.code==='invalid_result');
});

test('model errors never contain the upstream body or token',async()=>{
  const model=createContentModel({configLoader,fetchImpl:async()=>new Response('sensitive upstream diagnostic',{status:401})});
  await assert.rejects(model.call('verify',{}),e=>e.code==='upstream'&&!e.message.includes('sensitive')&&!e.message.includes('fixture'));
});

test('multiple assets use independent typed judgments; advice cannot bypass the complete-prompt gate',async()=>{
  const before=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='fixture';
  try{
    const result=await classifyPipelineSource({content:'在仓库里按步骤配置长期规则。'},async()=>new Response(JSON.stringify({answers:{
      kind:{type:'choice',choice:'method',confidence:.99,probabilities:{method:.99}},
      sufficiency:{type:'choice',choice:'complete',confidence:.99,probabilities:{complete:.99}},
      taskPrompt:{type:'noul',noul:.1},method:{type:'noul',noul:.98},repository:{type:'noul',noul:.97},
    }})));
    assert.deepEqual(result.value.assets,['method','repository']);
  }finally{if(before===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=before;}
});
