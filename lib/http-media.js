import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export function matchesEtag(value, etag) {
  return String(value || '').split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}
export function mediaTag(value) {
  return '"' + createHash('sha256').update(JSON.stringify(value)).digest('hex') + '"';
}
// Call only after the owning route has checked current permissions.
export function revalidateMedia(req, res, etag, headers = {}) {
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('ETag', etag);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304); res.end(); return true; }
  return false;
}
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end = size - 1;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
  } else {
    start = Number(match[1]);
    if (match[2]) { const requested = Number(match[2]); if (!Number.isSafeInteger(requested)) return false; end = Math.min(end, requested); }
  }
  return Number.isSafeInteger(start) && start >= 0 && start <= end && start < size ? { start, end } : false;
}
export function permittedRange(req, etag, modified) {
  const condition = req.headers['if-range'];
  if (!condition) return req.headers.range;
  const date = Date.parse(condition);
  return (condition === etag && !etag.startsWith('W/')) || (modified && Number.isFinite(date) && date >= Date.parse(modified)) ? req.headers.range : undefined;
}
export async function serveLocalMedia(req, res, file, { contentType, headers = {}, etag: supplied } = {}) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('media_file_missing');
  const etag = supplied || `W/"${info.size}-${info.mtimeMs}-${info.ctimeMs}"`;
  const modified = info.mtime.toUTCString();
  const base = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Last-Modified': modified,
    'X-Content-Type-Options': 'nosniff', ...headers };
  if (revalidateMedia(req, res, etag, base)) return true;
  const range = req.method === 'HEAD' ? null : byteRange(permittedRange(req, etag, modified), info.size);
  if (range === false) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' }); res.end(); return true; }
  res.writeHead(range ? 206 : 200, { 'Content-Length': range ? range.end - range.start + 1 : info.size,
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return true; }
  await pipeline(createReadStream(file, range || {}), res);
  return true;
}
