import { readFileSync } from 'node:fs';

const parsed = value => {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(result) ? result : []; }
  catch { return []; }
};

export function promptPostUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.port || url.username || url.password) return '';
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    return match ? `https://x.com/${match[1].toLowerCase()}/status/${match[2]}` : '';
  } catch { return ''; }
}

export function loadPromptMediaReview() {
  const record = JSON.parse(readFileSync(new URL('../content/prompt-media-reviewed.json', import.meta.url), 'utf8'));
  if (record.version !== 1 || !Array.isArray(record.items)) throw new Error('Invalid prompt media review');
  return new Map(record.items.map(item => [promptPostUrl(item.sourceUrl), item]));
}

export function createPromptMediaSourceLookup(db, userId) {
  const sources = new Map();
  const lookup = db.prepare("SELECT id,visibility,status FROM inbox WHERE user_id=? AND source='x' AND external_id=?");
  return url => {
    const id = promptPostUrl(url).split('/').at(-1);
    if (!id) return null;
    // Tweet identity survives handle changes and legacy permalink formats.
    if (!sources.has(id)) sources.set(id, lookup.get(userId, id) || null);
    return sources.get(id);
  };
}

// A read projection only: raw posts and editorial prompt text are never rewritten.
export function reviewedPromptMedia(item, records, { publicOnly = true, findSource = () => null, rewrite = (_id, media) => media } = {}) {
  const sourceUrl = promptPostUrl(item.sourceUrl);
  const record = sourceUrl && records.get(sourceUrl);
  if (!record || record.status !== 'checked') return rewrite(item.sourceInboxId, parsed(item.media));
  const media = [], seen = new Set();
  for (const post of record.posts) {
    const url = promptPostUrl(post.sourceUrl);
    if (!url || !['original', 'reply_parent', 'quoted'].includes(post.relation)) continue;
    const source = findSource(url);
    // A known source's current visibility always overrides the public audit snapshot.
    if (source && (source.status !== 'pending' || (publicOnly && source.visibility !== 'public'))) continue;
    for (const entry of rewrite(source?.id || (url === sourceUrl ? item.sourceInboxId : null), parsed(post.media))) {
      const key = `${entry.type}:${entry.type === 'photo' ? entry.url : entry.preview_image_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({ ...entry, sourceUrl:url, sourceRelation:post.relation });
    }
  }
  return media.length ? media : rewrite(item.sourceInboxId, parsed(item.media));
}
