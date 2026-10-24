import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sendBody } from './http-response.js';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.jsx': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg' };

export function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);
  return async (req, res, pathname) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
    try {
      const canonicalRoot = await realpath(root);
      const target = await realpath(file);
      if (!target.startsWith(canonicalRoot + path.sep)) { res.writeHead(403); res.end(); return; }
      const stats = await stat(target);
      if (!stats.isFile()) throw new Error('Not a file');
      const type = types[path.extname(target)] || 'application/octet-stream';
      const compress = /^(text\/|application\/json|image\/svg)/.test(type);
      const etag = `W/"${stats.size}-${Math.round(stats.mtimeMs)}"`;
      const modified = stats.mtime.toUTCString();
      const headers = {
        ETag: etag, 'Last-Modified': modified,
        'Cache-Control': /^\/assets\/build-[a-f0-9]{16}\//.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'Content-Type': type + (compress ? '; charset=utf-8' : ''),
        ...(compress ? { Vary: 'Accept-Encoding' } : {}),
      };
      const ifNoneMatch = req.headers['if-none-match'];
      const unmodified = ifNoneMatch !== undefined
        ? ifNoneMatch.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
        : req.headers['if-modified-since'] === modified;
      if (unmodified) { res.writeHead(304, headers); res.end(); return; }
      const content = await readFile(target);
      delete headers.Vary;
      sendBody(req, res, 200, content, headers, { compress });
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('404 Not Found');
    }
  };
}
