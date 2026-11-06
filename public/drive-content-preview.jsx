/*
 * Card previews are deliberately browser-only.  They are created from the
 * already authorised OpenList file endpoint and never create a server cache.
 */
(function () {
  const previewCache = new Map();
  const CACHE_ITEMS = 64, CACHE_BYTES = 16 * 1024 * 1024;
  let cacheBytes = 0;
  const scriptCache = new Map();
  const MAX_IN_FLIGHT = 2;
  let inFlight = 0;
  const pending = [];

  function validPath(path) {
    return typeof path==='string' && /^\/夸克网盘\/(?:20-电子书|30-课程教程|40-副业变现|50-AI资源|60-技术开发|70-投资理财|80-素材库)(?:\/|$)/.test(path) && !/[\\\x00-\x1f]/.test(path) && !path.split('/').some(part=>part==='.'||part==='..');
  }
  function fileUrl(path) {
    if (!validPath(path)) throw new Error('预览文件路径无效');
    return '/api/openlist/file?' + new URLSearchParams({ path });
  }
  function estimatedBytes(value) { return Math.ceil(String(value?.src||'').length * .75); }
  function cacheGet(key) { const value=previewCache.get(key); if(value){previewCache.delete(key);previewCache.set(key,value);} return value?.value; }
  function cachePut(key,value) {
    if(value.type==='object-url')return; const bytes=estimatedBytes(value); if(bytes>CACHE_BYTES)return;
    const old=previewCache.get(key); if(old){cacheBytes-=old.bytes;previewCache.delete(key);} previewCache.set(key,{value,bytes});cacheBytes+=bytes;
    while(previewCache.size>CACHE_ITEMS || cacheBytes>CACHE_BYTES){const first=previewCache.entries().next().value;if(!first)break;previewCache.delete(first[0]);cacheBytes-=first[1].bytes;}
  }
  function runQueued() {
    while (inFlight < MAX_IN_FLIGHT && pending.length) {
      const job = pending.shift();
      if (job.cancelled || job.signal?.aborted) continue;
      inFlight++;
      let release;
      const aborted = new Promise(resolve => { release = resolve; job.signal?.addEventListener('abort', release, {once:true}); });
      // A reader may never settle its destroy promise after navigation. An
      // aborted job must still release its queue slot for the next visible card.
      Promise.race([job.run(), aborted]).catch(() => {}).finally(() => {
        job.signal?.removeEventListener('abort', release); inFlight--; runQueued();
      });
    }
  }
  function enqueue(run, signal) {
    const job = { run, signal, cancelled:false };
    pending.push(job); runQueued();
    return () => { job.cancelled = true; };
  }
  function waitFor(target, event, signal, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if(signal?.aborted){reject(signal.reason || new DOMException('Aborted','AbortError'));return;}
      const timer = setTimeout(() => finish(new Error('预览读取超时')), timeout);
      const abort = () => finish(signal.reason || new DOMException('Aborted','AbortError'));
      const done = () => finish();
      const fail = () => finish(new Error('预览文件无法读取'));
      function finish(error) {
        clearTimeout(timer); target.removeEventListener(event,done); target.removeEventListener('error',fail);
        signal?.removeEventListener('abort',abort); error ? reject(error) : resolve();
      }
      target.addEventListener(event,done,{once:true}); target.addEventListener('error',fail,{once:true});
      signal?.addEventListener('abort',abort,{once:true});
    });
  }
  function throwIfAborted(signal) { if(signal?.aborted)throw signal.reason || new DOMException('Aborted','AbortError'); }
  function script(src) {
    if (!scriptCache.has(src)) scriptCache.set(src,new Promise((resolve,reject) => {
      const tag=document.createElement('script'); tag.src=src; tag.async=true;
      tag.onload=resolve; tag.onerror=()=>{tag.remove();scriptCache.delete(src);reject(new Error('阅读器组件加载失败'));}; document.head.append(tag);
    }));
    return scriptCache.get(src);
  }
  async function imagePreview(candidate, signal) {
    const image=new Image(); image.decoding='async';
    try { const loaded=waitFor(image,'load',signal);image.src=fileUrl(candidate.path);await loaded; await image.decode?.().catch(()=>{});throwIfAborted(signal);return { type:'image', src:image.src, alt:candidate.name||'内容预览' }; }
    finally { image.removeAttribute('src');image.src=''; }
  }
  async function readLimited(path, limit, signal) {
    const response=await fetch(fileUrl(path),{credentials:'same-origin',cache:'no-store',signal,headers:{Range:`bytes=0-${limit-1}`}});
    if(!response.ok)throw new Error('预览文件读取失败');
    // The relay must honour Range. A 200 might otherwise start an unbounded
    // download before this browser has enough information to stop it.
    if(response.status!==206){await response.body?.cancel?.();throw new Error('预览服务未提供范围读取');}
    const reader=response.body?.getReader();if(!reader)throw new Error('预览文件不可读取');
    const chunks=[];let size=0;
    try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel();throw new Error('预览文件超过读取上限');}chunks.push(next.value);}}
    finally {reader.releaseLock();}
    const out=new Uint8Array(size);let offset=0;for(const part of chunks){out.set(part,offset);offset+=part.byteLength;}return out;
  }
  function cleanLine(value, max=94) { return String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max); }
  function textLines(value) { return String(value||'').replace(/\r\n?/g,'\n').split('\n').map(line=>cleanLine(line)).filter(Boolean).slice(0,14); }
  function documentCanvas(candidate, value) {
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;const ctx=canvas.getContext('2d',{alpha:false});
    ctx.fillStyle='#161c24';ctx.fillRect(0,0,960,540);ctx.fillStyle='#91b4da';ctx.fillRect(0,0,12,540);ctx.fillStyle='#dfe9f4';ctx.font='600 28px system-ui,sans-serif';ctx.fillText(cleanLine(candidate.name||'文档预览',48),48,54);
    ctx.fillStyle='#6f92b6';ctx.font='16px ui-monospace,SFMono-Regular,Menlo,monospace';ctx.fillText(candidate.kind==='code'?'CODE · 文件开头':'DOCUMENT · 文件开头',48,86);
    const lines=textLines(value);ctx.fillStyle='#d3dce7';ctx.font='18px ui-monospace,SFMono-Regular,Menlo,monospace';lines.forEach((line,index)=>ctx.fillText(line,48,132+index*27));
    if(!lines.length){ctx.fillStyle='#8491a0';ctx.fillText('文件开头没有可显示的文本。',48,132);}return {type:'canvas',src:canvas.toDataURL('image/jpeg',.84),alt:(candidate.name||'文档')+'内容预览'};
  }
  async function textPreview(candidate, signal) {
    const bytes=await readLimited(candidate.path,24*1024,signal);throwIfAborted(signal);
    return documentCanvas(candidate,new TextDecoder('utf-8',{fatal:false}).decode(bytes));
  }
  function waveformPoints(channel, width=360) {
    const points=[];const span=Math.max(1,Math.floor(channel.length/width));for(let i=0;i<width;i++){let peak=0;const end=Math.min(channel.length,(i+1)*span);for(let j=i*span;j<end;j++)peak=Math.max(peak,Math.abs(channel[j]||0));points.push(peak);}return points;
  }
  async function audioPreview(candidate, signal) {
    const bytes=await readLimited(candidate.path,4*1024*1024,signal);throwIfAborted(signal);
    const Context=window.AudioContext||window.webkitAudioContext;if(!Context)throw new Error('浏览器不能解析音频预览');const audio=new Context();
    try {const decoded=await audio.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));throwIfAborted(signal);const points=waveformPoints(decoded.getChannelData(0));
      const canvas=document.createElement('canvas');canvas.width=960;canvas.height=420;const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#18232b';ctx.fillRect(0,0,960,420);ctx.fillStyle='#a8d7c0';ctx.font='600 28px system-ui,sans-serif';ctx.fillText(cleanLine(candidate.name||'音频预览',48),48,54);ctx.fillStyle='#6e9b87';ctx.font='16px system-ui,sans-serif';ctx.fillText(`真实波形 · ${Math.round(decoded.duration||0)} 秒`,48,82);ctx.strokeStyle='#a8d7c0';ctx.lineWidth=2;ctx.beginPath();points.forEach((peak,i)=>{const x=48+i*(864/(points.length-1)),h=Math.max(2,peak*145);ctx.moveTo(x,210-h);ctx.lineTo(x,210+h);});ctx.stroke();return {type:'canvas',src:canvas.toDataURL('image/jpeg',.84),alt:(candidate.name||'音频')+'真实波形'};
    } finally {await audio.close?.().catch(()=>{});}
  }
  async function videoPreview(candidate, signal) {
    const video=document.createElement('video'); video.muted=true; video.playsInline=true; video.preload='metadata';
    try {
      const metadata=waitFor(video,'loadedmetadata',signal);video.src=fileUrl(candidate.path); await metadata;
      const seeked=waitFor(video,'seeked',signal);video.currentTime=Math.min(Math.max(0.1, Number.isFinite(video.duration) ? video.duration * .08 : 4), 12);await seeked;
      const width=Math.min(960,video.videoWidth||640),height=Math.max(1,Math.round(width*(video.videoHeight||360)/(video.videoWidth||640)));
      const canvas=document.createElement('canvas'); canvas.width=width;canvas.height=height;
      canvas.getContext('2d',{alpha:false}).drawImage(video,0,0,width,height);
      return {type:'canvas',src:canvas.toDataURL('image/jpeg',.82),alt:candidate.name||'视频画面'};
    } finally { video.pause(); video.removeAttribute('src'); video.load(); }
  }
  async function pdfPreview(candidate, signal) {
    throwIfAborted(signal);
    const pdfjs=await import('/assets/readers/pdfjs-6.5.438/build/pdf.mjs');
    throwIfAborted(signal);
    pdfjs.GlobalWorkerOptions.workerSrc='/assets/readers/pdfjs-6.5.438/build/pdf.worker.mjs';
    const task=pdfjs.getDocument({url:fileUrl(candidate.path),withCredentials:true,disableAutoFetch:true,disableStream:true,isEvalSupported:false,cMapUrl:'/assets/readers/pdfjs-6.5.438/web/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/readers/pdfjs-6.5.438/web/standard_fonts/',wasmUrl:'/assets/readers/pdfjs-6.5.438/web/wasm/'});
    const stop=()=>task.destroy(); signal?.addEventListener('abort',stop,{once:true});
    let pdfDocument;
    try {
      pdfDocument=await task.promise; const page=await pdfDocument.getPage(1); const base=page.getViewport({scale:1});
      const scale=Math.min(1.2,900/base.width); const view=page.getViewport({scale}); const canvas=window.document.createElement('canvas');
      canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
      const render=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:view});
      signal?.addEventListener('abort',()=>render.cancel(),{once:true}); await render.promise;
      throwIfAborted(signal);
      return {type:'canvas',src:canvas.toDataURL('image/jpeg',.84),alt:candidate.name||'PDF 首页'};
    } finally { signal?.removeEventListener('abort',stop); await pdfDocument?.destroy?.(); task.destroy(); }
  }
  async function epubPreview(candidate, signal) {
    if (Number(candidate.size||0) > 40*1024*1024) throw new Error('电子书过大，不读取封面');
    await script('/assets/readers/jszip-3.10.2/jszip.min.js');throwIfAborted(signal);
    const response=await fetch(fileUrl(candidate.path),{credentials:'same-origin',cache:'no-store',signal});
    if (!response.ok) throw new Error('电子书读取失败');
    const declared=Number(response.headers.get('content-length')||0); if(declared>40*1024*1024)throw new Error('电子书过大，不读取封面');
    const reader=response.body?.getReader(); const parts=[];let received=0;
    if(reader){while(true){const next=await reader.read();if(next.done)break;received+=next.value.byteLength;if(received>40*1024*1024){await reader.cancel();throw new Error('电子书过大，不读取封面');}parts.push(next.value);}}else{const bytes=await response.arrayBuffer();received=bytes.byteLength;if(received>40*1024*1024)throw new Error('电子书过大，不读取封面');parts.push(new Uint8Array(bytes));}
    throwIfAborted(signal);
    const bytes=new Blob(parts).arrayBuffer(); const zip=await window.JSZip.loadAsync(await bytes);
    const container=await zip.file('META-INF/container.xml')?.async('text'); if (!container) throw new Error('电子书目录缺失');
    const doc=new DOMParser().parseFromString(container,'application/xml'); const opf=doc.querySelector('rootfile')?.getAttribute('full-path');
    if (!opf) throw new Error('电子书目录无效'); const packageXml=await zip.file(opf)?.async('text'); if (!packageXml) throw new Error('电子书书目信息缺失');
    const packageDoc=new DOMParser().parseFromString(packageXml,'application/xml'); const coverId=[...packageDoc.querySelectorAll('meta')].find(x=>x.getAttribute('name')==='cover')?.getAttribute('content');
    const item=[...packageDoc.querySelectorAll('item')].find(x=>x.getAttribute('id')===coverId || (x.getAttribute('properties')||'').split(/\s+/).includes('cover-image'));
    const href=item?.getAttribute('href'); if (!href || !/^image\//.test(item.getAttribute('media-type')||'')) throw new Error('电子书没有内嵌封面');
    const entry=new URL(href,'https://preview.invalid/'+opf).pathname.slice(1); const blob=await zip.file(entry)?.async('blob'); if (!blob) throw new Error('电子书封面缺失');
    throwIfAborted(signal);
    const src=URL.createObjectURL(blob); if(signal?.aborted){URL.revokeObjectURL(src);throw signal.reason || new DOMException('Aborted','AbortError');} return {type:'object-url',src,alt:candidate.name||'电子书封面'};
  }
  async function makePreview(candidate, signal) {
    if (candidate.kind==='image') return imagePreview(candidate,signal);
    if (candidate.kind==='video') return videoPreview(candidate,signal);
    if (candidate.kind==='pdf') return pdfPreview(candidate,signal);
    if (candidate.kind==='epub') return epubPreview(candidate,signal);
    if (candidate.kind==='text'||candidate.kind==='code') return textPreview(candidate,signal);
    if (candidate.kind==='audio') return audioPreview(candidate,signal);
    throw new Error('该文件不适合作为预览');
  }
  function validCandidates(value) {
    const paths=new Set();
    return (Array.isArray(value)?value:[]).filter(c=>c && ['image','video','pdf','epub','text','code','audio'].includes(c.kind) && validPath(c.path) && !paths.has(c.path) && paths.add(c.path)).slice(0,3);
  }
  function candidateState(value) { return validCandidates(value).length ? 'loading' : 'failed'; }
  function collectionPreview(items) {
    if(items.length>1)return {type:'mosaic',items,alt:'合集内容预览'};
    return items.length?{...items[0],alt:'内容预览'}:null;
  }
  function releasePreview(value) {
    const values=value?.type==='mosaic'?value.items||[]:[value];
    for(const item of values)if(item?.type==='object-url')URL.revokeObjectURL(item.src);
  }
  function ContentPreview({reactRuntime:React,item,fallback}) {
    const root=React.useRef(null),owned=React.useRef(new Set()),[preview,setPreview]=React.useState(null),[state,setState]=React.useState('loading');
    const key=(item?.previewCandidates||[]).map(c=>c.path+'|'+c.kind).join('\n');
    React.useEffect(()=>{let active=true,seen=false,cancel=()=>{},timedOut=false,deadline;const controller=new AbortController();const clearOwned=()=>{for(const src of owned.current)URL.revokeObjectURL(src);owned.current.clear();};const own=value=>{for(const part of value?.type==='mosaic'?value.items||[]:[value])if(part?.type==='object-url')owned.current.add(part.src);};clearOwned(); setPreview(null);setState('loading');
      const start=()=>{if(seen)return;seen=true;cancel=enqueue(async()=>{deadline=setTimeout(()=>{timedOut=true;if(active)setState('failed');controller.abort(new DOMException('Preview deadline','AbortError'));},30000);try{const candidates=validCandidates(item?.previewCandidates);if(candidateState(candidates)==='failed'){if(active)setState('failed');return;}
        const load=async candidate=>{const cacheKey=candidate.path+'|'+candidate.kind;let value=cacheGet(cacheKey);if(!value){value=await makePreview(candidate,controller.signal);cachePut(cacheKey,value);}return value;};
        if(item?.contentType==='collection'&&candidates.length>=2){const values=[];for(const candidate of candidates){if(!active)return;try{const value=await load(candidate);if(!active){releasePreview(value);return;}values.push(value);const partial=collectionPreview(values);own(partial);setPreview(partial);setState('ready');}catch(error){if((error.name==='AbortError'||controller.signal.aborted)&&!timedOut)return;if(timedOut)break;}}if(!values.length&&active)setState('failed');return;}
        for(const candidate of candidates){if(!active)return;try{const value=await load(candidate);if(active){own(value);setPreview(value);setState('ready');}else releasePreview(value);return;}catch(error){if((error.name==='AbortError'||controller.signal.aborted)&&!timedOut)return;}}if(active)setState('failed');}finally{clearTimeout(deadline);}},controller.signal);};
      const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{if(entries.some(x=>x.isIntersecting)){observer.disconnect();start();}},{rootMargin:'240px'});
      if(observer&&root.current)observer.observe(root.current);else start();
      return()=>{active=false;clearTimeout(deadline);controller.abort();cancel();observer?.disconnect();clearOwned();};
    },[key]);
    if(!preview)return React.createElement('div',{className:'drive-content-preview',ref:root,'aria-busy':state==='loading'?'true':undefined,'data-preview-state':state},state==='loading'?React.createElement('span',{className:'drive-preview-loading','aria-hidden':'true'}):fallback||null);
    if(preview.type==='mosaic')return React.createElement('div',{className:'drive-content-preview drive-content-preview-mosaic',ref:root,'data-preview-kind':'mosaic'},preview.items.map((entry,index)=>React.createElement('img',{key:index,src:entry.src,alt:index===0?preview.alt:'',loading:'lazy',decoding:'async'})));
    return React.createElement('div',{className:'drive-content-preview',ref:root},React.createElement('img',{src:preview.src,alt:preview.alt,loading:'lazy',decoding:'async'}));
  }
  window.OmniDrivePreview={ContentPreview,validCandidates,fileUrl,__test:{cachePut,cacheGet,cacheStats:()=>({items:previewCache.size,bytes:cacheBytes}),enqueue,queueStats:()=>({inFlight,pending:pending.length}),validPath,candidateState,textLines,waveformPoints,collectionPreview}};
})();
