function httpUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch { return ""; }
}

/** Convert one official X API page into immutable inbox capture records. */
export function normalizeBookmarkPage(page) {
  if (!page || typeof page !== "object" || !page.meta || typeof page.meta !== "object") {
    throw new Error("X 收藏分页格式不完整");
  }
  const rows = page.data === undefined ? [] : page.data;
  if (!Array.isArray(rows)) throw new Error("X 收藏分页 data 格式无效");
  const users = new Map((page.includes?.users || []).map((user) => [String(user.id), user]));
  const media = new Map((page.includes?.media || []).map((item) => [String(item.media_key), item]));
  return rows.map((post) => {
    const externalId = String(post?.id || "").trim();
    if (!/^\d{1,20}$/.test(externalId)) throw new Error("X 返回了无效帖子 ID");
    const author = users.get(String(post.author_id)) || {};
    const username = /^[A-Za-z0-9_]{1,15}$/.test(author.username || "") ? author.username : "i";
    const content = String(post.note_post?.text || post.note_tweet?.text || post.text || "").trim();
    const links = [...(post.entities?.urls || []), ...(post.note_post?.entities?.urls || [])]
      .map((item) => httpUrl(item?.expanded_url || item?.url || item))
      .filter((value, index, all) => value && all.indexOf(value) === index);
    return {
      source: "x",
      externalId,
      title: content.split(/\r?\n/)[0].slice(0, 160) || `X 帖子 ${externalId}`,
      url: `https://x.com/${username}/status/${externalId}`,
      author: username === "i" ? "" : `@${username}`,
      content,
      media: (post.attachments?.media_keys || []).map((key) => media.get(String(key)) || { media_key: key }),
      links,
      metrics: {
        ...(post.public_metrics || {}), authorId: String(post.author_id || ""),
        postCreatedAt: post.created_at || "", lang: post.lang || "",
        referencedPosts: post.referenced_posts || [],
      },
    };
  });
}
