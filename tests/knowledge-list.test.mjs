import test from 'node:test';
import assert from 'node:assert/strict';
import {compactKnowledgeList} from '../lib/knowledge-list.js';

test('compact directory preserves every ID and filter field while bounding previews', () => {
  const rows = [{id:'method-2', updatedAt:'2026-10-26 00:00:00', title:'早', summary:'🙂'.repeat(500), tags:['产品与设计'], body:'private body'},
    {id:'archive-3', updatedAt:'2026-10-26T01:00:00Z', title:'晚', summary:'完整摘要', sourceInboxId:3}];
  const input = structuredClone(rows), calls=[];
  const result = compactKnowledgeList(rows, id => {calls.push(id); return {id,body:'首篇原文',sources:[]};});
  assert.deepEqual(result.map(row=>row.id), ['archive-3','method-2']);
  assert.deepEqual(calls,['archive-3']);
  assert.equal(result[0].initialDetail.body,'首篇原文');
  assert.equal(Array.from(result[1].summary).length,121);
  assert.deepEqual(result[1].tags,['产品与设计']);
  assert.ok(result.every(row=>!Object.hasOwn(row,'body')));
  assert.deepEqual(rows,input);
});

test('large first article stays on demand and an empty directory performs no detail read', () => {
  const result=compactKnowledgeList([{id:1}],id=>({id,body:'原文'.repeat(12000)}));
  assert.equal(result[0].initialDetail,undefined);
  assert.deepEqual(compactKnowledgeList([],()=>assert.fail('empty read')),[]);
  assert.equal(compactKnowledgeList([{id:'archive-1'}],()=>assert.fail('large archive must stay on demand'),()=>false)[0].initialDetail,undefined);
});
