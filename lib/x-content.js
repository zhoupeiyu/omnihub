const URL_ONLY_RE = /^(?:https?:\/\/\S+\s*)+$/i;

function hasMedia(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "string") return Boolean(value);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    return Boolean(value.trim());
  }
}

/** A link alone is a pointer to content, not a readable X bookmark. */
export function isContentlessXBookmark(item) {
  if (item.source !== "x" || hasMedia(item.media)) return false;
  try {
    const metrics = typeof item.metrics === 'string' ? JSON.parse(item.metrics) : item.metrics;
    if (typeof metrics?.article?.body === 'string' && metrics.article.body.trim()) return false;
    const recovered = metrics?.recoveredPost?.text;
    if (typeof recovered === 'string' && recovered.trim() && !URL_ONLY_RE.test(recovered.trim())) return false;
  } catch { /* A malformed supplement does not turn a link into readable content. */ }
  const content = String(item.content || "").trim();
  return !content || URL_ONLY_RE.test(content);
}
