// Life guide HTTP handler: public, read-only endpoints over a life guide store.
// Factory: createLifeGuideHandler(store) -> (req, res, pathname) => handled boolean.
// Only GET/HEAD are served; paths outside the prefix are not handled (the caller
// falls through to the existing router). All data is public, so successful JSON
// reads are compressed via sendBody's fifth options argument; cookies never
// change the payload.

import { sendBody } from './http-response.js';

const PREFIX = '/api/life-guide';
const PUBLIC_READ_COMPRESS = Object.freeze({ compress: true });

const SAFE_MESSAGES = Object.freeze({
  NOT_READY: 'Life guide data is not available yet',
  VERSION_CHANGED: 'Life guide data has changed since it was read',
  INVALID_CORPUS: 'Life guide corpus failed validation',
  BAD_REQUEST: 'Invalid life guide request',
  NOT_FOUND: 'Life guide resource not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  INTERNAL: 'Life guide request failed',
});

const STATUS = Object.freeze({
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  VERSION_CHANGED: 409,
  NOT_READY: 503,
  INTERNAL: 500,
});

function sendJson(req, res, status, payload, options) {
  sendBody(
    req,
    res,
    status,
    JSON.stringify(payload),
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    options,
  );
}

function sendError(req, res, code) {
  const status = STATUS[code] || STATUS.INTERNAL;
  const headers = code === 'METHOD_NOT_ALLOWED' ? { Allow: 'GET, HEAD' } : undefined;
  // Errors are small and never compressed; only successful public reads are.
  if (headers) {
    sendBody(req, res, status, JSON.stringify({ error: code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
  } else {
    sendJson(req, res, status, { error: code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL });
  }
}

function withinPrefix(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

export function createLifeGuideHandler(store) {
  if (!store || typeof store.list !== 'function' || typeof store.metadata !== 'function') {
    throw new TypeError('createLifeGuideHandler requires a life guide store');
  }

  return function lifeGuideHandler(req, res, pathname) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return false;
    }
    const path = pathname === undefined || pathname === null ? url.pathname : pathname;
    if (!withinPrefix(path)) return false;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(req, res, 'METHOD_NOT_ALLOWED');
      return true;
    }

    const params = Object.fromEntries(url.searchParams);
    try {
      if (path === `${PREFIX}/meta`) {
        sendJson(req, res, 200, store.metadata(), PUBLIC_READ_COMPRESS);
        return true;
      }
      if (path === `${PREFIX}/list`) {
        sendJson(req, res, 200, store.list(params), PUBLIC_READ_COMPRESS);
        return true;
      }
      if (path === `${PREFIX}/detail`) {
        sendJson(req, res, 200, store.detail(params), PUBLIC_READ_COMPRESS);
        return true;
      }
    } catch (error) {
      const code = error && typeof error.code === 'string' && SAFE_MESSAGES[error.code] ? error.code : 'INTERNAL';
      sendError(req, res, code);
      return true;
    }

    sendError(req, res, 'NOT_FOUND');
    return true;
  };
}
