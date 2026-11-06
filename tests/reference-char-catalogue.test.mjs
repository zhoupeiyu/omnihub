import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCharCatalogue} from '../lib/reference-char-catalogue.js';
const item={id:'P001',set:'pose',zh:'站姿',catZh:'站姿',tags:'standing, full body',line:true};
const input=items=>'window.CHARDB='+JSON.stringify({items})+';';
test('isolates ids and retains source tags and line art',()=>{
 const [row]=parseCharCatalogue(input([item])); assert.equal(row.id,'pose:taki-P001');
 assert.equal(row.collectionId,'taki-anime-reference');assert.ok(row.tags.includes('full body'));
 assert.equal(row.lineSourceUrl,'https://charadb-2fi.pages.dev/line/P001.png');
});
test('rejects executable source, duplicate ids, unknown sets and unsafe paths',()=>{
 for(const source of [input([item])+'alert(1)',input([item,item]),input([{...item,set:'bad'}]),input([{...item,id:'../x'}])]) assert.throws(()=>parseCharCatalogue(source));
});
