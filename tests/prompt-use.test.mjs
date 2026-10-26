import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const c=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/prompt-use.js',import.meta.url),'utf8'),c);
test('variables are unique, complete and do not treat JSON/CSS as fillable fields',()=>{
 const text='{主题} {{style}} {主题} {a} {b} {c} {d} {e} {f} {"json":true} {color:red;}';
 assert.deepEqual(Array.from(c.promptTemplateNames(text)),['主题','style','a','b','c','d','e','f']);
});
test('replacement is literal, single-pass and leaves missing inputs visible',()=>{
 assert.equal(c.fillPromptTemplate('{a} + {b} + {{a}}',{a:'$& {b}'}),'$& {b} + {b} + $& {b}');
 assert.equal(c.fillPromptTemplate('a {主题} b',{主题:'纸飞机'}),'a 纸飞机 b');
});
test('only explicit media categories enter generation and video uses video module',()=>{
 for (const category of ['视频','视频生成']) assert.equal(c.promptCreationModule({category}),'seedance');
 for (const category of ['图像','图像生成']) assert.equal(c.promptCreationModule({category}),'image');
 for (const category of ['编程','Agent','学习','研究','自动化']) assert.equal(c.promptCreationModule({category}),null);
});
