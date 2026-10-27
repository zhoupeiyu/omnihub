/// API 路由层 —— 认证、收藏、提示词、AI 配置与对话
import {
  db,
  createUser, findUserByName,
  listFavorites, getFavorite, addFavorite, updateFavorite, deleteFavorite,
  listPrompts, getPrompt, addPrompt, updatePrompt, deletePrompt,
  listKnowledge, getKnowledge, addKnowledge, updateKnowledge, deleteKnowledge,
  listInbox, listInboxIndex, searchInboxIds, getInboxItem, addInboxItem, importInboxItems, updateInboxAnalysis, ignoreInboxItem, dispatchInboxItem,
  setInboxVisibility,
} from "./db.js";
import { createHash } from "node:crypto";
import { readFile } from 'node:fs/promises';
import { normalizeSnsUrl } from "./sns.js";
import { fetchFeed, listFeedSources } from "./feed.js";
import { classifyInboxItem } from "./typesafe.js";
import { parseOrganizedXImport } from "./x-bookmarks.js";
import {
  hashPassword, verifyPassword,
  createSession, destroySession, sessionCookie, clearSessionCookie, getSessionUser,
} from "./auth.js";
import { chatWithAi, streamChatToClient } from "./ai.js";
import { aiConnections, aiProvider, aiSettings, testAiConnection, withAiSlot } from './ai-service.js';
import {
  createPdfCompressionJob,
  downloadPdfCompressionJob,
  getPdfCompressionJob,
} from "./pdf_tools.js";
import { handleMediaApi } from "./media.js";
import { handleLocalImageApi } from './local-image.js';
import {
  getKnowledgeArticle,
  getRepositoryAsset,
  listKnowledgeArticles,
  listPromptAssets,
  listRepositoryAssets,
  indexPublishedRepositories,
  updateRepositoryStatus,
} from "./knowledge-store.js";
import { createLibraryCuration } from "./library-curation.js";
import { publicPromptView, publicPromptMedia } from './library-public-view.js';
import { sendBody, sendJson } from "./http-response.js";
import { contentStore, contentPipeline, pipelineStatus, localCuration } from './content-runtime.js';
import { createLocalCurationHandler } from './local-curation-api.js';
import { xBookmarkSync, xAccount } from './x-bookmark-sync-runtime.js';
import { createXAccountHandler } from './x-account-api.js';
import { xWatch, xFollowing, xWatchMedia } from './x-watch-runtime.js';
import { createXCosMedia, createCosImageReader } from './x-cos-media.js';
import { loadPromptMediaReview, createPromptMediaSourceLookup, reviewedPromptMedia } from './prompt-media.js';
import { createSourceArticleReader } from './x-source-articles.js';
import { compactKnowledgeList } from './knowledge-list.js';
import { readPrivateRepositoryGuide, readPrivateRepositoryGuideMedia } from './repository-guide-store.js';
import {
  getManualKnowledgeAsset,
  getManualPromptAsset,
  listManualKnowledgeAssets,
  listManualPromptAssets,
} from './personal-library-view.js';

const libraryCuration = createLibraryCuration(db);
const handleXAccount=createXAccountHandler({account:xAccount,sync:xBookmarkSync,requireOwner:requirePersonalUser,readBody,send});
const handleLocalCuration=createLocalCurationHandler({queue:localCuration,pipeline:contentPipeline,sync:xBookmarkSync,
  requireOwner:requirePersonalUser,send});
const xCosMedia = createXCosMedia({ directory: process.env.OMNIHUB_X_MEDIA_ARCHIVE || '', readRemote: createCosImageReader() });
const promptMediaReview = loadPromptMediaReview();
const sourceArticles = createSourceArticleReader(db);

function canInlineKnowledgeDetail(ownerId, id, prepared) {
  id = String(id);
  const limit = 32 * 1024;
  if (id.startsWith('method-') || id.startsWith('pipeline-')) {
    const row = [...prepared.methods, ...prepared.generated].find(item => String(item.id) === id);
    return row && Buffer.byteLength(row.body || '') + Buffer.byteLength(row.promptText || '') <= limit;
  }
  // Query the stored size before materializing a long archived article. This is
  // conservative: large metadata can skip the seed even when its body is small.
  const row = id.startsWith('archive-')
    ? db.prepare('SELECT length(CAST(metrics AS BLOB)) AS bytes FROM inbox WHERE user_id=? AND id=?').get(ownerId, Number(id.slice(8)))
    : db.prepare('SELECT length(CAST(body AS BLOB)) + length(CAST(summary AS BLOB)) AS bytes FROM knowledge WHERE user_id=? AND id=?')
      .get(ownerId, Number(id.startsWith('manual-knowledge-') ? id.slice(17) : id));
  return row && Number(row.bytes || 0) <= limit;
}

function knowledgeDetail(ownerId, id, privateAccess, manualAccess, prepared = {}) {
  id = String(id);
  const item = id.startsWith('manual-knowledge-')
    ? manualAccess && getManualKnowledgeAsset(db, ownerId, Number(id.slice(17)))
    : id.startsWith('archive-') ? sourceArticles.get(ownerId, Number(id.slice(8)), {privateAccess})
    : id.startsWith('pipeline-') ? (prepared.generated || contentStore.knowledge(ownerId, {publicOnly:!privateAccess})).find(row => row.id === id)
    : id.startsWith('method-') ? (prepared.methods || libraryCuration.methods(ownerId, {publicOnly:!privateAccess, sourceId:Number(id.slice(7))})).find(row => row.id === id)
    : getKnowledgeArticle(ownerId, Number(id), {publicOnly:!privateAccess});
  if (!item) return null;
  return privateAccess ? item : {...item, sources:(item.sources || []).map(publicEvidenceItem).filter(Boolean)};
}

function inboxWithArchivedMedia(row) {
  return row?.source === 'x' ? { ...row, media: JSON.stringify(xCosMedia.rewrite(row.id, row.media)) } : row;
}

function promptLibraryItems(userId, publicOnly, { includeManual = false } = {}) {
  const generated = contentStore.prompts(userId, {publicOnly});
  const generatedIds = new Set(generated.map(item => item.sourceInboxId));
  const manualAll = listManualPromptAssets(db, userId);
  const manual = includeManual ? manualAll : [];
  const manualIds = new Set(manualAll.map((item) => item.manualAssetId));
  const curated = libraryCuration.prompts(userId,
    listPromptAssets(userId, {publicOnly}).filter((item) => !manualIds.has(Number(item.id))), {publicOnly});
  const findSource = createPromptMediaSourceLookup(db,userId);
  return [...curated.filter(item => !generatedIds.has(item.sourceInboxId)), ...generated, ...manual].map(item => ({...item,
    media:reviewedPromptMedia(item,promptMediaReview,{publicOnly,findSource,rewrite:(id,media)=>xCosMedia.rewrite(id,media)})}));
}

let publishedMediaCache = { stamp:'', paths:new Set() };
function mediaPublicationStamp(userId) {
  // data_version detects writes by other connections; total_changes detects
  // this connection's writes. No TTL may delay an access revocation.
  return `${userId}:${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() AS n').get().n}`;
}

function isPublishedPromptMedia(userId, inboxId, pathname) {
  if (!userId || !Number.isSafeInteger(inboxId)) return false;
  const stamp = mediaPublicationStamp(userId);
  if (stamp !== publishedMediaCache.stamp) {
    const paths = new Set();
    for (const item of promptLibraryItems(userId, true)) {
      for (const media of publicPromptMedia(item.media)) {
        const url = media.type === 'photo' ? media.url : media.preview_image_url;
        if (/^\/api\/x-media\/[1-9]\d*\/[a-f0-9]{64}$/.test(url || '')) paths.add(url);
      }
    }
    // Fail closed if an external writer changed publication during the rebuild.
    if (mediaPublicationStamp(userId) !== stamp) return false;
    publishedMediaCache = {stamp, paths};
  }
  return publishedMediaCache.paths.has(pathname);
}

function requirePersonalUser(req, writing = false) {
  const user = requireUser(req);
  if (writing) {
    const origin = req.headers.origin;
    let trustedOrigin = !origin;
    try { if (origin) { const url = new URL(origin); trustedOrigin = ['http:','https:'].includes(url.protocol) && url.host === req.headers.host; } } catch { /* reject malformed origin */ }
    if (!trustedOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw { status:403, message:'不允许跨站修改归类' };
    if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw { status:415, message:'请使用 JSON 提交归类' };
  }
  return user;
}

// Shared paid services remain restricted; personal connections never inherit them.
function requireCurationOwner(req, writing = false) {
  const user = requirePersonalUser(req, writing);
  if (!hasFullAccess(user)) throw { status:403, message:'此服务仅管理员可用' };
  return user;
}

function queuePersonalImports(user, ids) {
  if (!hasFullAccess(user)) contentStore.setLocalMode(user.id);
  contentStore.sync();
  if (contentStore.localMode(user.id)) contentStore.allowLocalSources(user.id, ids);
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 支持 base64 配图
const FULL_ACCESS_USERS = new Set(["zane"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject({ status: 413, message: "请求内容过大（图片请控制在 5MB 内）" }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (err) { reject({ status: 400, message: "请求格式不是合法 JSON" }); }
    });
    req.on("error", () => reject({ status: 400, message: "读取请求失败" }));
  });
}

/** 输出 JSON 响应；返回 true 方便路由分支 `return send(...)` 标记“已处理” */
function send(res, status, payload, extraHeaders = {}) {
  sendJson(res.req, res, status, payload, extraHeaders);
  return true;
}

function requireUser(req) {
  const user = getSessionUser(req);
  if (!user) throw { status: 401, message: "请先登录" };
  return user;
}

export function hasFullAccess(user) {
  const username = String((user && user.username) || "").trim();
  return FULL_ACCESS_USERS.has(username);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullAccess: hasFullAccess(user),
    personalAccess: true,
  };
}

function requireFullAccess(req) {
  const user = requireUser(req);
  if (!hasFullAccess(user)) throw { status: 403, message: "当前账号暂未开放完整功能" };
  return user;
}

function parsedJson(value, fallback) {
  try { return JSON.parse(value || "") || fallback; }
  catch { return fallback; }
}

function publicXPermalink(row) {
  try {
    const url = new URL(row.url);
    const postId = url.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/)?.[1];
    if (url.protocol !== "https:" ||
        !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase()) ||
        postId !== String(row.externalId)) return "";
    return `https://x.com${url.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

function publicEvidenceItem(item) {
  const url = publicXPermalink({ url: item.url, externalId: item.originalExternalId || item.externalId });
  if (!url) return null;
  const author = String(item.author || "").slice(0, 120);
  return {
    id: item.id,
    externalId: String(item.externalId || ""),
    title: String(item.title || "").trim() || (author ? `${author} 的原帖` : "来源帖子"),
    url,
    author,
    excerpt: '', private: true,
    citationKey: item.citationKey,
  };
}

function ownerContext(req) {
  const scope = new URL(req.url, 'http://localhost').searchParams.get('scope');
  if (scope && !['mine', 'public'].includes(scope)) throw { status:400, message:'内容空间无效' };
  if (scope === 'mine') return { owner:requireUser(req), privateAccess:true };
  const owner = findUserByName("zane");
  const session = getSessionUser(req);
  return {
    owner,
    privateAccess: scope !== 'public' && Boolean(owner && session && session.id === owner.id && hasFullAccess(session)),
  };
}

function hasPersonalLibraryAccess(req, owner, privateAccess, requireMine = true) {
  const scope = new URL(req.url, 'http://localhost').searchParams.get('scope');
  const session = getSessionUser(req);
  return Boolean(owner && session && owner.id === session.id && privateAccess && hasFullAccess(session) &&
    (!requireMine || scope === 'mine'));
}

function publicXMedia(media) {
  return Array.isArray(media) ? media.map((item) => ({
    type: item?.type, url: item?.url, preview_image_url: item?.preview_image_url,
    alt_text: item?.alt_text,
    ...(["video", "animated_gif"].includes(item?.type) ? { video_url: publicXVideoUrl(item) } : {}),
  })) : [];
}

function publicXBookmark(row, url) {
  const metrics = parsedJson(row.metrics, {});
  const extract = parsedJson(row.aiExtract, {});
  const organization = extract.xOrganization || {};
  const digest = extract.xDigest || {};
  const quoted = metrics.quotedTweet || {};
  const media = parsedJson(row.media, []);
  const links = parsedJson(row.links, []);
  return {
    id: row.id,
    source: "x",
    title: row.title,
    url,
    author: row.author,
    content: row.content,
    media: JSON.stringify(publicXMedia(xCosMedia.rewrite(row.id, media))),
    links: JSON.stringify(Array.isArray(links) ? links.map((item) =>
      typeof item === "string" ? item : item?.expanded_url || item?.url || "").filter(Boolean) : []),
    metrics: JSON.stringify({
      postCreatedAt: metrics.postCreatedAt || "",
      ...Object.fromEntries(["likes", "retweets", "bookmarks", "replies"]
        .filter((key) => metrics[key] !== undefined).map((key) => [key, metrics[key]])),
      ...(quoted.full_text ? { quotedTweet: {
        full_text: quoted.full_text,
        author: { screen_name: quoted.author?.screen_name || "" },
      } } : {}),
    }),
    aiType: row.aiType,
    aiSummary: row.aiSummary,
    aiExtract: JSON.stringify({
      xOrganization: {
        assetType: organization.assetType,
        topic: organization.topic,
        groupId: organization.groupId,
        groupTitle: organization.groupTitle,
        coverage: organization.coverage,
        contentIncomplete: Boolean(organization.contentIncomplete),
      },
      xDigest: { summary: digest.summary || "", status: digest.status || "" },
    }),
  };
}

function publicXVideoUrl(item) {
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  return variants.filter((variant) => variant?.content_type === "video/mp4")
    .map((variant) => {
      try {
        const url = new URL(variant.url);
        if (url.protocol !== "https:" || url.hostname !== "video.twimg.com" ||
            url.username || url.password || !url.pathname.endsWith(".mp4")) return null;
        url.hash = "";
        return { url: url.toString(), bitrate: Number(variant.bitrate) || 0 };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.bitrate - a.bitrate)[0]?.url || "";
}

let publicXCache = { expiresAt: 0, body: "", etag: "" };
function invalidatePublicXCache() { publicXCache = { expiresAt: 0, body: "", etag: "" }; }

function asJson(value, fallback) {
  if (typeof value === "string") {
    try { JSON.parse(value); return value; } catch (err) { return JSON.stringify(fallback); }
  }
  return JSON.stringify(value == null ? fallback : value);
}

function cleanUrl(value, required = false) {
  const raw = String(value || "").trim();
  if (!raw && !required) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    return parsed.toString();
  } catch (err) {
    throw { status: 400, message: "网址格式不正确" };
  }
}

function inboxTitle(data, url, content) {
  const explicit = String(data.title || "").trim();
  if (explicit) return explicit.slice(0, 160);
  if (url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (err) { /* 已校验 */ }
  }
  return String(content || "未命名内容").split(/\r?\n/)[0].trim().slice(0, 80) || "未命名内容";
}

export function normalizeInboxInput(data) {
  const rawContent = String(data.content ?? data.text ?? "").trim();
  const contentLooksLikeUrl = /^https?:\/\/\S+$/i.test(rawContent);
  const url = cleanUrl(data.url || (contentLooksLikeUrl ? rawContent : ""));
  const content = contentLooksLikeUrl && !data.url ? "" : rawContent;
  if (!url && !content) throw { status: 400, message: "请粘贴链接或输入内容" };
  let source = String(data.source || "manual").trim().toLowerCase().slice(0, 24) || "manual";
  const xStatus=url.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[a-zA-Z0-9_]{1,15}|i\/web)\/status\/([1-9][0-9]{0,24})(?:[/?#]|$)/i);
  if(xStatus)source='x';
  const identity = String(data.externalId || url || content).trim();
  const externalId = String(xStatus?.[1] || data.externalId || createHash("sha256")
    .update(`${source}\0${identity}`).digest("hex").slice(0, 32));
  return {
    source,
    externalId,
    title: inboxTitle(data, url, content),
    url,
    author: String(data.author || "").trim().slice(0, 120),
    content,
    media: asJson(data.media, []),
    links: asJson(data.links, []),
    metrics: asJson(data.metrics, {}),
    aiType: ["prompt", "resource", "knowledge", "noise"].includes(data.aiType) ? data.aiType : "",
    aiConfidence: Number(data.aiConfidence || 0),
    aiSummary: String(data.aiSummary || "").trim(),
    aiExtract: asJson(data.aiExtract, {}),
  };
}

function buildDispatchData(item, targetType, input = {}) {
  const title = String(input.title || item.title || item.content || "未命名资产").trim().slice(0, 160);
  const sourceUrl = cleanUrl(input.sourceUrl || item.url || "");
  if (targetType === "prompt") {
    const text = String(input.text || item.content || item.aiSummary || "").trim();
    if (!text) throw { status: 400, message: "提示词内容不能为空" };
    let media = [];
    try { media = JSON.parse(item.media || "[]"); } catch { /* Keep the source text. */ }
    const firstImage = Array.isArray(media) ? media
      .map((entry) => entry.type === "photo" ? entry.url : entry.preview_image_url)
      .find((url) => { try { return Boolean(cleanUrl(url)); } catch { return false; } }) : "";
    const sns = normalizeSnsUrl(sourceUrl);
    return {
      title, text, category: input.category || "其他", image: input.image || firstImage || "",
      negativeText: input.negativeText || "", model: input.model || "", tags: input.tags || "",
      media: item.media || "[]", snsUrl: sourceUrl, snsUrlNormalized: sns.normalizedUrl, snsType: sns.snsType,
      note: input.note || "", summary: input.summary || item.aiSummary || "",
      promptTextRaw: input.promptTextRaw || text, promptTextClean: input.promptTextClean || "",
      sourceUrl, sourceAuthor: input.sourceAuthor || item.author || "",
      sourceContent: input.sourceContent || item.content || "",
      kind: input.kind || "work", status: input.status || "untested",
      facetData: asJson({ ...parsedJson(input.facetData, {}), manualAsset: true,
        manualSourceInboxId: item.id }, {}),
    };
  }
  if (targetType === "resource") {
    const url = cleanUrl(input.url || item.url || "", true);
    return {
      name: String(input.name || title).trim(), url,
      desc: String(input.desc || item.aiSummary || item.content || "").trim().slice(0, 500),
      category: input.category || "常用", type: input.type || "site", tags: input.tags || "",
      sourceUrl, note: input.note || "", starred: Boolean(input.starred),
    };
  }
  if (targetType === "knowledge") {
    const body = String(input.body || item.content || item.aiSummary || "").trim();
    if (!body) throw { status: 400, message: "知识正文不能为空" };
    return {
      title, summary: input.summary || item.aiSummary || "", body, tags: input.tags || "",
      sourceUrl, sourceAuthor: input.sourceAuthor || item.author || "",
      sourceContent: input.sourceContent || item.content || "",
    };
  }
  throw { status: 400, message: "不支持的资产类型" };
}

async function analyzeInboxItem(userId, id) {
  const item = getInboxItem(userId, id);
  if (!item || item.status !== "pending") throw { status: 409, message: "这条内容已经处理过了" };
  const analysis = await classifyInboxItem(item);
  if (!updateInboxAnalysis(userId, id, analysis)) {
    throw { status: 409, message: "这条内容已经处理过了" };
  }
  return getInboxItem(userId, id);
}

function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : key.slice(0, 4) + "****" + key.slice(-4);
}

/** 处理 /api/* 请求；非 API 路径返回 false 交给静态服务 */
export async function handleApi(req, res, pathname) {
  if (!pathname.startsWith("/api/")) return false;

  try {
    if (pathname.startsWith('/api/x-media/')) {
      const match = /^\/api\/x-media\/([1-9]\d*)\/[a-f0-9]{64}$/.exec(pathname);
      const inboxId = Number(match?.[1]);
      const mediaOwner = Number.isSafeInteger(inboxId) ? db.prepare('SELECT user_id FROM inbox WHERE id=?').get(inboxId) : null;
      const publisher = findUserByName('zane');
      const privateAccess = () => Boolean(mediaOwner && getSessionUser(req)?.id === mediaOwner.user_id);
      const isPublic = row => mediaOwner?.user_id === publisher?.id && row.visibility === 'public'
        && isPublishedPromptMedia(mediaOwner.user_id, row.id, pathname);
      if (!privateAccess() && (!['GET','HEAD'].includes(req.method) || !xCosMedia.has(pathname) ||
          !mediaOwner || mediaOwner.user_id !== publisher?.id || !isPublishedPromptMedia(mediaOwner.user_id, inboxId, pathname))) {
        requirePersonalUser(req);
        throw { status:404, message:'图片不存在' };
      }
      return await xCosMedia.handle(req, res, pathname, {
        getRow: id => mediaOwner ? getInboxItem(mediaOwner.user_id, id) : null,
        privateAccess,
        isPublic,
      });
    }
    if (pathname.startsWith('/api/local-image/')) return await handleLocalImageApi(req,res,pathname);
    if (pathname.startsWith("/api/media/")) return await handleMediaApi(req, res, pathname);
    const route = `${req.method} ${pathname}`;
    if(pathname.startsWith('/api/local-curation/'))return await handleLocalCuration(req,res,pathname);
    if(pathname.startsWith('/api/account/x'))return await handleXAccount(req,res,pathname);
    if (route === 'GET /api/account/connections') {
      const user = requirePersonalUser(req);
      return send(res, 200, { user:publicUser(user),
        chatgpt:{status:'unavailable',reason:'hosted_approval_required',canConnect:false,supportsImageGeneration:false},
        localCuration:localCuration.status(user.id) });
    }

    /* ---------- 认证 ---------- */
    if (route === "POST /api/register") {
      const { username, password } = await readBody(req);
      const name = (username || "").trim();
      if (name.length < 2 || name.length > 20) throw { status: 400, message: "用户名需要 2–20 个字符" };
      if (!password || password.length < 6) throw { status: 400, message: "密码至少 6 位" };
      if (findUserByName(name)) throw { status: 409, message: "用户名已被占用，换一个试试" };
      const { hash, salt } = hashPassword(password);
      const userId = createUser({ username: name, passwordHash: hash, salt });
      const token = createSession(userId);
      return send(res, 200, publicUser({ id: userId, username: name }), { "Set-Cookie": sessionCookie(token) });
    }

    if (route === "POST /api/login") {
      const { username, password } = await readBody(req);
      const user = findUserByName((username || "").trim());
      if (!user || !verifyPassword(password || "", user.salt, user.password_hash)) {
        throw { status: 401, message: "用户名或密码不对" };
      }
      const token = createSession(user.id);
      return send(res, 200, publicUser(user), { "Set-Cookie": sessionCookie(token) });
    }

    if (route === "POST /api/logout") {
      const user = getSessionUser(req);
      if (user) destroySession(user.token);
      return send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (route === "GET /api/me") {
      const user = getSessionUser(req);
      if (!user) return send(res, 200, null, { "Cache-Control": "no-store" });
      const config = aiConnections.selected(user.id);
      return send(res, 200, {
        ...publicUser(user),
        hasAiConfig: Boolean(config && config.test_state === 'ready'),
      });
    }

    /* ---------- 收件箱 ---------- */
    if (route === "GET /api/x-bookmarks") {
      const owner = requirePersonalUser(req);
      return send(res, 200, listInbox(owner.id, { status: 'pending', source: 'x' }).map(inboxWithArchivedMedia), { 'Cache-Control': 'no-store' });
    }
    const curationMatch = pathname.match(/^\/api\/library-classification\/(source|repository)\/(.+)$/);
    if (curationMatch && ['GET','PUT'].includes(req.method)) {
      const user = requirePersonalUser(req, req.method === 'PUT');
      const [,type,rawKey] = curationMatch;
      const key = type === 'repository' ? rawKey.toLowerCase() : rawKey;
      if (req.method === 'GET') return send(res,200,libraryCuration.read(user.id,type,key),{'Cache-Control':'no-store'});
      const payload = await readBody(req);
      if (!payload || Object.keys(payload).some(k => !['revision','data'].includes(k))) throw { status:400,message:'不支持的请求字段' };
      return send(res,200,libraryCuration.write(user.id,type,key,payload.revision,payload.data),{'Cache-Control':'no-store'});
    }
    if (route === 'GET /api/content-pipeline') {
      const user=requirePersonalUser(req);
      return send(res,200,pipelineStatus(user.id),{'Cache-Control':'no-store'});
    }
    const pipelineDraft=pathname.match(/^\/api\/content-pipeline\/results\/(\d+)$/);
    if(pipelineDraft&&req.method==='GET') {
      const user=requirePersonalUser(req);
      const result=contentStore.resultFor(Number(pipelineDraft[1]),{includeReview:true});
      if(!result||result.source.userId!==user.id)throw {status:404,message:'尚未生成整理草稿'};
      return send(res,200,{state:result.state,article:result.article,classification:result.classification,
        source:{title:result.source.title,url:cleanUrl(result.source.url),author:result.source.author}},{'Cache-Control':'no-store'});
    }
    if (route === 'GET /api/x-watch') {
      const user=requireCurationOwner(req);
      return send(res,200,{...xWatch.status(user.id),mediaStorage:xWatchMedia.status(user.id)},{'Cache-Control':'no-store'});
    }
    const watchMedia=pathname.match(/^\/api\/x-watch\/media\/(\d+)$/);
    if(route==='POST /api/x-watch/media/retry') {
      const user=requireCurationOwner(req,true);
      return send(res,200,{queued:xWatchMedia.retry(user.id)},{'Cache-Control':'no-store'});
    }
    if(watchMedia&&['GET','HEAD'].includes(req.method)) {
      const user=requireCurationOwner(req);
      xWatchMedia.serve(req,res,user.id,Number(watchMedia[1]));return true;
    }
    if (route === 'POST /api/x-watch/accounts') {
      const user=requireCurationOwner(req,true);
      return send(res,200,xWatch.configure(user.id,await readBody(req)),{'Cache-Control':'no-store'});
    }
    if (route === 'POST /api/x-watch/accounts/batch') {
      const user=requireCurationOwner(req,true);
      return send(res,200,xWatch.addAccounts(user.id,await readBody(req)),{'Cache-Control':'no-store'});
    }
    if (route === 'GET /api/x-watch/following') {
      const user=requireCurationOwner(req);
      return send(res,200,xFollowing.status(user.id),{'Cache-Control':'no-store'});
    }
    if (route === 'POST /api/x-watch/following') {
      const user=requireCurationOwner(req,true);
      return send(res,200,await xFollowing.load(user.id,await readBody(req)),{'Cache-Control':'no-store'});
    }
    if (route === 'GET /api/x-watch/posts' || route === 'GET /api/x-watch/hot') {
      const user=requireCurationOwner(req);
      const decorate=post=>xWatchMedia.decorate(user.id,post);
      return send(res,200,route.endsWith('/hot')?xWatch.hot(user.id).map(event=>({...event,items:event.items.map(decorate)})):xWatch.posts(user.id).map(decorate),{'Cache-Control':'no-store'});
    }
    const watchBookmark=pathname.match(/^\/api\/x-watch\/posts\/(\d+)\/bookmark$/);
    const watchRetry=pathname.match(/^\/api\/x-watch\/posts\/(\d+)\/retry$/);
    if(watchRetry&&req.method==='POST') {
      const user=requireCurationOwner(req,true);
      if(!xWatch.status(user.id).analysisEnabled)throw {status:409,message:'中文整理服务尚未启用'};
      if(!xWatch.retryAnalysis(user.id,Number(watchRetry[1])))throw {status:409,message:'该条分析不可重试'};
      return send(res,202,{queued:true},{'Cache-Control':'no-store'});
    }
    if(watchBookmark&&req.method==='POST') {
      const user=requireCurationOwner(req,true);
      const saved=xWatch.bookmark(user.id,Number(watchBookmark[1]),post=>addInboxItem(user.id,normalizeInboxInput(post)));
      contentStore.sync();invalidatePublicXCache();
      return send(res,saved.created?201:200,{...inboxWithArchivedMedia(getInboxItem(user.id,saved.id)),created:saved.created},{'Cache-Control':'no-store'});
    }
    if (route === 'POST /api/content-pipeline') {
      const user=requirePersonalUser(req,true);
      const body=await readBody(req);
      if (!body || Object.keys(body).some(k=>!['action','jobId','includePrivate','sampleSize'].includes(k))) throw {status:400,message:'不支持的整理参数'};
      if (!hasFullAccess(user)) contentStore.setLocalMode(user.id);
      if(body.action==='enable') {
        contentStore.configure(user.id,{includePrivate:body.includePrivate,sampleSize:body.sampleSize});
        contentStore.seed(user.id);contentStore.setEnabled(user.id,true);
      }
      else if(body.action==='pause') contentStore.setEnabled(user.id,false);
      else if(body.action==='enqueue') contentStore.seed(user.id);
      else if(body.action==='publish') {
        if (!hasFullAccess(user)) throw {status:403,message:'个人整理结果默认私有，当前未开放对外发布'};
        if(!Number.isSafeInteger(body.jobId)||body.jobId<1)throw {status:400,message:'整理任务无效'};
        contentStore.publish(user.id,body.jobId,{onPublish:result=>indexPublishedRepositories(user.id,result)});
      }
      else if(body.action==='retry') {
        if(!Number.isSafeInteger(body.jobId)||body.jobId<1||!contentStore.retry(user.id,body.jobId))throw {status:400,message:'任务不可重试'};
      } else if(body.action==='run') {
        if(!contentStore.enabled(user.id))throw {status:409,message:'请先启用整理流程'};
        void contentPipeline.run(user.id).catch(()=>{});
      } else throw {status:400,message:'未知整理操作'};
      return send(res,202,pipelineStatus(user.id),{'Cache-Control':'no-store'});
    }
    if (route === "GET /api/repositories") {
      const { owner, privateAccess } = ownerContext(req);
      if (!owner) return send(res, 200, []);
      return send(res, 200, listRepositoryAssets(owner.id, { publicOnly: !privateAccess }).map(row => libraryCuration.repository(owner.id,row)), {
        "Cache-Control": "no-store",
      });
    }
    const repositoryGuideMatch = pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)\/guide$/);
    if (repositoryGuideMatch && req.method === 'GET') {
      const { owner, privateAccess } = ownerContext(req);
      const key = `${repositoryGuideMatch[1]}/${repositoryGuideMatch[2]}`.toLowerCase();
      // New guides are a private derived layer. Public catalogues continue to
      // read their reviewed static guides from the build assets.
      if (!owner || !privateAccess || !getRepositoryAsset(owner.id, key, { publicOnly: false })) {
        throw { status: 404, message: '仓库指南不存在' };
      }
      const guide = await readPrivateRepositoryGuide(key);
      if (!guide) throw { status: 404, message: '仓库指南不存在' };
      return send(res, 200, guide, { 'Cache-Control': 'no-store' });
    }
    const repositoryGuideMediaMatch = pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)\/guide-media\/(media-[a-f0-9]{12,64}\.webp)$/);
    if (repositoryGuideMediaMatch && ['GET', 'HEAD'].includes(req.method)) {
      const { owner, privateAccess } = ownerContext(req);
      const key = `${repositoryGuideMediaMatch[1]}/${repositoryGuideMediaMatch[2]}`.toLowerCase();
      if (!owner || !privateAccess || !getRepositoryAsset(owner.id, key, { publicOnly: false })) {
        throw { status: 404, message: '仓库指南素材不存在' };
      }
      const media = await readPrivateRepositoryGuideMedia(key, repositoryGuideMediaMatch[3]);
      if (!media) throw { status: 404, message: '仓库指南素材不存在' };
      sendBody(req, res, 200, await readFile(media.file), {
        'Content-Type': 'image/webp', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return true;
    }
    const repositoryMatch = pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)$/);
    if (repositoryMatch && req.method === "GET") {
      const { owner, privateAccess } = ownerContext(req);
      if (!owner) throw { status: 404, message: "仓库资产不存在" };
      const key = `${repositoryMatch[1]}/${repositoryMatch[2]}`.toLowerCase();
      const item = getRepositoryAsset(owner.id, key, { publicOnly: !privateAccess });
      if (!item) throw { status: 404, message: "仓库资产不存在" };
      if (!privateAccess) item.sources = item.sources.map(publicEvidenceItem).filter(Boolean);
      return send(res, 200, libraryCuration.repository(owner.id,item), { "Cache-Control": "no-store" });
    }
    const repositoryStatusMatch = pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)\/status$/);
    if (repositoryStatusMatch && req.method === "PUT") {
      const user = requireFullAccess(req);
      const { status } = await readBody(req);
      const key = `${repositoryStatusMatch[1]}/${repositoryStatusMatch[2]}`.toLowerCase();
      if (!updateRepositoryStatus(user.id, key, String(status || ""))) {
        throw { status: 400, message: "仓库状态无效或仓库不存在" };
      }
      return send(res, 200, getRepositoryAsset(user.id, key));
    }
    if (route === "GET /api/knowledge-library") {
      const { owner, privateAccess } = ownerContext(req);
      if (!owner) return send(res, 200, []);
      const includeManual = hasPersonalLibraryAccess(req, owner, privateAccess);
      const manualAll = listManualKnowledgeAssets(db, owner.id);
      const manual = includeManual ? manualAll : [];
      const manualIds = new Set(manualAll.map((item) => item.manualAssetId));
      const prepared = {methods:libraryCuration.methods(owner.id,{publicOnly:!privateAccess}), generated:contentStore.knowledge(owner.id,{publicOnly:!privateAccess})};
      const methods = prepared.methods.map(({body,promptText,sources,claims,repositories,...row}) => row);
      const generated=prepared.generated.map(({body,sources,claims,repositories,...row})=>row);
      const archived=sourceArticles.list(owner.id,{privateAccess,excludeSourceIds:generated.map(row=>row.sourceInboxId)});
      const articles = listKnowledgeArticles(owner.id, { publicOnly: !privateAccess })
        .filter((item) => !manualIds.has(Number(item.id)));
      const rows = [...methods, ...articles, ...generated, ...archived, ...manual];
      const compact = new URL(req.url, 'http://localhost').searchParams.get('view') === 'compact';
      return send(res, 200, compact ? compactKnowledgeList(rows,
        id => knowledgeDetail(owner.id, id, privateAccess, includeManual, prepared),
        id => canInlineKnowledgeDetail(owner.id, id, prepared)) : rows, {
        "Cache-Control": "no-store",
      });
    }
    const knowledgeLibraryMatch = pathname.match(/^\/api\/knowledge-library\/(\d+|archive-\d+|method-\d+|manual-knowledge-\d+|pipeline-(?:source-)?\d+)$/);
    if (knowledgeLibraryMatch && req.method === "GET") {
      const { owner, privateAccess } = ownerContext(req);
      if (!owner) throw { status: 404, message: "知识文章不存在" };
      const manualAccess = hasPersonalLibraryAccess(req, owner, privateAccess, false);
      const item = knowledgeDetail(owner.id, knowledgeLibraryMatch[1], privateAccess, manualAccess);
      if (!item) throw { status: 404, message: "知识文章不存在" };
      return send(res, 200, item, { "Cache-Control": "no-store" });
    }
    if (route === "GET /api/prompt-library") {
      const { owner, privateAccess } = ownerContext(req);
      if (!owner) return send(res, 200, []);
      const includeManual = hasPersonalLibraryAccess(req, owner, privateAccess);
      return send(res, 200, promptLibraryItems(owner.id,!privateAccess,{includeManual}).map(item => privateAccess
        ? item : publicPromptView(item)), { "Cache-Control": "no-store" });
    }
    if (route === "GET /api/inbox/search") {
      const user = requirePersonalUser(req);
      const params = new URL(req.url, 'http://localhost').searchParams;
      const q = params.get('q') || '';
      if (q.length > 300) throw {status:400, message:'搜索词不能超过 300 个字符'};
      return send(res, 200, searchInboxIds(user.id, q, {status:'pending', terms:params.get('mode') === 'terms'}), {'Cache-Control':'no-store'});
    }
    if (route === "GET /api/inbox" || route === "GET /api/inbox/list") {
      const user = requirePersonalUser(req);
      const params = new URL(req.url, "http://localhost").searchParams;
      const curations = new Map(db.prepare("SELECT asset_key, revision, data FROM library_curation WHERE user_id=? AND asset_type='source'")
        .all(user.id).map(row => [String(row.asset_key), { revision: row.revision, data: { type: JSON.parse(row.data).type } }]));
      const readInbox = route === 'GET /api/inbox/list' ? listInboxIndex : listInbox;
      return send(res, 200, readInbox(user.id, {
        status: params.get("status") || "pending",
        type: params.get("type") || "",
      }).map(item => ({ ...inboxWithArchivedMedia(item), curation: curations.get(String(item.id)) || null })));
    }
    if (route === "POST /api/inbox") {
      const user = requirePersonalUser(req, true);
      const data = normalizeInboxInput(await readBody(req));
      const result = addInboxItem(user.id, data);
      if (data.source === "x") invalidatePublicXCache();
      // Local curation accepts X sources; other captures remain saved without
      // claiming that a local model task has been queued.
      queuePersonalImports(user, [result.id]);
      const item = getInboxItem(user.id, result.id);
      const processingQueued = result.created && (data.source === "x" || !contentStore.localMode(user.id));
      return send(res, result.created ? 201 : 200, { ...inboxWithArchivedMedia(item), created: result.created, processingQueued });
    }
    if (route === "POST /api/inbox/import/x") {
      const user = requirePersonalUser(req, true);
      const body = await readBody(req);
      let parsed;
      try {
        parsed = parseOrganizedXImport(body.text, { allowPartial: body.allowPartial === true });
      }
      catch (error) { throw { status: 400, message: error.message }; }
      const result = importInboxItems(user.id, parsed.items.map(normalizeInboxInput));
      const importedIds = parsed.items.map(item => db.prepare('SELECT id FROM inbox WHERE user_id=? AND source=? AND external_id=?').get(user.id, 'x', String(item.externalId))?.id).filter(Boolean);
      queuePersonalImports(user, importedIds);
      invalidatePublicXCache();
      return send(res, 200, result);
    }
    if (route === "POST /api/inbox/import") {
      const user = requirePersonalUser(req, true);
      const body = await readBody(req);
      const inputs = Array.isArray(body.items) ? body.items : [body];
      if (inputs.length > 500) throw { status: 400, message: "单次最多导入 500 条" };
      let imported = 0;
      let skipped = 0;
      const ids = [];
      for (const input of inputs) {
        const data = normalizeInboxInput(input || {});
        const result = addInboxItem(user.id, data);
        ids.push(result.id);
        if (result.created) imported += 1;
        else skipped += 1;
      }
      if (inputs.some((input) => input?.source === "x")) invalidatePublicXCache();
      queuePersonalImports(user, ids);
      return send(res, 200, { imported, skipped, ids });
    }
    const inboxItemMatch = pathname.match(/^\/api\/inbox\/(\d+)$/);
    if (inboxItemMatch && req.method === "GET") {
      const user = requirePersonalUser(req);
      const item = getInboxItem(user.id, Number(inboxItemMatch[1]));
      if (!item) throw { status: 404, message: "收件箱内容不存在" };
      return send(res, 200, inboxWithArchivedMedia(item));
    }
    const inboxVisibilityMatch = pathname.match(/^\/api\/inbox\/(\d+)\/visibility$/);
    if (inboxVisibilityMatch && req.method === "PUT") {
      const user = requireFullAccess(req);
      const { visibility } = await readBody(req);
      if (!["public", "private"].includes(visibility)) {
        throw { status: 400, message: "可见范围必须是公开或仅自己可见" };
      }
      const id = Number(inboxVisibilityMatch[1]);
      if (!setInboxVisibility(user.id, id, visibility)) {
        throw { status: 404, message: "X 收藏不存在或已处理" };
      }
      invalidatePublicXCache();
      return send(res, 200, inboxWithArchivedMedia(getInboxItem(user.id, id)), { "Cache-Control": "no-store" });
    }
    const inboxAnalyzeMatch = pathname.match(/^\/api\/inbox\/(\d+)\/analyze$/);
    if (inboxAnalyzeMatch && req.method === "POST") {
      const user = requireFullAccess(req);
      try {
        const item = await analyzeInboxItem(user.id, Number(inboxAnalyzeMatch[1]));
        if (item.source === "x") invalidatePublicXCache();
        return send(res, 200, inboxWithArchivedMedia(item));
      } catch (err) {
        if (err.status) throw err;
        throw { status: 503, message: err.message || "TypeSafe 判断暂不可用" };
      }
    }
    const inboxDispatchMatch = pathname.match(/^\/api\/inbox\/(\d+)\/dispatch$/);
    if (inboxDispatchMatch && req.method === "POST") {
      const user = requireFullAccess(req);
      const item = getInboxItem(user.id, Number(inboxDispatchMatch[1]));
      if (!item) throw { status: 404, message: "收件箱内容不存在" };
      const { targetType, data } = await readBody(req);
      const targetData = buildDispatchData(item, targetType, data || {});
      const result = dispatchInboxItem(user.id, item.id, targetType, targetData);
      if (item.source === "x") invalidatePublicXCache();
      const manualAssetId = ['prompt', 'knowledge'].includes(result.targetType) ? result.targetId : undefined;
      const libraryId = result.targetType === 'prompt' ? `manual-prompt-${result.targetId}`
        : result.targetType === 'knowledge' ? `manual-knowledge-${result.targetId}` : undefined;
      return send(res, 200, { ...result, ...(manualAssetId ? { manualAssetId, libraryId } : {}) });
    }
    const inboxIgnoreMatch = pathname.match(/^\/api\/inbox\/(\d+)\/ignore$/);
    if (inboxIgnoreMatch && req.method === "POST") {
      const user = requirePersonalUser(req, true);
      if (!ignoreInboxItem(user.id, Number(inboxIgnoreMatch[1]))) {
        throw { status: 409, message: "这条内容已经处理过了" };
      }
      invalidatePublicXCache();
      return send(res, 200, { ok: true });
    }

    /* ---------- 知识库正文搜索（与列表/详情同一 owner/scope/manual/public 规则） ---------- */
    if (route === "GET /api/knowledge-library/search") {
      const { owner, privateAccess } = ownerContext(req);
      const q = String(new URL(req.url, "http://localhost").searchParams.get("q") || "").trim();
      if (!q) throw { status: 400, message: "请输入搜索词" };
      if (Array.from(q).length > KNOWLEDGE_SEARCH_MAX_QUERY) throw { status: 400, message: "搜索词最多 120 个字符，请缩小范围" };
      if (!owner) return send(res, 200, { query: q, results: [], total: 0, truncated: false }, { "Cache-Control": "no-store" });
      const includeManual = hasPersonalLibraryAccess(req, owner, privateAccess);
      return send(res, 200, searchKnowledgeLibrary(owner.id, q, { privateAccess, includeManual }), { "Cache-Control": "no-store" });
    }

    /* ---------- 收藏 ---------- */
    if (route === "GET /api/favorites") {
      const user = requireFullAccess(req);
      return send(res, 200, listFavorites(user.id));
    }
    if (route === "POST /api/favorites") {
      const user = requireFullAccess(req);
      const { name, url, desc, category, type, tags, sourceUrl, note, starred } = await readBody(req);
      if (!name || !url) throw { status: 400, message: "名称和网址不能为空" };
      const clean = cleanUrl(url, true);
      const id = addFavorite(user.id, { name, url: clean, desc, category, type, tags, sourceUrl, note, starred });
      return send(res, 200, getFavorite(user.id, id));
    }
    const favMatch = pathname.match(/^\/api\/favorites\/(\d+)$/);
    if (favMatch && req.method === "PUT") {
      const user = requireFullAccess(req);
      const current = getFavorite(user.id, Number(favMatch[1]));
      if (!current) throw { status: 404, message: "收藏不存在" };
      const patch = { ...current, ...await readBody(req) };
      if (!patch.name || !patch.url) throw { status: 400, message: "名称和网址不能为空" };
      patch.url = cleanUrl(patch.url, true);
      if (!updateFavorite(user.id, Number(favMatch[1]), patch)) {
        throw { status: 404, message: "收藏不存在" };
      }
      return send(res, 200, getFavorite(user.id, Number(favMatch[1])));
    }
    if (favMatch && req.method === "DELETE") {
      const user = requireFullAccess(req);
      if (!deleteFavorite(user.id, Number(favMatch[1]))) throw { status: 404, message: "收藏不存在" };
      return send(res, 200, { ok: true });
    }

    /* ---------- 提示词（灵感库） ---------- */
    if (route === "GET /api/prompts") {
      const user = requireFullAccess(req);
      return send(res, 200, listPrompts(user.id));
    }
    if (route === "POST /api/prompts") {
      const user = requireFullAccess(req);
      const data = await readBody(req);
      if (!data.title || !data.text) throw { status: 400, message: "标题和提示词内容不能为空" };
      if (data.sourceInboxId != null) {
        const sourceInboxId = Number(data.sourceInboxId);
        if (!Number.isSafeInteger(sourceInboxId) || !getInboxItem(user.id, sourceInboxId)) {
          throw { status: 404, message: "提示词来源不存在" };
        }
        data.sourceInboxId = sourceInboxId;
      }
      const sns = normalizeSnsUrl(data.snsUrl);
      const facetData = asJson({ ...parsedJson(data.facetData, {}), manualAsset: true,
        ...(data.sourceInboxId == null ? {} : { manualSourceInboxId:data.sourceInboxId }) }, {});
      const id = addPrompt(user.id, { ...data, sourceInboxId:null, facetData,
        snsUrlNormalized: sns.normalizedUrl, snsType: sns.snsType });
      return send(res, 200, { id, manualAssetId:id, libraryId:`manual-prompt-${id}`,
        snsUrlNormalized: sns.normalizedUrl, snsType: sns.snsType });
    }
    if (route === "GET /api/prompts/export") {
      const user = requireFullAccess(req);
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), prompts: listPrompts(user.id) }, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="omnihub-prompts-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      res.end(payload);
      return true;
    }
    const promptMatch = pathname.match(/^\/api\/prompts\/(\d+)$/);
    if (promptMatch && req.method === "PUT") {
      const user = requireFullAccess(req);
      const patch = await readBody(req);
      if (patch.title !== undefined && !patch.title) throw { status: 400, message: "标题不能为空" };
      if (patch.text !== undefined && !patch.text) throw { status: 400, message: "提示词内容不能为空" };
      if (patch.snsUrl !== undefined) {
        const sns = normalizeSnsUrl(patch.snsUrl);
        patch.snsUrlNormalized = sns.normalizedUrl;
        patch.snsType = sns.snsType;
      }
      if (!updatePrompt(user.id, Number(promptMatch[1]), patch)) throw { status: 404, message: "提示词不存在" };
      const manual = getManualPromptAsset(db, user.id, Number(promptMatch[1]));
      return send(res, 200, { ok: true, ...(manual ? { manualAssetId:manual.manualAssetId,
        libraryId:manual.id } : {}), snsUrlNormalized: patch.snsUrlNormalized, snsType: patch.snsType });
    }
    if (promptMatch && req.method === "DELETE") {
      const user = requireFullAccess(req);
      if (!deletePrompt(user.id, Number(promptMatch[1]))) throw { status: 404, message: "提示词不存在" };
      return send(res, 200, { ok: true });
    }

    /* ---------- 知识资产 ---------- */
    if (route === "GET /api/knowledge") {
      const user = requireFullAccess(req);
      return send(res, 200, listKnowledge(user.id));
    }
    if (route === "POST /api/knowledge") {
      const user = requireFullAccess(req);
      const data = await readBody(req);
      if (!String(data.title || "").trim() || !String(data.body || "").trim()) {
        throw { status: 400, message: "标题和正文不能为空" };
      }
      if (data.sourceUrl) data.sourceUrl = cleanUrl(data.sourceUrl);
      const id = addKnowledge(user.id, data);
      return send(res, 200, { ...getKnowledge(user.id, id), manualAssetId:id,
        libraryId:`manual-knowledge-${id}` });
    }
    const knowledgeMatch = pathname.match(/^\/api\/knowledge\/(\d+)$/);
    if (knowledgeMatch && req.method === "GET") {
      const user = requireFullAccess(req);
      const item = getKnowledge(user.id, Number(knowledgeMatch[1]));
      if (!item) throw { status: 404, message: "知识资产不存在" };
      const manual = getManualKnowledgeAsset(db, user.id, item.id);
      return send(res, 200, { ...item, ...(manual ? { manualAssetId:item.id,
        libraryId:`manual-knowledge-${item.id}` } : {}) });
    }
    if (knowledgeMatch && req.method === "PUT") {
      const user = requireFullAccess(req);
      const current = getKnowledge(user.id, Number(knowledgeMatch[1]));
      if (!current) throw { status: 404, message: "知识资产不存在" };
      const data = { ...current, ...await readBody(req) };
      if (!String(data.title || "").trim() || !String(data.body || "").trim()) {
        throw { status: 400, message: "标题和正文不能为空" };
      }
      if (data.sourceUrl) data.sourceUrl = cleanUrl(data.sourceUrl);
      updateKnowledge(user.id, Number(knowledgeMatch[1]), data);
      const item = getKnowledge(user.id, Number(knowledgeMatch[1]));
      const manual = getManualKnowledgeAsset(db, user.id, item.id);
      return send(res, 200, { ...item, ...(manual ? { manualAssetId:item.id,
        libraryId:`manual-knowledge-${item.id}` } : {}) });
    }
    if (knowledgeMatch && req.method === "DELETE") {
      const user = requireFullAccess(req);
      if (!deleteKnowledge(user.id, Number(knowledgeMatch[1]))) {
        throw { status: 404, message: "知识资产不存在" };
      }
      return send(res, 200, { ok: true });
    }

    /* ---------- 信息流（外部 RSS 代理，公共内容，游客可访问） ---------- */
    if (route === "GET /api/feed/sources") {
      return send(res, 200, listFeedSources());
    }
    const feedMatch = pathname.match(/^\/api\/feed\/([a-z0-9_-]+)$/);
    if (feedMatch && req.method === "GET") {
      return send(res, 200, await fetchFeed(feedMatch[1]));
    }

    /* ---------- 工具箱：PDF 压缩（内部功能，白名单可用） ---------- */
    if (route === "POST /api/tools/pdf-compress") {
      requireFullAccess(req);
      return await createPdfCompressionJob(req, res);
    }
    const pdfJobMatch = pathname.match(/^\/api\/tools\/pdf-compress\/([0-9a-f-]+)$/);
    if (pdfJobMatch && req.method === "GET") {
      requireFullAccess(req);
      return getPdfCompressionJob(res, pdfJobMatch[1]);
    }
    const pdfDownloadMatch = pathname.match(/^\/api\/tools\/pdf-compress\/([0-9a-f-]+)\/download$/);
    if (pdfDownloadMatch && req.method === "GET") {
      requireFullAccess(req);
      return await downloadPdfCompressionJob(res, pdfDownloadMatch[1]);
    }

    /* ---------- AI 配置与对话 ---------- */
    if (route === 'GET /api/ai/connections') {
      const user=requirePersonalUser(req);
      return send(res,200,aiSettings(user.id),{'Cache-Control':'no-store'});
    }
    if (route === 'POST /api/ai/connections') {
      const user=requirePersonalUser(req,true);
      return send(res,201,aiConnections.save(user.id,await readBody(req)),{'Cache-Control':'no-store'});
    }
    if (route === 'PUT /api/ai/routes') {
      const user=requirePersonalUser(req,true);
      const body=await readBody(req);
      aiConnections.assign(user.id,body.purpose,body.connectionId);
      return send(res,200,aiSettings(user.id),{'Cache-Control':'no-store'});
    }
    const aiConnectionMatch=pathname.match(/^\/api\/ai\/connections\/([a-zA-Z0-9-]+)(?:\/(test|models))?$/);
    if (aiConnectionMatch) {
      const user=requirePersonalUser(req,req.method!=='GET');
      const [,id,action]=aiConnectionMatch;
      if (!aiConnections.get(user.id,id)) throw {status:404,message:'连接不存在'};
      if (!action && req.method==='PUT') return send(res,200,aiConnections.save(user.id,await readBody(req),id),{'Cache-Control':'no-store'});
      if (!action && req.method==='DELETE') {aiConnections.remove(user.id,id);return send(res,200,{ok:true});}
      if (action==='test' && req.method==='POST') return send(res,200,await testAiConnection(user.id,id),{'Cache-Control':'no-store'});
      if (action==='models' && req.method==='POST') return send(res,200,{models:await withAiSlot(user.id,()=>aiProvider.models(aiConnections.get(user.id,id)))},{'Cache-Control':'no-store'});
      throw {status:405,message:'请求方式不正确'};
    }
    if (route === "GET /api/ai-config") {
      const user = requirePersonalUser(req);
      const config = aiConnections.selected(user.id);
      return send(res, 200, config
        ? { baseUrl: config.base_url, model: config.model, apiKeyMasked: '已保存', hasKey: config.test_state==='ready' }
        : { baseUrl: "", model: "", apiKeyMasked: "", hasKey: false },{'Cache-Control':'no-store'});
    }
    if (route === "PUT /api/ai-config") {
      const user = requirePersonalUser(req,true);
      const { baseUrl, apiKey, model } = await readBody(req);
      if (!baseUrl || !model) throw { status: 400, message: "接口地址和模型名不能为空" };
      const existing = aiConnections.selected(user.id);
      // 留空 apiKey 表示沿用已保存的 Key（界面里显示的是掩码）
      const finalKey = apiKey || (existing ? existing.api_key : "");
      if (!finalKey) throw { status: 400, message: "请填写 API Key" };
      const saved=aiConnections.save(user.id,{name:existing?.name || '文字服务',provider:existing?.provider || 'custom',protocol:existing?.protocol || 'chat-completions',
        baseUrl,apiKey:apiKey || '',model,revision:existing?.revision},existing?.id);
      return send(res, 200, { ok: true, connectionId:saved.id, requiresTest:true });
    }
    if (route === "POST /api/ai/chat") {
      const user = requirePersonalUser(req,true);
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) throw { status: 400, message: "消息不能为空" };
      const result = await chatWithAi(user.id, messages);
      return send(res, 200, result);
    }
    if (route === "POST /api/ai/chat/stream") {
      const user = requirePersonalUser(req,true);
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) throw { status: 400, message: "消息不能为空" };
      await streamChatToClient(user.id, messages, res);
      return true;
    }

    throw { status: 404, message: "接口不存在" };
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "服务器开小差了";
    if (status === 500) console.error("[api]", err);
    send(res, status, { error: message });
  }
  return true;
}

/* ---------- 知识库正文搜索 ---------- */
const KNOWLEDGE_SEARCH_MAX_QUERY = 120;
const KNOWLEDGE_SEARCH_MAX_RESULTS = 200;

/** Markdown/citation noise removed so body matches and snippets read like the article. */
function knowledgeSearchPlain(value) {
  return String(value || "")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[(?:[A-Z]:[^\]\s]+)\]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function knowledgeSearchSnippet(text, index, length) {
  const start = Math.max(0, index - 32);
  const end = Math.min(text.length, index + length + 72);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Bulk body lookup for authorised ids only — one query per table, never per article. */
function knowledgeSearchBodies(sql, userId, ids) {
  const list = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!list.length) return new Map();
  return new Map(db.prepare(sql).all(userId, JSON.stringify(list)).map((row) => [Number(row.id), row.body || ""]));
}

/**
 * Searches exactly the items GET /api/knowledge-library would list for this owner/scope and
 * returns ids plus a short snippet. Full bodies never leave the server through this route.
 */
function searchKnowledgeLibrary(ownerId, query, { privateAccess = false, includeManual = false } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const publicOnly = !privateAccess;
  const manualAll = listManualKnowledgeAssets(db, ownerId);
  const manualIds = new Set(manualAll.map((item) => item.manualAssetId));
  const candidates = [];
  for (const row of libraryCuration.methods(ownerId, { publicOnly })) {
    candidates.push({ item: row, body: row.body, extra: row.promptText });
  }
  const generated = contentStore.knowledge(ownerId, { publicOnly });
  const archived = sourceArticles.list(ownerId, { privateAccess, excludeSourceIds: generated.map((row) => row.sourceInboxId) });
  const articles = listKnowledgeArticles(ownerId, { publicOnly }).filter((item) => !manualIds.has(Number(item.id)));
  const manual = includeManual ? manualAll : [];
  const archiveBodies = knowledgeSearchBodies(
    "SELECT id, json_extract(metrics,'$.article.body') AS body FROM inbox WHERE user_id=? AND id IN (SELECT value FROM json_each(?))",
    ownerId, archived.map((row) => Number(row.sourceInboxId)));
  const knowledgeBodies = knowledgeSearchBodies(
    "SELECT id, body FROM knowledge WHERE user_id=? AND id IN (SELECT value FROM json_each(?))",
    ownerId, [...articles.map((row) => Number(row.id)), ...manual.map((row) => Number(row.manualAssetId))]);
  for (const row of articles) candidates.push({ item: row, body: knowledgeBodies.get(Number(row.id)) });
  for (const row of generated) candidates.push({ item: row, body: row.body });
  for (const row of archived) candidates.push({ item: row, body: archiveBodies.get(Number(row.sourceInboxId)) });
  for (const row of manual) candidates.push({ item: row, body: knowledgeBodies.get(Number(row.manualAssetId)) });

  const results = [];
  let total = 0;
  for (const { item, body, extra } of candidates) {
    const fields = [item.title, item.summary, Array.isArray(item.tags) ? item.tags.join(" ") : item.tags, knowledgeSearchPlain(body), knowledgeSearchPlain(extra)];
    let snippet = null;
    for (const field of fields) {
      const text = String(field || "");
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) { snippet = knowledgeSearchSnippet(text, index, needle.length); break; }
    }
    if (snippet == null) continue;
    total += 1;
    if (results.length < KNOWLEDGE_SEARCH_MAX_RESULTS) results.push({ id: item.id, snippet });
  }
  return { query, results, total, truncated: total > results.length };
}
