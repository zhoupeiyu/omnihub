import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';
import { Readable } from 'node:stream';
import { aiError, normalizeAiUrl } from './ai-connections.js';

const blocked = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix);
export const publicAiAddress = address => !blocked.check(address,'ipv4');

// Resolve once and pin the connection address. HTTPS retains hostname/SNI validation;
// redirects are never followed, including model-list requests carrying credentials.
export async function fetchAiEndpoint(endpoint, options={}) {
  const url=new URL(endpoint);
  normalizeAiUrl(url.origin);
  let records;
  try { records=await lookup(url.hostname,{all:true,family:4}); } catch { throw aiError(502,'无法解析 AI 服务地址','upstream'); }
  if (!records.length || records.some(r=>!publicAiAddress(r.address))) throw aiError(400,'AI 服务地址不能指向内网','configuration');
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method:options.method || 'GET',headers:options.headers,signal:options.signal,
      lookup:(_host,opts,cb)=>opts.all ? cb(null,[records[0]]) : cb(null,records[0].address,4)},res=>{
      const empty=[204,205,304].includes(res.statusCode);
      if(empty)res.resume();
      resolve(new Response(empty?null:Readable.toWeb(res),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))}));
    });
    req.on('error',()=>reject(aiError(502,'AI 服务连接失败或超时','upstream')));
    req.end(options.body);
  });
}

function headers(c) {
  return {'content-type':'application/json',...(c.protocol==='anthropic'
    ? {'x-api-key':c.api_key,'anthropic-version':'2023-06-01'}
    : {authorization:`Bearer ${c.api_key}`})};
}
function providerError(status) {
  const message = status===401 || status===403 ? '认证失败，请检查 API Key 和模型权限'
    : status===429 ? '服务额度或调用频率已达上限，请在服务商后台检查'
    : status===404 ? '接口或模型不存在，请检查地址与模型名称'
    : status===402 ? '服务余额不足，请在服务商后台检查'
    : `AI 服务请求失败（HTTP ${status}）`;
  return aiError(502,message,'upstream');
}
const invalid = message => aiError(502,message,'invalid_result');

export function validateAiMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length>100 || messages.some(m=>!m || !['system','user','assistant'].includes(m.role) || typeof m.content!=='string') || Buffer.byteLength(JSON.stringify(messages))>256*1024) throw aiError(400,'消息格式不正确或内容过长');
}

export function createAiProvider({fetchImpl=fetchAiEndpoint}={}) {
  async function request(c,suffix,body) {
    const url=normalizeAiUrl(c.base_url)+'/'+suffix;
    let response;
    try { response=await fetchImpl(url,{method:body?'POST':'GET',headers:headers(c),body:body?JSON.stringify(body):undefined,
      redirect:'error',signal:AbortSignal.timeout(120_000)}); }
    catch(error) { if(error?.status)throw error;throw aiError(502,'AI 服务连接失败或超时','upstream'); }
    if (!response.ok) { await response.body?.cancel().catch(()=>{}); throw providerError(response.status); }
    return response;
  }
  async function *stream(c,messages,{maxTokens=8192}={}) {
    validateAiMessages(messages);
    let suffix,body;
    if(c.protocol==='anthropic') {
      suffix='messages';body={model:c.model,max_tokens:maxTokens,stream:true,
        system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:messages.filter(m=>m.role!=='system')};
    } else if(c.protocol==='responses') {
      suffix='responses';body={model:c.model,input:messages.map(m=>({...m,role:m.role==='system'?'developer':m.role})),stream:true,store:false,max_output_tokens:maxTokens};
    } else {
      suffix='chat/completions';body={model:c.model,messages,stream:true,max_tokens:maxTokens};
    }
    const response=await request(c,suffix,body);
    if(!response.body)throw invalid('AI 服务返回了空回复');
    const decoder=new TextDecoder(); let buffer='',size=0,done=false,text='',usage={},model=c.model,reason='';
    for await(const chunk of response.body) {
      size+=chunk.byteLength;if(size>2*1024*1024)throw invalid('AI 服务响应过大');
      buffer+=decoder.decode(chunk,{stream:true});
      let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
        if(!line.startsWith('data:'))continue;
        const raw=line.slice(5).trim(); if(!raw)continue;
        if(raw==='[DONE]'){if(c.protocol==='chat-completions' && reason!=='length' && reason!=='tool_calls' && reason!=='content_filter')done=true;continue;}
        let p;try{p=JSON.parse(raw);}catch{throw invalid('AI 服务返回了无效的数据流');}
        if(p.error || p.type==='error' || ['response.failed','response.incomplete'].includes(p.type))throw invalid('AI 服务未完成请求，请检查模型权限、额度或输出长度');
        let delta='';
        if(c.protocol==='responses') {
          if(p.type==='response.output_text.delta')delta=p.delta||'';
          if(p.type==='response.output_item.added' && ['function_call','custom_tool_call','web_search_call'].includes(p.item?.type))throw invalid('AI 服务返回了非预期的工具请求');
          if(p.type==='response.completed') {done=true;usage=p.response?.usage||{};model=p.response?.model||model;}
        } else if(c.protocol==='anthropic') {
          if(p.type==='content_block_start' && ['tool_use','server_tool_use'].includes(p.content_block?.type))throw invalid('AI 服务返回了非预期的工具请求');
          if(p.type==='content_block_delta' && p.delta?.type==='text_delta')delta=p.delta.text||'';
          if(p.type==='message_start'){model=p.message?.model||model;usage=p.message?.usage||{};}
          if(p.type==='message_delta'){reason=p.delta?.stop_reason||reason;usage={...usage,...p.usage};}
          if(p.type==='message_stop') {if(!['end_turn','stop_sequence'].includes(reason))throw invalid('AI 服务输出不完整');done=true;}
        } else {
          const choice=p.choices?.[0];
          if(choice?.delta?.tool_calls || choice?.delta?.function_call)throw invalid('AI 服务返回了非预期的工具请求');
          delta=choice?.delta?.content||''; model=p.model||model;usage=p.usage||usage;
          if(choice?.finish_reason) {reason=choice.finish_reason;if(reason!=='stop')throw invalid('AI 服务输出不完整');done=true;}
        }
        if(typeof delta!=='string')throw invalid('AI 服务返回了非文本结果');
        if(delta){text+=delta;yield {delta};}
      }
    }
    if(buffer.trim())throw invalid('AI 服务传输中断，请重试');
    if(!done)throw invalid('AI 服务传输中断，请重试');
    if(!text.trim())throw invalid('AI 服务返回了空回复');
    yield {done:true,model,usage};
  }
  return {
    stream,
    async complete(c,messages,options) {
      let reply='',result;
      for await(const event of stream(c,messages,options)) {if(event.delta)reply+=event.delta;if(event.done)result=event;}
      return {reply,model:result.model,usage:result.usage};
    },
    async models(c) {
      const response=await request(c,'models');
      let raw='',size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw invalid('模型列表响应过大');raw+=Buffer.from(chunk).toString('utf8');}
      let data;try{data=JSON.parse(raw);}catch{throw invalid('模型列表格式不正确');}
      const rows=data.data||data.models;
      if(!Array.isArray(rows))throw invalid('服务未提供可识别的模型列表，请手动填写');
      return rows.filter(r=>r.visibility===undefined || r.visibility==='list').slice(0,500).map(r=>({id:String(r.id||r.slug||''),name:String(r.display_name||r.name||r.id||r.slug||'')})).filter(r=>r.id);
    },
  };
}
