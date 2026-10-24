import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/refinery.jsx',import.meta.url),'utf8');
const context = vm.createContext({AbortController});
vm.runInContext(source.slice(source.indexOf('function knowledgePlainText'),source.indexOf('function KnowledgeHighlight')),context);
const {knowledgeSearchMatch:search,knowledgeSummaryIsRepeated:repeated,createKnowledgeDetailStore:createStore} = context;
const item = {title:'视频提示词',summary:'整理镜头结构',tags:['Seedance']};

test('search finds body-only phrases and original instructions with useful snippets',()=>{
  const detail = {body:'## 连续性锚点\n\n用人物或道具连接镜头。[S:123]',promptText:'Read DEV_STATE.md before changing code.'};
  assert.match(search(item,detail,'连续性锚点').snippet,/连续性锚点/);
  assert.match(search(item,detail,'dev_state.md').snippet,/DEV_STATE.md/);
  assert.match(search(item,{promptText:'<instructions>Be precise.</instructions>'},'instructions').snippet,/<instructions>/);
  assert.match(search(item,detail,'seedance').snippet,/Seedance/);
  assert.equal(search(item,detail,'不存在的关键词'),null);
  assert.equal(search(item,null,'连续性锚点'),null);
  assert.equal(search(item,null,'  ').snippet,item.summary);
  assert.match(search(item,{body:'前文'.repeat(60)+'需要找到的段落'+'后文'.repeat(70)},'需要找到的段落').snippet,/^….*需要找到的段落.*…$/);
});

test('duplicate introduction hides only the summary, keeping citations in the body',()=>{
  const body='第一句。[S:123]\n\n第二句。\n\n## 正文';
  assert.equal(repeated({summary:'第一句。 第二句。',body}),true);
  assert.equal(repeated({summary:'不同的导读',body}),false);
  assert.equal(repeated({summary:'',body}),false);
});

test('detail reads deduplicate concurrent search and reader requests',async()=>{
  let calls=0;
  const store=createStore(async id=>{calls++;return {id,body:'正文'};});
  const [first,second]=await Promise.all([store.load(1),store.load('1')]);
  assert.equal(calls,1);assert.equal(first,second);
  await store.load(1);assert.equal(calls,1);
  assert.equal(store.peek(1),first);
  store.dispose();assert.equal(store.peek(1),undefined);
});

test('failed reads can be retried and disposed catalogues cannot retain late data',async()=>{
  let calls=0;
  const store=createStore(async()=>{if(!calls++)throw new Error('offline');return {body:'ok'};});
  await assert.rejects(store.load(1),/offline/);
  assert.equal((await store.load(1)).body,'ok');
  let release, signal;
  const old=createStore((id,requestSignal)=>{signal=requestSignal;return new Promise(resolve=>{release=resolve;});});
  const pending=old.load(2);await Promise.resolve();old.dispose();
  assert.equal(signal.aborted,true);release({body:'old scope'});await pending;
  assert.equal(old.peek(2),undefined);await assert.rejects(old.load(2),/disposed/);
  store.dispose();
});
