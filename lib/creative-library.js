import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectMediaFile } from './media.js';

const fsp = fs.promises;
const BASE = '/api/creative-library';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_CONCURRENT = 4;

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function sameOrigin(req, origin) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'cross-site') return false;
  return req.headers.origin === origin;
}

function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (_e) { return ''; }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32 * 1024) {
      req.resume();
      throw httpError(413, '请求内容过大');
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, '请求内容格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '请求内容格式不正确');
  return value;
}

async function stageMedia(stream, directory, expectedSize) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.library-${crypto.randomUUID()}.pending`);
  const file = await fsp.open(temporary, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const header = Buffer.alloc(24);
  try {
    try {
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        if (size + chunk.length > MAX_UPLOAD) {
          if (expectedSize === undefined) stream.resume();
          throw httpError(413, '文件超过 100 MB');
        }
        if (size < header.length) chunk.copy(header, size, 0, header.length - size);
        size += chunk.length;
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (!size) throw httpError(400, '文件为空');
      if (expectedSize !== undefined && size !== expectedSize) throw httpError(409, '源文件已变化，请重新下载');
      const type = detectMediaFile(header.subarray(0, Math.min(size, header.length)));
      if (!type) throw httpError(422, '此格式暂不能入库。支持 PNG、JPEG、GIF、WebP、MP4、WAV 和 MP3');
      await file.sync();
      return { temporary, size, type, sha256: hash.digest('hex') };
    } finally {
      await file.close();
    }
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function stageDownload(source, directory) {
  if (!['.mp4', '.mp3'].includes(path.extname(source.path).toLowerCase())) {
    throw httpError(422, '此下载格式暂不能入库，请使用 MP4 或 MP3');
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const handle = await fsp.open(source.path, flags).catch(() => { throw httpError(404, '源文件已不可用'); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== source.size) throw httpError(404, '源文件已不可用');
    if (stat.size > MAX_UPLOAD) throw httpError(413, '文件超过 100 MB');
    const stream = handle.createReadStream({ autoClose: false });
    try { return await stageMedia(stream, directory, stat.size); }
    finally { stream.destroy(); }
  } finally {
    await handle.close();
  }
}

function toItem(row) {
  return {
    id: row.item_id, kind: row.kind, title: row.item_title || row.asset_title,
    mimeType: row.mime_type, sizeBytes: row.size_bytes, sourceUrl: row.source_url || '',
    sourceType: row.source_type || '', storageState: row.storage_state || 'saved',
    createdAt: row.item_created, collectionId: row.collection_id || null,
    favorite: !!row.favorite, fileUrl: `/api/media/assets/${row.asset_id}/file`,
  };
}

export function createCreativeLibraryHandler(opts) {
  const { db, directory, getUser, canCollect, resolveSource, origin, storageInitial, kickStorage } = opts;

  db.exec(`CREATE TABLE IF NOT EXISTS creative_library_collections (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS creative_library_items (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, asset_id TEXT NOT NULL,
    collection_id TEXT, favorite INTEGER NOT NULL DEFAULT 0, title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, asset_id))`);

  db.exec(`CREATE TABLE IF NOT EXISTS creative_library_imports (
    user_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY (user_id, source_type, source_id))`);
  const itemCols = `li.id as item_id, li.collection_id, li.favorite, li.title as item_title, li.created_at as item_created,
    a.id as asset_id, a.kind, a.mime_type, a.size_bytes, a.source_url, a.source_type, a.storage_state,
    a.title as asset_title, a.created_at as asset_created`;
  const selectItemById = db.prepare(`SELECT ${itemCols} FROM creative_library_items li JOIN media_assets a ON a.id = li.asset_id WHERE li.id = ? AND li.user_id = ? AND a.user_id = li.user_id`);
  const selectItemsForUser = db.prepare(`SELECT ${itemCols} FROM creative_library_items li JOIN media_assets a ON a.id = li.asset_id WHERE li.user_id = ? AND a.user_id = ? ORDER BY li.created_at DESC`);
  const selectCollections = db.prepare('SELECT id, name FROM creative_library_collections WHERE user_id = ? ORDER BY created_at');
  const selectUsage = db.prepare(`SELECT COUNT(*) as n, COALESCE(SUM(a.size_bytes),0) as b FROM creative_library_items li JOIN media_assets a ON a.id = li.asset_id WHERE li.user_id = ? AND a.user_id = li.user_id`);
  const findAssetOwned = db.prepare('SELECT * FROM media_assets WHERE id = ? AND user_id = ?');
  const findImportedItem = db.prepare(`SELECT ${itemCols}
    FROM creative_library_imports i
    JOIN creative_library_items li ON li.id = i.asset_id AND li.user_id = i.user_id
    JOIN media_assets a ON a.id = li.asset_id AND a.user_id = li.user_id
    WHERE i.user_id = ? AND i.source_type = ? AND i.source_id = ?`);
  const insertImport = db.prepare('INSERT INTO creative_library_imports (user_id, source_type, source_id, asset_id) VALUES (?, ?, ?, ?)');
  const findMembership = db.prepare('SELECT * FROM creative_library_items WHERE user_id = ? AND asset_id = ?');
  const insertMembership = db.prepare('INSERT INTO creative_library_items (id,user_id,asset_id,collection_id,favorite) VALUES (?,?,?,?,0)');
  const updateMembershipCollection = db.prepare('UPDATE creative_library_items SET collection_id = ? WHERE id = ?');
  const insertCollection = db.prepare('INSERT INTO creative_library_collections (id,user_id,name) VALUES (?,?,?)');
  const findCollectionOwned = db.prepare('SELECT id FROM creative_library_collections WHERE id = ? AND user_id = ?');
  const insertAsset = db.prepare(`INSERT INTO media_assets (id,user_id,kind,origin,file_name,mime_type,size_bytes,title,source_type,source_id,source_url,storage_state,storage_sha256,storage_next_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let active = 0;
  const activeOwners = new Set();

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function withFileSlot(userId, action) {
    if (active >= MAX_CONCURRENT || activeOwners.has(userId)) throw httpError(429, '保存任务繁忙，请稍后重试');
    active += 1;
    activeOwners.add(userId);
    try { return await action(); }
    finally { active -= 1; activeOwners.delete(userId); }
  }

  function checkQuota(userId, addBytes, addItems) {
    const usage = selectUsage.get(userId);
    if (usage.n + addItems > MAX_ITEMS) throw httpError(422, '素材数量已达上限');
    if (usage.b + addBytes > MAX_BYTES) throw httpError(422, '素材容量已达上限');
  }

  async function listLibrary(user, res) {
    const rows = selectItemsForUser.all(user.id, user.id);
    const collections = selectCollections.all(user.id);
    const usage = selectUsage.get(user.id);
    sendJson(res, 200, {
      items: rows.map(toItem), collections,
      limits: { maxBytes: MAX_UPLOAD, maxItems: MAX_ITEMS, maxStorageBytes: MAX_BYTES },
      usage: { items: usage.n, bytes: usage.b },
    });
  }

  async function createCollection(user, req, res) {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (!name) throw httpError(400, '请输入集合名称');
    if (selectCollections.all(user.id).length >= 200) throw httpError(422, '集合数量已达上限');
    const id = crypto.randomUUID();
    insertCollection.run(id, user.id, name);
    sendJson(res, 201, { id, name });
  }

  function assertCollection(user, collectionId) {
    if (collectionId === undefined || collectionId === null) return null;
    if (typeof collectionId !== 'string') throw httpError(400, '集合无效');
    const row = findCollectionOwned.get(collectionId, user.id);
    if (!row) throw httpError(404, '集合不存在');
    return collectionId;
  }

  async function adoptItems(user, req, res) {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.assetIds) && body.assetIds.every(id => typeof id === 'string') ? [...new Set(body.assetIds)] : [];
    if (!ids.length || ids.length > 100) throw httpError(400, '请选择 1 至 100 项作品');
    const hasCollection = Object.prototype.hasOwnProperty.call(body, 'collectionId');
    const collectionId = hasCollection ? assertCollection(user, body.collectionId) : undefined;
    const assets = ids.map(id => {
      const a = findAssetOwned.get(id, user.id);
      if (!a) throw httpError(404, '素材不存在');
      return a;
    });
    transaction(() => {
      let newBytes = 0, newCount = 0;
      for (const a of assets) { if (!findMembership.get(user.id, a.id)) { newBytes += a.size_bytes; newCount += 1; } }
      checkQuota(user.id, newBytes, newCount);
      for (const a of assets) {
        const existing = findMembership.get(user.id, a.id);
        if (existing) { if (hasCollection) updateMembershipCollection.run(collectionId || null, existing.id); }
        else insertMembership.run(a.id, user.id, a.id, collectionId || null);
      }
    });
    const freshRows = selectItemsForUser.all(user.id, user.id);
    const items = assets.map(a => toItem(freshRows.find(r => r.asset_id === a.id)));
    sendJson(res, 200, { items });
  }

  async function patchItem(user, req, res, itemId) {
    const existing = selectItemById.get(itemId, user.id);
    if (!existing) throw httpError(404, '素材不存在');
    const body = await readJsonBody(req);
    const sets = [];
    const vals = [];
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
      sets.push('title = ?'); vals.push(title || null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'collectionId')) {
      const cid = assertCollection(user, body.collectionId);
      sets.push('collection_id = ?'); vals.push(cid || null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'favorite')) {
      sets.push('favorite = ?'); vals.push(body.favorite ? 1 : 0);
    }
    if (sets.length) {
      db.prepare(`UPDATE creative_library_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, itemId, user.id);
    }
    const updated = selectItemById.get(itemId, user.id);
    sendJson(res, 200, { item: toItem(updated) });
  }

  async function commitFile(user, staged, { collectionId, title, sourceType, sourceId, sourceUrl }) {
    const id = crypto.randomUUID();
    const fileName = `${id}.${staged.type.ext}`;
    const finalPath = path.join(directory, fileName);
    let renamed = false;
    let created = false;
    let item;
    try {
      item = transaction(() => {
        const existing = sourceType && findImportedItem.get(user.id, sourceType, sourceId);
        if (existing) return toItem(existing);
        assertCollection(user, collectionId);
        checkQuota(user.id, staged.size, 1);
        const storage = storageInitial(staged.sha256);
        fs.renameSync(staged.temporary, finalPath);
        renamed = true;
        insertAsset.run(id, user.id, staged.type.kind, sourceType ? 'import' : 'upload', fileName,
          staged.type.mime, staged.size, title || '未命名素材', sourceType ? 'omniget' : '', sourceId || null,
          sanitizeUrl(sourceUrl), storage.storageState, storage.storageSha256, storage.storageNextAt);
        insertMembership.run(id, user.id, id, collectionId);
        if (sourceType) insertImport.run(user.id, sourceType, sourceId, id);
        return toItem(selectItemById.get(id, user.id));
      });
      created = renamed;
    } finally {
      if (!renamed) await fsp.rm(staged.temporary, { force: true });
      else if (!created) await fsp.rm(finalPath, { force: true });
    }
    if (created) kickStorage();
    return item;
  }

  const pendingImports = new Map();

  async function importItem(user, req, res) {
    if (!canCollect(user)) throw httpError(403, '当前账号未获 OmniGet 权限');
    const { sourceType, sourceId, collectionId: selected } = await readJsonBody(req);
    if (!['queue', 'job'].includes(sourceType) || typeof sourceId !== 'string' || !/^[a-f0-9-]{36}$/.test(sourceId)) {
      throw httpError(400, '收集记录无效');
    }
    const collectionId = assertCollection(user, selected);
    const existing = findImportedItem.get(user.id, sourceType, sourceId);
    if (existing) return sendJson(res, 201, { item: toItem(existing) });
    const key = JSON.stringify([user.id, sourceType, sourceId]);
    let operation = pendingImports.get(key);
    if (!operation) {
      operation = withFileSlot(user.id, async () => {
        checkQuota(user.id, 0, 1);
        const source = await resolveSource(user.id, sourceType, sourceId);
        checkQuota(user.id, source.size, 1);
        const staged = await stageDownload(source, directory);
        return commitFile(user, staged, {
          collectionId, title: String(source.title || '').trim().slice(0, 160),
          sourceType, sourceId, sourceUrl: source.url,
        });
      }).finally(() => pendingImports.delete(key));
      pendingImports.set(key, operation);
    }
    sendJson(res, 201, { item: await operation });
  }

  async function uploadItem(user, req, res) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const title = (params.get('title') || '').trim().slice(0, 160);
    const collectionId = assertCollection(user, params.get('collectionId') || null);
    const item = await withFileSlot(user.id, async () => {
      const length = Number(req.headers['content-length'] || 0);
      if (length > MAX_UPLOAD) throw httpError(413, '文件超过 100 MB');
      checkQuota(user.id, length, 1);
      return commitFile(user, await stageMedia(req, directory), { collectionId, title });
    });
    sendJson(res, 201, { item });
  }

  async function process(req, res, pathname) {
    try {
      if (req.method !== 'GET' && !sameOrigin(req, origin)) { sendJson(res, 403, { error: '请求来源不可信' }); return; }
      const user = getUser(req);
      if (!user) { sendJson(res, 401, { error: '请先登录' }); return; }
      const sub = pathname.slice(BASE.length) || '/';
      if (req.method === 'GET' && sub === '/') return await listLibrary(user, res);
      if (req.method === 'POST' && sub === '/collections') return await createCollection(user, req, res);
      if (req.method === 'POST' && sub === '/items') return await adoptItems(user, req, res);
      if (req.method === 'PATCH' && sub.startsWith('/items/')) return await patchItem(user, req, res, sub.slice('/items/'.length));
      if (req.method === 'POST' && sub === '/imports') return await importItem(user, req, res);
      if (req.method === 'POST' && sub === '/uploads') return await uploadItem(user, req, res);
      sendJson(res, 404, { error: '接口不存在' });
    } catch (err) {
      const status = err?.httpStatus || err?.status || 500;
      sendJson(res, status, { error: status < 500 ? err.message : '暂时无法保存素材，请重试' });
    }
  }

  return async function handle(req, res, pathname) {
    if (typeof pathname !== 'string') return false;
    if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return false;
    await process(req, res, pathname);
    return true;
  };
}
