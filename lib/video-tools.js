import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { discoveryRequest, discoveryPath, discoveryResult, discoveryExport } from './video-discovery.js';
import { createMediaWatchStore } from './media-watch.js';

const PREFIX = '/api/tools/video';
const ACTIVE = new Set(['parsing', 'saving', 'browsing', 'transcribing']);
const KINDS = new Set(['download', 'transcript', 'collection', 'discovery']);
const MEDIA_TYPES = new Set(['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav']);
const HOSTS = new Map([
  ...['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com', 'jingxuan.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].map(h => [h, 'douyin']),
  ...['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'].map(h => [h, 'tiktok']),
  ...['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].map(h => [h, 'bilibili']),
]);
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const clip = (value, n = 1000) => String(value || '').slice(0, n);
const safeName = name => typeof name === 'string' && name.length <= 180 && !name.startsWith('.') && !/[\/\\\x00-\x1f\x7f]/.test(name);

export function extractVideoLink(text) {
  if (typeof text !== 'string' || text.length > 4096) throw fail(400, '请粘贴一条视频链接或分享文案。');
  const links = text.match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
  if (!links.length) throw fail(400, '没有找到链接，请在作品分享菜单中选择“复制链接”。');
  if (links.length !== 1) throw fail(400, '每次请解析一条链接。');
  let url;
  try { url = new URL(links[0].replace(/[。，、；！？）】》」』.,;!?)\]]+$/u, '')); } catch { throw fail(400, '链接格式不正确。'); }
  const platform = HOSTS.get(url.hostname.toLowerCase());
  if (!platform || url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol)) {
    throw fail(400, '支持抖音、TikTok 和哔哩哔哩的公开作品链接。');
  }
  // Only content links enter the public queue; profile/search/live links cannot create crawls.
  const short = ['v.douyin.com', 'vm.tiktok.com', 'vt.tiktok.com', 'b23.tv'].includes(url.hostname);
  const content = /\/(?:video|note|photo|slides)\/[\w-]+/i.test(url.pathname) || (platform === 'douyin' && /^\d+$/.test(url.searchParams.get('modal_id') || ''));
  if ((!short && !content) || url.pathname.length < 2) throw fail(400, '请使用作品的分享链接，暂不支持主页、直播或合集。');
  url.hash = '';
  return { url: url.href, platform };
}

export function extractCollectionLink(text, options = {}) {
  if (typeof text !== 'string' || text.length > 4096) throw fail(400, '请粘贴作者主页或合集链接。');
  const links = text.match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
  if (links.length !== 1) throw fail(400, '每次请输入一个作者主页或合集链接。');
  let url;
  try { url = new URL(links[0].replace(/[。，、；！？）】》」』.,;!?)\]]+$/u, '')); } catch { throw fail(400, '链接格式不正确。'); }
  const platform = url.hostname === 'space.bilibili.com' ? 'bilibili' : HOSTS.get(url.hostname);
  if (!platform || url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol)) throw fail(400, '支持抖音、TikTok 和哔哩哔哩的主页与合集链接。');
  if (options.platform && options.platform !== platform) throw fail(400, '平台与链接不一致。');
  let mode = options.mode || 'posts';
  let resourceId = options.resourceId || '';
  if (!['posts', 'mixes', 'collections', 'mix', 'collection'].includes(mode)) throw fail(400, '请选择作品、合集或公开收藏。');
  if (!resourceId) {
    if (platform === 'douyin' && (/^\/collection\/\d+/.test(url.pathname) || url.searchParams.has('mix_id'))) {
      mode = 'mix'; resourceId = url.pathname.match(/^\/collection\/(\d+)/)?.[1] || url.searchParams.get('mix_id');
    } else if (platform === 'tiktok' && /\/(collection|playlist)\//.test(url.pathname)) {
      mode = url.pathname.includes('/playlist/') ? 'mix' : 'collection'; resourceId = url.pathname.match(/-(\d+)\/?$/)?.[1];
    } else if (platform === 'bilibili' && (url.searchParams.has('fid') || /\/list\/ml\d+/.test(url.pathname))) {
      mode = 'collection'; resourceId = url.searchParams.get('fid') || url.pathname.match(/\/list\/ml(\d+)/)?.[1];
    } else if (platform === 'bilibili' && url.searchParams.has('sid')) {
      mode = 'mix'; resourceId = url.searchParams.get('sid');
    }
  }
  if (['mix', 'collection'].includes(mode)) {
    if (!/^[\w-]{1,64}$/.test(resourceId || '')) throw fail(400, '合集链接中没有有效编号，请从作者主页选择合集。');
  } else {
    const profile = platform === 'douyin' ? /^\/(?:share\/)?user\/[\w-]+\/?$/.test(url.pathname)
      : platform === 'tiktok' ? /^\/@[^/?#]+\/?$/.test(url.pathname)
      : (url.hostname === 'space.bilibili.com' && /^\/\d+(?:\/(?:video|upload|dynamic|favlist|lists))?\/?$/.test(url.pathname)) || /^\/space\/\d+\/?$/.test(url.pathname);
    const short = ['v.douyin.com', 'vm.tiktok.com', 'vt.tiktok.com', 'b23.tv'].includes(url.hostname) && url.pathname.length > 1;
    if (!profile && !short) throw fail(400, '请粘贴作者主页、合集或公开收藏夹链接。');
    if (mode === 'collections' && platform === 'douyin') throw fail(400, '抖音个人收藏需要单独登录抖音，目前可读取作者作品和公开合集。');
  }
  url.hash = '';
  return { url: url.href, platform, mode, resourceId };
}

export function extractBatchLinks(text) {
  if (typeof text !== 'string' || text.length > 16384) throw fail(400, '批量输入最多 20 个链接、16384 个字符。');
  const urls = text.match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
  if (!urls.length || urls.length > 20) throw fail(400, '每次请输入 1 至 20 个作品链接。');
  return [...new Map(urls.map(url => { const link = extractVideoLink(url); return [link.url, link]; })).values()];
}

function contentUrl(item) {
  if (item.web_url) {
    try { return extractVideoLink(item.web_url).url; } catch { /* Use a canonical public content URL. */ }
  }
  if (item.platform === 'douyin') return `https://www.douyin.com/video/${item.content_id}`;
  if (item.platform === 'bilibili') return `https://www.bilibili.com/video/${item.content_id}`;
  return `https://www.tiktok.com/@${encodeURIComponent(item.author?.unique_id || '_')}/video/${item.content_id}`;
}

export function normalizeVideoContent(data, expectedPlatform) {
  if (!data || data.platform !== expectedPlatform || !/^[\w-]{1,100}$/.test(data.content_id || '') || !data.media) {
    throw fail(422, '这条链接没有返回可下载的作品，请换一条作品链接。');
  }
  if (data.is_private || data.is_deleted) throw fail(422, '作品已删除或不公开。');
  return {
    platform: data.platform, contentId: data.content_id,
    title: clip(data.title || data.description || '未命名作品', 500),
    author: clip(data.author?.nickname, 100),
    duration: Math.max(0, Number(data.duration_ms) || 0),
    imageCount: Math.min(200, data.media.images?.length || 0),
    hasVideo: Boolean(data.media.video || data.media.streams?.length),
    musicId: /^\d{1,32}$/.test(String(data.music?.music_id || '')) ? String(data.music.music_id) : '',
    musicTitle: clip(data.music?.title, 200),
  };
}

function publicFailure(error, kind) {
  const code = String(error?.code || '').toUpperCase();
  if (kind === 'discovery') {
    if (/LOGIN|AUTH/.test(code)) return '该查询需要平台登录身份，当前无法继续读取。';
    if (/UNSUPPORTED|INVALID|URL/.test(code)) return '平台暂不支持这项查询，请检查输入或切换查询类型。';
    if (/NOT_FOUND|DELETED/.test(code)) return '未找到公开内容，请检查输入。';
    return '平台暂时限制了这次查询，请稍后重试；已读取的结果会保留。';
  }
  if (/NOT_FOUND|DELETED/.test(code)) return '作品不存在、已删除或不公开，请检查原链接。';
  if (/SIZE|CEILING|TOO_LARGE/.test(code)) return '文件超过 250 MB，暂时无法保存。';
  if (/RISK|BLOCK|POOL|CAPTCHA|RATE|LOGIN|AUTH|CIRCUIT/.test(code)) return '平台暂时限制了访问，请稍后重试或更换作品链接。';
  if (/URL|UNSUPPORTED|INVALID/.test(code)) return '这条链接暂不支持，请使用作品的分享链接。';
  return '平台暂时没有返回可用结果，请稍后重试。';
}

export function createVideoToolHandler({ databasePath, getUser = () => null,
  baseUrl = process.env.OMNIHUB_VIDEO_API_URL, apiKey = process.env.OMNIHUB_VIDEO_API_KEY,
  transcription = process.env.OMNIHUB_VIDEO_TRANSCRIPTION === '1', refreshIntervalMs = 2500,
  origin = process.env.OMNIHUB_VIDEO_ORIGIN || 'https://omnihub.noxhub.org', fetchImpl = fetch } = {}) {
  const db = new DatabaseSync(databasePath || ':memory:');
  if (databasePath && databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL,
      updated INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created DESC);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const pending = new Map();
  const mutations = new Set();
  let pumping = false;
  let closed = false;
  const streams = new Map();
  let totalStreams = 0;
  let lastCleanup = 0;
  let watching = false;
  const watches = createMediaWatchStore({ db, upstream, extractCollectionLink, extractVideoLink, normalizeVideoContent, contentUrl });
  const configured = Boolean(baseUrl && apiKey);
  if (configured && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(baseUrl)) throw new Error('Video API must use a loopback address');
  const read = (id, owner, legacyOwner) => {
    const row = db.prepare("SELECT payload FROM jobs WHERE id=? AND (owner=? OR owner='public' OR owner=?)").get(id, owner, legacyOwner || owner);
    if (!row) throw fail(404, '找不到这条记录。');
    return JSON.parse(row.payload);
  };
  const write = job => {
    if (closed) return job;
    job.updated = Date.now();
    db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.owner, job.created, job.updated, JSON.stringify(job));
    return job;
  };
  const present = ({ owner, taskId, downloadId, transcriptionId, checked, refreshFiles, refreshParse, ...job }) => ({
    ...job, kind: job.kind || 'download', input: job.input ?? job.url,
    visibility: owner === 'public' ? 'public' : owner.startsWith('guest:') ? 'legacy-private' : 'private',
  });
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < 60000) return;
    lastCleanup = now;
    db.prepare('DELETE FROM limits WHERE expires<?').run(now);
    db.prepare("DELETE FROM jobs WHERE created<? AND COALESCE(json_array_length(payload,'$.files'),0)=0 AND json_extract(payload,'$.transcript') IS NULL").run(now - 30 * 86400000);
    db.prepare('DELETE FROM jobs WHERE created<?').run(now - 180 * 86400000);
  }
  function rate(key, count, seconds) {
    const bucket = `${key}:${Math.floor(Date.now() / (seconds * 1000))}`;
    db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(bucket, Date.now() + seconds * 1000);
    if (db.prepare('SELECT count FROM limits WHERE key=?').get(bucket).count > count) throw fail(429, '操作有些频繁，请稍后再试。');
  }
  async function upstream(path, body, raw = false, headers = {}, signal) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Accept-Language': 'zh', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
        signal: signal || AbortSignal.timeout(20000) });
    } catch { throw fail(503, '解析服务暂时无法连接，请稍后再试。'); }
    if (raw) return response;
    let payload;
    try { payload = await response.json(); } catch { throw fail(502, '解析服务返回异常，请稍后再试。'); }
    if (!response.ok || payload.error) throw fail(response.status === 429 ? 429 : 502, publicFailure(payload.error));
    return payload.data;
  }
  async function submitTask(job, cursor) {
    if (job.kind === 'discovery') {
      job.state = 'browsing'; write(job);
      const result = await upstream(discoveryPath(job, cursor));
      job.taskId = result.task_id;
    } else if (job.kind === 'collection') {
      const routes = { posts: 'user/posts', mixes: 'user/mixes', collections: 'user/collections', mix: 'mix/posts', collection: 'collection/posts' };
      const query = new URLSearchParams({ wait: '0', count: '20', include_raw: 'false', refresh: String(Boolean(job.refreshParse)) });
      if (job.mode === 'mix') query.set('mix_id', job.resourceId);
      else if (job.mode === 'collection') query.set('collection_id', job.resourceId);
      else query.set('url', job.url);
      if (cursor) query.set('cursor', cursor);
      job.state = 'browsing';
      write(job);
      const result = await upstream(`/api/v1/${job.platform}/${routes[job.mode]}?${query}`);
      job.taskId = result.task_id;
    } else {
      job.state = 'parsing';
      write(job);
      const result = await upstream(`/api/v1/parse?wait=0${job.refreshParse ? '&refresh=true' : ''}`, { url: job.url, include_raw: false });
      job.taskId = result.task_id;
    }
    if (!job.taskId) throw fail(502, '解析服务没有返回任务，请稍后重试。');
    job.checked = 0;
    return write(job);
  }
  async function beginSave(job) {
    job.state = 'saving'; job.saveStarted = Date.now(); job.error = ''; write(job);
    try {
      const download = await upstream('/api/v1/downloads', { platform: job.content.platform, content_id: job.content.contentId, skip_existing: !job.refreshFiles });
      job.downloadId = download.download_id || download.id;
      if (!job.downloadId) throw fail(502, '没有创建保存任务，请重试。');
      job.checked = 0; job.refreshFiles = false; return write(job);
    } catch (error) { job.state = job.kind === 'transcript' ? 'failed' : 'parsed'; job.error = error.message; write(job); throw error; }
  }
  function collectionResult(job, data) {
    if (!Array.isArray(data?.items)) throw fail(422, '没有返回可用列表，请检查链接或稍后重试。');
    const groups = ['mixes', 'collections'].includes(job.mode);
    const old = job.collection || { items: [], groups: [] };
    const next = data.items.slice(0, 200).flatMap(item => {
      if (item.platform !== job.platform || item.is_private || item.is_deleted || item.is_public === false) return [];
      if (groups) {
        const id = item.mix_id || item.collection_id;
        if (!/^[\w-]{1,64}$/.test(id || '')) return [];
        return [{ id, title: clip(item.name || '未命名合集', 300), count: Math.max(0, Number(item.item_count) || 0), kind: job.mode === 'mixes' ? 'mix' : 'collection', platform: job.platform }];
      }
      try { return [{ ...normalizeVideoContent(item, job.platform), url: contentUrl(item) }]; } catch { return []; }
    });
    const key = groups ? 'groups' : 'items';
    const entries = [...new Map([...old[key], ...next].map(item => [item.id || item.contentId, item])).values()].slice(0, 200);
    const cursor = typeof data.cursor === 'string' ? data.cursor.slice(0, 512) : null;
    job.collection = { ...old, title: groups ? '作者的合集与收藏' : (entries[0]?.author || '作品列表'), [key]: entries,
      hasMore: Boolean(data.has_more && cursor && cursor !== old.cursor && entries.length < 200), cursor };
    job.state = 'ready'; job.error = '';
  }
  async function refresh(job) {
    if (!ACTIVE.has(job.state) || Date.now() - (job.checked || 0) < refreshIntervalMs) return job;
    if (pending.has(job.id)) return pending.get(job.id);
    const promise = (async () => {
      try {
        if (Date.now() - (job.saveStarted || job.created) > 15 * 60000) { job.state = job.collection || job.discovery ? 'ready' : 'failed'; job.error = '处理超时，请重试。'; return write(job); }
        if (['parsing', 'browsing'].includes(job.state) && job.taskId) {
          const task = await upstream(`/api/v1/tasks/${encodeURIComponent(job.taskId)}`);
          if (task.state === 'done') {
            if (job.kind === 'discovery') discoveryResult(job, task.data);
            else if (job.kind === 'collection') collectionResult(job, task.data);
            else {
              job.content = normalizeVideoContent(task.data, job.platform); job.state = 'parsed';
              if (job.kind === 'transcript') {
                if (!job.content.hasVideo || job.content.duration > 10 * 60000) throw fail(422, '转文字支持 10 分钟以内的视频，请使用视频作品链接。');
                await beginSave(job);
              }
            }
          }
          else if (['failed', 'cancelled'].includes(task.state)) { job.state = job.collection || job.discovery ? 'ready' : 'failed'; job.error = publicFailure(task.error, job.kind); }
        } else if (job.state === 'saving' && job.downloadId) {
          const download = await upstream(`/api/v1/downloads/${encodeURIComponent(job.downloadId)}`);
          job.progress = Math.max(0, Number(download.bytes_total) || 0);
          if (['done', 'partial'].includes(download.state)) {
            job.files = (download.files || []).filter(f => f.state === 'done' && safeName(f.name) && MEDIA_TYPES.has(f.content_type))
              .slice(0, 200).map(f => ({ name: f.name, type: f.content_type, kind: f.kind || '', bytes: f.bytes || 0, label: clip(f.export_name || f.name, 180) }));
            job.state = download.on_disk && job.files.length ? 'saved' : 'parsed';
            job.error = job.state === 'saved' ? (download.state === 'partial' ? '部分文件未能保存，已列出可用文件。' : '') : '文件暂不可用，请重新准备。';
            if (job.kind === 'transcript') {
              if (!job.files.some(file => file.type.startsWith('video/'))) throw fail(422, '没有可转写的视频文件，请换一条视频链接。');
              const result = await upstream('/api/v1/transcriptions?wait=0', { download_id: job.downloadId, normalize: false, refresh: Boolean(job.refreshParse) });
              job.transcriptionId = result.transcription_id;
              if (!job.transcriptionId) throw fail(422, '转写服务没有返回任务，请重试。');
              job.state = 'transcribing';
            }
          } else if (['failed', 'cancelled'].includes(download.state)) { job.state = job.kind === 'transcript' ? 'failed' : 'parsed'; job.error = publicFailure(download.error); }
        } else if (job.state === 'transcribing' && job.transcriptionId) {
          const result = await upstream(`/api/v1/transcriptions/${encodeURIComponent(job.transcriptionId)}`);
          if (result.state === 'done') {
            job.transcript = { text: clip(result.text, 200000), duration: Number(result.duration_ms) || 0, model: clip(result.model, 80) };
            job.state = 'transcribed'; job.error = job.transcript.text ? '' : '没有识别到清晰语音。';
          } else if (['failed', 'cancelled'].includes(result.state)) { job.state = 'failed'; job.error = '转写未完成，请重试或换一条有清晰人声的视频。'; }
        }
        job.checked = Date.now();
        return write(job);
      } catch (error) {
        if ([400, 422].includes(error.status) || (job.kind === 'transcript' && job.state !== 'transcribing')) { job.state = job.collection || job.discovery ? 'ready' : 'failed'; job.error = error.message; return write(job); }
        throw error;
      }
    })();
    pending.set(job.id, promise);
    try { return await promise; } finally { pending.delete(job.id); }
  }
  function busy(owner) {
    const recent = db.prepare('SELECT payload FROM jobs WHERE updated>?').all(Date.now() - 15 * 60000).map(r => JSON.parse(r.payload));
    const active = recent.filter(j => ACTIVE.has(j.state));
    if (active.length >= 4 || (owner !== 'public' && active.filter(j => j.owner === owner).length >= 2)) throw fail(429, '正在处理其他作品，请等当前任务完成。');
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请求格式不正确。');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > (new URL(req.url, origin).pathname === `${PREFIX}/batch` ? 65536 : 8192)) throw fail(413, '分享文案过长，请只粘贴作品链接。');
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch { throw fail(400, '请求格式不正确。'); }
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const handler = async (req, res, pathname) => {
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      cleanup();
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw fail(403, '请从本站打开工具。');
      const user = getUser(req);
      let token = /(?:^|;\s*)omnihub_video=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!token) {
        token = randomBytes(32).toString('hex');
        res.setHeader('Set-Cookie', `omnihub_video=${token}; Path=/api/tools/video; HttpOnly; SameSite=Lax; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`);
      }
      const owner = user ? `user:${user.id}` : 'public';
      // Previously cookie-private records remain visible only to that browser.
      const legacyOwner = user ? owner : `guest:${digest(token)}`;
      const scope = user ? 'private' : 'public';
      const remote = req.socket.remoteAddress || '';
      const trusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
      const ip = digest(trusted ? String(req.headers['x-real-ip'] || remote).slice(0, 100) : remote);
      rate(`read:${ip}`, 240, 60);
      if (pathname === `${PREFIX}/status` && req.method === 'GET') return json(res, 200, { available: configured, maxFileMB: 250, maxBatch: 20, scope, features: { transcription: configured && transcription, collections: true, discovery: configured, watchlists: configured, snapshots: configured } }), true;
      if (!configured) throw fail(503, '下载服务正在维护，请稍后再试。');
      const params = new URL(req.url, origin).searchParams;
      const watchRoute = new RegExp(`^${PREFIX}/watchlists(?:/([a-f0-9-]{36})(?:/(run|items))?)?$`).exec(pathname);
      if (watchRoute || pathname === `${PREFIX}/snapshots`) {
        const context = { owner, scope };
        const readOnly = req.method === 'GET';
        const input = readOnly ? {} : await body(req);
        if (!readOnly) {
          if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新后重试。');
          rate(`watch:${ip}`, 10, 600); rate(`watch:${owner}`, 20, 600); rate('watch:all', 100, 3600);
        }
        let result, status = 200;
        if (!watchRoute) {
          if (req.method === 'GET') result = params.has('platform') ? { scope, snapshots: watches.snapshots(context, Object.fromEntries(params)) } : { scope, recent: watches.recentSnapshots(context) };
          else if (req.method === 'POST') { result = await watches.snapshot(context, input); status = 201; }
          else throw fail(405, '不支持这个操作。');
        } else if (!watchRoute[1]) {
          if (req.method === 'GET') result = { scope, watchlists: watches.list(context) };
          else if (req.method === 'POST') { result = watches.create(context, input); status = 201; }
          else throw fail(405, '不支持这个操作。');
        } else if (watchRoute[2] === 'items' && req.method === 'GET') result = { items: watches.items(context, watchRoute[1]) };
        else if (watchRoute[2] === 'run' && req.method === 'POST') result = await watches.run(context, watchRoute[1]);
        else if (!watchRoute[2] && req.method === 'GET') result = watches.get(context, watchRoute[1]);
        else if (!watchRoute[2] && req.method === 'PATCH') result = watches.update(context, watchRoute[1], input);
        else if (!watchRoute[2] && req.method === 'DELETE') result = watches.remove(context, watchRoute[1]);
        else throw fail(405, '不支持这个操作。');
        json(res, status, result); return true;
      }
      if (pathname === `${PREFIX}/jobs` && req.method === 'GET') {
        const library = params.get('view') === 'library';
        const kind = params.get('kind');
        const query = (params.get('q') || '').slice(0, 200).toLowerCase();
        const type = params.get('type') || 'all';
        let jobs = db.prepare('SELECT payload FROM jobs WHERE owner=? OR owner=? ORDER BY created DESC LIMIT 1000').all(owner, legacyOwner).map(row => JSON.parse(row.payload));
        jobs = jobs.filter(j => !kind || (j.kind || 'download') === kind);
        if (library) jobs = jobs.filter(j => j.files?.length || j.transcript).filter(j => type === 'all' || (type === 'text' ? Boolean(j.transcript) : j.files?.some(f => f.type.startsWith(type + '/'))));
        if (query) jobs = jobs.filter(j => `${j.content?.title || ''} ${j.content?.author || ''} ${j.input || j.url} ${j.transcript?.text || ''}`.toLowerCase().includes(query));
        jobs = jobs.slice(0, library ? 200 : 50);
        const updated = await Promise.all(jobs.map(j => refresh(j).catch(() => j)));
        json(res, 200, { scope, jobs: updated.map(present) }); return true;
      }
      if ([`${PREFIX}/jobs`, `${PREFIX}/batch`].includes(pathname) && req.method === 'POST') {
        const input = await body(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        const batch = pathname.endsWith('/batch');
        const kind = batch ? 'download' : input.kind || 'download';
        if (!KINDS.has(kind)) throw fail(400, '不支持这个工具。');
        if (kind === 'transcript' && !transcription) throw fail(503, '转文字服务正在维护，请稍后再试。');
        const links = batch ? extractBatchLinks(input.text) : [kind === 'discovery' ? discoveryRequest(input, extractVideoLink) : kind === 'collection' ? extractCollectionLink(input.text, input) : extractVideoLink(input.text)];
        rate(`parse:${ip}`, batch ? 5 : 10, 600); rate('parse:all', 100, 3600);
        if (db.prepare('SELECT count(*) AS n FROM jobs').get().n > 10000) throw fail(503, '记录空间已满，请稍后再试。');
        if (batch && db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(payload,'$.state')='queued'").get().n + links.length > 40) throw fail(429, '等待处理的作品较多，请稍后再试。');
        if (!batch) busy(owner);
        const jobs = [];
        for (const link of links) {
          const job = write({ id: randomUUID(), owner, created: Date.now(), kind, state: batch ? 'queued' : 'parsing', ...link,
            input: input.text, refreshFiles: input.retry === true, refreshParse: input.retry === true, files: [] });
          if (!batch) {
            try { await submitTask(job); } catch (error) { job.state = 'failed'; job.error = error.message; write(job); }
          }
          jobs.push(present(job));
        }
        json(res, 202, batch ? { jobs } : jobs[0]);
        if (batch) void pump();
        return true;
      }
      const match = new RegExp(`^${PREFIX}/jobs/([a-f0-9-]{36})(?:/(save|files|retry|more|transcribe|transcript\\.txt|export\\.json|export\\.csv)(?:/([^/]+))?)?$`).exec(pathname);
      if (!match) throw fail(404, '找不到这个工具接口。');
      let job = read(match[1], owner, legacyOwner);
      if (!match[2] && req.method === 'GET') { json(res, 200, present(await refresh(job))); return true; }
      if (match[2] === 'transcribe' && req.method === 'POST') {
        const input = await body(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        if (!transcription) throw fail(503, '转文字服务正在维护，请稍后再试。');
        if ((job.kind || 'download') !== 'download' || !job.content?.hasVideo || job.content.duration > 10 * 60000) throw fail(422, '请选择已解析的 10 分钟以内视频。');
        // Scope the handoff to its new owner, even when the source is public.
        const existing = db.prepare("SELECT payload FROM jobs WHERE owner=? AND json_extract(payload,'$.sourceJobId')=? AND json_extract(payload,'$.kind')='transcript' AND json_extract(payload,'$.state')!='failed' ORDER BY created DESC LIMIT 1").get(owner, job.id);
        if (existing) {
          const next = JSON.parse(existing.payload);
          json(res, next.state === 'transcribed' ? 200 : 202, present(next)); return true;
        }
        rate(`parse:${ip}`, 10, 600); rate('parse:all', 100, 3600); busy(owner);
        if (db.prepare('SELECT count(*) AS n FROM jobs').get().n > 10000) throw fail(503, '记录空间已满，请稍后再试。');
        const next = write({ id: randomUUID(), owner, created: Date.now(), state: 'parsing', kind: 'transcript',
          sourceJobId: job.id, input: job.input ?? job.url, url: job.url, platform: job.platform, content: job.content, files: [] });
        try { await beginSave(next); } catch (error) { next.state = 'failed'; next.error = error.message; write(next); }
        json(res, 202, present(next)); return true;
      }
      if (match[2] === 'retry' && req.method === 'POST') {
        const input = await body(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        rate(`parse:${ip}`, 10, 600); rate('parse:all', 100, 3600); busy(owner);
        if (job.kind === 'transcript' && !transcription) throw fail(503, '转文字服务正在维护，请稍后再试。');
        const next = write({ id: randomUUID(), owner, created: Date.now(), state: 'parsing', kind: job.kind || 'download', input: job.input ?? job.url,
          url: job.url, platform: job.platform, mode: job.mode, resourceId: job.resourceId,
          ...(job.kind === 'discovery' ? {operation:job.operation, discoveryQuery:job.discoveryQuery} : {}), refreshFiles: true, refreshParse: true, files: [] });
        try { await submitTask(next); } catch (error) { next.state = 'failed'; next.error = error.message; write(next); }
        json(res, 202, present(next)); return true;
      }
      if (match[2] === 'more' && req.method === 'POST') {
        const input = await body(req);
        if (input.visibility !== scope) throw fail(409, '记录归属已变化，请刷新页面后重新提交。');
        const listing = job.kind === 'discovery' ? job.discovery : job.collection;
        if (!['collection', 'discovery'].includes(job.kind) || !['ready', 'failed'].includes(job.state) || !listing?.hasMore) throw fail(409, '没有更多内容可加载。');
        rate(`parse:${ip}`, 20, 600); busy(owner);
        if (mutations.has(job.id)) throw fail(409, '正在加载，请稍候。');
        mutations.add(job.id);
        try { job.saveStarted = Date.now(); job.refreshParse = Boolean(job.error); job.error = ''; await submitTask(job, listing.cursor); }
        catch (error) { job.state = 'ready'; job.error = error.message; write(job); throw error; }
        finally { mutations.delete(job.id); }
        json(res, 202, present(job)); return true;
      }
      if (match[2] === 'transcript.txt' && ['GET', 'HEAD'].includes(req.method)) {
        if (job.state !== 'transcribed' || !job.transcript) throw fail(404, '文字尚未准备好。');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="transcript.txt"; filename*=UTF-8''${encodeURIComponent((job.content?.title || '视频转写').slice(0, 100) + '.txt').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
        res.end(req.method === 'HEAD' ? '' : job.transcript.text); return true;
      }
      if (['export.json', 'export.csv'].includes(match[2]) && ['GET', 'HEAD'].includes(req.method)) {
        if (job.kind !== 'discovery' || !job.discovery) throw fail(404, '查询结果尚未准备好。');
        const format = match[2].split('.')[1];
        res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${job.operation}.${format}"`);
        res.end(req.method === 'HEAD' ? '' : discoveryExport(job, format)); return true;
      }
      if (match[2] === 'save' && req.method === 'POST') {
        await body(req);
        if (job.kind === 'discovery') throw fail(400, '请从查询结果选择一条作品，再进入下载解析。');
        rate(`save:${ip}`, 40, 600);
        job = await refresh(job);
        job = read(job.id, owner, legacyOwner);
        if (job.state === 'saved') {
          const download = await upstream(`/api/v1/downloads/${encodeURIComponent(job.downloadId)}`);
          if (download.on_disk) { json(res, 200, present(job)); return true; }
          job.state = 'parsed'; job.files = [];
        }
        if (job.state === 'saving' || (job.state === 'queued' && job.queueAction === 'save')) { json(res, 202, present(job)); return true; }
        if (job.state !== 'parsed') throw fail(409, '请先完成解析。');
        try { busy(owner); }
        catch (error) {
          if (error.status !== 429) throw error;
          if (db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(payload,'$.state')='queued'").get().n >= 40) throw error;
          job.state = 'queued'; job.queueAction = 'save'; write(job);
          json(res, 202, present(job)); return true;
        }
        await beginSave(job);
        json(res, 202, present(job)); return true;
      }
      if (match[2] === 'files' && match[3] && ['GET', 'HEAD'].includes(req.method)) {
        const name = match[3];
        const file = job.files?.find(f => f.name === name);
        if (!['saved', 'transcribing', 'transcribed', 'failed'].includes(job.state) || !safeName(name) || !file) throw fail(404, '文件尚未准备好。');
        if (totalStreams >= 6 || (streams.get(ip) || 0) >= 3) throw fail(429, '同时下载的文件过多，请稍后再试。');
        if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) throw fail(416, '不支持这个文件范围。');
        totalStreams++; streams.set(ip, (streams.get(ip) || 0) + 1);
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 10 * 60000);
        const close = () => abort.abort();
        res.on('close', close);
        try {
          const upstreamFile = await upstream(`/api/v1/downloads/${encodeURIComponent(job.downloadId)}/files/${encodeURIComponent(name)}`,
            undefined, true, req.headers.range ? { Range: req.headers.range } : {}, abort.signal);
          if (![200, 206].includes(upstreamFile.status)) {
            await upstreamFile.body?.cancel();
            if (upstreamFile.status === 404 || upstreamFile.status === 410) { job.state = job.transcript ? 'transcribed' : 'parsed'; job.files = []; write(job); throw fail(410, '缓存已清理，请返回页面重新准备文件。'); }
            throw fail(upstreamFile.status === 416 ? 416 : 502, '文件暂时无法下载，请稍后重试。');
          }
          const inline = new URL(req.url, origin).searchParams.get('inline') === '1';
          res.statusCode = upstreamFile.status;
          res.setHeader('Content-Type', file.type);
          res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="download.${name.split('.').pop().replace(/[^a-zA-Z0-9]/g, '')}"; filename*=UTF-8''${encodeURIComponent(file.label).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
          for (const h of ['content-length', 'content-range', 'accept-ranges']) if (upstreamFile.headers.has(h)) res.setHeader(h, upstreamFile.headers.get(h));
          if (req.method === 'HEAD') { await upstreamFile.body?.cancel(); res.end(); }
          else await pipeline(Readable.fromWeb(upstreamFile.body), res);
        } finally {
          clearTimeout(timer); res.off('close', close); totalStreams--; streams.set(ip, Math.max(0, (streams.get(ip) || 1) - 1));
          if (!streams.get(ip)) streams.delete(ip);
        }
        return true;
      }
      throw fail(405, '不支持这个操作。');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '处理失败，请稍后重试。' });
      else if (!res.writableEnded) res.destroy();
      return true;
    }
  };
  async function pump() {
    if (!configured || pumping || closed) return;
    pumping = true;
    try {
      let jobs = db.prepare('SELECT payload FROM jobs ORDER BY created DESC LIMIT 1000').all().map(r => JSON.parse(r.payload));
      await Promise.all(jobs.filter(j => ACTIVE.has(j.state)).map(j => refresh(j).catch(() => {})));
      if (closed) return;
      jobs = db.prepare('SELECT payload FROM jobs ORDER BY created ASC').all().map(r => JSON.parse(r.payload));
      const activeCount = jobs.filter(j => ACTIVE.has(j.state)).length;
      for (const job of jobs.filter(j => j.state === 'queued').slice(0, Math.max(0, 3 - activeCount))) {
        try {
          if (job.queueAction === 'save') { delete job.queueAction; await beginSave(job); }
          else await submitTask(job);
        } catch (error) { job.state = 'failed'; job.error = error.message; write(job); }
      }
    } finally { pumping = false; }
  }
  async function tickWatches() {
    if (closed || !configured || watching) return;
    watching = true;
    try { await watches.tick(); if (!closed) watches.cleanup(); } catch {} finally { watching = false; }
  }
  const maintenance = setInterval(() => { void pump(); void tickWatches(); }, 5000);
  maintenance.unref();
  // The processing gateway may consume an existing file only through the same
  // ownership check used by downloads. It never receives the upstream API key.
  handler.readSource = async (req, { jobId, fileName }) => {
    if (!configured) throw fail(503, '下载服务正在维护，请稍后再试。');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw fail(403, '请从本站打开工具。');
    if (!/^[a-f0-9-]{36}$/.test(jobId || '') || !safeName(fileName)) throw fail(404, '找不到这份素材。');
    const user = getUser(req);
    const owner = user ? `user:${user.id}` : 'public';
    const token = /(?:^|;\s*)omnihub_video=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const legacyOwner = !user && token ? `guest:${digest(token)}` : owner;
    const job = read(jobId, owner, legacyOwner);
    const file = job.files?.find(item => item.name === fileName);
    if (!['saved', 'transcribing', 'transcribed', 'failed'].includes(job.state) || !job.downloadId || !file || !MEDIA_TYPES.has(file.type)) throw fail(404, '文件尚未准备好。');
    const response = await upstream(`/api/v1/downloads/${encodeURIComponent(job.downloadId)}/files/${encodeURIComponent(fileName)}`,
      undefined, true, {}, AbortSignal.timeout(120000));
    if (response.status !== 200) {
      await response.body?.cancel();
      throw fail([404, 410].includes(response.status) ? 410 : 502, '素材缓存不可用，请重新解析或上传文件。');
    }
    return { job: present(job), file, response };
  };
  handler.close = () => { closed = true; clearInterval(maintenance); db.close(); };
  return handler;
}
