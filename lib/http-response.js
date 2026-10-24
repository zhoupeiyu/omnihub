import { gzip } from 'node:zlib';

export function acceptsGzip(value = '') {
  const encodings = String(value).toLowerCase().split(',').map(item => {
    const [name, ...parameters] = item.trim().split(';');
    const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    return { name, q: quality ? Number(quality.slice(2)) : 1 };
  });
  const selected = encodings.find(item => item.name === 'gzip') || encodings.find(item => item.name === '*');
  return Boolean(selected && selected.q > 0 && selected.q <= 1);
}

export function sendBody(req, res, status, body, headers, { compress = false } = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const responseHeaders = { ...headers };
  if (compress) responseHeaders.Vary = responseHeaders.Vary ? `${responseHeaders.Vary}, Accept-Encoding` : 'Accept-Encoding';
  const finish = (bytes, encoded = false) => {
    if (res.destroyed) return;
    res.writeHead(status, { ...responseHeaders, ...(encoded ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  if (!compress || content.length < 1024 || !acceptsGzip(req.headers['accept-encoding'])) return finish(content);
  gzip(content, { level: 6 }, (error, packed) => finish(error ? content : packed, !error));
}

export function sendJson(req, res, status, payload, headers = {}) {
  // Compress anonymous library reads only; sessions, mutations and streams are untouched.
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const anonymousLibrary = req.method === 'GET' && !req.headers.cookie && !req.headers.authorization
    && /^\/api\/(repositories|knowledge-library|prompt-library|x-bookmarks)(\/|$)/.test(pathname);
  sendBody(req, res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    { compress: anonymousLibrary && status === 200 });
}
