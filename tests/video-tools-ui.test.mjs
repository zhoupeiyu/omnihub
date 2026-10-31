import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/video-tools.jsx',import.meta.url),'utf8').split('const VIDEO_TOOL_CATALOG')[0];
test('a lost POST response times out without repeating the request',async()=>{
  let calls=0,delay;
  const context=vm.createContext({AbortController,Error,setTimeout:(fn,ms)=>{delay=ms;return setTimeout(fn,5);},clearTimeout,
    api:async(_path,options)=>{calls++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Aborted'))));}});
  vm.runInContext(source,context);
  await assert.rejects(context.videoToolApi('/api/tools/video/batch',{method:'POST',body:{text:'one'}}),/网络响应超时/);
  assert.equal(calls,1);assert.equal(delay,30000);
});
test('tool requests honor screen cancellation without reporting it as a timeout',async()=>{
  const context=vm.createContext({AbortController,Error,setTimeout,clearTimeout,
    api:async(_path,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Screen cancelled'))))});
  vm.runInContext(source,context);
  const controller=new AbortController();const request=context.videoToolApi('/api/tools/video/jobs',{signal:controller.signal});controller.abort();
  await assert.rejects(request,/Screen cancelled/);
});
test('parsed selection loads its preview once without starting hidden or failed jobs',()=>{
  const attempted={current:new Set()};
  const context=vm.createContext({Set,React:{useRef:()=>attempted,useEffect:fn=>fn()}});
  vm.runInContext(source,context);
  const calls=[];
  const onPrepare=(job)=>calls.push(job.id);
  const render=(active,id,state='parsed',error='')=>context.useAutomaticMediaPreview({active,job:{id,state,error},onPrepare});
  render(false,'hidden'); render(true,'pending','parsing'); render(true,'failed','parsed','File unavailable');
  assert.deepEqual(calls,[]);
  render(true,'first'); render(true,'first'); render(false,'first'); render(true,'first');
  assert.deepEqual(calls,['first']);
  render(true,'second'); render(true,'first','saved');
  assert.deepEqual(calls,['first','second']);
});
test('media previews leave capacity for video and release image slots exactly once',()=>{
  const fullSource=readFileSync(new URL('../public/video-tools.jsx',import.meta.url),'utf8');
  const scheduler=fullSource.slice(fullSource.indexOf('const mediaImageTasks'),fullSource.indexOf('function MediaThumbnail'));
  const context=vm.createContext({});
  vm.runInContext(scheduler,context);
  const started=[];
  const first=context.scheduleMediaImage(()=>started.push(1));
  const second=context.scheduleMediaImage(()=>started.push(2));
  const third=context.scheduleMediaImage(()=>started.push(3));
  const cancelled=context.scheduleMediaImage(()=>started.push(4));
  assert.deepEqual(started,[1,2]);
  cancelled(); first(); first();
  assert.deepEqual(started,[1,2,3]);
  const fifth=context.scheduleMediaImage(()=>started.push(5));
  assert.deepEqual(started,[1,2,3]);
  second(); assert.deepEqual(started,[1,2,3,5]);
  third(); fifth();
});

test('expanded hosts route to media jobs while original hosts stay on legacy API',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});
  vm.runInContext(source,context);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('分享 https://youtu.be/abc123?si=x'),true);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://vimeo.com/123'),true);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://x.com/a/status/1'),true);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://instagram.com/p/abc'),true);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://soundcloud.com/a/b'),true);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://www.douyin.com/video/123'),false);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://www.bilibili.com/video/BV1'),false);
  assert.equal(vm.runInContext('mediaNeedsNewDownload',context)('https://notyoutube.com/a'),false);
});
test('processing links preserve source engine, job and file for refresh',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});
  vm.runInContext(source,context);
  const href=vm.runInContext('mediaProcessHref',context)({engine:'media',id:'job-1'},{name:'clip.mp4',type:'video/mp4'},'mine');
  const p=new URLSearchParams(href.split('?')[1]);
  assert.equal(p.get('tab'),'process');assert.equal(p.get('space'),'mine');
  assert.equal(p.get('sourceEngine'),'media');assert.equal(p.get('sourceJob'),'job-1');
  assert.equal(p.get('sourceFile'),'clip.mp4');assert.equal(p.get('sourceType'),'video/mp4');
  assert.equal(vm.runInContext('mediaFileHref',context)({engine:'media',id:'job-1'},{name:'clip.mp4'},true),'/api/tools/media/jobs/job-1/files/clip.mp4?inline=1');
});
test('advanced media capability gates use the server contract and never enable AI stubs',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams,window:{}});
  vm.runInContext(source,context);
  const key=vm.runInContext('mediaFeatureKey',context),available=vm.runInContext('mediaFeatureAvailable',context);
  assert.equal(key('separate'),'separation');
  assert.equal(available({},'separate'),false);
  assert.equal(available({separation:true},'separate'),true);
  assert.equal(available({},'edit'),false);
  assert.equal(available({edit:true},'edit'),true);
  assert.equal(available({},'gallery'),false);
  assert.equal(available({gallery:true},'gallery'),true);
  assert.equal(available({},'concat'),false);
  assert.equal(available({concat:true},'concat'),true);
});
test('standalone uploads persist their selected job while processing uploads defer navigation',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8');
  assert.match(source,/const upload = async \(navigate = true\)/);
  assert.match(source,/if\(navigate\) window\.location\.hash/);
  assert.match(source,/const saved = await upload\(false\)/);
  assert.match(source,/item\.operation === 'gallery'/);
});

test('audio trims without source MIME remain identifiable from their output',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});vm.runInContext(source,context);
  const audio=vm.runInContext('mediaIsAudioJob',context),label=vm.runInContext('mediaOperationLabel',context);
  const trimmed={operation:'trim',source:{engine:'media',jobId:'original',fileName:'source.mp3'},files:[{name:'output.mp3',type:'audio/mpeg'}]};
  assert.equal(audio(trimmed),true);assert.equal(label(trimmed),'裁剪音频');
  assert.equal(audio({operation:'trim',files:[{type:'video/mp4'},{type:'audio/mpeg'}]}),false);
  assert.equal(audio({operation:'trim',source:{type:'audio/wav'},files:[]}),true);
  assert.equal(audio({operation:'trim',files:[]}),false);
});

test('subtitle history routes reopen the subtitle workspace after refresh',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});vm.runInContext(source,context);
  const href=vm.runInContext('mediaJobHref',context);
  const p=new URLSearchParams(href('subtitles','mine','job-1').split('?')[1]);
  assert.equal(p.get('tab'),'transcribe');assert.equal(p.get('textMode'),'subtitles');
  assert.equal(p.get('space'),'mine');assert.equal(p.get('job'),'job-1');
  assert.equal(new URLSearchParams(href('audio','public','job-2').split('?')[1]).get('tab'),'audio');
});

test('library source handoff preserves the originating operation and scope',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});vm.runInContext(source,context);
  const library=vm.runInContext('mediaLibraryHref',context),process=vm.runInContext('mediaProcessHref',context);
  for(const [mode,operation,tab] of [['process','concat','process'],['audio','audio','audio'],['subtitles','subtitles','transcribe'],['image','remove-background','image']]) {
    const pick=new URLSearchParams(library(mode,'mine',operation).split('?')[1]);
    assert.equal(pick.get('pickFor'),mode);assert.equal(pick.get('operation'),operation);assert.equal(pick.get('space'),'mine');
    const back=new URLSearchParams(process({engine:'media',id:'job-1'},{name:'input.mp4',type:'video/mp4'},pick.get('space'),pick.get('pickFor'),pick.get('operation')).split('?')[1]);
    assert.equal(back.get('tab'),tab);assert.equal(back.get('operation'),operation);assert.equal(back.get('space'),'mine');
    assert.equal(back.get('sourceJob'),'job-1');assert.equal(back.get('sourceFile'),'input.mp4');
    if(mode==='subtitles')assert.equal(back.get('textMode'),'subtitles');
  }
});

test('library selection offers compatible files and routes video to audio extraction',()=>{
  const source=readFileSync(new URL('../public/media-processing.jsx',import.meta.url),'utf8').split('function useMediaJobs')[0];
  const context=vm.createContext({URL,URLSearchParams});vm.runInContext(source,context);
  const pick=vm.runInContext('mediaPickFile',context),href=vm.runInContext('mediaProcessHref',context),validate=vm.runInContext('mediaModeOperation',context);
  const video={name:'clip.mp4',type:'video/mp4'},audio={name:'track.mp3',type:'audio/mpeg'},image={name:'frame.png',type:'image/png'};
  assert.equal(pick({files:[video]},'audio','trim'),undefined);
  assert.equal(pick({files:[audio]},'audio','audio'),undefined);
  assert.equal(pick({files:[audio,video]},'audio','audio'),video);
  assert.equal(pick({files:[video,audio]},'audio','trim'),audio);
  assert.equal(pick({files:[image,video]},'subtitles','subtitles'),video);
  assert.equal(pick({files:[image,audio]},'process','concat'),undefined);
  assert.equal(pick({files:[video,image]},'image','remove-background'),image);
  assert.equal(validate('audio','remove-background'),'');
  assert.equal(new URLSearchParams(href({id:'1'},video,'public','audio').split('?')[1]).get('operation'),'audio');
  assert.equal(new URLSearchParams(href({id:'1'},audio,'public','audio').split('?')[1]).get('operation'),'trim');
});
