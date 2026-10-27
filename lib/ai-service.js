import { db } from './db.js';
import { createAiConnectionStore, AI_PROVIDERS, aiError } from './ai-connections.js';
import { createAiProvider } from './ai-provider.js';

export const aiConnections=createAiConnectionStore(db);
export const aiProvider=createAiProvider();
const active=new Map();
export async function withAiSlot(userId,task) {
  const count=active.get(userId)||0;
  if(count>=2)throw aiError(429,'已有 AI 请求正在执行，请稍后再试');
  active.set(userId,count+1);
  try{return await task();}finally{const remaining=(active.get(userId)||1)-1;if(remaining)active.set(userId,remaining);else active.delete(userId);}
}
export function selectedAiConnection(userId,purpose='chat') {
  const c=aiConnections.selected(userId,purpose);
  if(!c)throw aiError(400,'请到「设置 → AI 服务」选择已测试的连接');
  if(c.test_state!=='ready')throw aiError(400,'当前连接尚未通过测试，请到「设置 → AI 服务」重新测试');
  return c;
}
export async function testAiConnection(userId,id) {
  const c=aiConnections.get(userId,id);
  if(!c)throw aiError(404,'连接不存在');
  return withAiSlot(userId,async()=>{
    const start=Date.now();
    let state='ready',message='文字与 JSON 输出正常';
    try {
      const result=await aiProvider.complete(c,[{role:'user',content:'Connection test. Return only this JSON object, with no markdown or other text: {"ok":true}'}],{maxTokens:1024});
      const value=JSON.parse(result.reply.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
      if(value?.ok!==true || Object.keys(value).length!==1)throw aiError(502,'已收到回复，但 JSON 输出不符合要求','invalid_result');
    } catch(error) {state='failed';message=error?.status ? error.message : '已收到回复，但 JSON 输出不符合要求';}
    return aiConnections.recordTest(userId,id,c.revision,{state,message,latencyMs:Date.now()-start});
  });
}
export function aiSettings(userId) {
  return {providers:AI_PROVIDERS,connections:aiConnections.list(userId),routes:aiConnections.routes(userId)};
}
