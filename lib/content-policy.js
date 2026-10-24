import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CONTENT_KINDS = {
  prompt:'A complete copyable AI instruction for a concrete task, not general prompting advice or persistent agent rules.',
  method:'A repeatable technique, procedure, tutorial, or persistent agent working rule.',
  repository:'A specific source-code repository as the main reusable asset.',
  tool:'A named tool, service or product to revisit.',
  code:'Reusable code, commands or configuration.',
  template:'A reusable checklist, template or structured framework.',
  research:'A paper, benchmark, dataset or research report.',
  reference:'A factual explanation or reference article.',
  news:'A time-sensitive announcement or event.',
  opinion:'An attributed interpretation or opinion.',
  inspiration:'A creative result or visual example without complete instructions.',
  other:'Insufficient evidence or none of the listed asset kinds.',
};
export const CONTENT_LABELS = {prompt:'提示词',method:'方法技巧',repository:'仓库',tool:'工具',code:'代码配置',template:'模板清单',research:'研究资料',reference:'参考知识',news:'动态',opinion:'观点',inspiration:'灵感',other:'待整理'};
export const AXES = ['substance','novelty','evidence','relevance','actionability'];
export const WEIGHTS = {prompt:[1,2,2,1,4],method:[1,2,2,1,4],repository:[2,1,2,2,3],tool:[2,1,2,2,3],code:[1,1,2,2,4],template:[1,1,2,2,4],research:[3,2,3,1,1],reference:[2,1,3,2,2],news:[3,2,2,3,0],opinion:[1,2,3,3,1],inspiration:[1,3,1,3,2],other:[2,2,2,2,2]};
export const PROMPT_CATEGORIES = ['图像生成','视频生成','编程','自动化','研究','社媒内容','其他'];
export const CONTENT_PROMPTS = Object.fromEntries(['classify','classify_detail','editorial','group','synthesis','verify','watch'].map(name =>
  [name,readFileSync(new URL(`../content/pipeline/${name}.md`,import.meta.url),'utf8')]));
export const CONTENT_POLICY = Object.freeze({minConfidence:0.8,groupConfidence:0.88,verifyConfidence:0.85,
  selectionScore:65,groupCandidates:8,groupSources:12,maxSourceChars:18000,maxAttempts:3,leaseMs:10*60_000,
  defaultDailyCalls:40,defaultHourlyCalls:12});
export const hashContent = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CONTENT_VERSION = `bookmarks-v2-${hashContent({prompts:CONTENT_PROMPTS,kinds:CONTENT_KINDS,weights:WEIGHTS,policy:CONTENT_POLICY}).slice(0,12)}`;
export const parseContentJson = (text,fallback = {}) => {try{return JSON.parse(text);}catch{return fallback;}};
const schemaObject=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schemaText={type:'string'};
const schemaList=items=>({type:'array',items});
const confidenceSchema={type:'number',minimum:0,maximum:1};
const boundedText=maxLength=>({type:'string',minLength:1,maxLength});
const articleSchema={title:boundedText(240),summary:boundedText(1200),sections:{...schemaList(schemaObject({heading:boundedText(120),text:boundedText(4000),
  evidence:{...schemaList(schemaObject({sourceId:{type:'integer'},quote:{type:'string',minLength:4,maxLength:1600}})),minItems:1,maxItems:8}})),maxItems:12},
  limitations:{...schemaList(boundedText(600)),maxItems:12}};
export const CONTENT_SCHEMAS={
  classify_detail:schemaObject({kind:{type:'string',enum:Object.keys(CONTENT_KINDS)},assets:schemaList({type:'string',enum:Object.keys(CONTENT_KINDS)}),
    sufficiency:{type:'string',enum:['complete','incomplete']},confidence:confidenceSchema,reason:schemaText}),
  verify:schemaObject({supported:{type:'boolean'},confidence:confidenceSchema,issues:schemaList(schemaText)}),
  group:schemaObject({groupId:{type:['integer','null']},relation:{type:'string',enum:['new','same_problem','same_event','related']},confidence:confidenceSchema,reason:schemaText}),
  editorial:schemaObject({...articleSchema,problem:schemaText,topics:schemaList(schemaText),uses:schemaList(schemaText),
    scores:schemaObject(Object.fromEntries(AXES.map(axis=>[axis,{type:'integer',minimum:0,maximum:10}]))),
    scoreReasons:schemaObject(Object.fromEntries(AXES.map(axis=>[axis,schemaText]))),promptText:schemaText,promptCategory:{type:'string',enum:PROMPT_CATEGORIES}}),
  synthesis:schemaObject(articleSchema),
  watch:schemaObject({title:schemaText,summary:schemaText,claimType:{type:'string',enum:['announcement','opinion','unverified','promotion','tutorial']},
    topics:schemaList(schemaText),evidenceQuote:schemaText,eventId:{type:['integer','null']},sameEventConfidence:confidenceSchema,eventReason:schemaText}),
};
const reject = message => {throw Object.assign(new Error(message),{code:'invalid_result'});};
const text = (value,max,required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) reject('整理结果字段无效');
  return value.trim();
};
export function contentScore(kind,scores,reasons) {
  if (!WEIGHTS[kind] || !scores || !reasons) reject('整理评分无效');
  for (const axis of AXES) {
    if (!Number.isInteger(scores[axis]) || scores[axis]<0 || scores[axis]>10) reject('评分必须为 0 到 10 的整数');
    text(reasons[axis],600);
  }
  return AXES.reduce((sum,axis,index) => sum + scores[axis]*WEIGHTS[kind][index],0);
}
export function validateArticle(value,sources,{editorial = false,kind = 'reference',assets=[kind]} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('整理结果不是对象');
  const result = {title:text(value.title,240),summary:text(value.summary,1200),sections:[],limitations:[]};
  if (!/[\u4e00-\u9fff]/.test(result.title+result.summary)) reject('整理结果缺少中文说明');
  if (!Array.isArray(value.sections) || value.sections.length>12) reject('整理段落无效');
  const map = new Map(sources.map(source=>[Number(source.id),source]));
  result.sections = value.sections.map(section=>{
    const heading=text(section.heading,120),body=text(section.text,4000);
    if (!Array.isArray(section.evidence) || !section.evidence.length) reject('段落缺少原文证据');
    if(section.evidence.length>8)reject('单段引用超过 8 条，请拆分段落');
    const evidence=section.evidence.map(item=>{
      if (!Number.isSafeInteger(item.sourceId) || !map.has(item.sourceId)) reject('引用了未提供的来源');
      const quote=text(item.quote,1600),source=map.get(item.sourceId);
      if (quote.length<4 || !`${source.content}\n${source.quotedText||''}`.includes(quote)) reject('引用摘录不在原文中');
      return {sourceId:item.sourceId,quote};
    });
    return {heading,text:body,evidence};
  });
  if (!Array.isArray(value.limitations) || value.limitations.length>12) reject('材料限制无效');
  result.limitations=value.limitations.map(v=>text(v,600));
  if (editorial) {
    result.problem=text(value.problem,240);
    if (!Array.isArray(value.topics) || value.topics.length>8) reject('主题无效');
    result.topics=[...new Set(value.topics.map(v=>text(v,40)))];
    if(!Array.isArray(value.uses)||value.uses.length>8)reject('使用场景无效');
    result.uses=[...new Set(value.uses.map(v=>text(v,60)))];
    result.assets=assets;
    result.scores=value.scores;result.scoreReasons=value.scoreReasons;
    result.score=contentScore(kind,value.scores,value.scoreReasons);
    result.promptText=text(value.promptText,18000,false);
    result.promptCategory=PROMPT_CATEGORIES.includes(value.promptCategory)?value.promptCategory:'其他';
    if (result.promptText && !sources.some(s=>`${s.content}\n${s.quotedText||''}`.includes(result.promptText))) reject('提示词必须保留原文');
    if (!assets.includes('prompt')) result.promptText='';
    if (assets.includes('prompt') && !result.promptText) reject('没有完整的任务提示词');
  }
  return result;
}
export function articleMarkdown(article) {
  return article.sections.map(section=>`## ${section.heading}\n\n${section.text}\n\n${[...new Set(section.evidence.map(e=>`[S:${e.sourceId}]`))].join(' ')}`).join('\n\n')+
    (article.limitations.length?`\n\n## 适用边界与缺失材料\n\n${article.limitations.map(x=>`- ${x}`).join('\n')}`:'');
}
