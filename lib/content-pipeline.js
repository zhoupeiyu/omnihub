import { CONTENT_POLICY, CONTENT_VERSION, CONTENT_KINDS, hashContent, validateArticle } from './content-policy.js';

const invalid = message => {throw Object.assign(new Error(message),{code:'invalid_result'});};
function classification(value) {
  if(!value || !Object.hasOwn(CONTENT_KINDS,value.kind) || !['complete','incomplete'].includes(value.sufficiency) ||
    !Number.isFinite(value.confidence) || value.confidence<0 || value.confidence>1) invalid('分类结果无效');
  const assets=value.assets??[value.kind];
  if(!Array.isArray(assets)||assets.some(kind=>!Object.hasOwn(CONTENT_KINDS,kind)))invalid('资产类型无效');
  return {...value,assets:[...new Set([value.kind,...assets])]};
}
function verification(value) {
  if(!value || typeof value.supported!=='boolean' || !Number.isFinite(value.confidence) || value.confidence<0 || value.confidence>1 ||
    !Array.isArray(value.issues) || value.issues.some(x=>typeof x!=='string'))invalid('引用核验结果无效');
  return value;
}
const sourceInput = source => ({id:source.id,title:source.title,content:source.content,quotedText:source.quotedText,
  url:source.url,author:source.author,links:source.links,media:source.media,source:source.source});

export function createContentPipeline({store,model,budget,onError=()=>{}}={}) {
  let running=false;
  async function step(job,name,input,validate) {
    store.stage(job,name);
    const context={userId:job.source.userId,jobId:job.id};
    const provider=model.identity(name,context);
    const key=hashContent({version:CONTENT_VERSION,provider,stage:name,input});
    const cached=store.receipt(key);
    if(cached)return validate(cached.value);
    if(!model.deferred?.(context))store.reserve(job,budget);
    const response=await model.call(name,input,{...context,requestKey:key});
    const value=validate(response.value);
    store.saveReceipt(job,key,name,provider,{...response,value});
    store.assertLive(job);
    return value;
  }
  async function process(job) {
    const source=sourceInput(job.source);
    if(source.content.length+(source.quotedText||'').length>CONTENT_POLICY.maxSourceChars){
      store.finish(job,'review','source_too_long');return;
    }
    let kind=await step(job,'classify',source,classification);
    if(kind.confidence<CONTENT_POLICY.minConfidence || kind.sufficiency!=='complete') {
      kind=await step(job,'classify_detail',{source,preliminary:kind},classification);
    }
    if(kind.sufficiency!=='complete' || kind.kind==='other'){
      store.saveResult(job,kind,null,'review');store.finish(job,'review',kind.sufficiency==='incomplete'?'needs_material':'uncertain');return;
    }
    const validateEditorial=value=>validateArticle(value,[source],{editorial:true,kind:kind.kind,assets:kind.assets});
    let article=await step(job,'editorial',{classification:kind,sources:[source]},validateEditorial);
    if(!article.sections.length){store.saveResult(job,kind,article,'review');store.finish(job,'review','needs_material');return;}
    let checked=await step(job,'verify',{article,sources:[source]},verification);
    if(!checked.supported&&checked.issues.length){
      store.saveResult(job,kind,{...article,verification:checked},'review');
      article=await step(job,'editorial',{classification:kind,sources:[source],revision:{previousDraft:article,issues:checked.issues,
        instruction:'Correct only the supplied draft against original evidence. Remove unsupported inferences; distinguish quoted-post authors. Do not add missing facts.'}},validateEditorial);
      checked=await step(job,'verify',{article,sources:[source]},verification);
    }
    article.verification=checked;
    if(!checked.supported || checked.confidence<CONTENT_POLICY.verifyConfidence || checked.issues.length){
      store.saveResult(job,kind,article,'review');store.finish(job,'review','unsupported');return;
    }
    // Uncertain taxonomy does not prevent a grounded summary/score, but never
    // silently moves the result into a library or a synthesis group.
    if(kind.confidence<CONTENT_POLICY.minConfidence){store.saveResult(job,kind,article,'review');store.finish(job,'review','uncertain');return;}
    store.saveResult(job,kind,article,'ready');
    if(store.protectedItem(job.source.id,job.source.userId)){store.finish(job,'done');return;}
    // News remains a timeline asset, never an evergreen how-to solely because it is popular.
    if(['news','opinion','inspiration','other'].includes(kind.kind)){store.finish(job,'done');return;}
    const candidates=store.candidates(job.source.userId,article,kind.kind);
    let groupId=null;
    if(candidates.length){
      const decision=await step(job,'group',{source,problem:article.problem,candidates},value=>{
        if(!value || !['new','same_problem','same_event','related'].includes(value.relation) ||
          !Number.isFinite(value.confidence) || value.confidence<0 || value.confidence>1 ||
          (value.groupId!==null && (!Number.isSafeInteger(value.groupId)||!candidates.some(c=>c.id===value.groupId))))invalid('归组结果无效');
        return value;
      });
      if(decision.relation==='same_problem'&&decision.confidence>=CONTENT_POLICY.groupConfidence)groupId=decision.groupId;
    }
    groupId=store.attach(job,kind,article,groupId);
    const members=[...store.members(groupId).filter(s=>s.id!==job.source.id).slice(-(CONTENT_POLICY.groupSources-1)),job.source];
    if(members.length>=2&&!store.hasArticle(groupId,members)){
      const inputs=members.map(sourceInput);
      if(inputs.some(s=>s.content.length+(s.quotedText||'').length>CONTENT_POLICY.maxSourceChars)){store.finish(job,'done');return;}
      const knowledge=await step(job,'synthesis',{problem:article.problem,sources:inputs},value=>{
        const result=validateArticle(value,inputs);
        const cited=new Set(result.sections.flatMap(s=>s.evidence.map(e=>e.sourceId)));
        if(result.sections.length && cited.size<2)invalid('综合知识必须引用多个来源');
        return result;
      });
      if(knowledge.sections.length){
        const verified=await step(job,'verify',{article:knowledge,sources:inputs},verification);
        knowledge.verification=verified;
        if(verified.supported&&verified.confidence>=CONTENT_POLICY.verifyConfidence&&!verified.issues.length)
          store.saveArticle(job,groupId,members,knowledge);
        else {store.finish(job,'review','synthesis_unsupported');return;}
      }
    }
    store.finish(job,'done');
  }
  async function run(userId,{limit=1}={}) {
    if(running)return {processed:0,busy:true};
    running=true;
    let processed=0;
    try {
      store.sync();
      while(processed<Math.max(1,Math.min(10,limit))){
        const job=store.claim(userId);if(!job)break;
        try {await process(job);}catch(error){store.fail(job,error);onError(error);}
        processed++;
      }
      return {processed,busy:false};
    } finally {running=false;}
  }
  return {run};
}
