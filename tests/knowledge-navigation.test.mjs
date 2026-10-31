import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/refinery.jsx',import.meta.url),'utf8');
const order = readFileSync(new URL('../public/library-order.js',import.meta.url),'utf8');
const context = vm.createContext({URLSearchParams});
vm.runInContext(order,context);
vm.runInContext(source.slice(source.indexOf('function knowledgeMethodTools'),source.indexOf('function knowledgePlainText')),context);
vm.runInContext(source.split('// <knowledge-navigation>')[1].split('// </knowledge-navigation>')[0],context);
const {knowledgeKind:kind,knowledgeTopics:topics,knowledgeCompare:compare} = context;
test('source archives have a separate type and multi-topic methods remain discoverable',()=>{
  assert.equal(kind({type:'source_archive'}),'archive');
  assert.equal(kind({type:'manual'}),'article');
  assert.deepEqual([...topics({type:'method',tags:['Claude + Codex','安装技能']})],['Claude','Codex']);
  assert.deepEqual([...topics({tags:['AI','AI','视频']})],['AI','视频']);
});
test('search ranks a title match above newer body matches, with a reliable date tie-break',()=>{
  const a={id:'a',title:'Skill',updatedAt:'2020-01-01'},b={id:'b',title:'Other',updatedAt:'2026-01-01'};
  assert.ok(compare(a,b,{query:'skill',sort:'auto',shelf:'all',personal:{},hits:new Map([['b',{score:20}]])})<0);
  assert.ok(compare(a,b,{query:'skill',sort:'updated',shelf:'all',personal:{}})>0);
});
test('personal shelves use the personal dates, without changing ordinary browsing order',()=>{
  const a={id:1,title:'A',updatedAt:'2026-01-01'},b={id:2,title:'B',updatedAt:'2025-01-01'};
  const personal={'1':{savedAt:'2026-01-01',readAt:'2026-03-01'},'2':{savedAt:'2026-02-01',readAt:'2026-01-01'}};
  assert.ok(compare(a,b,{sort:'auto',shelf:'saved',personal})>0);
  assert.ok(compare(a,b,{sort:'auto',shelf:'recent',personal})<0);
  assert.ok(compare(a,b,{sort:'auto',shelf:'all',personal})<0);
});

test('article routes preserve scope and distinguish leaving the knowledge module',()=>{
  const {knowledgeArticleHash,knowledgeRouteArticle}=context;
  assert.equal(knowledgeArticleHash('#knowledgeLibrary?space=mine','method-2'),'#knowledgeLibrary?space=mine&article=method-2');
  assert.equal(knowledgeArticleHash('#knowledgeLibrary?space=mine&article=method-2',null),'#knowledgeLibrary?space=mine');
  assert.equal(knowledgeRouteArticle('#knowledgeLibrary?space=public&article=archive-3'),'archive-3');
  assert.equal(knowledgeRouteArticle('#knowledgeLibrary?space=mine'),null);
  assert.equal(knowledgeRouteArticle('#knowledgeLibrary?article=../../private'),null);
  assert.equal(knowledgeRouteArticle('#settings?category=ai'),undefined);
});
