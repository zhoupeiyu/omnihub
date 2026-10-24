import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { Transform } from 'node:stream';

export const MAX_MEDIA_RESULT_BYTES = 256 * 1024 * 1024;

function publicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0));
}

function expandedIpv6(address) {
  const value = address.toLowerCase().split('%')[0];
  // IPv4-mapped notation is rejected rather than treated as an IPv6 public
  // address; it is a common way to hide loopback/private destinations.
  if (value.includes('.')) return null;
  const [left, right = ''] = value.split('::');
  const leftParts = left ? left.split(':').filter(Boolean) : [];
  const rightParts = right ? right.split(':').filter(Boolean) : [];
  const parts = [...leftParts, ...Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill('0'), ...rightParts];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map(part => Number.parseInt(part, 16));
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const parts = expandedIpv6(address);
  if (!parts) return false;
  const [first, second] = parts;
  // ::/128, ::1/128, IPv4-mapped/compatible, ULA, link-local, multicast,
  // documentation and discard-only ranges are never public destinations.
  if (parts.every(part => part === 0) || (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1)) return false;
  if (parts.slice(0, 5).every(part => part === 0) && (parts[5] === 0 || parts[5] === 0xffff)) return false;
  // Only global-unicast 2000::/3 is accepted.  This intentionally excludes
  // documented, Teredo and 6to4 routes in addition to private IPv6 ranges.
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8))
    && first !== 0x2002;
}

function failure(message) { return Object.assign(new Error(message), { safe: true }); }

async function pinnedAddress(url, { localOrigin, lookupImpl }) {
  const local = localOrigin && url.origin === localOrigin
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local) {
    const address = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
    return { address, family: net.isIP(address) || 4 };
  }
  const records = await lookupImpl(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || !records.length || records.some(record => !isPublicAddress(record.address))) {
    throw failure('生成结果地址不安全');
  }
  return records[0];
}

export function createPinnedLookup(pinned) {
  return (_host, options, callback) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function deadlineRace(work, remaining) {
  if (!Number.isFinite(remaining) || remaining <= 0) return Promise.reject(failure('生成结果下载超时'));
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => reject(failure('生成结果下载超时')), remaining); }),
  ]).finally(() => clearTimeout(timer));
}

export async function downloadMediaResult(value, { localOrigin = '', timeoutMs = 30_000, maxBytes = MAX_MEDIA_RESULT_BYTES, lookupImpl = dnsLookup } = {}) {
  let url;
  try { url = new URL(value); } catch { throw failure('生成结果地址不正确'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('生成结果地址不安全');
  const origin = (() => { try { return new URL(localOrigin).origin; } catch { return ''; } })();
  const local = url.protocol === 'http:' && origin && url.origin === origin
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) throw failure('生成结果地址不安全');
  const deadline = Date.now() + timeoutMs;
  const pinned = await deadlineRace(pinnedAddress(url, { localOrigin: local ? origin : '', lookupImpl }), deadline - Date.now());
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false, response;
    const timer = setTimeout(() => {
      const error = failure('生成结果下载超时');
      response?.destroy(error); request.destroy(error); finish(error);
    }, Math.max(1, deadline - Date.now()));
    const finish = (error, value) => {
      if (settled) return; settled = true;
      if (error) clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = client.request(url, {
      method: 'GET',
      headers: { Accept: 'image/*,video/*,audio/*;q=0.8,*/*;q=0.1' },
      lookup: createPinnedLookup(pinned),
    }, incoming => {
      response = incoming;
      const status = Number(response.statusCode || 0);
      if (status < 200 || status >= 300) { const error=failure(status >= 300 && status < 400 ? '不允许生成结果跳转' : '生成结果下载失败'); response.destroy(error); request.destroy(error); finish(error); return; }
      const declared = Number(response.headers['content-length'] || 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) { const error=failure('生成结果文件超过大小上限'); response.destroy(error); request.destroy(error); finish(error); return; }
      let received = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > maxBytes ? failure('生成结果文件超过大小上限') : null, chunk);
      } });
      limiter.once('end', () => clearTimeout(timer));
      limiter.once('close', () => clearTimeout(timer));
      limiter.once('error', error => { response.destroy(error); request.destroy(error); });
      response.on('error', error => limiter.destroy(error));
      response.pipe(limiter);
      finish(null, { stream: limiter, mimeType: String(response.headers['content-type'] || ''), status });
    });
    request.once('error', () => finish(failure('暂时无法下载生成结果')));
    request.end();
  });
}
