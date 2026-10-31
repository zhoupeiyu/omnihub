import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const fullSource=readFileSync(new URL('../public/video-tools.jsx',import.meta.url),'utf8');
const helperSource=fullSource.slice(fullSource.indexOf('const videoHandoffInput'),fullSource.indexOf('const videoBusy'));

test('discovery input handoff fills download and collection shells after their first async mount',()=>{
  const context=vm.createContext({URLSearchParams});
  vm.runInContext(helperSource,context);
  const handoff=vm.runInContext('videoHandoffInput',context);
  const url='https://www.bilibili.com/video/BV1h34y1t7gg';
  assert.equal(handoff(new URLSearchParams({tab:'download',input:url})),url);
  assert.equal(handoff(new URLSearchParams({tab:'collections',input:url})),url);
  assert.equal(handoff(new URLSearchParams({text:'legacy text'})),'legacy text');
  assert.equal(handoff(new URLSearchParams({text:'stale',input:''})),'');
  assert.match(fullSource,/videoHandoffInput\(initialParams\)/);
  assert.match(fullSource,/params\.has\("input"\) \|\| params\.has\("text"\)/);
});
