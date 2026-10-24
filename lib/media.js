import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { db, DATA_DIR, getInboxItem, getPrompt } from "./db.js";
import { getSessionUser } from "./auth.js";
import { createProviderJob, normalizeGeneration, queryProviderJobs, validateMediaBaseUrl, validateMediaResultUrl, MEDIA_MODELS } from "./media-provider.js";
import { createXCosMedia, createCosImageReader } from './x-cos-media.js';
import { downloadMediaResult } from './media-download.js';
import { xImageUrl } from './x-cos-archive.js';

const MEDIA_DIR = path.join(DATA_DIR, "media");
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_DOWNLOAD = 200 * 1024 * 1024;
const ACTIVE = new Set(["init", "queued", "generating", "result_pending"]);
const processing = new Set();
const xCosReferences=createXCosMedia({directory:process.env.OMNIHUB_X_MEDIA_ARCHIVE||'',readRemote:createCosImageReader()});
const POLL_BASE_MS = 15_000;
const POLL_MAX_MS = 15 * 60_000;
const POLL_MAX_ATTEMPTS = 40;
const POLL_MAX_AGE_MS = 24 * 60 * 60_000;
const ASSET_COLUMNS = `id, user_id AS userId, job_id AS jobId, kind, origin,
  mime_type AS mimeType, size_bytes AS sizeBytes, title, note, tags, rating,
  source_type AS sourceType, source_id AS sourceId, source_url AS sourceUrl,
  prompt_id AS promptId, parent_asset_id AS parentAssetId, model, prompt,
  created_at AS createdAt`;
const JOB_COLUMNS = `id, user_id AS userId, request_key AS requestKey, kind, module, model, mode,
  title, prompt, args, reference_asset_ids AS referenceAssetIds, source_type AS sourceType,
  source_id AS sourceId, parent_asset_id AS parentAssetId, status, remote_id AS remoteId,
  error, asset_id AS assetId, poll_attempts AS pollAttempts, next_poll_at AS nextPollAt,
  poll_deadline_at AS pollDeadlineAt, submission_started_at AS submissionStartedAt,
  created_at AS createdAt, updated_at AS updatedAt`;

function ensureMediaColumn(column, definition) {
  if (!db.prepare('PRAGMA table_info(media_jobs)').all().some((item) => item.name === column))
    db.exec(`ALTER TABLE media_jobs ADD COLUMN ${definition}`);
}
// A durable reservation is made before every provider query.  These columns
// are intentionally local to the media module so old databases migrate in
// place without a broad schema change.
ensureMediaColumn('poll_attempts', 'poll_attempts INTEGER NOT NULL DEFAULT 0');
ensureMediaColumn('next_poll_at', 'next_poll_at INTEGER NOT NULL DEFAULT 0');
ensureMediaColumn('poll_deadline_at', 'poll_deadline_at INTEGER NOT NULL DEFAULT 0');
ensureMediaColumn('last_poll_at', 'last_poll_at INTEGER NOT NULL DEFAULT 0');
ensureMediaColumn('submission_started_at', 'submission_started_at INTEGER NOT NULL DEFAULT 0');
ensureMediaColumn('result_url', "result_url TEXT NOT NULL DEFAULT ''");
// A process may die after the provider receives a create request but before it
// returns an ID.  Never auto-submit that ambiguous request after restart.
db.prepare("UPDATE media_jobs SET status='needs_review', error=?, next_poll_at=0, updated_at=datetime('now') WHERE status='submitting'")
  .run('生成提交结果不明，请先在服务方核对，避免重复生成');
// Databases created before durable polling did not have a deadline.  Anchor
// their remaining window to creation time; never grant an old job a new day.
db.prepare(`UPDATE media_jobs SET status='needs_review', error=?, next_poll_at=0, updated_at=datetime('now')
  WHERE module <> 'codex-local' AND status IN ('init','queued','generating','result_pending') AND COALESCE(poll_deadline_at,0)=0
    AND COALESCE(CAST(strftime('%s',created_at) AS INTEGER)*1000,0) <= ?`)
  .run('生成查询已超过 24 小时，请在服务方核对后手动处理', Date.now() - POLL_MAX_AGE_MS);
db.prepare(`UPDATE media_jobs SET poll_deadline_at=CAST(strftime('%s',created_at) AS INTEGER)*1000+?
  WHERE module <> 'codex-local' AND status IN ('init','queued','generating','result_pending') AND COALESCE(poll_deadline_at,0)=0`)
  .run(POLL_MAX_AGE_MS);

function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
  return true;
}

function currentUser(req, pathname) {
  const user = getSessionUser(req);
  if (!user) throw { status: 401, message: "请先登录" };
  // Native local jobs and their private files are available to each signed-in user.
  // Legacy third-party provider configuration and writes remain restricted.
  if (user.username.toLowerCase() !== "zane" && !(req.method === 'GET' && /^\/api\/media\/(assets|jobs)(\/|$)/.test(pathname))
    && !(req.method === 'PATCH' && /^\/api\/media\/assets\/[0-9a-f-]+$/.test(pathname)))
    throw { status: 403, message: "当前账号暂未开放第三方媒体服务" };
  return user;
}

function requireSameOriginWrite(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = String(req.headers.origin || '');
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { throw { status: 403, message: '写入来源不可信' }; }
    if (!/^https?:$/.test(url.protocol) || url.host !== String(req.headers.host || ''))
      throw { status: 403, message: '写入来源不可信' };
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site')
    throw { status: 403, message: '不允许跨站写入' };
}

async function jsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw { status: 413, message: "请求内容过大" };
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw { status: 400, message: "请求格式不是合法 JSON" }; }
}

function mask(value) {
  return value ? value.length > 8 ? `已保存 ····${value.slice(-4)}` : "已保存 ····" : "";
}

function getConfig(userId) {
  return db.prepare("SELECT base_url, authentication, sys_token FROM media_config WHERE user_id = ?").get(userId);
}

function publicConfig(config) {
  return {
    baseUrl: config?.base_url || "",
    authenticationMasked: mask(config?.authentication || ""),
    sysTokenMasked: mask(config?.sys_token || ""),
    hasAuthentication: Boolean(config?.authentication),
    hasSysToken: Boolean(config?.sys_token),
  };
}

function sourceInfo(userId, type, id) {
  if (!type && !id) return { type: "", id: null, url: "", promptId: null, sourceInboxId: null };
  const sourceId = Number(id);
  if (!Number.isInteger(sourceId) || sourceId < 1) throw { status: 400, message: "来源 ID 不正确" };
  if (type === "prompt") {
    const prompt = getPrompt(userId, sourceId);
    if (!prompt) throw { status: 404, message: "提示词不存在" };
    return { type, id: sourceId, url: prompt.sourceUrl || prompt.snsUrl || "", promptId: sourceId,
      sourceInboxId: Number.isSafeInteger(prompt.sourceInboxId) ? prompt.sourceInboxId : null };
  }
  if (type === "inbox") {
    const item = getInboxItem(userId, sourceId);
    if (!item) throw { status: 404, message: "收藏来源不存在" };
    return { type, id: sourceId, url: item.url || "", promptId: null, sourceInboxId: sourceId };
  }
  throw { status: 400, message: "来源类型不正确" };
}

function getAsset(userId, id) {
  return db.prepare(`SELECT ${ASSET_COLUMNS}, file_name AS fileName FROM media_assets WHERE user_id = ? AND id = ?`).get(userId, id);
}

function listAssets(userId) {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM media_assets WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(userId);
}

function publicJob(row) {
  if (!row) return null;
  const { resultUrl, ...publicRow } = row;
  return { ...publicRow, args: JSON.parse(row.args), referenceAssetIds: JSON.parse(row.referenceAssetIds) };
}

function getStoredJob(userId, id) {
  return db.prepare(`SELECT ${JOB_COLUMNS}, result_url AS resultUrl, last_poll_at AS lastPollAt
    FROM media_jobs WHERE user_id = ? AND id = ?`).get(userId, id);
}

function getJob(userId, id) {
  return publicJob(getStoredJob(userId, id));
}

function listJobs(userId) {
  return db.prepare(`SELECT ${JOB_COLUMNS} FROM media_jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`)
    .all(userId).map(publicJob);
}

function detectFile(header) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: "image", mime: "image/png", ext: "png" };
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp" };
  if (/^GIF8[79]a/.test(header.toString("ascii", 0, 6))) return { kind: "image", mime: "image/gif", ext: "gif" };
  if (header.toString("ascii", 4, 8) === "ftyp") return { kind: "video", mime: "video/mp4", ext: "mp4" };
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE") return { kind: "audio", mime: "audio/wav", ext: "wav" };
  if (header.toString("ascii", 0, 3) === "ID3" || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  return null;
}

async function writeLimited(stream, destination, limit) {
  await mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) callback(Object.assign(new Error("文件超过大小上限"), { status: 413 }));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    return size;
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

async function sniff(destination) {
  const handle = await open(destination, "r");
  try {
    const buffer = Buffer.alloc(24);
    await handle.read(buffer, 0, buffer.length, 0);
    return detectFile(buffer);
  } finally { await handle.close(); }
}

function validateParent(userId, parentAssetId) {
  if (!parentAssetId) return "";
  if (!getAsset(userId, parentAssetId)) throw { status: 404, message: "关联作品不存在" };
  return parentAssetId;
}

async function uploadAsset(req, userId) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const source = sourceInfo(userId, params.get("sourceType") || "", params.get("sourceId"));
  const title = String(params.get("title") || "未命名作品").trim().slice(0, 160);
  const parentAssetId = validateParent(userId, params.get("parentAssetId") || "");
  const id = randomUUID();
  const temp = path.join(MEDIA_DIR, `${id}.pending`);
  const size = await writeLimited(req, temp, MAX_UPLOAD);
  const file = await sniff(temp);
  if (!file || size === 0) {
    await rm(temp, { force: true });
    throw { status: 400, message: "仅支持 PNG、JPEG、WebP、GIF、MP4、WAV 或 MP3 文件" };
  }
  if (file.kind === "audio" && size > 15 * 1024 * 1024) {
    await rm(temp, { force: true });
    throw { status: 413, message: "音频文件最多 15 MB" };
  }
  const finalName = `${id}.${file.ext}`;
  await rename(temp, path.join(MEDIA_DIR, finalName));
  db.prepare(`INSERT INTO media_assets
    (id, user_id, kind, origin, file_name, mime_type, size_bytes, title, source_type,
     source_id, source_url, prompt_id, parent_asset_id)
    VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, file.kind, finalName, file.mime, size, title || "未命名作品",
      source.type, source.id, source.url, source.promptId, parentAssetId);
  const { fileName, ...asset } = getAsset(userId, id);
  return asset;
}

async function importSourceImage(userId, input) {
  const source = sourceInfo(userId, input.sourceType, input.sourceId);
  let allowed = [];
  if (source.type === "inbox") {
    const item = getInboxItem(userId, source.id);
    try {
      const media = JSON.parse(item.media || "[]");
      allowed = media.map((entry) => entry.type === "photo" ? entry.url : entry.preview_image_url || entry.url).filter(Boolean);
    } catch { /* invalid source media has no importable images */ }
  } else if (source.type === "prompt") {
    const prompt = getPrompt(userId, source.id);
    allowed = [prompt.image].filter(Boolean);
    try {
      const media = JSON.parse(prompt.media || "[]");
      if (Array.isArray(media)) allowed.push(...media.map((entry) => entry.url));
    } catch { /* invalid source media has no importable images */ }
  }
  allowed=allowed.filter(value=>typeof value==='string'&&value.length>0);
  const index = Number(input.mediaIndex);
  if (!Number.isInteger(index) || index < 0 || index >= allowed.length) throw { status: 400, message: "所选图片不属于该来源" };
  const selected = xImageUrl(allowed[index]) || allowed[index];
  const id = randomUUID();
  const temp = path.join(MEDIA_DIR, `${id}.pending`);
  await mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  let size;
  if (selected.startsWith("data:image/")) {
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(selected);
    if (!match || match[2].length > 40 * 1024 * 1024) throw { status: 400, message: "来源图片格式不受支持" };
    const bytes = Buffer.from(match[2], "base64");
    size = bytes.length;
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  } else {
    // Prompt-library media retains the original pbs URL in the database even
    // when the UI displays /api/x-media.  Prefer the checked COS/local archive
    // bound to this user's current inbox source; only then use the pre-existing
    // pbs fallback.  No URL supplied by the browser participates here.
    if (source.sourceInboxId) {
      try {
        const archived=await xCosReferences.readReference({inboxId:source.sourceInboxId,sourceUrl:selected,
          getOwnedRow:inboxId=>getInboxItem(userId,inboxId)});
        await writeFile(temp,archived.bytes,{flag:'wx',mode:0o600});
        size=archived.bytes.length;
      } catch { /* unavailable/corrupt archive falls back to the stored pbs source */ }
    }
    if (size !== undefined) {
      // The archive read was authorized twice by xCosReferences; continue to
      // the common signature check below.
    } else {
    let url;
    try { url = new URL(selected); }
    catch { throw { status: 400, message: "来源图片地址不正确" }; }
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) {
      throw { status: 400, message: "该来源图片暂不支持直接导入，请先下载后手动上传" };
    }
    let response;
    try { response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch { throw { status: 502, message: "暂时无法读取来源图片，请手动上传" }; }
    if (!response.ok || !response.body) throw { status: 502, message: "来源图片无法下载" };
    size = await writeLimited(Readable.fromWeb(response.body), temp, 30 * 1024 * 1024);
    }
  }
  const file = await sniff(temp);
  if (!file || file.kind !== "image") {
    await rm(temp, { force: true });
    throw { status: 400, message: "来源文件不是支持的图片" };
  }
  const finalName = `${id}.${file.ext}`;
  await rename(temp, path.join(MEDIA_DIR, finalName));
  db.prepare(`INSERT INTO media_assets
    (id, user_id, kind, origin, file_name, mime_type, size_bytes, title, source_type,
     source_id, source_url, prompt_id)
    VALUES (?, ?, 'image', 'reference', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, finalName, file.mime, size, String(input.title || "来源参考图").slice(0, 160),
      source.type, source.id, source.url, source.promptId);
  const { fileName, ...asset } = getAsset(userId, id);
  return asset;
}

async function serveFile(req, res, userId, id, download = false) {
  const asset = getAsset(userId, id);
  if (!asset) throw { status: 404, message: "作品不存在" };
  const filePath = path.join(MEDIA_DIR, asset.fileName);
  let details;
  try { details = await stat(filePath); }
  catch { throw { status: 404, message: "作品文件待恢复" }; }
  const range = req.headers.range;
  let start = 0;
  let end = details.size - 1;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { "Content-Range": `bytes */${details.size}` }); res.end(); return true; }
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= details.size) { res.writeHead(416, { "Content-Range": `bytes */${details.size}` }); res.end(); return true; }
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Type": asset.mimeType,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asset.id}.${asset.fileName.split(".").pop()}"`,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${details.size}` } : {}),
  });
  await pipeline(createReadStream(filePath, { start, end }), res);
  return true;
}

function prepareReferences(userId, ids) {
  if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length) {
    throw { status: 400, message: "参考素材列表不正确" };
  }
  return ids.map((id) => {
    const asset = getAsset(userId, String(id));
    if (!asset) throw { status: 404, message: "参考素材不存在" };
    return {
      id: asset.id, kind: asset.kind, mimeType: asset.mimeType,
      name: asset.fileName,
      read: () => readFile(path.join(MEDIA_DIR, asset.fileName)),
    };
  });
}

async function submitJob(userId, input) {
  if (input.acceptUnknownCost !== true) throw { status: 400, message: "请先确认本次生成可能消耗公司额度，费用暂未公布" };
  const requestKey = String(input.requestKey || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw { status: 400, message: "请求标识不正确" };
  const old = db.prepare("SELECT id FROM media_jobs WHERE user_id = ? AND request_key = ?").get(userId, requestKey);
  if (old) return getJob(userId, old.id);
  const config = getConfig(userId);
  if (!config?.authentication) throw { status: 400, message: "请先在 AI 设置中填写媒体接口认证信息" };
  if (!config.base_url) throw { status: 400, message: "请先在 AI 设置中填写媒体接口地址" };
  validateMediaBaseUrl(config.base_url);
  const references = prepareReferences(userId, input.referenceAssetIds || []);
  const normalized = normalizeGeneration(input, references);
  if (normalized.module === "hh1" && references.length) {
    throw { status: 400, message: "Happy Horse 的本地参考素材需要先取得服务可访问的 URL；当前可用文生视频或选择 Seedance" };
  }
  const source = sourceInfo(userId, input.sourceType || "", input.sourceId);
  const parentAssetId = validateParent(userId, input.parentAssetId || "");
  const id = randomUUID();
  const title = String(input.title || normalized.prompt.slice(0, 60) || "未命名作品").trim().slice(0, 160);
  try {
    db.prepare(`INSERT INTO media_jobs
      (id, user_id, request_key, kind, module, model, mode, title, prompt, args,
       reference_asset_ids, source_type, source_id, parent_asset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, requestKey, normalized.kind, normalized.module, normalized.model,
        normalized.mode, title, normalized.prompt, JSON.stringify(normalized.args),
        JSON.stringify(references.map((r) => r.id)), source.type, source.id, parentAssetId);
  } catch (error) {
    const duplicate = db.prepare("SELECT id FROM media_jobs WHERE user_id = ? AND request_key = ?")
      .get(userId, requestKey);
    if (duplicate) return getJob(userId, duplicate.id);
    throw error;
  }
  let providerAccepted = false;
  try {
    // This durable state transition is the reservation for the paid create
    // request.  A crash after this point is recovered above as needs_review,
    // rather than creating another provider task.
    db.prepare("UPDATE media_jobs SET status='submitting',submission_started_at=?,poll_deadline_at=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(Date.now(),Date.now()+POLL_MAX_AGE_MS,id,userId);
    const remote = await createProviderJob(config, { id, ...normalized }, references);
    if (!remote?.id) throw { status: 502, message: "生成服务未返回任务 ID", uncertain: true };
    providerAccepted = true;
    const started=Date.now();
    db.prepare("UPDATE media_jobs SET remote_id = ?, status = ?, next_poll_at = ?, poll_deadline_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(remote.id), ACTIVE.has(remote.status) ? remote.status : "init", started + POLL_BASE_MS, started + POLL_MAX_AGE_MS, id);
  } catch (error) {
    db.prepare("UPDATE media_jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(error.uncertain || providerAccepted ? "needs_review" : "failed", error.uncertain || providerAccepted
        ? "生成提交结果不明，请先在服务方核对，避免重复生成"
        : "生成提交失败，请检查媒体接口配置和参数", id);
  }
  return getJob(userId, id);
}

async function saveGeneratedAsset(job, config, resultUrl) {
  const existing = db.prepare("SELECT id FROM media_assets WHERE user_id = ? AND job_id = ?").get(job.userId, job.id);
  if (existing) {
    db.prepare("UPDATE media_jobs SET asset_id = ?, status = 'success', error = '', updated_at = datetime('now') WHERE id = ?")
      .run(existing.id, job.id);
    return;
  }
  const url = validateMediaResultUrl(resultUrl, config.base_url);
  const id = randomUUID();
  const temp = path.join(MEDIA_DIR, `${id}.pending`);
  const download = await downloadMediaResult(url, {
    localOrigin: new URL(config.base_url).origin,
    timeoutMs: 30_000,
    maxBytes: MAX_DOWNLOAD,
  });
  const size = await writeLimited(download.stream, temp, MAX_DOWNLOAD);
  const file = await sniff(temp);
  if (!file || file.kind !== job.kind) {
    await rm(temp, { force: true });
    throw new Error("生成结果文件类型不正确");
  }
  const finalName = `${id}.${file.ext}`;
  await rename(temp, path.join(MEDIA_DIR, finalName));
  let source;
  try { source = sourceInfo(job.userId, job.sourceType, job.sourceId); }
  catch { source = { type: job.sourceType, id: job.sourceId, url: "", promptId: null }; }
  db.prepare(`INSERT INTO media_assets
    (id, user_id, job_id, kind, origin, file_name, mime_type, size_bytes, title,
     source_type, source_id, source_url, prompt_id, parent_asset_id, model, prompt)
    VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, job.userId, job.id, file.kind, finalName, file.mime, size,
      job.title, source.type, source.id, source.url, source.promptId,
      job.parentAssetId, job.model, job.prompt);
  db.prepare("UPDATE media_jobs SET asset_id = ?, status = 'success', error = '', updated_at = datetime('now') WHERE id = ?")
    .run(id, job.id);
}

const pollDelay=attempt=>Math.min(POLL_MAX_MS,POLL_BASE_MS*(2**Math.min(Math.max(0,attempt-1),6)));
// Provider failures can contain an upstream body.  Store only an actionable,
// stable message so neither credentials nor provider diagnostics reach UI/API.
const safeFailure=(_error,fallback)=>String(fallback).replace(/[\r\n]+/g,' ').slice(0,240);

function stopPolling(job, reason) {
  db.prepare("UPDATE media_jobs SET status='needs_review', error=?, next_poll_at=0, updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(reason,job.id,job.userId);
}

function reservePoll(job, current) {
  const deadline=Number(job.pollDeadlineAt)||current+POLL_MAX_AGE_MS;
  if(current>=deadline) { stopPolling(job,'生成查询已超过 24 小时，请在服务方核对后手动处理'); return null; }
  if(Number(job.pollAttempts)>=POLL_MAX_ATTEMPTS) { stopPolling(job,'生成查询次数已达上限，任务已暂停以避免持续消耗'); return null; }
  const attempt=Number(job.pollAttempts)+1;
  const next=current+pollDelay(attempt);
  const changed=db.prepare(`UPDATE media_jobs SET poll_attempts=?,last_poll_at=?,next_poll_at=?,poll_deadline_at=?,error='',updated_at=datetime('now')
    WHERE id=? AND user_id=? AND status IN ('init','queued','generating','result_pending') AND next_poll_at<=?`).run(attempt,current,next,deadline,job.id,job.userId,current).changes;
  return changed ? {...job,pollAttempts:attempt,nextPollAt:next,pollDeadlineAt:deadline} : null;
}

async function refreshJob(userId, id) {
  let job=getStoredJob(userId,id);
  if(!job||!ACTIVE.has(job.status)||processing.has(id))return publicJob(job);
  const current=Date.now();
  if(Number(job.nextPollAt)>current)return publicJob(job);
  processing.add(id);
  try {
    const config=getConfig(userId);
    if(!config?.authentication||!config.base_url) { stopPolling(job,'媒体接口配置已变化，请重新检查后再处理'); return getJob(userId,id); }
    if(job.status==='result_pending'&&job.resultUrl) {
      // The provider already accepted and completed this task.  Only retry the
      // local file save; never create another paid generation or query again.
      const reserved=reservePoll({...job,status:'generating'},current);
      if(!reserved)return getJob(userId,id);
      try { await saveGeneratedAsset(job,config,job.resultUrl); }
      catch(error) {
        db.prepare("UPDATE media_jobs SET status='result_pending',error=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
          .run(safeFailure(error,'暂时无法保存生成结果，将按退避重试'),id,userId);
      }
      return getJob(userId,id);
    }
    const reserved=reservePoll(job,current);
    if(!reserved)return getJob(userId,id);
    const rows=await queryProviderJobs(config,[job.remoteId]);
    const row=Array.isArray(rows)?rows.find(item=>String(item.id)===job.remoteId):null;
    if(!row) {
      db.prepare("UPDATE media_jobs SET error=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run('生成服务尚未返回任务状态，将按退避重试',id,userId);
    } else if(row.status==='failed') {
      db.prepare("UPDATE media_jobs SET status='failed',error=?,next_poll_at=0,updated_at=datetime('now') WHERE id=? AND user_id=?")
        .run('生成服务报告失败，请在服务方查看详情',id,userId);
    } else if(row.status==='success'&&row.result?.url) {
      db.prepare("UPDATE media_jobs SET status='result_pending',result_url=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
        .run(String(row.result.url).slice(0,4096),id,userId);
      try { await saveGeneratedAsset(job,config,row.result.url); }
      catch(error) {
        db.prepare("UPDATE media_jobs SET status='result_pending',error=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
          .run(safeFailure(error,'暂时无法保存生成结果，将按退避重试'),id,userId);
      }
    } else if(['init','queued','generating'].includes(row.status)) {
      db.prepare("UPDATE media_jobs SET status=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(row.status,id,userId);
    } else {
      db.prepare("UPDATE media_jobs SET error=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run('生成服务返回了未知任务状态，将按退避重试',id,userId);
    }
  } catch(error) {
    db.prepare("UPDATE media_jobs SET error=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(safeFailure(error,'任务查询暂不可用，将按退避重试'),id,userId);
  } finally { processing.delete(id); }
  return getJob(userId,id);
}

export async function pollMediaJobs() {
  const rows = db.prepare("SELECT user_id AS userId, id FROM media_jobs WHERE status IN ('init','queued','generating','result_pending') AND remote_id <> '' AND next_poll_at<=? ORDER BY next_poll_at,created_at LIMIT 30").all(Date.now());
  for (const row of rows) await refreshJob(row.userId, row.id);
}

export function startMediaWorker() {
  const timer = setInterval(() => { pollMediaJobs().catch(() => {}); }, 15000);
  timer.unref();
  pollMediaJobs().catch(() => {});
}

export async function handleMediaApi(req, res, pathname) {
  if (!pathname.startsWith("/api/media/")) return false;
  const user = currentUser(req, pathname);
  requireSameOriginWrite(req);
  const route = `${req.method} ${pathname}`;
  if (route === "GET /api/media/config") return send(res, 200, publicConfig(getConfig(user.id)));
  if (route === "PUT /api/media/config") {
    const body = await jsonBody(req);
    const existing = getConfig(user.id);
    const rawBaseUrl = body.baseUrl !== undefined ? String(body.baseUrl).trim() : existing?.base_url || "";
    const baseUrl = rawBaseUrl ? validateMediaBaseUrl(rawBaseUrl) : "";
    const authentication = String(body.authentication || existing?.authentication || "").trim();
    const sysToken = body.clearSysToken === true ? "" : String(body.sysToken || existing?.sys_token || "").trim();
    if (!authentication) throw { status: 400, message: "请填写媒体接口认证信息" };
    db.prepare(`INSERT INTO media_config (user_id, base_url, authentication, sys_token)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      base_url = excluded.base_url, authentication = excluded.authentication,
      sys_token = excluded.sys_token, updated_at = datetime('now')`)
      .run(user.id, baseUrl, authentication, sysToken);
    return send(res, 200, publicConfig(getConfig(user.id)));
  }
  if (route === "GET /api/media/models") return send(res, 200, MEDIA_MODELS);
  if (route === "GET /api/media/assets") return send(res, 200, listAssets(user.id));
  if (route === "POST /api/media/assets/upload") return send(res, 201, await uploadAsset(req, user.id));
  if (route === "POST /api/media/assets/import-source") return send(res, 201, await importSourceImage(user.id, await jsonBody(req)));
  const assetMatch = pathname.match(/^\/api\/media\/assets\/([0-9a-f-]+)$/);
  if (assetMatch && req.method === "GET") {
    const asset = getAsset(user.id, assetMatch[1]);
    if (!asset) throw { status: 404, message: "作品不存在" };
    const { fileName, ...publicAsset } = asset;
    return send(res, 200, publicAsset);
  }
  if (assetMatch && req.method === "PATCH") {
    const body = await jsonBody(req);
    const asset = getAsset(user.id, assetMatch[1]);
    if (!asset) throw { status: 404, message: "作品不存在" };
    const title = String(body.title ?? asset.title).trim().slice(0, 160);
    if (!title) throw { status: 400, message: "作品标题不能为空" };
    const rating = Number(body.rating ?? asset.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw { status: 400, message: "评分只能为 0 至 5" };
    db.prepare("UPDATE media_assets SET title = ?, note = ?, tags = ?, rating = ? WHERE id = ? AND user_id = ?")
      .run(title, String(body.note ?? asset.note).slice(0, 4000), String(body.tags ?? asset.tags).slice(0, 500), rating, asset.id, user.id);
    const { fileName, ...publicAsset } = getAsset(user.id, asset.id);
    return send(res, 200, publicAsset);
  }
  const fileMatch = pathname.match(/^\/api\/media\/assets\/([0-9a-f-]+)\/(file|download)$/);
  if (fileMatch && req.method === "GET") return serveFile(req, res, user.id, fileMatch[1], fileMatch[2] === "download");
  if (route === "GET /api/media/jobs") return send(res, 200, listJobs(user.id));
  if (route === "POST /api/media/jobs") return send(res, 201, await submitJob(user.id, await jsonBody(req)));
  const jobMatch = pathname.match(/^\/api\/media\/jobs\/([0-9a-f-]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = getJob(user.id, jobMatch[1]);
    if (!job) throw { status: 404, message: "任务不存在" };
    return send(res, 200, job);
  }
  const refreshMatch = pathname.match(/^\/api\/media\/jobs\/([0-9a-f-]+)\/refresh$/);
  if (refreshMatch && req.method === "POST") {
    const job = getJob(user.id, refreshMatch[1]);
    if (!job) throw { status: 404, message: "任务不存在" };
    if (job.module === 'codex-local') return send(res, 200, job);
    return send(res, 200, await refreshJob(user.id, refreshMatch[1]));
  }
  throw { status: 404, message: "媒体接口不存在" };
}

export { sourceInfo as mediaSourceInfo, getJob as getMediaJob, requireSameOriginWrite };
