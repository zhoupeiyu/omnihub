import { createHash } from 'node:crypto';
import { isContentlessXBookmark } from './x-content.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const historyDigest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const parse = (value, array = false) => {
  const result = JSON.parse(value);
  if (array ? !Array.isArray(result) : !object(result)) throw new Error('Invalid stored JSON');
  return result;
};
const mediaKey = item => {
  try { return `${item.type}:${new URL(item.capturedPreviewUrl || item.capturedUrl || item.preview_image_url || item.url).pathname}`; }
  catch { return JSON.stringify(item); }
};

export function mergeHistoryMedia(saved, incoming) {
  const result = structuredClone(saved);
  for (const media of incoming) {
    const index = result.findIndex(item => mediaKey(item) === mediaKey(media));
    if (index < 0) result.push(media);
    else {
      const old = result[index];
      result[index] = { ...media, ...old, variants:[...(old.variants || []),
        ...(media.variants || []).filter(item => !(old.variants || []).some(previous => previous.url === item.url))] };
      if (media.verifiedPreviewUrl) {
        result[index].capturedPreviewUrl=old.capturedPreviewUrl || old.preview_image_url || old.url;
        result[index].preview_image_url=media.verifiedPreviewUrl;
        if (old.type==='photo') { result[index].capturedUrl=old.capturedUrl || old.url; result[index].url=media.verifiedPreviewUrl; }
      }
    }
  }
  return result;
}

// Original captures and editorial decisions survive source recovery.
export function repairHistoryRow(old, source, batch) {
  const savedMetrics = parse(old.metrics), extract = parse(old.ai_extract);
  const savedExtract=structuredClone(extract);
  if (savedMetrics.sourceAudit?.batch===batch || savedMetrics.recoveryPrevious?.[batch] || extract.xRecoveryPrevious?.[batch]) throw new Error('History batch already applied');
  const metrics = { ...savedMetrics };
  for (const key of ['article','recoveredPost','recoveredQuote','replyParent','promptReply','relatedReplies','visualReview','sourceAudit']) {
    const incoming=source.metrics[key], saved=savedMetrics[key];
    if (!incoming) continue;
    if (saved && historyDigest(saved)!==historyDigest(incoming)) {
      metrics.recoveryPrevious={...metrics.recoveryPrevious,[batch]:{...metrics.recoveryPrevious?.[batch],[key]:saved}};
    }
    // A partial fetch must never replace a longer saved original.
    if ((key==='article' && (saved?.body?.length || 0)>(incoming.body?.length || 0)) ||
        (key==='recoveredPost' && (saved?.text?.length || 0)>(incoming.text?.length || 0))) continue;
    metrics[key]=incoming;
  }
  const media=JSON.stringify(mergeHistoryMedia(parse(old.media,true),source.media));
  const organization = { ...(extract.xOrganization || source.organization || {}) };
  const readable = source.hasRecoveredContent === true && !isContentlessXBookmark({...old,media,metrics});
  const published=old.visibility==='public';
  if (source.review && published) throw new Error('Cannot reclassify published sources');
  if (!organization.assetType && source.metrics.article && !published) organization.assetType = 'knowledge';
  if (readable && organization.contentIncomplete) organization.contentIncomplete = false;
  if (source.review) {
    extract.xReviewPrevious={...extract.xReviewPrevious,[batch]:{title:old.title,ai_type:old.ai_type,organization:extract.xOrganization || null}};
    Object.assign(organization, { assetType:source.review.type, topic:source.review.topic,
    groupTitle:source.review.title, review:{ method:'source_and_image_review', batch } });
  }
  if (Object.keys(organization).length) extract.xOrganization = organization;
  // Only the documented automatic contentless filter is reversible here.
  const restore = !published && old.status === 'ignored' && extract.xOmission?.reason === 'no_readable_content' && readable;
  if (restore) { extract.xOmissionRestored = { ...extract.xOmission, batch }; delete extract.xOmission; }
  const shell = !old.title.trim() || /^(https?:\/\/\S+|X 帖子 \d+)$/.test(old.title.trim());
  const recoveredTitle=source.title.trim() && !/^(https?:\/\/\S+|X 帖子 \d+)$/.test(source.title.trim());
  if (shell && recoveredTitle && source.metrics.article && !published) metrics.capturedTitle=metrics.capturedTitle ?? old.title;
  const changed=Object.fromEntries(Object.entries(savedExtract).filter(([key,value])=>key!=='xRecoveryPrevious' && historyDigest(value)!==historyDigest(extract[key])));
  if (Object.keys(changed).length) extract.xRecoveryPrevious={...savedExtract.xRecoveryPrevious,[batch]:changed};
  return { ...old, title:source.review?.title || (shell && recoveredTitle && source.metrics.article && !published ? source.title.slice(0,240) : old.title),
    media,
    links:JSON.stringify([...new Set([...parse(old.links,true),...source.links])]),
    metrics:JSON.stringify(metrics), ai_extract:JSON.stringify(extract),
    ai_type:published ? old.ai_type : source.review?.type || old.ai_type || (source.metrics.article ? 'knowledge' : ''),
    status:restore ? 'pending' : old.status };
}

export function validateHistoryPlan(plan, userId, existing) {
  if (plan.version !== 1 || plan.userId !== userId || !Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length > 10000) throw new Error('Invalid history plan');
  if (!/^\d{8}(?:-[a-z0-9-]{1,32})?$/.test(plan.batch) || plan.baseline !== historyDigest(existing)) throw new Error('History baseline changed');
  const ids = new Set();
  for (const source of plan.sources) {
    if (typeof source.externalId!=='string' || !/^[1-9]\d{1,19}$/.test(source.externalId) || ids.has(source.externalId) ||
      typeof source.content !== 'string' || typeof source.title !== 'string' || !object(source.metrics) ||
      typeof source.author!=='string' || !object(source.organization || {}) ||
      !Array.isArray(source.links) || !Array.isArray(source.media)) throw new Error('Invalid history source');
    const url=new URL(source.url);
    if (url.protocol!=='https:' || url.hostname!=='x.com' || url.port || url.username || url.password || url.search || url.hash ||
      !new RegExp(`^/[A-Za-z0-9_]{1,15}/status/${source.externalId}$`).test(url.pathname)) throw new Error('Invalid source URL');
    if (source.metrics.article && (!object(source.metrics.article) || typeof source.metrics.article.body!=='string')) throw new Error('Invalid article body');
    if (source.review && (!['resource','knowledge','prompt','idea'].includes(source.review.type) ||
      typeof source.review.title!=='string' || !source.review.title.trim() || source.review.title.length>240 ||
      typeof source.review.topic!=='string' || source.review.topic.length>100)) throw new Error('Invalid reviewed type');
    ids.add(source.externalId);
  }
  return ids;
}
