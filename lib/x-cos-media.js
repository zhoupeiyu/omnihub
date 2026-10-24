import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { xImageUrl } from './x-cos-archive.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const keyPattern = /^x-bookmarks\/originals\/([a-f0-9]{2})\/([a-f0-9]{64})\.(jpg|png|webp|gif)$/;
const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const mediaArray = value => {
  try { const items = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(items) ? items : []; }
  catch { return []; }
};
const imageSource = item => xImageUrl(item?.type === 'photo' ? item.url
  : ['video', 'animated_gif'].includes(item?.type) ? item.preview_image_url : '');

// The manifest is a lookup table, never an authorization source. Permissions come
// from the current inbox row even when the image is already cached by the browser.
export function createXCosMedia({ directory = '', readRemote, maxResponseBytes = 64 * 1024 ** 2 } = {}) {
  const records = new Map();
  if (directory) {
    if (!path.isAbsolute(directory)) throw new Error('invalid_x_media_directory');
    const manifest = JSON.parse(readFileSync(path.join(directory, 'x-bookmarks/manifests/media-index.json')));
    if (manifest.version !== 1 || !Array.isArray(manifest.items)) throw new Error('invalid_x_media_manifest');
    for (const item of manifest.items) {
      if (item.state !== 'prepared') continue;
      const match = keyPattern.exec(item.key || '');
      if (!match || match[1] !== match[2].slice(0, 2) || item.sha256 !== match[2]
        || types[match[3]] !== item.contentType || !Number.isSafeInteger(item.bytes)
        || item.bytes < 1 || item.bytes > 10 * 1024 ** 2
        || !item.sourceUrl || xImageUrl(item.sourceUrl) !== item.sourceUrl
        || item.id !== digest(item.sourceUrl) || records.has(item.id)) throw new Error('invalid_x_media_record');
      if (!Array.isArray(item.references) || !item.references.length || item.references.some(ref =>
          !Number.isSafeInteger(ref.inboxId) || ref.inboxId < 1)) throw new Error('invalid_x_media_references');
      records.set(item.id, item);
    }
  }

  function rewrite(inboxId, media) {
    return mediaArray(media).map(item => {
      const source = imageSource(item);
      const id = source && digest(source);
      if (!Number.isSafeInteger(inboxId) || inboxId < 1 || !records.get(id)?.references.some(ref => ref.inboxId === inboxId)) return item;
      const url = `/api/x-media/${inboxId}/${id}`;
      // Keep all original values in the database; only the display projection changes.
      return item.type === 'photo' ? { ...item, url, preview_image_url: url }
        : { ...item, preview_image_url: url };
    });
  }

  // Internal-only byte access for a media creation reference.  The caller
  // supplies a row lookup already scoped to the authenticated website user;
  // sourceUrl is checked against both that live row and the signed manifest.
  // It deliberately accepts no client-provided object key or user id.
  async function readReference({ inboxId, sourceUrl, getOwnedRow }) {
    if(!Number.isSafeInteger(inboxId)||inboxId<1||typeof sourceUrl!=='string'||typeof getOwnedRow!=='function')
      throw new Error('x_media_reference_invalid');
    const item=records.get(digest(sourceUrl));
    const allowed=row=>row&&row.source==='x'&&item&&item.sourceUrl===sourceUrl
      &&item.references.some(ref=>ref.inboxId===inboxId)
      &&mediaArray(row.media).some(media=>imageSource(media)===sourceUrl);
    if(!allowed(getOwnedRow(inboxId)))throw new Error('x_media_reference_denied');
    const bytes=await bytesFor(item);
    // Authorization is rechecked after local/COS I/O in case the source was
    // deleted, moved, or revoked while the read was pending.
    if(!allowed(getOwnedRow(inboxId)))throw new Error('x_media_reference_denied');
    return { bytes, mimeType:item.contentType, name:`x-reference-${item.id}.${item.key.split('.').pop()}` };
  }

  const inflight = new Map();
  let reservedBytes = 0;
  async function bytesFor(item) {
    if (inflight.has(item.key)) return inflight.get(item.key);
    if (inflight.size >= 12) throw new Error('x_media_busy');
    const work = (async () => {
      let bytes;
      try {
        const file = path.join(directory, item.key);
        if ((await stat(file)).size === item.bytes) bytes = await readFile(file);
      } catch { /* The verified on-disk archive is an optional COS read cache. */ }
      if (!bytes || digest(bytes) !== item.sha256) {
        if (!readRemote) throw new Error('x_media_unavailable');
        bytes = await readRemote(item);
      }
      if (!Buffer.isBuffer(bytes) || bytes.length !== item.bytes || digest(bytes) !== item.sha256) {
        throw new Error('x_media_integrity_failed');
      }
      return bytes;
    })();
    inflight.set(item.key, work);
    try { return await work; } finally { inflight.delete(item.key); }
  }

  async function handle(req, res, pathname, { getRow, privateAccess = false, isPublic }) {
    if (res.destroyed) return true;
    const headers = { 'Cache-Control': 'private, no-cache, must-revalidate',
      'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
    const finish = (status, extra = {}, body) => { res.writeHead(status, { ...headers, ...extra }); res.end(body); return true; };
    if (!['GET', 'HEAD'].includes(req.method)) return finish(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    const match = /^\/api\/x-media\/([1-9]\d*)\/([a-f0-9]{64})$/.exec(pathname);
    const inboxId = Number(match?.[1]);
    const item = match && records.get(match[2]);
    const row = item && Number.isSafeInteger(inboxId) ? getRow(inboxId) : null;
    const allowed = current => current && current.source === 'x'
      && item.references.some(ref => ref.inboxId === inboxId)
      && ((typeof privateAccess === 'function' ? privateAccess() : privateAccess)
        || (current.status === 'pending' && isPublic(current)))
      && mediaArray(current.media).some(media => imageSource(media) === item.sourceUrl);
    if (!allowed(row)) return finish(404, { 'Cache-Control': 'no-store' });
    const etag = `"${item.sha256}"`;
    const metadata = { ETag: etag, 'Content-Type': item.contentType };
    if (req.headers['if-none-match'] === etag) return finish(304, metadata);
    if (req.method === 'HEAD') return finish(200, { ...metadata, 'Content-Length': item.bytes });
    if (reservedBytes + item.bytes > maxResponseBytes) return finish(503, { 'Cache-Control': 'no-store', 'Retry-After': '10' });
    // Keep the reservation through transmission, not only through the read. A
    // disconnected client also retains it until its outstanding read settles.
    reservedBytes += item.bytes;
    let readDone = false, responseDone = false, released = false;
    const release = () => {
      if (readDone && responseDone && !released) { released = true; reservedBytes -= item.bytes; }
    };
    const responseEnded = () => { responseDone = true; release(); };
    res.once('finish', responseEnded);
    res.once('close', responseEnded);
    try {
      const bytes = await bytesFor(item);
      if (res.destroyed) return true;
      // A remote read may take seconds; honor revocation that happens while waiting.
      const current = getRow(inboxId);
      if (!allowed(current)) {
        return finish(404, { 'Cache-Control': 'no-store' });
      }
      return finish(200, { ...metadata, 'Content-Length': bytes.length }, bytes);
    } catch {
      // Never forward SDK errors, signed requests, or bucket credentials to clients/logs.
      return finish(503, { 'Cache-Control': 'no-store', 'Retry-After': '10' });
    } finally { readDone = true; release(); }
  }
  function has(pathname) {
    const match = /^\/api\/x-media\/([1-9]\d*)\/([a-f0-9]{64})$/.exec(pathname);
    return Boolean(match && Number.isSafeInteger(Number(match[1])) && records.has(match[2]));
  }
  return { rewrite, handle, readReference, has, size: records.size };
}

export function createCosImageReader(env = process.env) {
  let client;
  return async item => {
    if (env.COS_BUCKET !== 'omnihub-media-1319495021' || env.COS_REGION !== 'ap-hongkong'
      || !env.COS_SECRET_ID || !env.COS_SECRET_KEY) throw new Error('x_media_not_configured');
    if (!client) {
      const { default: COS } = await import('cos-nodejs-sdk-v5');
      client = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY,
        Protocol: 'https:', StrictSsl: true, FollowRedirect: false, Timeout: 15000 });
    }
    // A bounded range protects memory if an object has unexpectedly grown.
    const response = await client.getObject({ Bucket: env.COS_BUCKET, Region: env.COS_REGION,
      Key: item.key, Range: `bytes=0-${item.bytes}` });
    return response.Body;
  };
}
