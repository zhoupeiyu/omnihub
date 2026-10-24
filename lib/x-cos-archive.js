import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const digest = value => createHash('sha256').update(value).digest('hex');

export function xImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.port || url.username || url.password) return '';
    if (!/^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function planXImages(rows) {
  const items = new Map();
  let rejected = 0;
  for (const row of rows) {
    if (row.media == null || row.media === '') continue;
    let media;
    try { media = typeof row.media === 'string' ? JSON.parse(row.media) : row.media; } catch { rejected++; continue; }
    if (!Array.isArray(media)) { rejected++; continue; }
    for (const [index, entry] of media.entries()) {
      if (!entry || !['photo', 'video', 'animated_gif'].includes(entry.type)) continue;
      const sourceUrl = xImageUrl(entry.type === 'photo' ? entry.url : entry.preview_image_url);
      if (!sourceUrl) { rejected++; continue; }
      const record = items.get(sourceUrl) || { id: digest(sourceUrl), sourceUrl, references: [] };
      record.references.push({ inboxId: row.id, postId: row.external_id, mediaIndex: index,
        kind: entry.type === 'photo' ? 'photo' : 'poster', visibility: row.visibility, status: row.status });
      items.set(sourceUrl, record);
    }
  }
  return { version: 1, sourcePosts: rows.length, rejected, items: [...items.values()] };
}

async function atomicFile(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, value, { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const atomicJson = (file, value) => atomicFile(file, JSON.stringify(value, null, 2) + '\n');

async function imageBytes(url, fetchImpl, maxBytes) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!TYPES.has(type)) { await response.body?.cancel(); throw new Error('unsupported_image_type'); }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('image_too_large'); }
  if (!response.body) throw new Error('empty_body');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('image_too_large'); }
    chunks.push(Buffer.from(value));
  }
  if (!size) throw new Error('empty_body');
  const bytes = Buffer.concat(chunks);
  const valid = type === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'image/webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'
    : ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString());
  if (!valid) throw new Error('invalid_image_signature');
  return { bytes, type, extension: TYPES.get(type) };
}

export async function prepareXImages(plan, outDir, { fetchImpl = fetch, concurrency = 4,
  maxImageBytes = 10 * 1024 * 1024, maxTotalBytes = 8 * 1024 ** 3, onProgress = () => {} } = {}) {
  if (!path.isAbsolute(outDir)) throw new Error('absolute_output_required');
  await mkdir(path.join(outDir, 'records'), { recursive: true, mode: 0o700 });
  for (const folder of ['originals', 'previews', 'manifests']) await mkdir(path.join(outDir, 'x-bookmarks', folder), { recursive: true, mode: 0o700 });
  const lockPath = path.join(outDir, 'prepare.lock');
  await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    await atomicJson(path.join(outDir, 'plan.json'), plan);
    let cursor = 0, done = 0, totalBytes = 0;
    const stored = new Set(), results = new Array(plan.items.length);
    let commitQueue = Promise.resolve();
    function storeImage(key, bytes, existing = false) {
      const commit = commitQueue.then(async () => {
        if (stored.has(key)) return;
        if (totalBytes + bytes.length > maxTotalBytes) throw new Error('archive_capacity_limit');
        if (!existing) {
          await mkdir(path.dirname(path.join(outDir,key)), { recursive: true, mode: 0o700 });
          await atomicFile(path.join(outDir,key), bytes);
        }
        stored.add(key); totalBytes += bytes.length;
      });
      commitQueue = commit.catch(() => {});
      return commit;
    }
    async function processItem(item) {
      if (xImageUrl(item.sourceUrl) !== item.sourceUrl || digest(item.sourceUrl) !== item.id) throw new Error('invalid_plan');
      const recordPath = path.join(outDir, 'records', `${item.id}.json`);
      let previous;
      try { previous = JSON.parse(await readFile(recordPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      try {
        if (previous?.state === 'prepared' && /^x-bookmarks\/originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(previous.key)) {
          const bytes = await readFile(path.join(outDir, previous.key)).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
          if (digest(bytes) === previous.sha256 && bytes.length === previous.bytes) {
            await storeImage(previous.key, bytes, true);
            const result = { ...previous, ...item };
            await atomicJson(recordPath, result);
            return result;
          }
        }
        let downloadUrl = item.sourceUrl, image;
        try { image = await imageBytes(downloadUrl, fetchImpl, maxImageBytes); }
        catch (error) {
          const fallback = new URL(downloadUrl);
          if (error.message !== 'http_404' || fallback.searchParams.get('name') !== 'orig') throw error;
          fallback.searchParams.set('name', 'large'); downloadUrl = fallback.href;
          image = await imageBytes(downloadUrl, fetchImpl, maxImageBytes);
        }
        const hash = digest(image.bytes);
        const key = `x-bookmarks/originals/${hash.slice(0,2)}/${hash}.${image.extension}`;
        await storeImage(key, image.bytes);
        const result = { ...item, state: 'prepared', key, sha256: hash, bytes: image.bytes.length,
          contentType: image.type, downloadUrl, preparedAt: new Date().toISOString() };
        await atomicJson(recordPath, result);
        return result;
      } catch (error) {
        const safeCodes = /^(http_\d{3}|unsupported_image_type|image_too_large|empty_body|invalid_image_signature|archive_capacity_limit)$/;
        const result = { ...item, state: 'failed', error: safeCodes.test(error.message) ? error.message : 'download_failed' };
        await atomicJson(recordPath, result);
        return result;
      }
    }
    let fatalError;
    await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, async () => {
      try {
        while (!fatalError && cursor < plan.items.length) {
          const index = cursor++;
          results[index] = await processItem(plan.items[index]); done++;
          if (done % 50 === 0 || done === plan.items.length) onProgress({ done, total: plan.items.length, bytes: totalBytes });
        }
      } catch (error) {
        fatalError ||= error;
      }
    }));
    if (fatalError) throw fatalError;
    const summary = { version: 1, preparedAt: new Date().toISOString(), sourcePosts: plan.sourcePosts,
      total: results.length, prepared: results.filter(r=>r.state==='prepared').length,
      failed: results.filter(r=>r.state==='failed').length, rejected: plan.rejected, uniqueObjects: stored.size, bytes: totalBytes };
    await atomicJson(path.join(outDir, 'x-bookmarks/manifests/media-index.json'), { ...summary, items: results });
    await atomicJson(path.join(outDir, 'summary.json'), summary);
    return summary;
  } finally { await unlink(lockPath); }
}
