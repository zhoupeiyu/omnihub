import {WATCH_VERSION} from './x-watch.js';
import {hashContent} from './content-policy.js';

const invalid=()=>{throw Object.assign(new Error('分析结构或引用无效'),{code:'invalid_result'});};
export function createWatchProcessor({store,model,now=()=>Date.now(),dailyCalls=20}) {
  let busy=false;
  async function step(userId,row,stage,input,validate) {
    const key=hashContent({userId,postId:row.id,hash:row.content_hash,version:WATCH_VERSION,model:model.identity(stage),stage,input});
    const cached=store.receipt(key);if(cached)return validate(cached);
    if(!store.reserveAnalysis(userId,row,dailyCalls))throw Object.assign(new Error('budget'),{code:'budget'});
    const result=validate((await model.call(stage,input)).value);
    store.saveReceipt(key,result);return result;
  }
  async function run(userId) {
    if(busy)return {state:'busy'};
    busy=true;let row;
    try {
      row=store.pendingAnalysis(userId);if(!row)return {state:'idle'};
      const post=JSON.parse(row.document);
      if(!post.content.trim()||post.metrics.truncated||post.content.length>18000){store.saveAnalysis(userId,row,{},'review');return {state:'review'};}
      const candidates=store.posts(userId).filter(p=>p.id!==row.id&&p.analysis&&p.id===p.eventId&&now()-p.publishedMs<14*86400000).slice(0,10)
        .map(p=>({id:p.id,title:p.analysis.title,content:p.content.slice(0,5000),contentHash:p.contentHash}));
      const result=await step(userId,row,'watch',{version:WATCH_VERSION,source:{id:row.id,...post,raw:undefined},candidates},value=>{
        if(!value||typeof value.title!=='string'||!value.title.trim()||value.title.length>240||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>1600||
          !/[\u4e00-\u9fff]/.test(value.title+value.summary)||!['announcement','opinion','unverified','promotion','tutorial'].includes(value.claimType)||
          typeof value.evidenceQuote!=='string'||value.evidenceQuote.length<4||!post.content.includes(value.evidenceQuote)||
          !Array.isArray(value.topics)||value.topics.length>8||value.topics.some(t=>typeof t!=='string'||t.length>40)||
          !Number.isFinite(value.sameEventConfidence)||value.sameEventConfidence<0||value.sameEventConfidence>1||
          (value.eventId!==null&&!candidates.some(c=>c.id===value.eventId)))invalid();
        return Object.fromEntries(['title','summary','claimType','evidenceQuote','topics','sameEventConfidence','eventId'].map(k=>[k,value[k]]));
      });
      const article={title:result.title,summary:result.summary,sections:[{heading:'动态',text:result.summary,evidence:[{sourceId:row.id,quote:result.evidenceQuote}]}]};
      const verified=await step(userId,row,'verify',{article,sources:[{id:row.id,content:post.content}]},value=>{
        if(!value||typeof value.supported!=='boolean'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1||
          !Array.isArray(value.issues)||value.issues.some(i=>typeof i!=='string'))invalid();
        return {supported:value.supported,confidence:value.confidence,issues:value.issues};
      });
      if(!verified.supported||verified.confidence<.85||verified.issues.length){store.saveAnalysis(userId,row,{},'review');return {state:'review'};}
      const eventId=result.eventId&&result.sameEventConfidence>=.9?result.eventId:row.id;
      const saved=store.saveAnalysis(userId,row,result,'ready',eventId,candidates.find(c=>c.id===eventId)?.contentHash||'');
      return {state:saved?'ready':'stale'};
    } catch(error) {
      if(error.code==='budget')return {state:'budget'};
      if(row)store.saveAnalysis(userId,row,{},error.code==='invalid_result'?'review':'error');
      return {state:error.code==='invalid_result'?'review':'error'};
    } finally {if(row)store.releaseAnalysis(row);busy=false;}
  }
  return {run};
}
