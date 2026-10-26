/** Compact, complete inbox index used by list screens. Full source material stays in /api/inbox/:id. */
function parse(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
function text(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function articleLink(row, links) {
  const candidates = [...links.map(item => typeof item === 'string' ? item : item?.url), String(row.content || '').match(/https?:\/\/[^\s]+/g) || []].flat();
  return candidates.find(url => /(?:x|twitter)\.com\/i\/article\//i.test(String(url))) || '';
}
function playableVideo(item) {
  const candidates = [item?.verifiedVideoUrl, item?.video_url, ...(Array.isArray(item?.variants) ? item.variants.filter(candidate => candidate?.content_type === 'video/mp4').sort((a,b) => (Number(b.bitrate)||0)-(Number(a.bitrate)||0)).map(candidate => candidate.url) : [])];
  for (const value of candidates) {
    try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === 'video.twimg.com' && !url.username && !url.password && url.pathname.endsWith('.mp4')) { url.hash = ''; return url.toString(); } } catch {}
  }
  return '';
}
function compactMedia(value) {
  const list = Array.isArray(parse(value, [])) ? parse(value, []) : [];
  return list.slice(0, 12).map(item => {
    const video = ['video', 'animated_gif'].includes(item?.type);
    const url = item?.url || item?.media_url_https || item?.preview_image_url || '';
    const compact = {};
    if (item?.type) compact.type = item.type;
    if (url) compact.url = url;
    if (video && item?.preview_image_url && item.preview_image_url !== url) compact.preview_image_url = item.preview_image_url;
    const playable = video ? playableVideo(item) : '';
    if (playable) compact.verifiedVideoUrl = playable;
    if (item?.alt_text) compact.alt_text = text(item.alt_text, 120);
    return compact;
  }).filter(item => item.url);
}
function compactMetrics(value) {
  const source = parse(value, {}) || {};
  const picked = {};
  for (const key of ['likes', 'retweets', 'replies', 'bookmarks', 'quotes', 'views', 'postCreatedAt']) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}
function compactOrganization(value) {
  const source = value && typeof value === 'object' ? value : {};
  const picked = {};
  for (const key of ['topic', 'assetType', 'groupId', 'groupTitle', 'coverage', 'contentIncomplete']) {
    if (source[key] !== undefined && source[key] !== '') picked[key] = key === 'groupTitle' ? text(source[key], 120) : source[key];
  }
  return picked;
}
function compactDigest(value) {
  const source = value && typeof value === 'object' ? value : {};
  const picked = {};
  if (source.summary) picked.summary = text(source.summary, 180);
  if (source.status) picked.status = source.status;
  return picked;
}
export function compactInboxListRow(row) {
  const metrics = parse(row.metrics, {}) || {};
  const rawLinks = Array.isArray(parse(row.links, [])) ? parse(row.links, []) : [];
  const article = articleLink(row, rawLinks);
  const firstLink = rawLinks.map(link => typeof link === 'string' ? link : link?.url).find(Boolean) || '';
  const links = firstLink ? [String(firstLink).slice(0, 600)] : [];
  const extract = parse(row.aiExtract, {}) || {};
  const safeExtract = {};
  const organization = compactOrganization(extract.xOrganization);
  const digest = compactDigest(extract.xDigest);
  if (Object.keys(organization).length) safeExtract.xOrganization = organization;
  if (Object.keys(digest).length) safeExtract.xDigest = digest;
  return {
    id: row.id, source: row.source, externalId: row.externalId, title: text(row.title, 500),
    url: row.url || '', author: text(row.author, 240), contentPreview: text(row.content, 180),
    media: JSON.stringify(compactMedia(row.media)), links: JSON.stringify(links), metrics: JSON.stringify(compactMetrics(row.metrics)),
    hasArticle: Boolean(metrics?.article?.body && String(metrics.article.body).trim()), articleLink: article,
    aiType: row.aiType || '', aiConfidence: row.aiConfidence, aiSummary: text(row.aiSummary, 160),
    aiExtract: JSON.stringify(safeExtract), status: row.status, visibility: row.visibility,
    dispatchedTo: row.dispatchedTo || '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    subjectCollections: row.subjectCollections || [], isListItem: true,
  };
}
export function inboxSearchMatches(row, query, { terms = false } = {}) {
  const needle = String(query || '').toLocaleLowerCase().trim();
  if (!needle) return true;
  const metrics = parse(row.metrics, {}) || {};
  // Inbox historically matches the typed phrase as one substring. Keep that contract;
  // callers wanting token search (Chat) can opt in explicitly.
  const haystack = [row.title, row.author, row.content, row.url, row.aiSummary,
    metrics?.recoveredPost?.text, metrics?.article?.plainText, metrics?.article?.body].join('\n').toLocaleLowerCase();
  if (!terms) return haystack.includes(needle);
  return needle.split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}
