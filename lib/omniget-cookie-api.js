import { OMNIGET_COOKIE_MAX_BYTES, OMNIGET_COOKIE_SITES } from './omniget-cookies.js';

const MAX_BODY_BYTES = OMNIGET_COOKIE_MAX_BYTES;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const apiError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function safeMessage(error, operation) {
  const status = Number(error?.status);
  if (status === 401) return [401, '请先登录'];
  if (status === 403) return [403, '此操作未获授权'];
  if (status === 413) return [413, '请求内容超过 256KiB 限制'];
  if (status === 400) return [400, operation === 'read' ? 'Cookie 状态请求无效' : 'Cookie 文件或设置不符合要求'];
  return [500, operation === 'read' ? 'Cookie 状态暂不可用' : 'Cookie 设置未保存'];
}

function ownerId(user) {
  const value = user?.id ?? user?.userId ?? user?.username;
  if (value === undefined || value === null || String(value).trim() === '') throw apiError(401, '请先登录');
  return String(value);
}

function matchesOrigin(req, configuredOrigin) {
  const actual = req.headers.origin;
  if (!actual || typeof actual !== 'string') return false;
  const expected = typeof configuredOrigin === 'function' ? configuredOrigin(req) : configuredOrigin;
  if (!expected) return false;
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

async function readJson(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw apiError(413, '请求内容超过限制');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw apiError(413, '请求内容超过限制');
    chunks.push(bytes);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw apiError(400, '请求格式错误'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, '请求格式错误');
  return body;
}

function parseUpload(body) {
  const keys = Object.keys(body);
  if (keys.some(key => key !== 'cookiesTxt' && key !== 'ttlSeconds') || typeof body.cookiesTxt !== 'string') throw apiError(400, '请求格式错误');
  if (body.ttlSeconds !== undefined && (!Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 1 || body.ttlSeconds > 24 * 60 * 60)) throw apiError(400, '请求格式错误');
  return { cookiesTxt: body.cookiesTxt, ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }) };
}

function pathSite(pathname) {
  const match = /^\/api\/omniget\/cookies\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const site = decodeURIComponent(match[1]);
    if (!site || site.includes('/') || site.length > 64) return null;
    return site;
  } catch { return null; }
}

function supportedSite(site) {
  if (!site || !Object.hasOwn(OMNIGET_COOKIE_SITES, site)) throw apiError(400, '站点不受支持');
  return site;
}

/**
 * Private Cookie connection routes. Cookie plaintext is accepted only on POST
 * and is passed directly to the encrypted store; it is never returned or logged.
 */
export function createOmnigetCookieApi({ store, getUser, canTool = () => true, origin } = {}) {
  if (!store || typeof store.save !== 'function' || typeof store.list !== 'function' || typeof store.status !== 'function' || typeof store.remove !== 'function') throw new TypeError('store 必须提供 Cookie 存储接口');
  if (typeof getUser !== 'function' || typeof canTool !== 'function') throw new TypeError('getUser 和 canTool 必须是函数');

  const authorize = req => {
    const user = getUser(req);
    const owner = ownerId(user);
    if (!canTool(user, 'omniget')) throw apiError(403, '此操作未获授权');
    return owner;
  };

  return async function handleOmnigetCookies(req, res, pathname) {
    if (pathname !== '/api/omniget/cookies' && !pathname.startsWith('/api/omniget/cookies/')) return false;
    const site = pathSite(pathname);
    try {
      const owner = authorize(req);
      if (req.method === 'GET' && pathname === '/api/omniget/cookies') {
        send(res, 200, { connections: store.list(owner) });
        return true;
      }
      if (req.method === 'GET' && site) {
        send(res, 200, { connection: store.status(owner, supportedSite(site)) });
        return true;
      }
      if (req.method === 'POST' && site) {
        if (!matchesOrigin(req, origin)) throw apiError(403, '跨站请求被拒绝');
        const upload = parseUpload(await readJson(req));
        send(res, 200, { connection: store.save(owner, supportedSite(site), upload.cookiesTxt, { ttlSeconds: upload.ttlSeconds }) });
        return true;
      }
      if (req.method === 'DELETE' && site) {
        if (!matchesOrigin(req, origin)) throw apiError(403, '跨站请求被拒绝');
        send(res, 200, { connection: store.remove(owner, supportedSite(site)) });
        return true;
      }
      send(res, 404, { error: 'Cookie 接口不存在' });
      return true;
    } catch (error) {
      const [status, message] = safeMessage(error, req.method === 'GET' ? 'read' : 'write');
      send(res, status, { error: message });
      return true;
    }
  };
}
