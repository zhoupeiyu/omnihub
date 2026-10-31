import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/api/tools/media';
const LIMIT = 100 * 1024 * 1024;
const OUTPUT_LIMIT = 250 * 1024 * 1024;
const ACTIVE = new Set(['queued', 'processing', 'submission-unknown']);
const OPS = new Set(['trim', 'compress', 'convert', 'audio', 'frame', 'remove-background', 'download', 'subtitles', 'separate', 'gallery', 'edit', 'concat']);
const FORMATS = new Set(['mp4', 'webm', 'mp3', 'wav', 'png', 'jpeg']);
const INPUT_TYPES = new Set(['video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'image/jpeg', 'image/png', 'image/webp']);
const OUTPUT_TYPES = new Set([...INPUT_TYPES, 'audio/x-wav', 'audio/wave', 'application/x-subrip', 'text/vtt', 'text/plain']);
const inputType = type => ['audio/x-wav','audio/wave'].includes(type) ? 'audio/wav' : type;
const DOWNLOAD_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', 'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'instagram.com', 'www.instagram.com', 'soundcloud.com', 'www.soundcloud.com']);
const safeName = n => typeof n === 'string' && n.length > 0 && n.length <= 180 && !n.startsWith('.') && !/[\\/\0-\x1f\x7f]/.test(n);
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = v => createHash('sha256').update(v).digest('hex');
const clip = (v, n = 1000) => String(v || '').slice(0, n);

function failureMessage(error, operation) {
  const detail = String(error || '');
  if (['subtitles', 'separate'].includes(operation)) {
    if (/5 分钟|时长|duration/i.test(detail)) return '字幕和人声分离支持 5 分钟以内的素材，请先裁剪片段。';
    if (/没有.*(?:语音|音轨)|未.*(?:语音|音轨)|no audio/i.test(detail)) return '没有识别到清晰语音或可用音轨，请换一段素材。';
    if (/未安装|未启用|not installed/.test(detail)) return '该处理组件暂不可用，请稍后重试。';
    if (/翻译.*(?:语言|支持)|语言.*翻译/.test(detail)) return '当前离线翻译仅支持中文和英文，请选择对应语言。';
  }
  if (operation === 'download') {
    if (/sign.?in|logged.?in|login required|not a bot|oauth token|cookies/i.test(detail)) return '该平台当前要求登录或验证，暂时无法下载这条作品。可先保存文件，再上传处理。';
    if (/没有可安全下载|没有可配对的安全音轨/.test(detail)) return '该作品的媒体格式暂不支持下载。可先保存文件，再上传处理。';
    if (/unavailable|not found|private video|removed|HTTP Error (?:403|404|500)/i.test(detail)) return '这条作品当前无法访问，可能已下架或限制访问。请检查原链接。';
  }
  if (/超时|timed? ?out/i.test(detail)) return '处理超时，请尝试较小的文件或稍后重试。';
  if (/超过 (?:100|250) MB/.test(detail)) return '文件超过处理大小限制，请选择较小的文件。';
  return '媒体处理失败，请重试。';
}

export function createMediaProcessingHandler({ databasePath, getUser = () => null,
  baseUrl = process.env.OMNIHUB_MEDIA_API_URL, apiKey = process.env.OMNIHUB_MEDIA_API_KEY,
  origin = process.env.OMNIHUB_MEDIA_ORIGIN || 'https://omnihub.noxhub.org', fetchImpl = fetch, sourceReader, refreshIntervalMs = 2500 } = {}) {
  const db = new DatabaseSync(databasePath || ':memory:');
  if (databasePath && databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS media_jobs_owner ON jobs(owner, created DESC);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  if (baseUrl && !/^http:\/\/127\.0\.0\.1:8110\/?$/.test(baseUrl)) throw new Error('Media API must use http://127.0.0.1:8110');
  const configured = Boolean(baseUrl && apiKey);
  const pending = new Map(); let closed = false; let totalStreams = 0; const streams = new Map(); const reservations = new Map();
  const now = () => Date.now();
  const write = job => { if (closed) return job; job.updated = now(); db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.owner, job.created, job.updated, JSON.stringify(job)); return job; };
  const present = ({ owner, workerId, checked, ...job }) => ({ ...job, engine: 'media', visibility: owner === 'public' ? 'public' : 'private', input: job.input || '' });
  const ownerFor = user => user ? `user:${user.id}` : 'public';
  const read = (id, owner) => { const row = db.prepare("SELECT payload FROM jobs WHERE id=? AND (owner=? OR owner='public')").get(id, owner); if (!row) throw fail(404, '找不到这条记录。'); return JSON.parse(row.payload); };
  const rate = (key, max, seconds) => { const bucket = `${key}:${Math.floor(now() / (seconds * 1000))}`; db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(bucket, now() + seconds * 1000); if (db.prepare('SELECT count FROM limits WHERE key=?').get(bucket).count > max) throw fail(429, '操作有些频繁，请稍后再试。'); };
  function reserve(owner) {
    const rows = db.prepare("SELECT owner FROM jobs WHERE json_extract(payload,'$.state') IN ('queued','processing','submitting') OR (json_extract(payload,'$.state')='submission-unknown' AND created>?)").all(now() - 15 * 60000);
    const held = [...reservations.values()].reduce((sum, n) => sum + n, 0);
    if (rows.length + held >= 8 || rows.filter(x => x.owner === owner).length + (reservations.get(owner) || 0) >= 3) throw fail(429, '处理队列已满，请稍后重试。');
    reservations.set(owner, (reservations.get(owner) || 0) + 1);
    return () => { const next = (reservations.get(owner) || 1) - 1; if (next) reservations.set(owner, next); else reservations.delete(owner); };
  }
  const files = value => (Array.isArray(value) ? value : []).filter(f => safeName(f.name) && OUTPUT_TYPES.has(f.content_type || f.type) && Number(f.bytes) >= 0 && Number(f.bytes) <= OUTPUT_LIMIT).slice(0,100).map(f => ({ name:f.name, type:f.content_type || f.type, bytes:Number(f.bytes)||0, label:clip(f.label || f.name,180), kind:f.kind || String(f.content_type || f.type).split('/')[0] }));
  async function upstream(path, init = {}, raw = false) {
    let response;
    try { response = await fetchImpl(`${baseUrl}${path}`, { redirect: 'error', ...init, headers: { Authorization: `Bearer ${apiKey}`, ...init.headers }, signal: init.signal || AbortSignal.timeout(10 * 60000) }); }
    catch { throw fail(503, '媒体处理服务暂时无法连接，请稍后再试。'); }
    if (raw) return response;
    let data; try { data = await response.json(); } catch { throw fail(502, '媒体处理服务返回异常，请稍后再试。'); }
    if (!response.ok || data.error) throw fail(response.status === 429 ? 429 : 502, '媒体处理未完成，请稍后重试。');
    return data.data ?? data;
  }
  function validOptions(operation, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail(400, '处理参数不正确。');
    const next = {};
    if (['gallery','concat'].includes(operation)) {
      if (Object.keys(options).length) throw fail(400, '此处理方式不接受额外参数。');
      return {};
    }
    if (operation === 'edit') {
      const { aspect = 'original', fit = 'crop', rotation = 0, speed = 1, mute = false, volume = 1 } = options;
      if (Object.keys(options).some(k => !['aspect','fit','rotation','speed','mute','volume'].includes(k)) || !['original','9:16','1:1','16:9'].includes(aspect) || !['crop','pad'].includes(fit) || ![0,90,180,270].includes(rotation) || ![0.5,1,1.5,2].includes(speed) || typeof mute !== 'boolean' || typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 2) throw fail(400, '画面编辑参数不正确。');
      return { aspect, fit, rotation, speed, mute, volume };
    }
    if (operation === 'subtitles') {
      if (Object.keys(options).some(k => !['language', 'targetLanguage', 'burnIn'].includes(k)) || !['auto', 'zh', 'en'].includes(options.language ?? 'auto') || !['none', 'zh', 'en'].includes(options.targetLanguage ?? 'none') || (options.burnIn != null && typeof options.burnIn !== 'boolean')) throw fail(400, '字幕参数不正确。');
      return { language: options.language ?? 'auto', targetLanguage: options.targetLanguage ?? 'none', burnIn: options.burnIn ?? false };
    }
    if (operation === 'separate') {
      if (Object.keys(options).length) throw fail(400, '人声分离不接受额外参数。');
      return {};
    }
    if (Object.keys(options).some(key => !['start','end','quality','format','maxHeight','at'].includes(key))) throw fail(400, '处理参数不正确。');
    if (options.start != null || options.end != null) { next.start = Number(options.start ?? 0); next.end = Number(options.end ?? 0); if (!Number.isFinite(next.start) || !Number.isFinite(next.end) || next.start < 0 || next.end < 0 || (operation === 'trim' && next.end <= next.start)) throw fail(400, '结束时间必须晚于开始时间。'); }
    if (options.quality != null) { if (!['balanced', 'small', 'high'].includes(options.quality)) throw fail(400, '处理质量不正确。'); next.quality = options.quality; }
    if (options.format != null) { if (!FORMATS.has(options.format)) throw fail(400, '输出格式不正确。'); next.format = options.format; }
    if (options.maxHeight != null) { if (![0, 720, 1080].includes(Number(options.maxHeight))) throw fail(400, '分辨率不正确。'); next.maxHeight = Number(options.maxHeight); }
    if (options.at != null) { next.at = Number(options.at); if (!Number.isFinite(next.at) || next.at < 0) throw fail(400, '截图时间不正确。'); }
    if (operation === 'trim' && (!Number.isFinite(next.end) || next.end <= next.start)) throw fail(400, '请填写有效的裁剪时间。');
    if (operation === 'download' && Object.keys(next).length) throw fail(400, '链接下载不接受处理参数。');
    return next;
  }
  function downloadUrl(text) {
    if (typeof text !== 'string' || text.length > 2048) throw fail(400, '请粘贴一条作品链接。');
    const links = text.match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
    if (links.length !== 1) throw fail(400, '每次请输入一条作品链接。');
    let url; try { url = new URL(links[0].replace(/[。，、；！？）】》」』.,;!?)\]]+$/u, '')); } catch { throw fail(400, '链接格式不正确。'); }
    const host=url.hostname.toLowerCase(), path=url.pathname.replace(/\/$/,'');
    const single=host.endsWith('youtube.com') ? (path==='/watch'&&Boolean(url.searchParams.get('v')))||/^\/(?:shorts|embed)\/[\w-]+$/.test(path)
      : host==='youtu.be' ? /^\/[\w-]+$/.test(path)
      : host.endsWith('vimeo.com') ? /^\/\d+$/.test(path)
      : host==='x.com'||host==='www.x.com'||host==='twitter.com'||host==='www.twitter.com' ? /^\/[\w-]+\/status\/\d+$/.test(path)
      : host.endsWith('instagram.com') ? /^\/(?:p|reel|tv)\/[\w-]+$/.test(path)
      : host.endsWith('soundcloud.com') ? /^\/[\w-]+\/[\w-]+$/.test(path) : false;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(host) || !single || url.searchParams.has('list')) throw fail(400, '仅支持公开平台的单条作品 HTTPS 链接。');
    return url.href;
  }
  function galleryUrl(text) {
    if (typeof text !== 'string' || text.length > 2048) throw fail(400, '请输入一个公开图集链接。');
    let url;
    try { url = new URL(text.trim()); } catch { throw fail(400, '图集链接格式不正确。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['imgur.com','www.imgur.com'].includes(url.hostname) || !/^\/(?:a\/|gallery\/)?[A-Za-z0-9]+\/?$/.test(url.pathname) || url.search || url.hash) throw fail(400, '目前支持 Imgur 公开图片或相册的 HTTPS 链接。');
    return url.href;
  }
  async function jsonBody(req, max = 8192) { if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请求格式不正确。'); const chunks=[]; let n=0; for await (const c of req) { n += c.length; if (n > max) throw fail(413, '请求过大。'); chunks.push(c); } try { const v=JSON.parse(Buffer.concat(chunks).toString()); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; } catch { throw fail(400, '请求格式不正确。'); } }
  async function uploadWorker(name, body, contentType, contentLength, signal) {
    const response = await upstream(`/v1/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': contentType, ...(contentLength ? {'Content-Length': String(contentLength)} : {}) }, body, duplex: 'half', signal });
    if (!response.id || !files(response.files).length) throw fail(502, '媒体服务没有返回可用的上传文件。');
    return response;
  }
  async function sourceToWorker(req, source, owner, res) {
    if (!source || !['video', 'media'].includes(source.engine) || !/^[a-f0-9-]{36}$/.test(source.jobId || '') || !safeName(source.fileName)) throw fail(400, '请选择素材库中的文件。');
    if (source.engine === 'media') { const job = read(source.jobId, owner); const file = job.files?.find(f => f.name === source.fileName); if (!file || !job.workerId || job.state !== 'saved') throw fail(404, '源文件不可用。'); return { job, file, sourceId: job.workerId, sourceFile: file.name }; }
    if (typeof sourceReader !== 'function') throw fail(503, '视频素材读取服务暂时不可用。');
    const result = await sourceReader(req, { jobId: source.jobId, fileName: source.fileName });
    if (!result?.job || !result?.response?.body || !safeName(source.fileName)) throw fail(404, '源文件不可用。');
    const size = Number(result.response.headers?.get?.('content-length') || 0);
    if (size > LIMIT || Number(result.file?.bytes || 0) > LIMIT) { await result.response.body?.cancel(); throw fail(413, '源文件超过 100 MB。'); }
    const type = inputType(result.file?.type);
    if (!result.response.ok || !INPUT_TYPES.has(type)) { await result.response.body?.cancel(); throw fail(415, '源文件类型无法确认。'); }
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 10 * 60000);
    const close = () => abort.abort(); req.on('aborted', close); res.on('close', close);
    let upload;
    const body = Readable.from((async function* () { let received=0; for await (const chunk of Readable.fromWeb(result.response.body)) { received+=chunk.length; if(received>LIMIT) throw fail(413,'源文件超过 100 MB。'); yield chunk; } })());
    const name=source.fileName;
    try { upload = await uploadWorker(name, body, type, size || undefined, abort.signal); }
    catch (error) { await result.response.body?.cancel().catch(() => {}); throw error; }
    finally { clearTimeout(timer); req.off('aborted', close); res.off('close', close); }
    const uploadedName = upload.files?.[0]?.name;
    if (!safeName(uploadedName)) throw fail(502, '媒体服务没有返回可用的源文件。');
    return { job: result.job, file: upload.files[0], sourceId: upload.id, sourceFile: uploadedName };
  }
  async function concatSourcesToWorker(req, sources, owner, res) {
    if (!Array.isArray(sources) || sources.length < 2 || sources.length > 5) throw fail(400, '请选择 2 至 5 段视频。');
    if (sources.some(source => !source || !['video','media'].includes(source.engine) || !/^[a-f0-9-]{36}$/.test(source.jobId || '') || !safeName(source.fileName))) throw fail(400, '请选择有效的素材库视频。');
    let bytes = 0;
    const resolved = [];
    for (const source of sources) {
      const item = await sourceToWorker(req, source, owner, res);
      if (!(item.file?.type || item.file?.content_type || '').startsWith('video/')) throw fail(415, '拼接只支持视频素材。');
      bytes += Number(item.file.bytes || 0);
      if (bytes > 2 * LIMIT) throw fail(413, '拼接素材合计不能超过 200 MB。');
      resolved.push({ sourceId:item.sourceId, sourceFile:item.sourceFile });
    }
    return { sources:resolved };
  }
  async function refresh(job) {
    if (!ACTIVE.has(job.state) || now() - (job.checked || 0) < refreshIntervalMs || pending.has(job.id)) return pending.get(job.id) || job;
    const p = (async () => {
      try {
        const response = await upstream(`/v1/jobs/${encodeURIComponent(job.workerId || job.id)}`,
          { signal:AbortSignal.timeout(20000) }, true);
        if (response.status === 404) {
          await response.body?.cancel();
          if (now() - job.created > 120000) { job.state = 'failed'; job.error = '媒体服务没有收到这项任务，请重新提交。'; }
          job.checked = now(); return write(job);
        }
        if (!response.ok) { await response.body?.cancel(); throw fail(502, '媒体服务暂时不可用。'); }
        const value = await response.json();
        job.checked = now();
        job.workerId = value.id || job.workerId;
        job.state = ['queued','processing','saved','failed'].includes(value.state) ? value.state : 'failed';
        job.error = job.state === 'failed' ? failureMessage(value.error, job.operation) : '';
        if (Array.isArray(value.files)) job.files = files(value.files);
        if (job.operation === 'subtitles' && value.subtitles && job.state === 'saved') applySubtitles(job, value.subtitles);
        if (value.content && typeof value.content === 'object') job.content = { ...value.content, ...(!['download','gallery'].includes(job.operation) && job.content?.title ? {title:job.content.title} : {}) };
        return write(job);
      } catch { job.checked = now(); return write(job); }
    })();
    pending.set(job.id,p); try { return await p; } finally { pending.delete(job.id); }
  }
  async function submit(job, source) {
    try {
      const result = await upstream('/v1/jobs', { method:'POST', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ requestId:job.id, operation:job.operation, sourceId:source?.sourceId, sourceFile:source?.sourceFile,
          options:job.options, sources:source?.sources, url:['download','gallery'].includes(job.operation) ? job.url : undefined }), signal:AbortSignal.timeout(30000) });
      if (result.id !== job.id) throw fail(502, '媒体服务没有返回对应任务。');
      job.workerId = result.id;
      job.state = ['queued','processing','saved','failed'].includes(result.state) ? result.state : 'queued';
      job.error = job.state === 'failed' ? failureMessage(result.error, job.operation) : '';
      job.files = files(result.files);
      if (job.operation === 'subtitles' && result.subtitles && job.state === 'saved') applySubtitles(job, result.subtitles);
      if (result.content) job.content = { ...result.content, ...(!['download','gallery'].includes(job.operation) && job.content?.title ? {title:job.content.title} : {}) };
    } catch (error) {
      job.state = [502,503].includes(error.status) ? 'submission-unknown' : 'failed';
      job.error = job.state === 'submission-unknown' ? '提交结果暂时无法确认，请勿重复提交。' : error.message;
    }
    return write(job);
  }
  function applySubtitles(job, value) {
    const segments = (Array.isArray(value.segments) ? value.segments : []).slice(0, 1200)
      .filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= 301 && typeof s.text === 'string')
      .map(s => ({ start: s.start, end: s.end, text: clip(s.text, 1000) }));
    job.subtitles = { language: clip(value.language, 16), segments };
    job.transcript = { text: clip(segments.map(s => s.text).join('\n'), 200000), duration: Math.round((segments.at(-1)?.end || 0) * 1000) };
  }
  const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
  const handler = async (req,res,pathname) => {
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;
    res.setHeader('Cache-Control','private, no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw fail(403,'请从本站打开工具。');
      const user=getUser(req), owner=ownerFor(user), scope=user?'private':'public'; const remote=req.socket.remoteAddress || ''; const trusted=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote); const ip=digest(trusted ? String(req.headers['x-real-ip'] || remote).slice(0,100) : remote); rate(`read:${ip}`,240,60);
      if (pathname === PREFIX + '/status' && req.method === 'GET') {
        let health = {};
        if (configured) try { health = await upstream('/health', { signal: AbortSignal.timeout(3000) }); } catch {}
        const available = configured && health.available === true;
        const hosts = Array.isArray(health.platforms) ? health.platforms : [];
        const platforms = ['youtube','vimeo','x','instagram','soundcloud'].filter(name => hosts.some(host => host === ({ youtube:'youtube.com',vimeo:'vimeo.com',x:'x.com',instagram:'instagram.com',soundcloud:'soundcloud.com' })[name]));
        json(res, 200, { available, scope, maxUploadMB:100,
          features:{ concat:available && Boolean(health.features?.concat), edit:available && Boolean(health.features?.edit), gallery:available && Boolean(health.features?.gallery), trim:available && Boolean(health.features?.ffmpeg), compress:available && Boolean(health.features?.ffmpeg), convert:available && Boolean(health.features?.ffmpeg), audio:available && Boolean(health.features?.ffmpeg), frame:available && Boolean(health.features?.ffmpeg), removeBackground:available && Boolean(health.features?.backgroundRemoval), download:available && Boolean(health.features?.downloader), subtitles:available && Boolean(health.features?.subtitles), translation:available && Boolean(health.features?.translation), separation:available && Boolean(health.features?.separation) }, platforms, galleryPlatforms: Array.isArray(health.galleryPlatforms) ? health.galleryPlatforms.filter(host => host === 'imgur.com') : [] });
        return true;
      }
      if (!configured) throw fail(503,'媒体处理服务正在维护，请稍后再试。');
      const params=new URL(req.url,origin).searchParams;
      if (pathname === PREFIX + '/jobs' && req.method === 'GET') {
        const q = (params.get('q') || '').slice(0, 200).toLowerCase();
        const type = params.get('type') || 'all', kind = params.get('kind') || '';
        if (!['all','video','image','audio','text'].includes(type)) throw fail(400, '素材类型不正确。');
        let jobs = db.prepare('SELECT payload FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 500').all(owner).map(row => JSON.parse(row.payload));
        jobs = await Promise.all(jobs.slice(0, 200).map(refresh));
        jobs = jobs.filter(job => (!kind || job.kind === kind)
          && (!q || `${job.input} ${job.content?.title || ''} ${job.operation || ''}`.toLowerCase().includes(q))
          && (type === 'all' || (type === 'text' ? Boolean(job.transcript) : job.files?.some(file => file.type.startsWith(type + '/'))))
          && (params.get('view') !== 'library' || job.files?.length || job.transcript));
        json(res, 200, { scope, jobs:jobs.map(present) }); return true;
      }
      if (pathname === PREFIX + '/uploads' && req.method === 'POST') {
        const name = params.get('name') || '', visibility = params.get('visibility');
        if (!safeName(name) || visibility !== scope) throw fail(visibility !== scope ? 409 : 400, '上传参数不正确。');
        const type = inputType((req.headers['content-type'] || '').split(';')[0].toLowerCase());
        if (!INPUT_TYPES.has(type)) throw fail(415, '不支持这个文件类型。');
        const length = Number(req.headers['content-length'] || 0);
        if (!Number.isFinite(length) || length < 0 || length > LIMIT) throw fail(413, '文件超过 100 MB。');
        rate(`upload:${ip}`,10,600); rate(`upload:${owner}`,20,600); rate('upload:all',100,600);
        const release = reserve(owner);
        try {
        let received = 0;
        const guarded = Readable.from((async function* () {
          for await (const chunk of req) { received += chunk.length; if (received > LIMIT) throw fail(413, '文件超过 100 MB。'); yield chunk; }
        })());
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10 * 60000);
        const close = () => abort.abort(); res.on('close', close);
        let stored;
        try { stored = await uploadWorker(name, guarded, type, length || undefined, abort.signal); }
        finally { clearTimeout(timer); res.off('close', close); }
        const job = write({ id:randomUUID(), owner, created:now(), engine:'media', kind:'upload', state:'saved',
          input:name, content:{ ...stored.content, title:name.replace(/\.[^.]+$/, '') }, workerId:stored.id, files:files(stored.files) });
        json(res, 201, present(job)); return true;
        } finally { release(); }
      }
      if (pathname === PREFIX + '/jobs' && req.method === 'POST') {
        const input = await jsonBody(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        if (!OPS.has(input.operation)) throw fail(400, '不支持这个处理方式。');
        rate(`job:${ip}`,20,600); rate(`job:${owner}`,40,600); rate('job:all',200,600);
        const options = validOptions(input.operation, input.options);
        const originalUrl = input.operation === 'gallery' ? input.url ?? input.text : input.text;
        const url = input.operation === 'download' ? downloadUrl(originalUrl) : input.operation === 'gallery' ? galleryUrl(originalUrl) : undefined;
        const release = reserve(owner);
        try {
          const source = url ? undefined : input.operation === 'concat' ? await concatSourcesToWorker(req, input.sources, owner, res) : await sourceToWorker(req, input.source, owner, res);
          const original = url ? originalUrl : input.operation === 'concat' ? `拼接 ${input.sources.length} 段视频` : source.job.input || source.job.url || source.sourceFile;
          const id = randomUUID();
          const job = write({ id, workerId:id, owner, created:now(), engine:'media', kind:url ? 'download' : 'process',
            state:'submitting', input:original, url, content:source?.job?.content || { title:original },
            operation:input.operation, source:url || input.operation === 'concat' ? null : { engine:input.source.engine, jobId:input.source.jobId, fileName:input.source.fileName },
            ...(input.operation === 'concat' ? {sources:input.sources.map(({engine,jobId,fileName})=>({engine,jobId,fileName}))} : {}),
            options, files:[] });
          await submit(job, source);
          json(res, 202, present(job)); return true;
        } finally { release(); }
      }
      const match=new RegExp(`^${PREFIX}/jobs/([a-f0-9-]{36})(?:/(retry|files)(?:/([^/]+))?)?$`).exec(pathname); if(!match) throw fail(404,'找不到这个工具接口。'); let job=read(match[1],owner);
      if (!match[2] && req.method==='GET') return json(res,200,present(await refresh(job))),true;
      if (match[2] === 'retry' && req.method === 'POST') {
        const input = await jsonBody(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        if (job.kind === 'upload' || job.state !== 'failed') throw fail(409, '当前任务无需重试。');
        rate(`job:${ip}`,20,600); rate(`job:${owner}`,40,600); rate('job:all',200,600);
        const release = reserve(owner);
        try {
          const source = ['download','gallery'].includes(job.operation) ? undefined : job.operation === 'concat' ? await concatSourcesToWorker(req, job.sources, owner, res) : await sourceToWorker(req, job.source, owner, res);
          const id = randomUUID();
          const next = write({ ...job, id, workerId:id, owner, created:now(), updated:now(), state:'submitting', error:'', files:[] });
          await submit(next, source);
          json(res, 202, present(next)); return true;
        } finally { release(); }
      }
      if (match[2] === 'files' && match[3] && ['GET','HEAD'].includes(req.method)) {
        const name = match[3], file = job.files?.find(item => item.name === name);
        if (job.state !== 'saved' || !file || !safeName(name) || !job.workerId) throw fail(404, '文件尚未准备好。');
        if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) throw fail(416, '不支持这个文件范围。');
        if (totalStreams >= 6 || (streams.get(ip) || 0) >= 3) throw fail(429, '同时下载的文件过多，请稍后再试。');
        totalStreams++; streams.set(ip, (streams.get(ip) || 0) + 1);
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10 * 60000);
        const close = () => abort.abort(); res.on('close', close);
        try {
          const up = await upstream(`/v1/jobs/${encodeURIComponent(job.workerId)}/files/${encodeURIComponent(name)}`,
            { method:req.method, headers:req.headers.range ? { Range:req.headers.range } : {}, signal:abort.signal }, true);
          if (![200,206].includes(up.status)) {
            await up.body?.cancel();
            throw fail(up.status === 416 ? 416 : [404,410].includes(up.status) ? 410 : 502, '文件暂时不可用。');
          }
          res.statusCode = up.status;
          res.setHeader('Content-Type', file.type);
          res.setHeader('Content-Disposition', `${params.get('inline') === '1' ? 'inline' : 'attachment'}; filename="download.${name.split('.').pop().replace(/[^a-z0-9]/ig, '')}"`);
          for (const header of ['content-length','content-range','accept-ranges']) if (up.headers.has(header)) res.setHeader(header, up.headers.get(header));
          if (req.method === 'HEAD') { await up.body?.cancel(); res.end(); }
          else await pipeline(Readable.fromWeb(up.body), res);
        } finally {
          clearTimeout(timer); res.off('close', close); totalStreams--;
          streams.set(ip, Math.max(0, (streams.get(ip) || 1) - 1));
          if (!streams.get(ip)) streams.delete(ip);
        }
        return true;
      }
      throw fail(405,'不支持这个操作。');
    } catch(e) { if(!res.headersSent) json(res,e.status||500,{error:e.status?e.message:'处理失败，请稍后再试。'}); else if(!res.writableEnded)res.destroy(); return true; }
  };
  const maintenance = setInterval(() => {
    if (closed || !configured) return;
    const rows = db.prepare("SELECT payload FROM jobs WHERE json_extract(payload,'$.state') IN ('queued','processing','submission-unknown') ORDER BY updated ASC LIMIT 8").all();
    for (const row of rows) void refresh(JSON.parse(row.payload));
    db.prepare('DELETE FROM limits WHERE expires<?').run(now());
  }, 5000);
  maintenance.unref();
  handler.close = () => { closed = true; clearInterval(maintenance); db.close(); };
  return handler;
}
