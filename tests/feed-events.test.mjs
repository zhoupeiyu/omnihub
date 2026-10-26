import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/workspace-data.js',import.meta.url),'utf8');
const {groupFeedEvents}=vm.runInNewContext(source+';({groupFeedEvents})',{URL,URLSearchParams});
const row=(title,extra={})=>({title,summary:'',url:'',publishedAt:'2026-10-24T00:00:00Z',...extra});
test('event grouping joins distinctive reports without losing originals or merging broad topics',()=>{
 const rows=[row('PHP2Shell 漏洞披露与修复进展'),row('安全研究员分析 PHP2Shell 攻击事件',{summary:'新增补丁部署范围与受影响版本。'}),row('OpenAI 发布新的 API'),row('OpenAI 训练环境的安全测试'),row('Kimi 发布 K3.1 Pro'),row('Kimi K3.1 Pro 上线，开放模型权重'),row('Kimi K3.1 Pro 部署教程')];
 const events=groupFeedEvents(rows);
 assert.equal(events.length,5);
 assert.equal(events[0].related[0].item,rows[1]);
 assert.equal(events.reduce((n,event)=>n+1+event.related.length,0),rows.length);
 assert.match(events[0].related[0].supplement[0],/补丁/);
 assert.equal(events.find(event=>event.item===rows[4]).related.length,1);
});
test('same identifier outside event window or different event action remains separate',()=>{
 const rows=[row('ExampleV2 发布新版本'),row('ExampleV2 发布新版本',{publishedAt:'2026-10-28T00:00:00Z'}),row('ExampleV2 被攻击，发现安全漏洞')];
 assert.equal(groupFeedEvents(rows).length,3);
});
test('canonical URLs remove tracking while preserving distinct article identifiers',()=>{
 const rows=[row('第一篇报道',{url:'https://example.com/article?id=1&utm_source=x'}),row('转发标题',{url:'https://www.example.com/article?id=1&ref=feed'}),row('另一篇报道',{url:'https://example.com/article?id=2'})];
 const events=groupFeedEvents(rows);assert.equal(events.length,2);assert.equal(events[0].related.length,1);
 assert.equal(groupFeedEvents([row('短标题',{url:'https://example.com/'}),row('短标题',{url:'https://example.com/'})]).length,2);
});
