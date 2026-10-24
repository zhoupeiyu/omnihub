import { createHash } from "node:crypto";

function postIdentity(permalink) {
  const url = new URL(permalink);
  if (!(["x.com", "twitter.com"].includes(url.hostname))) throw new Error("收藏链接不是 X 帖子");
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/.exec(url.pathname);
  if (!match) throw new Error("收藏链接缺少有效帖子 ID");
  return { username: match[1], id: match[2], url: `https://x.com/${match[1]}/status/${match[2]}` };
}

function uniqueUrls(values) {
  return [...new Set(values.filter((value) => {
    try { return ["https:", "http:"].includes(new URL(value).protocol); }
    catch { return false; }
  }))];
}

function uiMedia(urls) {
  return uniqueUrls(urls).flatMap((value) => {
    const url = new URL(value);
    if (url.hostname !== "pbs.twimg.com") return [];
    const mediaKey = `ui-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
    if (url.pathname.startsWith("/media/")) return [{ media_key: mediaKey, type: "photo", url: value }];
    if (/^\/(amplify_video_thumb|ext_tw_video_thumb)\//.test(url.pathname)) {
      return [{ media_key: mediaKey, type: "video", preview_image_url: value }];
    }
    return [];
  });
}

function mediaAddress(item) {
  const value = item.url || item.preview_image_url || "";
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch { return value; }
}

function articleCardText(raw) {
  const card = String(raw || "").split(/\n\s*Article\n/)[1];
  return card ? card.replace(/(?:\n\d+(?:\.\d+)?[KMB]?){3,5}\s*$/, "").trim() : "";
}

/** Normalize only posts observed in X's UI. Historical records enrich matching IDs, never add unseen posts. */
export function convertXUiScan(scan, historicalPosts = [], { expectedAccount = "" } = {}) {
  if (scan?.coverage !== "partial_ui_scan" || !Array.isArray(scan.rows) || !scan.rows.length) {
    throw new Error("需要带 partial_ui_scan 标记的 X 页面快照");
  }
  if (expectedAccount && scan.account !== expectedAccount) throw new Error("X 快照账号不匹配");
  const oldById = new Map(historicalPosts.map((post) => [post.externalId, post]));
  const posts = new Map();
  let enriched = 0;
  for (const row of scan.rows) {
    const identity = postIdentity(row.permalink);
    if (posts.has(identity.id)) continue;
    const old = oldById.get(identity.id);
    const observedText = String(row.text || "").trim();
    const articleText = observedText ? "" : articleCardText(row.raw);
    const content = old?.content || observedText || articleText;
    const textTruncated = !old && (!row.expanded || Boolean(articleText) || !content);
    const media = [...(old?.media || [])];
    const mediaAddresses = new Set(media.map(mediaAddress));
    for (const item of uiMedia(row.media || [])) {
      const address = mediaAddress(item);
      if (!mediaAddresses.has(address)) { media.push(item); mediaAddresses.add(address); }
    }
    const links = uniqueUrls([...(old?.links || []), ...(row.links || [])]);
    posts.set(identity.id, {
      source: "x", externalId: identity.id,
      title: content.split(/\r?\n/)[0].slice(0, 160) || `X 帖子 ${identity.id}`,
      url: identity.url, author: old?.author || `@${identity.username}`,
      content, media, links,
      metrics: {
        ...(old?.metrics || {}),
        postCreatedAt: row.date || old?.metrics?.postCreatedAt || "",
        uiTextExpanded: Boolean(row.expanded),
        uiTextTruncated: textTruncated,
        uiCardType: articleText ? "article" : "post",
        contentSource: old ? "historical_api_export" : "browser_ui",
        uiObservedText: observedText,
        uiRawText: String(row.raw || ""),
      },
    });
    if (old) enriched++;
  }
  const values = [...posts.values()];
  return {
    posts: values,
    summary: {
      coverage: "partial_ui_scan", account: scan.account || "", observed: values.length,
      enrichedFromHistorical: enriched,
      historicalOnly: historicalPosts.length - enriched,
      textTruncated: values.filter((post) => post.metrics.uiTextTruncated).length,
      withMedia: values.filter((post) => post.media.length).length,
      mediaCount: values.reduce((total, post) => total + post.media.length, 0),
    },
    historicalOnly: historicalPosts.filter((post) => !posts.has(post.externalId)),
  };
}
