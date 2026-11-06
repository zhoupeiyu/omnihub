import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const OMNIGET_COOKIE_MAX_BYTES = 256 * 1024;
export const OMNIGET_COOKIE_MAX_TTL_SECONDS = 24 * 60 * 60;

// This is deliberately a small, explicit allowlist.  A site integration must
// add its exact hosts here before the uploader can accept its cookie file.
export const OMNIGET_COOKIE_SITES = Object.freeze({
  bilibili: Object.freeze(['bilibili.com', 'www.bilibili.com', 'passport.bilibili.com']),
  douyin: Object.freeze(['douyin.com', 'www.douyin.com', 'v.douyin.com']),
  instagram: Object.freeze(['instagram.com', 'www.instagram.com']),
  tiktok: Object.freeze(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']),
  x: Object.freeze(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']),
  youtube: Object.freeze(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']),
});

export const omnigetCookieError = (status, message) => Object.assign(new Error(message), { status });

function ownerId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 128 || /[\u0000\r\n]/.test(normalized)) throw omnigetCookieError(400, '用户标识不正确');
  return normalized;
}

function siteId(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!Object.hasOwn(OMNIGET_COOKIE_SITES, normalized)) throw omnigetCookieError(400, '该站点暂不支持 Cookie 登录');
  return normalized;
}

function decodeUpload(value) {
  const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'utf8') : null;
  if (!bytes || !bytes.length || bytes.length > OMNIGET_COOKIE_MAX_BYTES) throw omnigetCookieError(400, 'Cookie 文件必须为 1 至 256KiB');
  try { return new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { throw omnigetCookieError(400, 'Cookie 文件必须是 UTF-8 文本'); }
}

function normalizeDomain(raw) {
  const domain = raw.toLowerCase().replace(/^\./, '');
  if (!domain || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) throw omnigetCookieError(400, 'Cookie 域名不正确');
  return domain;
}

function parseNetscape(value, site, nowMs = Date.now()) {
  const text = decodeUpload(value);
  const allowed = new Set(OMNIGET_COOKIE_SITES[site]);
  const nowSeconds = Math.floor(nowMs / 1000);
  let count = 0;
  for (const sourceLine of text.split(/\n/)) {
    let line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    if (Buffer.byteLength(line, 'utf8') > 16 * 1024) throw omnigetCookieError(400, 'Cookie 字段过长');
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); }
    const fields = line.split('\t');
    if (fields.length !== 7) throw omnigetCookieError(400, 'Cookie 文件格式不正确');
    const [domainRaw, includeSubdomains, cookiePath, secure, expiresRaw, name, cookieValue] = fields;
    const domain = normalizeDomain(domainRaw);
    if (!allowed.has(domain)) throw omnigetCookieError(400, 'Cookie 文件含有不属于所选站点的域名');
    if (!['TRUE', 'FALSE'].includes(includeSubdomains) || !['TRUE', 'FALSE'].includes(secure) || !/^\d+$/.test(expiresRaw)) throw omnigetCookieError(400, 'Cookie 字段不正确');
    const expires = Number(expiresRaw);
    if (!Number.isSafeInteger(expires) || (expires !== 0 && expires < nowSeconds)) throw omnigetCookieError(400, 'Cookie 已过期');
    if (!cookiePath.startsWith('/') || cookiePath.length > 2048 || !name || name.length > 512 || cookieValue.length > 8192 || /[\u0000\t\r\n]/.test(`${cookiePath}${name}${cookieValue}`)) throw omnigetCookieError(400, 'Cookie 字段不正确');
    // Keep this assignment so format-aware parsers cannot silently discard the
    // HttpOnly Netscape convention while still accepting the original text.
    void httpOnly;
    if (++count > 1024) throw omnigetCookieError(400, 'Cookie 条目过多');
  }
  if (!count) throw omnigetCookieError(400, 'Cookie 文件中没有有效条目');
  return { text, count };
}

function readPrivateKey(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw omnigetCookieError(500, 'Cookie 加密配置异常');
  const key = readFileSync(file);
  if (key.length !== 32) throw omnigetCookieError(500, 'Cookie 加密配置异常');
  return key;
}

export function createOmnigetCookieStore({ db, directory, now = Date.now } = {}) {
  if (!db || !directory) throw new TypeError('db 和 directory 为必填项');
  if (typeof now !== 'function') throw new TypeError('now 必须是函数');
  db.exec(`CREATE TABLE IF NOT EXISTS omniget_cookie_connections (
    owner_id TEXT NOT NULL, site TEXT NOT NULL, ciphertext TEXT NOT NULL,
    cookie_count INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, site)
  )`);
  let key;
  const encryptionKey = () => {
    if (key) return key;
    mkdirSync(directory, { recursive:true, mode:0o700 });
    const file = path.join(directory, 'omniget-cookies.key');
    try { key = readPrivateKey(file); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { writeFileSync(file, randomBytes(32), { mode:0o600, flag:'wx' }); }
      catch (writeError) { if (writeError?.code !== 'EEXIST') throw writeError; }
      key = readPrivateKey(file);
    }
    return key;
  };
  const aad = (owner, site) => Buffer.from(`omniget-cookie-v1\u0000${owner}\u0000${site}`, 'utf8');
  const seal = (owner, site, value) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(aad(owner, site));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  };
  const unseal = (owner, site, value) => {
    try {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < 29) throw new Error('short ciphertext');
      const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
      cipher.setAAD(aad(owner, site));
      cipher.setAuthTag(bytes.subarray(-16));
      const payload = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'));
      if (!payload || payload.version !== 1 || payload.site !== site || typeof payload.text !== 'string' || !Number.isInteger(payload.count)) throw new Error('invalid payload');
      return payload;
    } catch (error) {
      if (error?.status) throw error;
      throw omnigetCookieError(500, 'Cookie 凭据无法读取');
    }
  };
  const find = (owner, site) => db.prepare('SELECT ciphertext,cookie_count,created_at,expires_at FROM omniget_cookie_connections WHERE owner_id=? AND site=?').get(owner, site);
  const safeStatus = (site, row, current) => ({ configured:Boolean(row && row.expires_at > current), site, expiresAt:row && row.expires_at > current ? row.expires_at : 0, cookieCount:row && row.expires_at > current ? row.cookie_count : 0 });
  const expire = (owner, site, row, current) => {
    if (row && row.expires_at <= current) { db.prepare('DELETE FROM omniget_cookie_connections WHERE owner_id=? AND site=?').run(owner, site); return undefined; }
    return row;
  };

  return {
    save(ownerInput, siteInput, upload, { ttlSeconds = OMNIGET_COOKIE_MAX_TTL_SECONDS } = {}) {
      const owner = ownerId(ownerInput), site = siteId(siteInput), current = now();
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > OMNIGET_COOKIE_MAX_TTL_SECONDS) throw omnigetCookieError(400, 'Cookie 有效期必须在 1 秒至 24 小时内');
      const parsed = parseNetscape(upload, site, current);
      const expiresAt = current + ttlSeconds * 1000;
      db.prepare(`INSERT INTO omniget_cookie_connections(owner_id,site,ciphertext,cookie_count,created_at,expires_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,site) DO UPDATE SET ciphertext=excluded.ciphertext,cookie_count=excluded.cookie_count,created_at=excluded.created_at,expires_at=excluded.expires_at`)
        .run(owner, site, seal(owner, site, { version:1, site, text:parsed.text, count:parsed.count }), parsed.count, current, expiresAt);
      return safeStatus(site, find(owner, site), current);
    },
    status(ownerInput, siteInput) {
      const owner = ownerId(ownerInput), site = siteId(siteInput), current = now();
      const row = expire(owner, site, find(owner, site), current);
      return safeStatus(site, row, current);
    },
    list(ownerInput) {
      const owner = ownerId(ownerInput), current = now();
      db.prepare('DELETE FROM omniget_cookie_connections WHERE owner_id=? AND expires_at<=?').run(owner, current);
      return db.prepare('SELECT site,cookie_count,expires_at FROM omniget_cookie_connections WHERE owner_id=? AND expires_at>? ORDER BY site').all(owner, current)
        .map(row => ({ configured:true, site:row.site, expiresAt:row.expires_at, cookieCount:row.cookie_count }));
    },
    remove(ownerInput, siteInput) {
      const owner = ownerId(ownerInput), site = siteId(siteInput);
      db.prepare('DELETE FROM omniget_cookie_connections WHERE owner_id=? AND site=?').run(owner, site);
      return { configured:false, site, expiresAt:0, cookieCount:0 };
    },
    // Runner-only consumption: plaintext is scoped to the supplied callback and
    // never returned by this public module.  HTTP handlers must not expose it.
    consumeForRunner(ownerInput, siteInput, callback) {
      const owner = ownerId(ownerInput), site = siteId(siteInput), current = now();
      if (typeof callback !== 'function') throw new TypeError('callback 必须是函数');
      const row = expire(owner, site, find(owner, site), current);
      if (!row) throw omnigetCookieError(409, '该站点尚未配置有效 Cookie');
      const payload = unseal(owner, site, row.ciphertext);
      const parsed = parseNetscape(payload.text, site, current);
      if (parsed.count !== row.cookie_count || parsed.count !== payload.count) throw omnigetCookieError(500, 'Cookie 凭据无法读取');
      callback(parsed.text);
      return { consumed:true, site, expiresAt:row.expires_at, cookieCount:row.cookie_count };
    },
  };
}
