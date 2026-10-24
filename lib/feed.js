/// 信息流来源层 —— 服务器代理拉取外部 RSS，解析为统一条目结构
/// 来源是后端写死的白名单（防 SSRF）；前端只传来源 id，不接受任意 URL
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(process.env.OMNIHUB_DATA_DIR || path.join(ROOT_DIR, "data"), "feed-cache");
mkdirSync(CACHE_DIR, { recursive: true });

/** 信息流来源白名单。新增来源只需在此加一项（category 用于前端分类区分）
 *  type "aihot" 走 AI HOT 富 API（带精选分/分类/时间）；其余走通用 RSS */
export const FEED_SOURCES = [
  {
    id: "aihot",
    name: "AI 资讯",
    category: "AI",
    desc: "AI HOT · 每日精选 AI 行业动态",
    type: "aihot",
    api: "https://aihot.news/api/v1/items?mode=selected&window=7d&by=published&limit=40",
    rich: true,
    home: "https://aihot.news/",
  },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // id -> { time, items, etag }
const retryAfter = new Map();
const AIHOT_CATEGORIES = {
  "ai-models": "AI 模型",
  "ai-products": "AI 产品",
  industry: "行业动态",
  paper: "论文",
  tip: "教程",
  opinion: "观点",
};

/** 把 RFC822 时间转成「X 分钟前 / 小时前 / 天前」 */
function relativeTime(pubDate) {
  const date = new Date(pubDate);
  if (isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function stripCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

/** Normalize the public v1 contract; image and discussion fields are not exposed by this API. */
function parseAihot(json) {
  if (json?.schemaVersion !== 1 || !Array.isArray(json.items)) throw new Error("Invalid AIHOT v1 response");
  return json.items
    .filter((it) => it && typeof it.title === "string" && it.title.trim())
    .map((it) => {
      const publishedAt = it.publishedAt || it.discoveredAt || "";
      return {
        title: it.title,
        titleEn: it.originalTitle && it.originalTitle !== it.title ? it.originalTitle : "",
        url: it.links?.original || it.links?.aihot || "",
        summary: it.summary || "",
        origin: it.source?.name || "",
        avatar: "",
        authorName: "",
        images: [],
        tags: it.category ? [Object.hasOwn(AIHOT_CATEGORIES, it.category) ? AIHOT_CATEGORIES[it.category] : it.category] : [],
        score: typeof it.score === "number" && Number.isFinite(it.score) ? it.score : null,
        selected: it.selected === true,
        reason: it.reason || "",
        duplicateCount: 0,
        publishedAt,
        discoveredAt: it.discoveredAt || "",
        attribution: it.attribution || { name: "AIHOT", url: it.links?.aihot || "https://aihot.news/" },
        time: relativeTime(publishedAt),
      };
    });
}

function currentItems(items) {
  return items.map((item) => ({ ...item, time: relativeTime(item.publishedAt) }));
}

/** 极简 RSS 解析（无第三方依赖）：提取每个 <item> 的字段 */
function parseRss(xml, source) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) && items.length < 40) {
    const block = match[1];
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? stripCdata(m[1]) : "";
    };
    const title = pick("title");
    if (!title) continue;
    // author 形如 "noreply@... (来源平台名)"，提取括号里的来源平台
    const author = pick("author");
    const sourceMatch = author.match(/\(([^)]+)\)/);
    items.push({
      title,
      url: pick("link"),
      summary: pick("description"),
      publishedAt: pick("pubDate"),
      time: relativeTime(pick("pubDate")),
      origin: sourceMatch ? sourceMatch[1] : source.name,
    });
  }
  return items;
}

function diskCachePath(id) {
  return path.join(CACHE_DIR, `${id}.json`);
}

/** 读磁盘缓存（拉取失败时降级用，断网/源故障仍能看上次内容） */
function readDiskCache(id) {
  try {
    const file = diskCachePath(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

function cachedOrUnavailable(source, cached) {
  const items = cached?.items || readDiskCache(source.id);
  if (Array.isArray(items)) return currentItems(items);
  throw { status: 502, message: `无法连接信息源「${source.name}」，请稍后重试` };
}

/** 拉取某来源的最新条目；内存缓存命中直接返回，拉取失败时降级到磁盘缓存 */
export async function fetchFeed(sourceId) {
  const source = FEED_SOURCES.find((s) => s.id === sourceId);
  if (!source) throw { status: 404, message: "未知的信息源" };

  const cached = cache.get(sourceId);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return currentItems(cached.items);
  if (Date.now() < (retryAfter.get(sourceId) || 0)) return cachedOrUnavailable(source, cached);

  try {
    const isApi = source.type === "aihot";
    const url = isApi ? source.api : source.rss;
    const accept = isApi ? "application/json" : "application/rss+xml, application/xml, text/xml";
    const headers = {
      "User-Agent": "OmniHub/1.0",
      "Accept": accept,
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 304 && cached) {
      retryAfter.delete(sourceId);
      cached.time = Date.now();
      return currentItems(cached.items);
    }
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        const value = response.headers.get("retry-after");
        const delay = /^\d+$/.test(value || "") ? Number(value) * 1000 : Date.parse(value || "") - Date.now();
        retryAfter.set(sourceId, Date.now() + Math.max(CACHE_TTL_MS, Number.isFinite(delay) ? delay : 0));
      }
      throw new Error(`status ${response.status}`);
    }
    const items = isApi ? parseAihot(await response.json()) : parseRss(await response.text(), source);
    if (!isApi && items.length === 0) throw new Error("empty feed");
    retryAfter.delete(sourceId);
    cache.set(sourceId, { time: Date.now(), items, etag: response.headers.get("etag") });
    try { writeFileSync(diskCachePath(sourceId), JSON.stringify(items)); } catch (err) { /* 缓存写入失败不影响主流程 */ }
    return items;
  } catch (err) {
    // 拉取失败：降级到磁盘缓存（如果有）
    return cachedOrUnavailable(source, cached);
  }
}

/** 给前端的来源列表（不暴露内部地址；rich 标记是否带精选分/分类等富展示） */
export function listFeedSources() {
  return FEED_SOURCES.map(({ id, name, category, desc, home, rich }) => ({ id, name, category, desc, home, rich: Boolean(rich) }));
}
