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
  if (compress) {
    const vary = String(responseHeaders.Vary || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!vary.some(value => value.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
    responseHeaders.Vary = vary.join(', ');
  }
  const finish = (bytes, encoded = false) => {
    if (res.destroyed) return;
    res.writeHead(status, { ...responseHeaders, ...(encoded ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  if (!compress || content.length < 1024 || !acceptsGzip(req.headers['accept-encoding'])) return finish(content);
  gzip(content, { level: 6 }, (error, packed) => finish(error ? content : packed, !error));
}

export function sendJson(req, res, status, payload, headers = {}) {
  // These routes return material lists or a single material record. Their payload may be
  // owner-specific, so Cache-Control remains no-store; gzip is negotiated per response.
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const materialRead = pathname === '/api/inbox' || pathname === '/api/inbox/list'
    || /^\/api\/inbox\/\d+$/.test(pathname)
    || pathname === '/api/repositories' || /^\/api\/repositories\/[^/]+\/[^/]+$/.test(pathname)
    || pathname === '/api/knowledge-library'
    || /^\/api\/knowledge-library\/(?:\d+|archive-\d+|method-\d+|manual-knowledge-\d+|pipeline-(?:source-)?\d+)$/.test(pathname)
    || pathname === '/api/prompt-library';
  sendBody(req, res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    { compress: req.method === 'GET' && status === 200 && materialRead });
}
