// Initial owner-only suggestions for the existing collection. zane can correct these one by one.
// New captures remain unreviewed until zane explicitly publishes them.
const PRIVATE_CONTEXT = /健身|锻炼|减脂|增肌|瑜伽|普拉提|深蹲|俯卧撑|凯格尔|骨盆底肌|腹肌|胸肌|撸铁|体操|性压抑|性欲|性爱|性交|色情|涉黄|成人视频|成人内容|裸照|裸体|私处|擦边|金枪不倒|操服|露点|黄色网站|性感|情趣|比基尼|内衣|乳沟|美腿|翘臀|巨乳|艳照|女优|ケーゲル|エロ|セックス|nsfw|porn|onlyfans|sexy|hentai|erotica|lingerie|bikini|\b(?:nude|naked|kegel|fitness|workout|gym)\b/i;

function json(value, fallback) {
  try { return JSON.parse(value || "") || fallback; }
  catch { return fallback; }
}

export function needsOwnerOnlyXBookmark(row) {
  const extract = json(row.aiExtract, {});
  if (row.aiType === "prompt" || extract.xOrganization?.assetType === "prompt") return false;
  const media = json(row.media, []);
  const metrics = json(row.metrics, {});
  const text = [row.title, row.content, row.aiSummary, row.author, row.url, row.links,
    extract.xDigest?.summary, metrics.quotedTweet?.full_text,
    ...(Array.isArray(media) ? media.map((item) => item.alt_text || "") : [])].join(" ");
  return PRIVATE_CONTEXT.test(text);
}

export function isSafePublicXBookmark(row) {
  if (row.source !== "x" || row.status !== "pending" || row.visibility !== "unreviewed") return false;
  const extract = json(row.aiExtract, {});
  if (!extract.xOrganization?.topic || extract.xOrganization.contentIncomplete) return false;
  return !needsOwnerOnlyXBookmark(row);
}
