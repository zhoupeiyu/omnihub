import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/media-watch.jsx',import.meta.url),'utf8').split('function MediaWatchPanel')[0];
test('watch UI preserves safe handoff, supported intervals, and only renders recorded metrics',()=>{
  const context=vm.createContext({URLSearchParams,Date});
  vm.runInContext(source,context);
  const href=vm.runInContext('mediaWatchDownloadHref',context)('https://www.douyin.com/video/1','mine');
  const params=new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('tab'),'download');assert.equal(params.get('space'),'mine');assert.equal(params.get('input'),'https://www.douyin.com/video/1');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('MEDIA_WATCH_INTERVALS',context))).map(item=>item.value),[21600000,43200000,86400000]);
  const metrics=vm.runInContext('mediaWatchMetrics',context);
  assert.deepEqual(Array.from(metrics({playCount:12,commentCount:0,shareCount:null})),['播放 12','评论 0']);
  const full=readFileSync(new URL('../public/media-watch.jsx',import.meta.url),'utf8');
  assert.match(full,/setItems\(\{\}\);setSnapshots\(\[\]\);setSnapshotContent\(null\)/);
  assert.match(full,/enabled:\!watch\.enabled/);
  assert.match(full,/if\(result\)void loadItems\(watch\)/);
  assert.match(full,/正在确认记录归属/);
  assert.doesNotMatch(full,/setInterval\(/);
});
