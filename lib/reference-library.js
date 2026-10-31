import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REFERENCE_KINDS, REFERENCE_COLLECTION, validReferenceObject } from './reference-catalogue.js';
import { createReferenceStorage } from './reference-storage.js';

export function createReferenceLibraryHandler({ directory, getUser, ownerName = 'zane', storage = createReferenceStorage({ directory }) }) {
  let cached = { version: 1, items: [] }, cacheStamp = '', reservedBytes = 0;
  const manifestFile = path.join(directory, 'manifest.json');
  const collectionId = item => item.collectionId || REFERENCE_COLLECTION.id;
  const collectionName = item => item.collectionName || (collectionId(item) === REFERENCE_COLLECTION.id ? REFERENCE_COLLECTION.name : collectionId(item));
  const publicItem = item => ({ id: item.id, stem: item.stem, kind: item.kind, title: item.title, category: item.category,
    collectionId: collectionId(item), collectionName: collectionName(item),
    hair: item.hair, tags: item.tags, groupId: item.groupId, angle: item.angle, sourceUrl: item.sourceUrl,
    addedAt: item.addedAt, originalReady: Boolean(item.original), sourceMissing: Boolean(item.sourceMissing),
    thumbnailUrl: `/api/reference-library/items/${encodeURIComponent(item.id)}/thumbnail`,
    imageUrl: `/api/reference-library/items/${encodeURIComponent(item.id)}/${item.original ? 'original' : 'thumbnail'}` });
  async function manifest() {
    let stamp;
    try { const info = await stat(manifestFile); stamp = `${info.mtimeMs}:${info.size}`; }
    catch (error) { if (error.code === 'ENOENT') return cached; throw error; }
    if (stamp !== cacheStamp) {
      const value = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 60000
        || value.items.some(item => !/^(face|pose|costume):[A-Za-z0-9_-]{1,100}$/.test(item.id)
          || !REFERENCE_KINDS.includes(item.kind) || !Array.isArray(item.tags) || !validReferenceObject(item.thumbnail)
          || (item.original && !validReferenceObject(item.original)))
        || new Set(value.items.map(item => item.id)).size !== value.items.length) throw new Error('reference_manifest_invalid');
      cached = value; cacheStamp = stamp;
    }
    return cached;
  }
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/reference-library')) return false;
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' };
    const json = (status, data) => { const body = JSON.stringify(data); res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body); return true; };
    const allowed = () => getUser(req)?.username === ownerName;
    if (!allowed()) return json(404, { error: '资源不存在或无权访问。' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: '不支持此操作。' });
    try {
      const data = await manifest(), query = new URL(req.url, 'http://localhost').searchParams;
      if (pathname === '/api/reference-library') {
        const kind = query.get('kind') || 'face', category = query.get('category') || '', hair = query.get('hair') || '', q = (query.get('q') || '').trim().slice(0, 200).toLocaleLowerCase();
        if (!REFERENCE_KINDS.includes(kind)) return json(400, { error: '请选择有效的素材类型。' });
        const collection = query.get('collection') || '', collections = new Map();
        for (const item of data.items) {
          const id = collectionId(item);
          if (!collections.has(id)) collections.set(id, { id, name: collectionName(item), count: 0 });
          collections.get(id).count++;
        }
        const inCollection = data.items.filter(item => !collection || collectionId(item) === collection);
        const inKind = inCollection.filter(item => item.kind === kind), limit = 48;
        let rows = inKind.filter(item => (!category || item.category === category) && (!hair || item.hair === hair)
          && (!q || [item.stem, item.title, ...item.tags].join(' ').toLocaleLowerCase().includes(q))
          && (query.get('originals') !== '1' || item.original));
        if (query.get('sort') === 'newest') rows.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || a.id.localeCompare(b.id));
        const total = rows.length, page = Math.min(Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1), Math.max(1, Math.ceil(total / limit)));
        return json(200, { items: rows.slice((page - 1) * limit, page * limit).map(publicItem), total, page, pages: Math.max(1, Math.ceil(total / limit)),
          categories: [...new Set(inKind.map(item => item.category))], hairs: [...new Set(inKind.map(item => item.hair).filter(Boolean))],
          counts: Object.fromEntries(REFERENCE_KINDS.map(key => [key, inCollection.filter(item => item.kind === key).length])),
          collections: [...collections.values()], originalCount: inCollection.filter(item => item.original).length, updatedAt: data.updatedAt || null });
      }
      if (pathname === '/api/reference-library/status') {
        let status = {};
        try { status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')); } catch { /* First import may not have run. */ }
        return json(200, { state: status.state || 'pending', checkedAt: status.checkedAt || null, completedAt: status.completedAt || null,
          nextCheckAt: status.nextCheckAt || null, added: status.added || 0, changed: status.changed || 0,
          error: status.error || null, pendingOriginals: data.items.filter(item => !item.original).length,
          total: data.items.length, originalCount: data.items.filter(item => item.original).length });
      }
      const match = /^\/api\/reference-library\/items\/((?:face|pose|costume):[A-Za-z0-9_-]{1,100})(?:\/(thumbnail|original))?$/.exec(pathname);
      const item = match && data.items.find(item => item.id === match[1]);
      if (!item) return json(404, { error: '素材不存在。' });
      if (!match[2]) return json(200, { ...publicItem(item), variants: data.items.filter(other => other.kind === item.kind && collectionId(other) === collectionId(item) && other.groupId === item.groupId).map(publicItem) });
      const object = item[match[2]];
      if (!object) return json(404, { error: '原图尚未导入，请先下载预览图。' });
      if (reservedBytes + object.bytes > 96 * 1024 ** 2) return json(503, { error: '图片加载繁忙，请稍后重试。' });
      const extension = object.key.split('.').pop(), download = query.get('download') === '1';
      const fileHeaders = { ...headers, 'Content-Type': object.contentType, 'Content-Length': object.bytes,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${item.stem}${match[2] === 'thumbnail' ? '-preview' : ''}.${extension}"` };
      if (req.method === 'HEAD') { res.writeHead(200, fileHeaders); res.end(); return true; }
      reservedBytes += object.bytes;
      let readDone = false, responseDone = false, released = false;
      const release = () => { if (readDone && responseDone && !released) { released = true; reservedBytes -= object.bytes; } };
      const finished = () => { responseDone = true; release(); };
      res.once('finish', finished); res.once('close', finished);
      try {
        const bytes = await storage.read(object);
        if (res.destroyed) return true;
        if (!allowed()) return json(404, { error: '资源不存在或无权访问。' });
        res.writeHead(200, fileHeaders); res.end(bytes); return true;
      } finally { readDone = true; release(); }
    } catch { return json(503, { error: '参考库暂时无法读取，请稍后重试。' }); }
  };
}
