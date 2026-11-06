import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, lstat, rm, chmod } from 'node:fs/promises';
import { createReadStream, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_ENTRIES = 128;
const TTL = 60 * 60 * 1000;
const VIDEO_QUALITIES = new Set([360,480,720,1080]);
const VIDEO_FORMATS = new Set(['mp4','webm','mkv']);
const VIDEO_EXTENSIONS = new Set(['.mp4','.webm','.mkv']);
const AUDIO_EXTENSIONS = new Set(['.m4a','.mp3']);
const MIME_TYPES = { '.mp4':'video/mp4', '.webm':'video/webm', '.mkv':'video/x-matroska', '.m4a':'audio/mp4', '.mp3':'audio/mpeg' };
const HOSTS = new Set(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','vimeo.com','www.vimeo.com','x.com','www.x.com','twitter.com','www.twitter.com','instagram.com','www.instagram.com','tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com','bilibili.com','www.bilibili.com','b23.tv','douyin.com','www.douyin.com','v.douyin.com']);
const error = (status, message) => Object.assign(new Error(message), { status });
const cookieSiteForUrl = value => {
  let host='';try { host=new URL(value).hostname.toLowerCase(); } catch { return null; }
  if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(host))return 'youtube';
  if(['bilibili.com','www.bilibili.com','b23.tv'].includes(host))return 'bilibili';
  if(['douyin.com','www.douyin.com','v.douyin.com'].includes(host))return 'douyin';
  if(['instagram.com','www.instagram.com'].includes(host))return 'instagram';
  if(['tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com'].includes(host))return 'tiktok';
  if(['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host))return 'x';
  return null;
};
export function classifyOmnigetFailure(stderr, url) {
  if (/requires login|import cookies/i.test(stderr)) return error(422,'该平台要求登录验证，当前下载服务未配置此平台 Cookie');
  let host='';try { host=new URL(url).hostname.toLowerCase(); } catch { /* validation occurs before runner */ }
  // This wording is intentionally tied to OmniGet's Bilibili-specific failure,
  // not to a generic non-zero exit. A no-credential sandbox probe confirmed
  // the public page currently returns HTTP 412 from the platform.
  if ((host==='bilibili.com'||host==='www.bilibili.com') && /bilibili extractor failed first:\s*failed to access the page/i.test(stderr)) return error(422,'B站当前拒绝服务器解析请求，请稍后重试或使用平台允许的下载方式');
  return error(502,'平台未返回可用文件，可能需要登录或不支持该链接');
}
export function validateOmnigetUrl(input) {
  let url; try { url = new URL(input); } catch { throw error(400, '请输入有效的作品链接'); }
  const host = url.hostname.toLowerCase();
  if (String(input).length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !HOSTS.has(host)) throw error(400, '仅支持列出的公开平台 HTTPS 作品链接');
  const p = url.pathname;
  const is = (...hosts) => hosts.includes(host);
  // Exact host and route checks keep the runner from becoming a general URL fetcher.
  const single =
    (is('youtube.com','www.youtube.com','m.youtube.com') && (/^\/watch$/.test(p) ? Boolean(url.searchParams.get('v')) : /^\/(shorts|live|clip)\/[\w-]+\/?$/.test(p))) ||
    (is('youtu.be','b23.tv','v.douyin.com','vm.tiktok.com','vt.tiktok.com') && /^\/[\w-]+\/?$/.test(p)) ||
    (is('vimeo.com','www.vimeo.com') && /^\/\d+\/?$/.test(p)) ||
    (is('x.com','www.x.com','twitter.com','www.twitter.com') && /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(p)) ||
    (is('instagram.com','www.instagram.com') && /^\/(p|reel|reels|tv)\/[\w-]+\/?$/.test(p)) ||
    (is('tiktok.com','www.tiktok.com') && /^\/@[\w.-]+\/video\/\d+\/?$/.test(p)) ||
    (is('bilibili.com','www.bilibili.com') && /^\/video\/[A-Za-z0-9]+\/?$/.test(p)) ||
    (is('douyin.com','www.douyin.com') && /^\/video\/\d+\/?$/.test(p));
  if (!single || url.searchParams.has('list')) throw error(400, '请使用单个作品链接，暂不支持合集和主页');
  // Durable history stores only the stable public work identity, never
  // tracking, signed, or incidental query parameters.
  if (is('youtube.com','www.youtube.com','m.youtube.com') && p==='/watch') {
    const videoId=url.searchParams.get('v');url.search=`?v=${encodeURIComponent(videoId)}`;
  } else url.search='';
  return url.href;
}
export function parseOmnigetOutput(output, type) {
  const rows = String(output).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  // Upstream 0.14 progress lines contain Rust Some()/None, not valid JSON.
  const row = rows.findLast(item => type === 'info' ? typeof item.title === 'string' && typeof item.platform === 'string' : item.type === 'complete');
  if (!row || (type !== 'info' && row.success !== true)) throw error(502, '下载引擎未返回有效结果');
  return row;
}
export function normalizeOmnigetDownloadOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(400,'请求格式错误');
  const keys=Object.keys(input);
  if (keys.some(key=>!['quality','format','audioOnly'].includes(key))) throw error(400,'下载选项不受支持');
  const audioOnly=input.audioOnly===undefined?false:input.audioOnly;
  if (typeof audioOnly!=='boolean') throw error(400,'仅音频选项无效');
  if (audioOnly) {
    if ('quality' in input || 'format' in input) throw error(400,'仅音频不能指定视频清晰度或格式');
    return {audioOnly:true};
  }
  const quality=input.quality===undefined?720:Number(input.quality);
  const format=input.format===undefined?'mp4':String(input.format).toLowerCase();
  if (!VIDEO_QUALITIES.has(quality)) throw error(400,'清晰度仅支持 360、480、720 或 1080');
  if (!VIDEO_FORMATS.has(format)) throw error(400,'视频格式仅支持 mp4、webm 或 mkv');
  return {quality,format,audioOnly:false};
}
export function buildOmnigetRunnerArgs(mode, job, destination) {
  if (mode==='info') return [mode,job.url,destination];
  const { autoDownload, ...downloadOptions }=job.options||{};
  if (autoDownload!==undefined && typeof autoDownload!=='boolean') throw error(400,'下载选项不受支持');
  const options=normalizeOmnigetDownloadOptions(downloadOptions);
  return [mode,job.url,destination,String(options.quality??''),options.format??'',options.audioOnly?'1':'0'];
}
async function outputSize(directory) {
  let total = 0; let entries = 0;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entries > MAX_OUTPUT_ENTRIES || entry.isSymbolicLink()) throw error(413, '文件超过 100 MB 限制或输出不受支持');
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        total += (await lstat(target)).size;
        if (total > MAX_BYTES) throw error(413, '文件超过 100 MB 限制或输出不受支持');
      } else throw error(413, '文件超过 100 MB 限制或输出不受支持');
    }
  }
  await visit(directory);
  return total;
}
export function createOmnigetHandler({ getUser, directory, runner = process.env.OMNIHUB_OMNIGET_RUNNER, origin = 'https://omnihub.noxhub.org', runImpl, queue, stopQueueUnits, cookieStore } = {}) {
  const jobs = new Map(); let active = 0;
  const activeQueueWorkers=new Map();
  const queueExecutions=new Map();
  const root = path.resolve(directory);
  const ownerHasActive = owner => [...jobs.values()].some(job => job.owner === String(owner) && ['parsing','downloading'].includes(job.status));
  const ownerHasQueueExecution = owner => [...queueExecutions.values()].some(value => value===String(owner));
  const hasExecutionCapacity = owner => active+queueExecutions.size<2&&!ownerHasActive(owner)&&!ownerHasQueueExecution(owner);
  function prepareRunnerCookie(job, destination) {
    const site=cookieStore&&cookieSiteForUrl(job.url);if(!site)return null;
    const file=path.join(destination,'.omniget-cookie');
    try {
      cookieStore.consumeForRunner(job.owner,site,text=>{
        try { unlinkSync(file); } catch (reason) { if(reason.code!=='ENOENT')throw reason; }
        writeFileSync(file,text,{encoding:'utf8',mode:0o600,flag:'wx'});
        const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw error(500,'Cookie 临时凭据创建失败');
      });
      return file;
    } catch(reason) {
      try { unlinkSync(file); } catch (cleanupError) { if(cleanupError.code!=='ENOENT')throw cleanupError; }
      if(reason?.status===409)return null;
      throw error(reason?.status===400?400:500,'Cookie 凭据无法安全使用');
    }
  }
  const removeRunnerCookie=file=>{if(!file)return;try{unlinkSync(file);}catch(reason){if(reason.code!=='ENOENT')throw reason;}};
  const command = (file,args) => new Promise(resolve=>{const child=spawn(file,args,{stdio:['ignore','pipe','ignore']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.on('error',()=>resolve({code:1,output:''}));child.on('close',code=>resolve({code:code??1,output}));});
  async function confirmQueueUnitsStopped(id) {
    if(runImpl)return true;
    if(stopQueueUnits)return Boolean(await stopQueueUnits(id));
    for(const mode of ['info','download']) await command('/usr/bin/systemctl',['stop',`omnihub-omniget-${id}-${mode}.service`]);
    for(let attempt=0;attempt<20;attempt++) {
      const states=await Promise.all(['info','download'].map(mode=>command('/usr/bin/systemctl',['show','-p','ActiveState','--value',`omnihub-omniget-${id}-${mode}.service`])));
      // A failed inspection is not evidence that a unit stopped. Only systemd's
      // successful inactive/failed response permits destructive cleanup.
      if(states.every(result=>result.code===0&&['inactive','failed'].includes(result.output.trim())))return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  }
  async function removeQueueArtifacts(task) {
    if(activeQueueWorkers.has(task.id)||queueExecutions.has(task.id)||!/^[0-9a-f-]{36}$/.test(task.id))return false;
    const target=path.resolve(root,task.id);if(path.dirname(target)!==root||!await confirmQueueUnitsStopped(task.id))return false;
    await rm(target,{recursive:true,force:true});return true;
  }
  async function removeLegacyOrphan(id) {
    if(!/^[0-9a-f-]{36}$/.test(id)||jobs.has(id)||queue?.hasJobId?.(id))return false;
    const target=path.resolve(root,id);if(path.dirname(target)!==root||!await confirmQueueUnitsStopped(id))return false;
    // A retry or a newly persisted queue record may appear while the units are
    // stopping. Re-read both ownership sources before the irreversible step.
    if(jobs.has(id)||queue?.hasJobId?.(id))return false;
    await rm(target,{recursive:true,force:true});return true;
  }
  const send = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
  const present = j => ({id:j.id,url:j.url,status:j.status,title:j.title,platform:j.platform,duration:j.duration,size:j.size,error:j.error,options:j.options,expiresAt:j.created+TTL,downloadUrl:j.status==='ready'?`/api/omniget/jobs/${j.id}/file`:null});
  async function cleanup() {
    for (const [id,j] of jobs) if (Date.now()-j.created>TTL && !['parsing','downloading'].includes(j.status)) { jobs.delete(id); await rm(path.join(root,id),{recursive:true,force:true}); }
    // Recover old in-memory jobs after restart without ever using a timestamp
    // to delete a persisted queue task. Ownership is checked before and after
    // the transient units are stopped.
    for (const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])) if (/^[0-9a-f-]{36}$/.test(entry.name) && entry.isDirectory() && !jobs.has(entry.name) && !queue?.hasJobId?.(entry.name)) {
      const st=await lstat(path.join(root,entry.name)); if(Date.now()-st.mtimeMs>TTL) await removeLegacyOrphan(entry.name);
    }
    // Persistent queue history remains after expiry, but its private payload is
    // removed only after the queue CAS proves this exact ready item is expired.
    if(queue) for(const task of queue.listExpiredReady(Date.now(),50)) {
      if(!/^[0-9a-f-]{36}$/.test(task.id))continue;
      try { if(await removeQueueArtifacts(task))queue.expireReady(task.owner,task.id,Date.now()); } catch { /* retain ready history for a later safe retry */ }
    }
    if(queue?.claimGcTasks) for(const task of queue.claimGcTasks(50)) {
      try { queue.finishGc(task.owner,task.id,task.ticket,{deleted:await removeQueueArtifacts(task)}); }
      catch { queue.finishGc(task.owner,task.id,task.ticket,{deleted:false}); }
    }
  }
  const timer=setInterval(()=>cleanup().catch(()=>{}),60000);timer.unref();
  async function run(mode, job, onController) {
    const destination=path.join(root,job.id);
    // The root is root-only on the host. Each dynamic-user unit sees only its
    // own bind-mounted directory at /work, never another user's job directory.
    await mkdir(destination,{recursive:true,mode:0o777}); await chmod(destination,0o777);
    const credential=prepareRunnerCookie(job,destination);
    try {
      if (runImpl) return await runImpl(mode,job,destination);
      return await new Promise((resolve,reject)=>{
      let output='', stderr='', settled=false;
      const child=spawn(runner,buildOmnigetRunnerArgs(mode,job,destination),{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin'},detached:true});
      let stopping=false;
      const stop=(err)=>{if(stopping)return;stopping=true;const stopper=spawn('/usr/bin/systemctl',['stop',`omnihub-omniget-${job.id}-${mode}.service`],{stdio:'ignore'});stopper.on('close',()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}finish(err);});stopper.on('error',()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}finish(err);});};
      onController?.({cancel:()=>stop(error(499,'任务已取消'))});
      const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(deadline);if(disk)clearInterval(disk);err?reject(err):resolve(value);};
      const deadline=setTimeout(()=>stop(error(504,'处理超时，请稍后重试')),mode==='info'?65000:185000);
      // Info commands legitimately create HOME/XDG state below /work. Only download
      // output is size-policed; nested regular files are counted, never followed.
      const disk=mode==='download'&&setInterval(()=>{void outputSize(destination).catch(reason=>stop(reason.status?reason:error(413,'文件超过 100 MB 限制或输出不受支持')));},500);
      child.stdout.on('data',chunk=>{output+=chunk; if(output.length>1024*1024)stop(error(502,'下载引擎输出过大'));});
      child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
      child.on('error',()=>finish(error(503,'下载引擎暂不可用')));
      child.on('close',code=>{if(code!==0)return finish(classifyOmnigetFailure(stderr,job.url));try{finish(null,parseOmnigetOutput(output,mode));}catch(e){finish(e);}});
      });
    } finally { removeRunnerCookie(credential); }
  }
  async function start(job, mode) {
    active++;job.status=mode==='info'?'parsing':'downloading';job.error='';
    try {
      const value=await run(mode,job);
      if(mode==='info') {
        if(Number(value.file_size_bytes)>MAX_BYTES)throw error(413,'文件超过 100 MB 限制');
        job.title=String(value.title||'视频').slice(0,300);job.platform=String(value.platform||'').slice(0,80);job.duration=Number(value.duration)||0;job.status='parsed';
      } else {
        const returned=path.resolve(value.file_path||'');
        if(!runImpl && path.dirname(returned)!=='/work')throw error(502,'下载结果不符合文件限制');
        const file=runImpl?returned:path.join(root,job.id,path.basename(returned));
        if(path.dirname(file)!==path.join(root,job.id))throw error(502,'下载结果不符合文件限制');
        const st=await lstat(file);
        const extension=path.extname(file).toLowerCase();
        const permitted=job.options?.audioOnly?AUDIO_EXTENSIONS:VIDEO_EXTENSIONS;
        if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>MAX_BYTES||!permitted.has(extension))throw error(502,'下载结果不符合文件限制');
        job.file=file;job.size=st.size;job.status='ready';
      }
    } catch(e) { job.status='failed';job.error=e.status?e.message:'下载处理失败';await rm(path.join(root,job.id),{recursive:true,force:true}).catch(()=>{}); }
    finally { active--;void pumpQueue(); }
  }
  async function queueDownload(job) {
    const value=await run('download',job,controller=>activeQueueWorkers.set(job.id,controller));
    const returned=path.resolve(value.file_path||'');
    if(!runImpl&&path.dirname(returned)!=='/work')throw error(502,'下载结果不符合文件限制');
    const file=runImpl?returned:path.join(root,job.id,path.basename(returned));
    if(path.dirname(file)!==path.join(root,job.id))throw error(502,'下载结果不符合文件限制');
    const st=await lstat(file), extension=path.extname(file).toLowerCase();
    const permitted=job.options?.audioOnly?AUDIO_EXTENSIONS:VIDEO_EXTENSIONS;
    if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>MAX_BYTES||!permitted.has(extension)||!MIME_TYPES[extension])throw error(502,'下载结果不符合文件限制');
    return {fileName:path.basename(file),size:st.size,mime:MIME_TYPES[extension],expiresAt:Date.now()+TTL};
  }
  async function executeQueued(job) {
    try {
      const value=await run('info',job,controller=>activeQueueWorkers.set(job.id,controller));
      if(Number(value.file_size_bytes)>MAX_BYTES)throw error(413,'文件超过 100 MB 限制');
      if(!queue.recordParsed(job.owner,job.id,{metadata:{title:String(value.title||'视频').slice(0,300),platform:String(value.platform||'').slice(0,80),duration:Number(value.duration)||0}})) {
        if(queue.get(job.owner,job.id)?.state==='cancelling')queue.complete(job.owner,job.id,{state:'cancelled'});
        return;
      }
      const routed=queue.routeParsed(job.owner,job.id);
      if(routed?.state!=='downloading')return;
      const metadata=await queueDownload(job);
      queue.complete(job.owner,job.id,{state:'ready',metadata});
    } catch(e) {
      const current=queue.get(job.owner,job.id);
      queue.complete(job.owner,job.id,{state:current?.state==='cancelling'?'cancelled':'failed',error:e.status?e.message:'下载处理失败'});
    } finally { activeQueueWorkers.delete(job.id);queueExecutions.delete(job.id);void cleanup();void pumpQueue(); }
  }
  async function executeQueuedDownload(job) {
    try { const metadata=await queueDownload(job);queue.complete(job.owner,job.id,{state:'ready',metadata}); }
    catch(e) { const current=queue.get(job.owner,job.id);queue.complete(job.owner,job.id,{state:current?.state==='cancelling'?'cancelled':'failed',error:e.status?e.message:'下载处理失败'}); }
    finally { activeQueueWorkers.delete(job.id);queueExecutions.delete(job.id);void cleanup();void pumpQueue(); }
  }
  function pumpQueue() {
    if(!queue)return;
    for(;;) {
      const job=queue.claimNext({canRun:candidate=>hasExecutionCapacity(candidate.owner)});
      if(!job)break;
      queueExecutions.set(job.id,String(job.owner));void executeQueued(job);
    }
  }
  async function body(req, maxBytes=4096) { let raw='';for await(const c of req){raw+=c;if(raw.length>maxBytes)throw error(413,'请求过大');}try{return JSON.parse(raw);}catch{throw error(400,'请求格式错误');} }
  const handler=async(req,res,pathname)=>{
    if(!pathname.startsWith('/api/omniget/'))return false;
    try {
      const user=getUser(req);if(!user)throw error(401,'请先登录');
      if(!['GET','POST'].includes(req.method))throw error(405,'不支持的操作');
      if(req.method==='POST' && (req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site'))throw error(403,'请求来源不可信');
      if(pathname==='/api/omniget/status'&&req.method==='GET'){send(res,200,{enabled:Boolean(runner||runImpl),maxBytes:MAX_BYTES,retentionMinutes:60,capabilities:{qualities:[360,480,720,1080],videoFormats:['mp4','webm','mkv'],audioOnly:true,subtitles:false},queue:queue?queue.status(user.id):undefined});return true;}
      if(!runner&&!runImpl)throw error(503,'OmniGet 服务尚未启用');
      await mkdir(root,{recursive:true,mode:0o700});
      if(queue&&pathname==='/api/omniget/queue'&&req.method==='GET'){send(res,200,{jobs:queue.list(user.id)});return true;}
      if(queue&&pathname==='/api/omniget/queue/batch'&&req.method==='POST') {
        const input=await body(req,24576);const {urls,...rawOptions}=input;
        const options={...normalizeOmnigetDownloadOptions(rawOptions),autoDownload:true};
        const queued=queue.enqueue(user.id,urls,{options,source:'batch'});pumpQueue();send(res,202,{jobs:queued});return true;
      }
      const queueMatch=queue&&/^\/api\/omniget\/queue\/([0-9a-f-]{36})(?:\/(cancel|retry|file))?$/.exec(pathname);
      if(queueMatch) {
        const id=queueMatch[1], action=queueMatch[2];
        if(!action&&req.method==='GET'){const job=queue.get(user.id,id);if(!job)throw error(404,'任务不存在');send(res,200,job);return true;}
        if(action==='cancel'&&req.method==='POST') {
          const job=queue.cancel(user.id,id);if(!job)throw error(409,'任务无法取消');
          activeQueueWorkers.get(id)?.cancel();send(res,202,job);return true;
        }
        if(action==='retry'&&req.method==='POST') {const job=queue.retry(user.id,id);if(!job)throw error(409,'任务无法重试');pumpQueue();send(res,202,job);return true;}
        if(action==='file'&&req.method==='GET') {
          const job=queue.get(user.id,id), metadata=job?.metadata||{};
          if(!job||job.state!=='ready')throw error(404,'文件不可用');
          if(!Number.isFinite(metadata.expiresAt)||metadata.expiresAt<Date.now())throw error(410,'文件已过期');
          const fileName=String(metadata.fileName||'');if(path.basename(fileName)!==fileName)throw error(404,'文件不可用');
          const file=path.join(root,id,fileName), extension=path.extname(file).toLowerCase(), st=await lstat(file);
          const permitted=job.options?.audioOnly?AUDIO_EXTENSIONS:VIDEO_EXTENSIONS;
          if(!st.isFile()||st.isSymbolicLink()||st.size!==metadata.size||!permitted.has(extension)||!MIME_TYPES[extension])throw error(404,'文件不可用');
          res.writeHead(200,{'Content-Type':MIME_TYPES[extension],'Content-Length':st.size,'Content-Disposition':`attachment; filename="download${extension}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
          const stream=createReadStream(file);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);return true;
        }
        throw error(404,'接口不存在');
      }
      if(pathname==='/api/omniget/jobs'&&req.method==='POST') {
        if(!hasExecutionCapacity(user.id))throw error(429,'下载服务繁忙，请稍后重试');
        await cleanup();if(jobs.size>=200||[...jobs.values()].filter(j=>j.owner===String(user.id)).length>=20)throw error(429,'当前任务较多，请稍后再试');
        const input=await body(req);if(!hasExecutionCapacity(user.id)||jobs.size>=200||[...jobs.values()].filter(j=>j.owner===String(user.id)).length>=20)throw error(429,'当前任务较多，请稍后再试');const job={id:randomUUID(),owner:String(user.id),url:validateOmnigetUrl(input.url),created:Date.now(),status:'parsing'};jobs.set(job.id,job);void start(job,'info');send(res,202,present(job));return true;
      }
      const match=/^\/api\/omniget\/jobs\/([0-9a-f-]{36})(?:\/(download|file))?$/.exec(pathname);
      const job=match&&jobs.get(match[1]);if(!job||job.owner!==String(user.id)||Date.now()-job.created>TTL)throw error(404,'任务不存在或已过期');
      if(match[2]==='download'&&req.method==='POST'){
        if(job.status!=='parsed')throw error(409,'请先完成解析，勿重复提交');if(!hasExecutionCapacity(user.id))throw error(429,'下载服务繁忙，请稍后重试');
        const options=normalizeOmnigetDownloadOptions(await body(req));
        // A second request may finish reading its body while this request awaits.
        // Recheck immediately before changing state so only one download can start.
        if(job.status!=='parsed')throw error(409,'请先完成解析，勿重复提交');
        if(!hasExecutionCapacity(user.id))throw error(429,'下载服务繁忙，请稍后重试');
        job.options=options;void start(job,'download');send(res,202,present(job));return true;
      }
      if(match[2]==='file'&&req.method==='GET'){
        if(job.status!=='ready')throw error(409,'文件尚未准备好');
        const st=await lstat(job.file);if(!st.isFile()||st.isSymbolicLink())throw error(404,'文件不可用');
        const extension=path.extname(job.file).toLowerCase();
        const permitted=job.options?.audioOnly?AUDIO_EXTENSIONS:VIDEO_EXTENSIONS;
        if(!permitted.has(extension)||!MIME_TYPES[extension])throw error(404,'文件不可用');
        res.writeHead(200,{'Content-Type':MIME_TYPES[extension],'Content-Length':st.size,'Content-Disposition':`attachment; filename="download${extension}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
        const stream=createReadStream(job.file);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);return true;
      }
      if(!match[2]&&req.method==='GET'){send(res,200,present(job));return true;}
      throw error(404,'接口不存在');
    } catch(e){send(res,e.status||500,{error:e.status?e.message:'下载服务异常'});return true;}
  };
  // Reopen the same owner-scoped artifact that the download endpoints serve.
  handler.resolveSource = async (userId, type, id) => {
    if (!/^[0-9a-f-]{36}$/.test(id) || !['job', 'queue'].includes(type)) throw error(404, '文件不可用');
    const queued = type === 'queue';
    const job = queued ? queue?.get(userId, id) : jobs.get(id);
    if (!job || (!queued && job.owner !== String(userId))) throw error(404, '文件不可用');
    if ((queued ? job.state : job.status) !== 'ready') throw error(409, '文件尚未准备好');
    const expiresAt = queued ? job.metadata?.expiresAt : job.created + TTL;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw error(410, '文件已过期');
    const directory = path.join(root, id);
    const fileName = queued ? job.metadata?.fileName : path.basename(job.file || '');
    if (!fileName || path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') throw error(404, '文件不可用');
    const file = path.join(directory, fileName);
    if (!queued && file !== job.file) throw error(404, '文件不可用');
    const [folder, stat] = await Promise.all([lstat(directory), lstat(file)]).catch(() => []);
    const size = queued ? job.metadata?.size : job.size;
    const allowed = job.options?.audioOnly ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
    if (!folder?.isDirectory() || !stat?.isFile() || stat.size !== size || !allowed.has(path.extname(file).toLowerCase())) {
      throw error(404, '文件不可用');
    }
    return { path: file, size, title: queued ? job.metadata?.title : job.title, url: job.url };
  };
  handler.close=()=>clearInterval(timer);handler.cleanup=cleanup;return handler;
}
