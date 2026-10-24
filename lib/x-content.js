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
  const content = String(item.content || "").trim();
  return !content || URL_ONLY_RE.test(content);
}
