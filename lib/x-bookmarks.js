const MAX_BOOKMARKS = 500;

function parseJsonValues(text) {
  const values = [];
  let pending = "";
  for (const line of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    pending += line;
    try {
      values.push(JSON.parse(pending));
      pending = "";
    } catch { /* A raw X page or one exported post may span several lines. */ }
  }
  if (pending || values.length === 0) throw new Error("X 导出文件不是完整的 JSON 数据");
  return values;
}

function httpUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

function normalizedPost(post, users = new Map(), media = new Map()) {
  const id = String(post?.id || post?.externalId || "").trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error("X 导出包含无效的帖子 ID");
  const author = post.author && typeof post.author === "object"
    ? post.author : users.get(String(post.author_id)) || {};
  const username = /^[A-Za-z0-9_]{1,15}$/.test(author.username || "") ? author.username : "i";
  const content = String(post.note_post?.text || post.note_tweet?.text || post.content || post.text || "").trim();
  const mediaItems = Array.isArray(post.media) ? post.media
    : (post.attachments?.media_keys || []).map((key) => media.get(String(key)) || { media_key: key });
  const links = (post.links || [...(post.entities?.urls || []), ...(post.note_post?.entities?.urls || [])])
    .map((entry) => typeof entry === "string" ? entry : entry.expanded_url || entry.url)
    .map(httpUrl)
    .filter((url, index, all) => url && all.indexOf(url) === index);
  const existingUrl = httpUrl(post.url);
  const organization = post.organization && typeof post.organization === "object" ? post.organization : null;
  const organizedType = ["prompt", "resource", "knowledge"].includes(organization?.assetType)
    ? organization.assetType : "";
  return {
    source: "x",
    externalId: id,
    title: content.split(/\r?\n/)[0].slice(0, 160) || `X 帖子 ${id}`,
    url: existingUrl && /^(x|twitter)\.com$/i.test(new URL(existingUrl).hostname)
      ? existingUrl : `https://x.com/${username}/status/${id}`,
    author: typeof post.author === "string" ? post.author : username === "i" ? "" : `@${username}`,
    content,
    media: mediaItems,
    links,
    metrics: {
      ...(post.metrics || post.public_metrics || {}),
      authorId: String(post.author_id || post.metrics?.authorId || author.id || ""),
      postCreatedAt: post.created_at || post.metrics?.postCreatedAt || "",
      lang: post.lang || post.metrics?.lang || "",
      referencedPosts: post.referenced_posts || post.referenced_tweets || post.metrics?.referencedPosts || [],
    },
    ...(organization ? {
      aiType: organizedType,
      aiConfidence: Number(organization.assetConfidence || 0),
      aiExtract: { xOrganization: organization },
    } : {}),
  };
}

/** Read xurl's raw page export or normalized posts without contacting X. */
export function parseXBookmarksExport(text, { maxBookmarks = MAX_BOOKMARKS } = {}) {
  const posts = new Map();
  for (const value of parseJsonValues(text)) {
    const pages = Array.isArray(value) ? value : [value];
    for (const page of pages) {
      if (!page || typeof page !== "object") throw new Error("X 导出包含无效记录");
      const isRawPage = Array.isArray(page.data);
      const users = new Map((page.includes?.users || []).map((user) => [String(user.id), user]));
      const media = new Map((page.includes?.media || []).map((item) => [String(item.media_key), item]));
      const rows = isRawPage ? page.data : [page];
      for (const row of rows) {
        const item = normalizedPost(row, users, media);
        if (!posts.has(item.externalId)) posts.set(item.externalId, item);
        if (posts.size > maxBookmarks) throw new Error(`单次最多导入 ${maxBookmarks} 条 X 收藏`);
      }
    }
  }
  if (posts.size === 0) throw new Error("X 导出文件中没有帖子");
  return [...posts.values()];
}

/** Accept a classified batch while retaining its actual capture coverage. */
export function parseOrganizedXImport(text, { allowPartial = false, maxBookmarks = MAX_BOOKMARKS } = {}) {
  const items = parseXBookmarksExport(text, { maxBookmarks });
  const coverages = new Set(items.map((item) => item.aiExtract?.xOrganization?.coverage));
  if (coverages.size !== 1) throw new Error("同一批 X 收藏的采集范围不一致");
  const [coverage] = coverages;
  if (!["complete", "partial_ui_scan", "partial_xarchive_scan"].includes(coverage)) {
    throw new Error("请先导入已分类的 X 收藏，不接受历史快照");
  }
  if (coverage !== "complete" && !allowPartial) {
    throw new Error("这批收藏尚未证明全量采集，请明确选择作为部分数据导入");
  }
  if (!items.every((item) => {
    const organization = item.aiExtract?.xOrganization;
    return organization?.groupId && organization.assetType && organization.topic;
  })) throw new Error("请先完成 X 收藏分类整理，再导入整理结果");
  return { items, coverage };
}
