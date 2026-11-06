import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { serveLocalMedia } from './http-media.js';
import { sendBody } from './http-response.js';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.jsx': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.gif': 'image/gif', '.avif': 'image/avif' };

export function createStaticHandler(publicDir, { canAccess = () => true } = {}) {
  const root = path.resolve(publicDir);
  return async (req, res, pathname) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (pathname === '/apps/mdskill' || pathname.startsWith('/apps/mdskill/')) {
      if (!canAccess(req, 'markdown')) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return; }
    }
    const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
    try {
      const canonicalRoot = await realpath(root);
      let target = await realpath(file);
      if (!target.startsWith(canonicalRoot + path.sep)) { res.writeHead(403); res.end(); return; }
      let stats = await stat(target);
      if (pathname.startsWith('/apps/') && stats.isDirectory()) {
        if (!pathname.endsWith('/')) {
          const query = new URL(req.url, 'http://localhost').search;
          res.writeHead(308, { Location: pathname + '/' + query }); res.end(); return;
        }
        target = await realpath(path.join(target, 'index.html'));
        if (!target.startsWith(canonicalRoot + path.sep)) { res.writeHead(403); res.end(); return; }
        stats = await stat(target);
      }
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
      if (/^(image|audio|video)\//.test(type) && !compress) {
        return await serveLocalMedia(req, res, target, { contentType: type, etag, headers: { ...headers, Vary: '' } });
      }
      const content = await readFile(target);
      delete headers.Vary;
      sendBody(req, res, 200, content, headers, { compress });
    } catch {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('404 Not Found');
    }
  };
}
