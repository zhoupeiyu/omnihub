import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

const file=new URL('../public/drive-content-preview.jsx',import.meta.url);
const source=readFileSync(file,'utf8');

test('preview component compiles and exposes browser-only preview contract',()=>{
  assert.doesNotThrow(()=>transformSync(source,{loader:'jsx',target:'es2020'}));
  for(const required of ['IntersectionObserver','MAX_IN_FLIGHT = 2','/api/openlist/file?','disableAutoFetch:true','disableStream:true','cache:\'no-store\'','video.removeAttribute(\'src\')','URL.revokeObjectURL']) assert.ok(source.includes(required),required);
});

test('preview deadline starts from queued job execution and timeout settles the card state',()=>{
  const jobStart=source.indexOf('cancel=enqueue(async()=>{deadline=setTimeout');
  const mountStart=source.indexOf('setPreview(null);setState(\'loading\')');
  assert.ok(jobStart>mountStart,'deadline must be created after lazy mount state');
  assert.ok(source.includes("timedOut=true;if(active)setState('failed');controller.abort"),'deadline marks a real timeout');
  assert.ok(source.includes("if(active)setState('failed')"),'timeout/failures finish loading state');
});

function runtime(){
  const script=transformSync(source,{loader:'jsx',format:'iife'}).code;
  const context={window:{},URLSearchParams,console};
  new Function('window','URLSearchParams','console',script)(context.window,URLSearchParams,console);
  return context.window.OmniDrivePreview;
}

test('only real, indexed preview candidates are considered',()=>{
  const api=runtime();
  const rows=api.validCandidates([
    {path:'/夸克网盘/80-素材库/a.jpg',kind:'image'},{path:'/夸克网盘/80-素材库/a.jpg',kind:'image'}, {path:'https://bad.example/a.jpg',kind:'image'},
    {path:'/夸克网盘/80-素材库/audio.mp3',kind:'audio'}, {path:'/夸克网盘/30-课程教程/deck.pdf',kind:'pdf'}, {path:'/夸克网盘/30-课程教程/movie.mp4',kind:'video'}, {path:'/夸克网盘/20-电子书/book.epub',kind:'epub'}, {path:'/夸克网盘/60-技术开发/readme.md',kind:'code'}
  ]);
  assert.deepEqual(rows.map(x=>x.path),['/夸克网盘/80-素材库/a.jpg','/夸克网盘/80-素材库/audio.mp3','/夸克网盘/30-课程教程/deck.pdf']);
  assert.throws(()=>api.fileUrl('https://bad.example/a.jpg'));
  assert.throws(()=>api.fileUrl('/夸克网盘/80-素材库/../secret.jpg'));
  assert.equal(api.__test.candidateState([]),'failed');
});

test('text and audio previews derive readable real-content primitives without HTML execution',()=>{
  const api=runtime();
  assert.deepEqual(api.__test.textLines('标题\n<script>alert(1)</script>\n\u0000第二行\n\n第三行'),['标题','<script>alert(1)</script>','第二行','第三行']);
  const peaks=api.__test.waveformPoints(Float32Array.from([0,.1,-.8,.3,-.5,0]),3);
  assert.deepEqual(peaks.map(value=>Number(value.toFixed(2))),[.1,.8,.5]);
  assert.equal(api.validCandidates([{path:'/夸克网盘/80-素材库/music.mp3',kind:'audio'}]).length,1);
});

test('collections preserve several real previews and never label one item as the collection cover',()=>{
  const api=runtime();
  const first={type:'canvas',src:'data:image/jpeg,one',alt:'第一项'};
  const second={type:'canvas',src:'data:image/jpeg,two',alt:'第二项'};
  const mosaic=api.__test.collectionPreview([first,second]);
  assert.equal(mosaic.type,'mosaic');assert.deepEqual(mosaic.items,[first,second]);assert.equal(mosaic.alt,'合集内容预览');
  const single=api.__test.collectionPreview([first]);
  assert.equal(single.type,'canvas');assert.equal(single.alt,'内容预览');
});

test('preview cache is bounded by LRU item and byte limits',()=>{
  const api=runtime();
  for(let n=0;n<70;n++)api.__test.cachePut('k'+n,{type:'canvas',src:'data:image/jpeg,'+'x'.repeat(100)});
  assert.equal(api.__test.cacheStats().items,64);
  assert.equal(api.__test.cacheGet('k0'),undefined);
  api.__test.cachePut('oversize',{type:'canvas',src:'x'.repeat(24*1024*1024)});
  assert.equal(api.__test.cacheStats().items,64);
  assert.ok(api.__test.cacheStats().bytes<=16*1024*1024);
});

test('queue runs two jobs, skips cancelled pending work, then drains',async()=>{
  const api=runtime(),started=[],release=[];
  const job=id=>async()=>{started.push(id);await new Promise(resolve=>release.push(resolve));};
  api.__test.enqueue(job('a'));api.__test.enqueue(job('b'));const cancel=api.__test.enqueue(job('c'));
  assert.deepEqual(started,['a','b']);assert.deepEqual(api.__test.queueStats(),{inFlight:2,pending:1});
  cancel();release.shift()();release.shift()();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(started,['a','b']);assert.deepEqual(api.__test.queueStats(),{inFlight:0,pending:0});
});


test('aborting a reader releases its slot even if the underlying reader never settles',async()=>{
  const api=runtime(),a=new AbortController(),b=new AbortController(),started=[];
  const stuck=id=>async()=>{started.push(id);await new Promise(()=>{});};
  api.__test.enqueue(stuck('a'),a.signal);api.__test.enqueue(stuck('b'),b.signal);
  api.__test.enqueue(async()=>{started.push('next');});
  a.abort();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(started,['a','b','next']);
  b.abort();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(api.__test.queueStats(),{inFlight:0,pending:0});
});
