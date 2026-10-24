import { xImageUrl } from './x-cos-archive.js';
import { promptPostUrl } from './prompt-media.js';

function imageUrl(value) {
  if (typeof value === 'string' && /^\/api\/x-media\/[1-9]\d*\/[a-f0-9]{64}$/.test(value)) return value;
  return xImageUrl(value);
}

export function publicPromptMedia(media) {
  if (!Array.isArray(media)) return [];
  return media.flatMap(item => {
    if (!item || !['photo', 'video', 'animated_gif'].includes(item.type)) return [];
    const preview = imageUrl(item.type === 'photo' ? item.url : item.preview_image_url);
    if (!preview) return [];
    const result = { type:item.type, ...(item.type === 'photo' ? {url:preview} : {preview_image_url:preview}) };
    if (promptPostUrl(item.sourceUrl)) {
      result.sourceUrl = promptPostUrl(item.sourceUrl);
      if (['original','reply_parent','quoted'].includes(item.sourceRelation)) result.sourceRelation = item.sourceRelation;
    }
    if (typeof item.alt_text === 'string') result.alt_text = item.alt_text.slice(0, 2000);
    if (item.type !== 'photo') {
      const variants = Array.isArray(item.variants) ? item.variants : [];
      result.video_url = variants.filter(variant => variant?.content_type === 'video/mp4').map(variant => {
        try {
          const url = new URL(variant.url);
          if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com' || url.port || url.username || url.password || !url.pathname.endsWith('.mp4')) return null;
          url.hash = '';
          return {url:url.href, bitrate:Number(variant.bitrate) || 0};
        } catch { return null; }
      }).filter(Boolean).sort((a,b) => Number(b.url === item.verifiedVideoUrl)-Number(a.url === item.verifiedVideoUrl) || b.bitrate-a.bitrate)[0]?.url || '';
    }
    return [result];
  });
}

// Published previews are public; raw captures and internal fields remain private.
export function publicPromptView(item) {
  const fields = ['id', 'title', 'text', 'category', 'tags', 'kind', 'summary', 'sourceInboxId', 'sourceAuthor',
    'status', 'rating', 'facets', 'updatedAt', 'curated', 'pipeline', 'methodId'];
  const result = Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]]));
  let sourceUrl = '';
  try {
    const url = new URL(item.sourceUrl);
    if (['https:', 'http:'].includes(url.protocol) && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase()) &&
        /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(url.pathname)) sourceUrl = `https://x.com${url.pathname.replace(/\/$/, '')}`;
  } catch { /* A malformed source link is not a public citation. */ }
  return { ...result, sourceUrl, media:publicPromptMedia(item.media), mediaPrivate:false };
}
