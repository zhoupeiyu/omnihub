/// 信息流来源层 —— 服务器代理拉取外部 RSS，解析为统一条目结构
/// 来源是后端写死的白名单（防 SSRF）；前端只传来源 id，不接受任意 URL
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT_DIR, "data", "feed-cache");
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
    api: "https://aihot.virxact.com/api/public/feed",
    rich: true,
    home: "https://aihot.virxact.com/",
  },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // id -> { time, items }

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

/** 解析 AI HOT 富 API（/api/public/feed）响应为统一条目
 *  保留：中文标题/摘要、精选标记、推荐理由、多标签、关联讨论数、来源、评分 */
function parseAihot(json) {
  const items = Array.isArray(json.items) ? json.items : [];
  return items
    .filter((it) => it && (it.titleZh || it.title))
    .map((it) => ({
      title: it.titleZh || it.title,
      titleEn: it.titleZh && it.title ? it.title : "",
      url: it.url || "",
      summary: it.summaryZh || it.summary || "",
      origin: (it.source && it.source.name) || "",
      tags: Array.isArray(it.aiTags) ? it.aiTags.map((t) => t.tag).filter(Boolean) : [],
      score: typeof it.finalScore === "number" ? it.finalScore
        : (typeof it.qualityScore === "number" ? it.qualityScore : null),
      selected: Boolean(it.aiSelected),
      reason: it.aiSelectedReason || "",
      duplicateCount: typeof it.duplicateCount === "number" ? it.duplicateCount : 0,
      publishedAt: it.publishedAt || "",
      time: relativeTime(it.publishedAt),
    }));
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

/** 拉取某来源的最新条目；内存缓存命中直接返回，拉取失败时降级到磁盘缓存 */
export async function fetchFeed(sourceId) {
  const source = FEED_SOURCES.find((s) => s.id === sourceId);
  if (!source) throw { status: 404, message: "未知的信息源" };

  const cached = cache.get(sourceId);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.items;

  try {
    const isApi = source.type === "aihot";
    const url = isApi ? source.api : source.rss;
    const accept = isApi ? "application/json" : "application/rss+xml, application/xml, text/xml";
    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": accept,
    };
    if (isApi) headers["Referer"] = source.home || "https://aihot.virxact.com/";
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const items = isApi ? parseAihot(await response.json()) : parseRss(await response.text(), source);
    if (items.length === 0) throw new Error("empty feed");
    cache.set(sourceId, { time: Date.now(), items });
    try { writeFileSync(diskCachePath(sourceId), JSON.stringify(items)); } catch (err) { /* 缓存写入失败不影响主流程 */ }
    return items;
  } catch (err) {
    // 拉取失败：降级到磁盘缓存（如果有）
    const fallback = readDiskCache(sourceId);
    if (fallback && fallback.length) return fallback;
    throw { status: 502, message: `无法连接信息源「${source.name}」，请稍后重试` };
  }
}

/** 给前端的来源列表（不暴露内部地址；rich 标记是否带精选分/分类等富展示） */
export function listFeedSources() {
  return FEED_SOURCES.map(({ id, name, category, desc, home, rich }) => ({ id, name, category, desc, home, rich: Boolean(rich) }));
}
