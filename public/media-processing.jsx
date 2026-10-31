const MEDIA_OPERATION_LABELS = Object.freeze({trim:'裁剪片段',compress:'压缩视频',convert:'转换格式',concat:'拼接片段',audio:'提取音频',frame:'导出画面',edit:'画面编辑',gallery:'图集采集',subtitles:'生成字幕',separate:'分离人声与伴奏','remove-background':'去除背景',download:'下载链接'});
const MEDIA_NEW_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|vimeo\.com|x\.com|twitter\.com|instagram\.com|soundcloud\.com)$/i;
const mediaInputUrl = (text) => { const found=String(text||'').match(/https?:\/\/[^\s<>"']+/i); if(!found) return null; try { return new URL(found[0].replace(/[，。！？、；;,.)\]]+$/u,'')); } catch { return null; } };
const mediaNeedsNewDownload = (text) => { const url=mediaInputUrl(text); return Boolean(url && MEDIA_NEW_HOSTS.test(url.hostname)); };
const mediaFileHref = (job,file,inline=false) => `${job.engine==='media'?'/api/tools/media':'/api/tools/video'}/jobs/${encodeURIComponent(job.id)}/files/${encodeURIComponent(file.name)}${inline?'?inline=1':''}`;
const mediaSourceParam = (job,file) => new URLSearchParams({sourceEngine:job.engine==='media'?'media':'video',sourceJob:job.id,sourceFile:file.name});
const MEDIA_MODE_OPERATIONS = Object.freeze({process:['trim','compress','convert','concat','edit','audio','frame'],audio:['trim','audio','separate'],subtitles:['subtitles'],image:['remove-background','gallery']});
const MEDIA_MODE_NAMES = Object.freeze({process:'视频处理',audio:'音频处理',subtitles:'文件字幕',image:'图片处理'});
const mediaModeOperation = (mode, operation) => MEDIA_MODE_OPERATIONS[mode]?.includes(operation) ? operation : '';
const mediaLibraryHref = (mode, space, operation) => `#media-tools?${new URLSearchParams({tab:'library',space,pickFor:mode,operation:mediaModeOperation(mode,operation)})}`;
const mediaPickFile = (job, mode, operation) => (job?.files || []).find(file => {
  const type = file.type || '';
  if (mode === 'image') return type.startsWith('image/');
  if (mode === 'subtitles' || mode === 'audio' && operation === 'separate') return /^(video|audio)\//.test(type);
  if (mode === 'audio' && operation === 'trim') return type.startsWith('audio/');
  return type.startsWith('video/');
});
const mediaProcessHref = (job,file,space='public',target='',operation='') => {
  const mediaType=file.type||'';
  const tab=target==='subtitles'?'transcribe':['process','audio','image'].includes(target)?target:mediaType.startsWith('image/')?'image':mediaType.startsWith('audio/')?'audio':job.operation==='subtitles'?'transcribe':'process';
  const params={tab,space,sourceType:mediaType,...Object.fromEntries(mediaSourceParam(job,file))};
  if(tab==='transcribe') params.textMode='subtitles';
  const nextOperation=mediaModeOperation(target,operation)||(target==='audio'?(mediaType.startsWith('video/')?'audio':'trim'):'');
  if(nextOperation) params.operation=nextOperation;
  return `#media-tools?${new URLSearchParams(params)}`;
};
const mediaDisplayTitle = (job) => job.content?.title || (typeof job.content==='string'?job.content:'') || job.input || job.url || MEDIA_OPERATION_LABELS[job.operation] || '媒体文件';
const mediaBusy = (job) => ['queued','processing','submitting','submission-unknown'].includes(job?.state);
const mediaIsAudioJob = job => (job.source?.type || '').startsWith('audio/') || Boolean(job.files?.some(file => file.type?.startsWith('audio/')) && !job.files?.some(file => file.type?.startsWith('video/')));
const mediaOperationLabel = job => job.operation === 'trim' && mediaIsAudioJob(job) ? '裁剪音频' : MEDIA_OPERATION_LABELS[job.operation] || '上传';
const mediaJobHref = (mode, space, id) => `#media-tools?${new URLSearchParams({tab:mode === 'subtitles' ? 'transcribe' : mode,space,job:id,...(mode === 'subtitles' ? {textMode:'subtitles'} : {})})}`;
const mediaSafeSecond = value => Number.isFinite(value) && value >= 0 ? Math.floor(value * 1000) / 1000 : 0;
const mediaFeatureKey = operation => ({'remove-background':'removeBackground',separate:'separation'}[operation] || operation);
const mediaFeatureAvailable = (features,operation) => {
  if(['subtitles','separate','edit','gallery','concat'].includes(operation)) return features?.[mediaFeatureKey(operation)]===true;
  if(operation==='remove-background') return features?.removeBackground !== false && features?.backgroundRemoval !== false;
  return features?.[mediaFeatureKey(operation)] !== false;
};
const mediaUnavailableHint = operation => ['subtitles','separate'].includes(operation) ? 'AI 工具待配置，配置后可使用。' : `当前服务暂不支持${MEDIA_OPERATION_LABELS[operation]}。`;
const mediaSubtitleTime = seconds => {
  const value=Math.max(0,Number(seconds)||0), hours=Math.floor(value/3600), minutes=Math.floor(value%3600/60), whole=Math.floor(value%60), millis=Math.round((value-Math.floor(value))*1000);
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(whole).padStart(2,'0')}.${String(millis).padStart(3,'0')}`;
};
async function mediaApi(path,options={}) { return api(`/api/tools/media${path}`,options); }
function mediaUpload(file,scope,onProgress,signal) {
  return new Promise((resolve,reject)=>{ const xhr=new XMLHttpRequest(); xhr.open('POST',`/api/tools/media/uploads?name=${encodeURIComponent(file.name)}&visibility=${encodeURIComponent(scope)}`); xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream'); const abort=()=>xhr.abort();signal?.addEventListener('abort',abort,{once:true});const settle=(fn,value)=>{signal?.removeEventListener('abort',abort);fn(value);};xhr.upload.onprogress=e=>{if(e.lengthComputable&&!signal?.aborted) onProgress(Math.round(e.loaded/e.total*100));}; xhr.onerror=()=>settle(reject,new Error('上传中断，请检查网络后重试。')); xhr.onabort=()=>settle(reject,new Error('上传已取消。')); xhr.onload=()=>{let value;try{value=JSON.parse(xhr.responseText);}catch{settle(reject,new Error('服务器返回了无法识别的结果。'));return;} if(xhr.status>=200&&xhr.status<300) settle(resolve,value); else settle(reject,new Error(value.error||`上传失败（${xhr.status}）`));}; if(signal?.aborted)abort();else xhr.send(file); });
}
async function mediaInspectLocal(file) {
  if(!file || !file.type.startsWith('video/')) return null;
  const library=window.Mediabunny;
  if(!library) return null;
  const input=new library.Input({source:new library.BlobSource(file),formats:library.ALL_FORMATS});
  try {
    if(!await input.canRead()) return null;
    const [duration,track]=await Promise.all([input.getDurationFromMetadata(),input.getPrimaryVideoTrack()]);
    if(!track) return {duration};
    const [width,height]=await Promise.all([track.getCodedWidth(),track.getCodedHeight()]);
    let thumbnail='';
    try { const wrapped=await new library.CanvasSink(track,{width:Math.min(width,600)}).getCanvas(0); if(wrapped?.canvas?.toDataURL) thumbnail=wrapped.canvas.toDataURL('image/jpeg',0.78); else if(wrapped?.canvas?.convertToBlob) {const blob=await wrapped.canvas.convertToBlob({type:'image/jpeg',quality:0.78});thumbnail=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve('');reader.readAsDataURL(blob);});} } catch {}
    return {duration,width,height,thumbnail};
  } finally {input.dispose();}
}
function useMediaJobs(active) {
  const [status,setStatus]=React.useState({available:null,scope:null,maxUploadMB:100,features:{}}),[jobs,setJobs]=React.useState([]),[loading,setLoading]=React.useState(true),[error,setError]=React.useState('');
  const refresh=React.useCallback(async()=>{const state=await mediaApi('/status');setStatus(state);try{const result=await mediaApi('/jobs');setJobs(result.jobs||[]);setStatus(s=>({...s,scope:result.scope||s.scope}));setError('');}catch(e){if(state.available)throw e;}return state;},[]);
  React.useEffect(()=>{if(!active)return;let live=true;setLoading(true);refresh().catch(e=>live&&setError(e.message)).finally(()=>live&&setLoading(false));return()=>{live=false;};},[active,refresh]);
  React.useEffect(()=>{if(!active||!jobs.some(mediaBusy))return;const timer=setTimeout(()=>void refresh().catch(e=>setError(e.message)),2500);return()=>clearTimeout(timer);},[active,jobs,refresh]);
  const update=React.useCallback(job=>setJobs(current=>[job,...current.filter(x=>x.id!==job.id)].sort((a,b)=>b.created-a.created)),[]);
  return {status,jobs,loading,error,setError,refresh,update};
}
function MediaProcessingResult({job,active,space,onRetry,showToast,downloadWorkspace=false}) {
  const files=job.files||[],preview=files.find(f=>/^(video|audio|image)\//.test(f.type||'')), subtitleFile=files.find(f=>/\.vtt$/i.test(f.name||'')||f.type==='text/vtt'), audioFiles=files.filter(f=>f.type?.startsWith('audio/')), galleryFiles=files.filter(f=>f.type?.startsWith('image/'));
  const original=job.source;
  const downloadReady=downloadWorkspace&&job.state==='saved'&&preview;
  const [compare,setCompare]=React.useState(false);
  const copy=async()=>{try{await navigator.clipboard.writeText(job.input||'');showToast?.('已复制原始输入');}catch{showToast?.('复制失败');}};
  return <article className="mp-result" aria-label="处理结果">
    <div className="mp-result-top"><div><span className="mp-eyebrow">{job.kind==='upload'?'已上传':mediaOperationLabel(job)}</span><h2>{mediaDisplayTitle(job)}</h2></div><span className={`video-status state-${job.state}`}>{mediaBusy(job)?'正在处理':job.state==='saved'?'已完成':job.state==='failed'?'失败':job.state}</span></div>
    {job.error&&<div className="video-error" role="alert">{job.error}</div>}
    {mediaBusy(job)&&<p className="mp-muted">文件正在后台处理，完成后会自动显示。</p>}
    {job.operation==='remove-background'&&original?.fileName&&preview?.type?.startsWith('image/')&&<div className="mp-compare"><button type="button" className={compare?'active':''} onClick={()=>setCompare(true)}>原图</button><button type="button" className={!compare?'active':''} onClick={()=>setCompare(false)}>透明结果</button></div>}
    {job.state==='saved'&&preview&&job.operation!=='separate'&&<div className={`mp-preview ${job.operation==='remove-background'&&!compare?'mp-checker':''}`}>
      {preview.type?.startsWith('video/')?<video key={job.id+preview.name} controls playsInline preload="metadata" src={active?mediaFileHref(job,preview,true):undefined}>{job.operation==='subtitles'&&subtitleFile&&<track kind="subtitles" label="字幕" srcLang={job.subtitles?.language||'zh'} src={active?mediaFileHref(job,subtitleFile,true):undefined} default />}</video>:
       preview.type?.startsWith('audio/')?<audio key={job.id+preview.name} controls preload="none" src={active?mediaFileHref(job,preview,true):undefined}/>:
       <img src={active?(compare&&original?.fileName?mediaFileHref({id:original.jobId,engine:original.engine},{name:original.fileName},true):mediaFileHref(job,preview,true)):undefined} alt={compare?'原图':'处理结果'}/>}
    </div>}
    {job.operation==='subtitles'&&job.subtitles?.segments?.length>0&&<div className="mp-subtitle-text"><strong>{job.subtitles.language ? `${job.subtitles.language.toUpperCase()} 字幕` : '字幕文本'}</strong><div>{job.subtitles.segments.map((segment,index)=><p key={`${segment.start}-${index}`}><time>{mediaSubtitleTime(segment.start)} → {mediaSubtitleTime(segment.end)}</time><span>{segment.text}</span></p>)}</div></div>}
    {job.operation==='separate'&&job.state==='saved'&&audioFiles.length>0&&<div className="mp-stems">{audioFiles.map(file=><div key={file.name}><strong>{/vocal|人声/i.test(file.name||file.label||'')?'人声':'伴奏'}</strong><audio controls preload="none" src={active?mediaFileHref(job,file,true):undefined}/></div>)}</div>}
    {job.operation==='gallery'&&<>{galleryFiles.length>0&&<div className="mp-gallery">{galleryFiles.map(file=><a key={file.name} href={mediaFileHref(job,file)} download={file.label||file.name}><img src={active?mediaFileHref(job,file,true):undefined} alt={file.label||file.name}/><span>{file.label||file.name}</span></a>)}</div>}{Number(job.content?.skippedCount)>0&&<p className="mp-muted">已保存 {galleryFiles.length} 张，跳过 {Number(job.content.skippedCount)} 张不支持或超限图片。</p>}</>}
    {downloadWorkspace&&job.state==='saved'&&preview&&<div className="video-result-actions"><a className="btn btn-primary" href={mediaFileHref(job,preview)} download={preview.label||preview.name}><IconDownload/>{preview.type?.startsWith('video/')?'下载视频':preview.type?.startsWith('audio/')?'下载音频':'下载图片'}</a><a className="btn btn-ghost" href={mediaProcessHref(job,preview,space)}>继续处理</a><ToolActionMenu key={job.id} ariaLabel="当前素材的更多操作">{files.filter(f=>f!==preview).map(f=><a key={f.name} href={mediaFileHref(job,f)} download={f.label||f.name}>下载 {f.label||f.name}</a>)}<button type="button" onClick={copy}><IconCopy/>复制原始输入</button></ToolActionMenu></div>}
    {!downloadReady&&files.length>0&&<div className="mp-files">{files.map(f=><div key={f.name}><span>{f.label||f.name}<small>{videoFileSize(f.bytes||0)}</small></span><div><a className="btn btn-primary" href={mediaFileHref(job,f)} download={f.label||f.name}>下载</a>{/^(video|audio|image)\//.test(f.type||'')&&<a className="btn btn-ghost" href={mediaProcessHref(job,f,space)}>继续处理</a>}</div></div>)}</div>}
    <div className="mp-result-actions">{job.input&&!downloadReady&&<button type="button" className="video-text-action" onClick={copy}><IconCopy/>复制原始输入</button>}{job.state==='failed'&&job.kind!=='upload'&&onRetry&&<button type="button" className="btn btn-ghost" onClick={()=>onRetry(job)}>重试任务</button>}</div>
  </article>;
}
function MediaProcessingTool({ active, visible, space, hash, showToast, mode = 'process', panelId }) {
  const { status, jobs, loading, error, setError, refresh, update } = useMediaJobs(active);
  const isImage = mode === 'image';
  const isAudioMode = mode === 'audio', isSubtitlesMode = mode === 'subtitles';
  const initialOperation = isImage ? 'remove-background' : isSubtitlesMode ? 'subtitles' : 'trim';
  const [operation, setOperation] = React.useState(initialOperation);
  const [file, setFile] = React.useState(null);
  const [local, setLocal] = React.useState(null);
  const [localUrl, setLocalUrl] = React.useState({ file: null, url: '' });
  const [source, setSource] = React.useState(null);
  const [sourceDetails, setSourceDetails] = React.useState(null);
  const [selected, setSelected] = React.useState('');
  const [sourceExpanded, setSourceExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [localOutput,setLocalOutput]=React.useState(null);
  const [localBusy,setLocalBusy]=React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [galleryUrl,setGalleryUrl]=React.useState('');
  const [concatSources,setConcatSources]=React.useState([]);
  const [concatUploading,setConcatUploading]=React.useState(false);
  const [params, setParams] = React.useState({ start: '0', end: '', at: '0', quality: 'balanced', format: 'mp4', maxHeight: 720, language:'auto', targetLanguage:'none', burnIn:false,aspect:'original',fit:'crop',rotation:'0',speed:'1',mute:false,volume:'1' });
  const fileInput = React.useRef(null);
  const concatInput = React.useRef(null);
  const player = React.useRef(null);
  const epoch = React.useRef(0);
  const uploadAbort = React.useRef(null);
  const localConversion = React.useRef(null);
  React.useEffect(() => () => { epoch.current++; uploadAbort.current?.abort(); void localConversion.current?.cancel?.(); }, []);
  React.useEffect(()=>{ if(!localOutput?.file) return; const url=URL.createObjectURL(localOutput.file); setLocalOutput(value=>value?.file===localOutput.file?{...value,url}:value); return()=>URL.revokeObjectURL(url); },[localOutput?.file]);
  React.useEffect(() => {
    if (!file) { setLocalUrl({ file: null, url: '' }); return; }
    const url = URL.createObjectURL(file);
    setLocalUrl({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  React.useEffect(() => {
    const inMode = isSubtitlesMode ? videoTabForHash(hash) === 'transcribe' && workspaceHashParams(hash).get('textMode') === 'subtitles' : videoTabForHash(hash) === mode;
    if (!inMode) return;
    const p = workspaceHashParams(hash);
    const requestedOperation = mediaModeOperation(mode, p.get('operation'));
    if (requestedOperation) setOperation(requestedOperation);
    const engine = p.get('sourceEngine'), jobId = p.get('sourceJob'), fileName = p.get('sourceFile');
    if (['video', 'media'].includes(engine) && jobId && fileName) {
      epoch.current++;
      uploadAbort.current?.abort();
      setBusy(false);
      setSource({ engine, jobId, fileName, type: p.get('sourceType') || '' });
      setFile(null); setLocal(null); setSelected('');
      setParams(value => ({ ...value, start: '0', end: '', at: '0' }));
    }
    if (p.get('job')) setSelected(p.get('job'));
  }, [hash, mode, isSubtitlesMode]);
  const job = jobs.find(item => item.id === selected);
  React.useEffect(() => { setSourceExpanded(false); }, [job?.id]);
  React.useEffect(() => {
    if (!job || !job.operation || job.operation === 'download') return;
    setOperation(job.operation);
    const options = job.options || {};
    setParams(value => ({ ...value,
      ...(options.start != null ? { start: String(options.start) } : {}),
      ...(options.end != null ? { end: String(options.end) } : {}),
      ...(options.at != null ? { at: String(options.at) } : {}),
      ...(options.quality != null ? { quality: options.quality } : {}),
      ...(options.format != null ? { format: options.format } : {}),
      ...(options.maxHeight != null ? { maxHeight: options.maxHeight } : {}),
      ...(options.language != null ? { language: options.language } : {}),
      ...(options.targetLanguage != null ? { targetLanguage: options.targetLanguage } : {}),
      ...(options.burnIn != null ? { burnIn: options.burnIn } : {}),
      ...(options.aspect != null ? { aspect: options.aspect } : {}),
      ...(options.fit != null ? { fit: options.fit } : {}),
      ...(options.rotation != null ? { rotation: String(options.rotation) } : {}),
      ...(options.speed != null ? { speed: String(options.speed) } : {}),
      ...(options.mute != null ? { mute: options.mute } : {}),
      ...(options.volume != null ? { volume: String(options.volume) } : {}),
    }));
  }, [job?.id]);
  React.useEffect(() => {
    if (!job || file) return;
    const next = job.source?.jobId && job.source?.fileName ? job.source : job.kind === 'upload' && job.files?.[0] ? { engine: 'media', jobId: job.id, fileName: job.files[0].name, type: job.files[0].type } : null;
    if (next && (source?.engine !== next.engine || source?.jobId !== next.jobId || source?.fileName !== next.fileName)) setSource(next);
  }, [job?.id, source, file]);
  React.useEffect(() => {
    if (!source || file) { setSourceDetails(null); return; }
    const controller = new AbortController();
    const path = `/jobs/${encodeURIComponent(source.jobId)}`;
    (source.engine === 'media' ? mediaApi(path, { signal: controller.signal }) : videoToolApi(`/api/tools/video${path}`, { signal: controller.signal }))
      .then(item => { if (!controller.signal.aborted) setSourceDetails(item); })
      .catch(e => { if (!controller.signal.aborted) setError(`源文件暂时无法读取：${e.message}`); });
    return () => controller.abort();
  }, [source?.engine, source?.jobId, source?.fileName, file]);
  const sourceFile = sourceDetails?.files?.find(item => item.name === source?.fileName);
  const sourceMime = file?.type || sourceFile?.type || source?.type || '';
  const sourceDuration = local?.duration || (sourceDetails?.content?.duration ? sourceDetails.content.duration / 1000 : 0);
  React.useEffect(() => {
    if (sourceDuration > 0) setParams(value => value.end ? value : { ...value, end: String(mediaSafeSecond(sourceDuration)) });
  }, [sourceDuration]);
  const previewUrl = file ? localUrl.file === file ? localUrl.url : '' : source ? mediaFileHref({ engine: source.engine, id: source.jobId }, { name: source.fileName }, true) : '';
  const isVideo = sourceMime.startsWith('video/'), isAudio = sourceMime.startsWith('audio/'), isStill = sourceMime.startsWith('image/');
  const choose = async next => {
    if (!next) return;
    const types = isImage ? ['image/png', 'image/jpeg', 'image/webp'] : ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav'];
    if (!types.includes(next.type)) { setError(isImage ? '请选择 PNG、JPEG 或 WebP 图片。' : '请选择 MP4、WebM、MP3、M4A 或 WAV 文件。'); return; }
    if (next.size > 100 * 1048576) { setError('文件超过 100 MB，请选择较小的文件。'); return; }
    const current = ++epoch.current;
    uploadAbort.current?.abort();
    setBusy(false); setLocalBusy(false); setLocalOutput(null); setFile(next); setSource(null); setSourceDetails(null); setLocal(null); setSelected(''); setError(''); setProgress(0); setPosition(0);
    setParams(value => ({ ...value, start: '0', end: '', at: '0' }));
    try { const metadata = await mediaInspectLocal(next); if (current === epoch.current) setLocal(metadata); }
    catch { if (current === epoch.current) setLocal(null); }
  };
  const upload = async (navigate = true) => {
    if (!file || !status.scope) return null;
    const current = epoch.current, chosen = file;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setBusy(true); setProgress(0); setError('');
    try {
      const saved = await mediaUpload(chosen, status.scope, value => { if (current === epoch.current) setProgress(value); }, controller.signal);
      if (current !== epoch.current || controller.signal.aborted) return null;
      update(saved);
      setSource({ engine: 'media', jobId: saved.id, fileName: saved.files?.[0]?.name || chosen.name, type: saved.files?.[0]?.type || chosen.type });
      setSelected(saved.id);
      if(navigate) window.location.hash = `#media-tools?${new URLSearchParams({ tab: isSubtitlesMode?'transcribe':mode, space, job:saved.id, ...(isSubtitlesMode?{textMode:'subtitles'}:{}) })}`;
      return saved;
    } catch (e) { if (current === epoch.current && !controller.signal.aborted) setError(e.message); return null; }
    finally { if (uploadAbort.current === controller) uploadAbort.current = null; if (current === epoch.current) setBusy(false); }
  };
  const setCurrentTime = key => {
    const time = player.current?.currentTime;
    const duration = player.current?.duration;
    if (Number.isFinite(time)) setParams(value => ({ ...value, [key]: String(mediaSafeSecond(Number.isFinite(duration) ? Math.min(time, duration) : time)) }));
  };
  const localSupported = typeof mediaLocalConversionAvailable === 'function' && mediaLocalConversionAvailable();
  const runLocal = async () => {
    if(!file || !['trim','compress','convert'].includes(operation) || !localSupported || localBusy) return;
    const start=Number(params.start),end=Number(params.end||sourceDuration);
    if(operation==='trim' && (!Number.isFinite(end)||end<=start)) { setError('结束时间须晚于开始时间。'); return; }
    const current=epoch.current; setLocalBusy(true);setProgress(0);setError('');setLocalOutput(null);
    try { const task=await startMediaLocalConversion({file,operation,options:{...params,start,end},onProgress:value=>{if(current===epoch.current)setProgress(value);}}); localConversion.current=task; const output=await task.done; if(current===epoch.current) setLocalOutput({file:output,url:''}); }
    catch(error) { if(current===epoch.current) setError(error.message); }
    finally { if(current===epoch.current) {setLocalBusy(false);localConversion.current=null;} }
  };
  const cancelLocal = () => void localConversion.current?.cancel?.();
  const addConcatSource = next => { if(!next?.jobId || !next?.fileName || concatSources.some(item=>item.engine===next.engine&&item.jobId===next.jobId&&item.fileName===next.fileName)) return; setConcatSources(items=>items.length>=5?items:[...items,next]); };
  const moveConcatSource = (index,direction) => setConcatSources(items=>{const target=index+direction;if(target<0||target>=items.length)return items;const next=[...items];[next[index],next[target]]=[next[target],next[index]];return next;});
  const uploadConcatFiles = async files => {
    const picked=[...files].filter(file=>file?.type?.startsWith('video/'));
    if(!picked.length) return setError('请选择视频文件。');
    if(picked.length+concatSources.length>5) return setError('最多拼接 5 段。');
    if(picked.some(file=>file.size>100*1048576)||picked.reduce((total,file)=>total+file.size,0)>200*1048576) return setError('每段不超过 100 MB，合计不超过 200 MB。');
    const current=epoch.current;setConcatUploading(true);setError('');
    try { for(const file of picked){const saved=await mediaUpload(file,status.scope,()=>{},undefined);if(current!==epoch.current)return;update(saved);addConcatSource({engine:'media',jobId:saved.id,fileName:saved.files?.[0]?.name||file.name,name:file.name});} } catch(error){if(current===epoch.current)setError(`部分片段可能已上传：${error.message}`);} finally {if(current===epoch.current)setConcatUploading(false);}
  };
  const submit = async () => {
    if (busy || !status.available || !status.scope || !mediaFeatureAvailable(status.features,operation)) return;
    const start = Number(params.start), end = Number(params.end || sourceDuration);
    if (operation === 'trim' && (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || sourceDuration > 0 && end > sourceDuration)) { setError('开始时间须不小于 0，结束时间须晚于开始且不超过素材时长。'); return; }
    if(operation==='gallery' && !galleryUrl.trim()) { setError('请输入公开图集链接。'); return; }
    if(operation==='concat' && (concatSources.length<2 || concatSources.length>5)) { setError('请按顺序选择 2–5 段视频。'); return; }
    let current = source;
    if (!current && file) {
      const saved = await upload(false);
      if (!saved) return;
      current = { engine: 'media', jobId: saved.id, fileName: saved.files?.[0]?.name || file.name };
    }
    if (!current && !['gallery','concat'].includes(operation)) { setError('先上传文件，或从素材库选择源文件。'); return; }
    setBusy(true); setError('');
    try {
      const options = {};
      if (operation === 'trim') { options.start = start; options.end = end; }
      if (['compress', 'convert'].includes(operation)) { options.quality = params.quality; options.maxHeight = Number(params.maxHeight); options.format = operation === 'convert' ? params.format : 'mp4'; }
      if (operation === 'audio') options.format = ['mp3', 'wav'].includes(params.format) ? params.format : 'mp3';
      if (operation === 'frame') { options.at = Number(params.at) || 0; options.format = ['png', 'jpeg'].includes(params.format) ? params.format : 'png'; }
      if (operation === 'edit') { options.aspect=params.aspect; options.fit=params.fit; options.rotation=Number(params.rotation)||0; options.speed=Number(params.speed)||1; options.mute=Boolean(params.mute); options.volume=Math.max(0,Math.min(2,Number(params.volume)||0)); }
      if (operation === 'subtitles') { options.language=params.language||'auto'; options.targetLanguage=params.targetLanguage||'none'; options.burnIn=Boolean(params.burnIn); }
      const next = await mediaApi('/jobs', { method: 'POST', body: { visibility: status.scope, operation, ...(operation==='gallery'?{url:galleryUrl.trim()}:operation==='concat'?{sources:concatSources.map(({engine,jobId,fileName})=>({engine,jobId,fileName}))}:{source:current}), options } });
      update(next); setSelected(next.id);
      window.location.hash = `#media-tools?${new URLSearchParams({ tab: isSubtitlesMode?'transcribe':mode, space, job: next.id, ...(isSubtitlesMode?{textMode:'subtitles'}:{}) })}`;
    } catch (e) { setError(e.message); void refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const retry = async item => {
    if (busy || item.kind === 'upload') return;
    setBusy(true);
    try {
      const next = await mediaApi(`/jobs/${item.id}/retry`, { method: 'POST', body: { visibility: status.scope } });
      update(next); setSelected(next.id);
      window.location.hash = `#media-tools?${new URLSearchParams({ tab: isSubtitlesMode?'transcribe':mode, space, job: next.id, ...(isSubtitlesMode?{textMode:'subtitles'}:{}) })}`;
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const choices = isImage ? [['remove-background', '去除背景'], ['gallery', '图集采集']] : isSubtitlesMode ? [['subtitles', '生成字幕']] : isAudioMode ? [['trim', '裁剪音频'], ['audio', '提取音频'], ['separate', '人声与伴奏']] : [['trim', '裁剪片段'], ['compress', '压缩视频'], ['convert', '转换格式'], ['concat', '拼接片段'], ['edit', '画面编辑'], ['audio', '提取音频'], ['frame', '导出画面']];
  const invalidSource = operation === 'remove-background' ? !isStill : operation === 'gallery' ? !galleryUrl.trim() : operation === 'concat' ? concatSources.length<2||concatSources.length>5 : operation === 'trim' ? isAudioMode ? !isAudio : !isVideo && !isAudio : operation === 'separate' || operation === 'subtitles' ? !isVideo && !isAudio : !isVideo;
  const invalidTrim = operation === 'trim' && (!Number.isFinite(Number(params.start)) || Number(params.start) < 0 || !(Number(params.end || sourceDuration) > Number(params.start)) || sourceDuration > 0 && Number(params.end || sourceDuration) > sourceDuration);
  const featureAvailable = mediaFeatureAvailable(status.features,operation);
  const showParameters = featureAvailable && Boolean(file || source || ['gallery','concat'].includes(operation)) && (!invalidSource || ['gallery','concat'].includes(operation));
  const sourceHint = invalidSource && (file || source) && !['gallery','concat'].includes(operation) && sourceMime
    ? operation === 'trim' && isAudioMode ? '裁剪音频需要音频文件；视频请先选择“提取音频”。'
    : operation === 'remove-background' ? '请选择图片文件。'
    : ['subtitles','separate'].includes(operation) ? '请选择视频或音频文件。'
    : '当前处理方式需要视频，请更换文件或从素材库选择视频。' : '';
  const galleryPlatforms=Array.isArray(status.galleryPlatforms)?status.galleryPlatforms:[];
  const galleryPlatformLabel=galleryPlatforms.length?galleryPlatforms.join('、'):'';
  const recentJobs = jobs.filter(item => item.operation !== 'download' && (isImage
    ? item.operation === 'remove-background' || item.operation === 'gallery' || item.kind === 'upload' && item.files?.some(file => file.type.startsWith('image/'))
    : isSubtitlesMode ? item.operation === 'subtitles'
    : isAudioMode ? item.operation === 'separate' || item.operation === 'audio' || item.operation === 'trim' && mediaIsAudioJob(item)
    : !['remove-background','subtitles','separate'].includes(item.operation) && (item.kind !== 'upload' || item.files?.some(file => /^(video|audio)\//.test(file.type)))));
  return <section id={panelId||`media-tools-panel-${mode}`} role="tabpanel" className="mp-tool" hidden={!visible} aria-labelledby={`media-tools-tab-${isSubtitlesMode?'transcribe':mode}`}>
    <div className="mp-intro"><p>{isImage ? '选择图片去除背景，或采集公开图集。' : isSubtitlesMode ? '选择视频或音频生成字幕，最长 5 分钟。' : isAudioMode ? '裁剪音频、提取声音或分离音轨。' : '选择素材，预览后设置输出。'}</p>{status.scope && <span className="mp-scope">{status.scope === 'private' ? '仅自己可见' : '公开记录'}</span>}</div>
    {status.available === false && <div className="video-error" role="status">媒体处理服务暂未启用，暂时无法提交任务。</div>}
    <div className="mp-workbench">
      <div className="mp-main">
        {job && <MediaProcessingResult job={job} active={active} space={space} onRetry={retry} showToast={showToast} />}
        <div className="mp-source-card">
          <div className="mp-section-head"><strong>{operation==='gallery'?'公开图集':operation==='concat'?'拼接片段':job?'原素材':'选择素材'}</strong><div>{job&&<button type="button" className="video-text-action" aria-expanded={sourceExpanded} onClick={()=>setSourceExpanded(value=>!value)}>{sourceExpanded?'收起原素材':'查看原素材'}</button>}{operation!=='gallery'&&<a href={mediaLibraryHref(mode,space,operation)}>从素材库选择</a>}</div></div>
          <div className="mp-source-body" hidden={Boolean(job)&&!sourceExpanded}>
          {operation==='gallery' && <label className="mp-single-field mp-gallery-input">公开图集链接<input type="url" inputMode="url" placeholder={galleryPlatformLabel?`支持 ${galleryPlatformLabel} 公开图集`:'等待支持站点公布后可使用'} value={galleryUrl} onChange={event=>setGalleryUrl(event.target.value)} /></label>}
          {operation==='concat' && <div className="mp-concat-source"><input ref={concatInput} type="file" accept=".mp4,.webm,video/mp4,video/webm" multiple hidden onChange={event=>{void uploadConcatFiles(event.target.files||[]);event.target.value='';}}/><p>按列表顺序拼接 2–5 段视频，固定导出 720p MP4；每段最多 100 MB，合计最多 200 MB、10 分钟。</p><button type="button" className="btn btn-ghost" disabled={!status.scope||concatUploading||concatSources.length>=5} onClick={()=>concatInput.current?.click()}>{concatUploading?'正在上传片段…':'上传多个本地视频'}</button>{source&&isVideo&&<button type="button" className="btn btn-ghost" disabled={concatSources.length>=5} onClick={()=>addConcatSource({engine:source.engine,jobId:source.jobId,fileName:source.fileName,name:source.fileName})}>将当前素材加入片段</button>}<a href={mediaLibraryHref(mode,space,operation)}>从素材库选择后回到此处加入</a>{concatSources.length>0&&<ol>{concatSources.map((item,index)=><li key={`${item.engine}:${item.jobId}:${item.fileName}`}><span>{index+1}. {item.name||item.fileName}</span><div><button type="button" disabled={index===0} onClick={()=>moveConcatSource(index,-1)}>上移</button><button type="button" disabled={index===concatSources.length-1} onClick={()=>moveConcatSource(index,1)}>下移</button><button type="button" onClick={()=>setConcatSources(items=>items.filter((_,at)=>at!==index))}>移除</button></div></li>)}</ol>}</div>}
          {!['gallery','concat'].includes(operation)&&<>
          <input ref={fileInput} type="file" accept={isImage ? '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp' : '.mp4,.webm,.mp3,.m4a,.wav,video/mp4,video/webm,audio/mpeg,audio/mp4,audio/wav'} hidden onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
          <button type="button" className={`mp-drop${file || source ? ' mp-drop-selected' : ''}`} onClick={() => fileInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files?.[0]); }}><IconPlus /><strong>{file?.name || source?.fileName || '点击或拖入文件'}</strong><span>{file || source ? '更换文件' : `${isImage ? 'PNG、JPEG、WebP' : 'MP4、WebM、MP3、M4A、WAV'} · 最大 100 MB`}</span></button>
          </>}
          {(file || source) && operation!=='gallery' && <div className="mp-source-summary"><span>{file ? videoFileSize(file.size) : sourceFile ? videoFileSize(sourceFile.bytes || 0) : '素材库文件'}{sourceDuration ? ` · ${Math.round(sourceDuration * 10) / 10} 秒` : ''}{local?.width ? ` · ${local.width} × ${local.height}` : ''}</span>{file && <button type="button" className="btn btn-ghost" disabled={busy || !status.available} onClick={upload}>{busy ? `上传中 ${progress}%` : '仅上传到素材库'}</button>}</div>}
          {previewUrl && !['gallery','concat'].includes(operation) && <div className={`mp-source-preview ${isStill ? 'mp-checker' : ''}`}>
            {isVideo ? <video ref={player} key={previewUrl} controls playsInline preload="metadata" poster={file ? local?.thumbnail || undefined : undefined} src={active ? previewUrl : undefined} onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onLoadedMetadata={event => { const duration = event.currentTarget.duration; if (Number.isFinite(duration) && duration > 0) setParams(value => value.end ? value : { ...value, end: String(mediaSafeSecond(duration)) }); }} /> :
             isAudio ? <audio ref={player} key={previewUrl} controls preload="metadata" src={active ? previewUrl : undefined} onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onLoadedMetadata={event => { const duration = event.currentTarget.duration; if (Number.isFinite(duration) && duration > 0) setParams(value => value.end ? value : { ...value, end: String(mediaSafeSecond(duration)) }); }} /> :
             isStill ? <img src={active ? previewUrl : undefined} alt="待处理原图" /> : <p>正在读取文件类型…</p>}
          </div>}
          {(isVideo || isAudio) && !['gallery','concat'].includes(operation) && <p className="mp-preview-position">当前播放位置 {position.toFixed(1)} 秒</p>}
          </div>
        </div>
        {error && <div className="video-error" role="alert">{error}</div>}
      </div>
      <aside className="mp-options-card">
        <div className="mp-section-head"><strong>处理方式</strong></div>
        <div className="mp-operation-list" role="group" aria-label="处理方式">{choices.map(([id, label]) => <button key={id} type="button" className={operation === id ? 'active' : ''} aria-pressed={operation === id} disabled={!status.available || !mediaFeatureAvailable(status.features,id)} title={status.available && !mediaFeatureAvailable(status.features,id) ? mediaUnavailableHint(id) : undefined} onClick={() => { setOperation(id); if (job) setSourceExpanded(true); }}><span>{label}</span>{status.available && !mediaFeatureAvailable(status.features,id) && <small>{['subtitles','separate'].includes(id) ? '待配置' : '暂不可用'}</small>}</button>)}</div>
        {status.available && !featureAvailable && <p className="mp-muted" role="status">{mediaUnavailableHint(operation)}</p>}
        {!file && !source && !['gallery','concat'].includes(operation) && featureAvailable && <p className="mp-start-hint">选择素材后可设置参数。</p>}
        {sourceHint&&<p className="mp-start-hint" role="status">{sourceHint}</p>}
        <div className="mp-parameters" hidden={!showParameters}>
        {operation === 'trim' && <div className="mp-field-row"><label>开始秒数<input type="number" min="0" step="0.1" value={params.start} onChange={event => setParams({ ...params, start: event.target.value })} /><button type="button" className="mp-mark" disabled={!previewUrl || Boolean(job) && !sourceExpanded} title={job && !sourceExpanded ? '展开原素材后可选取播放位置' : undefined} onClick={() => setCurrentTime('start')}>设为当前位置</button></label><label>结束秒数<input type="number" min="0" step="0.1" value={params.end} placeholder="请输入结束时间" onChange={event => setParams({ ...params, end: event.target.value })} /><button type="button" className="mp-mark" disabled={!previewUrl || Boolean(job) && !sourceExpanded} title={job && !sourceExpanded ? '展开原素材后可选取播放位置' : undefined} onClick={() => setCurrentTime('end')}>设为当前位置</button></label></div>}
        {['compress', 'convert'].includes(operation) && <div className="mp-field-row"><label>质量<select value={params.quality} onChange={event => setParams({ ...params, quality: event.target.value })}><option value="balanced">均衡</option><option value="small">文件更小</option><option value="high">画质优先</option></select></label><label>最高高度<select value={params.maxHeight} onChange={event => setParams({ ...params, maxHeight: event.target.value })}><option value="720">720p</option><option value="1080">1080p</option><option value="0">原始</option></select></label>{operation === 'convert' && <label>格式<select value={params.format} onChange={event => setParams({ ...params, format: event.target.value })}><option value="mp4">MP4</option><option value="webm">WebM</option></select></label>}</div>}
        {operation === 'audio' && <label className="mp-single-field">格式<select value={['mp3', 'wav'].includes(params.format) ? params.format : 'mp3'} onChange={event => setParams({ ...params, format: event.target.value })}><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>}
        {operation === 'edit' && <div className="mp-field-row"><label>画幅<select value={params.aspect} onChange={event=>setParams({...params,aspect:event.target.value})}><option value="original">原始</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="16:9">16:9</option></select></label><label>适配<select value={params.fit} onChange={event=>setParams({...params,fit:event.target.value})}><option value="crop">裁剪填满</option><option value="pad">留边完整</option></select></label><label>旋转<select value={params.rotation} onChange={event=>setParams({...params,rotation:event.target.value})}><option value="0">不旋转</option><option value="90">顺时针 90°</option><option value="180">180°</option><option value="270">顺时针 270°</option></select></label><label>速度<select value={params.speed} onChange={event=>setParams({...params,speed:event.target.value})}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label>音量<input type="number" min="0" max="2" step="0.1" value={params.volume} disabled={params.mute} onChange={event=>setParams({...params,volume:event.target.value})}/></label><label className="mp-check"><input type="checkbox" checked={params.mute} onChange={event=>setParams({...params,mute:event.target.checked})}/>静音</label></div>}
        {operation === 'subtitles' && <div className="mp-subtitle-options"><label>原始语言<select value={params.language} onChange={event => setParams({ ...params, language:event.target.value })}><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英文</option></select></label><label>翻译字幕<select value={params.targetLanguage} disabled={!status.features?.translation} onChange={event => setParams({ ...params, targetLanguage:event.target.value })}><option value="none">只要原始字幕</option><option value="zh">翻译为中文</option><option value="en">翻译为英文</option></select></label><label className="mp-check"><input type="checkbox" checked={params.burnIn} onChange={event => setParams({ ...params, burnIn:event.target.checked })} />同时导出内嵌字幕视频</label>{status.features?.subtitles === true && !status.features?.translation&&<p>翻译 AI 工具待配置，配置后可使用；仍可选择原始字幕。</p>}</div>}
        {operation === 'separate' && <p className="mp-muted">会生成两条音轨：人声和伴奏。</p>}
        {operation === 'gallery' && <p className="mp-muted">{galleryPlatformLabel?`当前仅支持 ${galleryPlatformLabel} 公开图集。`:'图集采集将在公开站点规则接入后启用。'}</p>}
        {operation === 'frame' && <div className="mp-field-row"><label>画面秒数<input type="number" min="0" step="0.1" value={params.at} onChange={event => setParams({ ...params, at: event.target.value })} /><button type="button" className="mp-mark" disabled={!previewUrl || Boolean(job) && !sourceExpanded} title={job && !sourceExpanded ? '展开原素材后可选取播放位置' : undefined} onClick={() => setCurrentTime('at')}>设为当前位置</button></label><label>图片格式<select value={['png', 'jpeg'].includes(params.format) ? params.format : 'png'} onChange={event => setParams({ ...params, format: event.target.value })}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label></div>}
        {operation === 'remove-background' && <p className="mp-muted">生成透明 PNG，并与原图切换对比。</p>}
        {invalidTrim && (file || source) && <p className="mp-muted">开始时间须不小于 0，结束时间须晚于开始且不超过素材时长。</p>}
        {file && ['trim','compress','convert'].includes(operation) && <div className="mp-local-actions"><button type="button" className="btn btn-ghost" disabled={!localSupported || localBusy || invalidTrim} title={!localSupported?'当前浏览器不支持本地处理，可改用服务器处理。':undefined} onClick={runLocal}>{localBusy ? `浏览器处理中 ${progress}%` : '此浏览器处理'}</button>{localBusy&&<button type="button" className="btn btn-ghost" onClick={cancelLocal}>取消</button>}</div>}
        </div>
        <button type="button" className="btn btn-primary mp-submit" disabled={busy || !status.available || !featureAvailable || (operation==='subtitles' && params.targetLanguage!=='none' && !status.features?.translation) || (!['gallery','concat'].includes(operation) && !file && !source) || invalidSource || invalidTrim} onClick={submit}>{busy ? `正在提交${progress ? ` · ${progress}%` : ''}` : '开始处理'}</button>
      </aside>
    </div>
    {localOutput?.file&&<section className="mp-local-result" aria-label="浏览器处理结果"><strong>浏览器处理完成</strong><span>{localOutput.file.name} · {videoFileSize(localOutput.file.size)}</span><div><a className="btn btn-ghost" href={localOutput.url} download={localOutput.file.name}>下载文件</a><button type="button" className="btn btn-ghost" disabled={localOutput.file.size>100*1048576} title={localOutput.file.size>100*1048576?'素材库上传上限为 100 MB。':undefined} onClick={()=>void choose(localOutput.file)}>用于服务器处理或上传</button></div></section>}
    <details className="mp-recent"><summary>处理记录 <span>{recentJobs.length}</span></summary><div>{loading ? <p>正在读取…</p> : !recentJobs.length ? <p>完成处理后，记录会显示在这里。</p> : recentJobs.slice(0,12).map(item => <button key={item.id} type="button" className={job?.id === item.id ? 'active' : ''} onClick={() => { setSelected(item.id); window.location.hash = mediaJobHref(mode, space, item.id); }}><strong>{mediaDisplayTitle(item)}</strong><small>{mediaOperationLabel(item)} · {item.state === 'saved' ? '已完成' : mediaBusy(item) ? '处理中' : '失败'}</small></button>)}</div></details>
  </section>;
}
function MediaTextWorkspace({ active, visible, space, hash, showToast, userKey }) {
  const localSubtitles=workspaceHashParams(hash).get('textMode')==='subtitles';
  const switchMode=next=>{
    window.location.hash=`#media-tools?${new URLSearchParams({tab:'transcribe',space,...(next==='subtitles'?{textMode:'subtitles'}:{})})}`;
  };
  return <section className="mp-text-workspace" hidden={!visible} aria-label="文字与字幕">
    <div className="mp-text-nav" role="tablist" aria-label="文字与字幕方式"><button type="button" role="tab" aria-selected={!localSubtitles} className={!localSubtitles?'active':''} onClick={()=>switchMode('legacy')}>链接转文字</button><button type="button" role="tab" aria-selected={localSubtitles} className={localSubtitles?'active':''} onClick={()=>switchMode('subtitles')}>文件字幕</button></div>
    {localSubtitles
      ? <MediaProcessingTool key={`subtitles:${userKey}:${space}`} panelId="media-tools-panel-transcribe" mode="subtitles" active={active} visible={visible} space={space} hash={hash} showToast={showToast} />
      : <ToolShell key={`transcribe:${userKey}:${space}`} tool={VIDEO_TOOL_CATALOG[3]} embedded hash={hash} visible={visible} active={active} space={space} showToast={showToast} />}
  </section>;
}
