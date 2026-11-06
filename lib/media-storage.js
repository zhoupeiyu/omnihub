import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Private COS persistence for creative media: uploads, imported references,
// provider results and local-image returns.  Every file is written to the
// website server first; COS is an additional private copy under
// creative-media/v1/users/ only.  The X bookmark archive (x-bookmarks/) and AI
// reference library (ai-reference/) prefixes are never read or written here.
export const CREATIVE_MEDIA_PREFIX = 'creative-media/v1/users/';
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', wav: 'audio/wav', mp3: 'audio/mpeg' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^creative-media\/v1\/users\/([1-9][0-9]{0,15})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|gif|mp4|wav|mp3)$/;
const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|gif|mp4|wav|mp3)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OBJECT = 200 * 1024 ** 2;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
// Stable, user-facing messages.  SDK errors can contain signed request details,
// so they are never stored or returned.
export const MEDIA_STORAGE_MESSAGES = {
  not_configured: '云端存储配置不完整，文件已保存到服务器',
  permission: '云端存储没有写入权限，文件已保存到服务器，可稍后重试',
  write_failed: '云端保存失败，文件已保存到服务器，可稍后重试',
  verify_failed: '云端保存校验未通过，可稍后重试',
  read_failed: '暂时无法从云端读取文件，请稍后重试',
  restore_verify_failed: '云端副本校验未通过，未写入服务器',
  restore_failed: '已从云端取回文件，但写入服务器失败，请稍后重试',
  conflict: '云端已有内容不同的同名文件，已停止覆盖',
  local_missing: '服务器上的文件缺失，无法保存到云端',
  local_changed: '服务器上的文件与保存时不一致，已停止云端保存',
  too_large: '文件超过云端保存大小上限',
  invalid_record: '作品记录不完整，无法保存到云端',
};
const TERMINAL = new Set(['conflict', 'local_missing', 'local_changed', 'too_large', 'invalid_record']);
const STORAGE_CODE = Symbol('mediaStorageCode');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const storageError = code => Object.assign(new Error(`media_storage_${code}`), { [STORAGE_CODE]: code });
const codeOf = error => Object.hasOwn(MEDIA_STORAGE_MESSAGES, error?.[STORAGE_CODE] || '') ? error[STORAGE_CODE] : 'write_failed';
export const mediaStorageRetryDelay = attempt => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempt - 1), 6));

// Flushes a freshly written local file to disk and returns its SHA-256 by
// streaming, so the expected hash recorded with the asset row never needs the
// whole file in memory.
export async function syncAndHashFile(file) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return hashFile(file);
}

// Streams a file through SHA-256 without holding it in memory.
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Small FIFO limiter shared by every upload and restore of one persistence
// instance, bounding both concurrent requests and buffered bytes.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { work, resolve, reject } = queue.shift();
    Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return { run: work => new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); next(); }) };
}

// Keys are derived only from the owning account and server-generated asset id;
// no browser value participates.  Reads re-derive the key, so a row can never
// point at another account's object or at another prefix.
export function creativeMediaKey(userId, assetId, extension) {
  const owner = Number(userId);
  if (!Number.isSafeInteger(owner) || owner < 1 || String(owner) !== String(userId)) throw new Error('invalid_media_owner');
  if (typeof assetId !== 'string' || !UUID.test(assetId)) throw new Error('invalid_media_asset');
  if (!Object.hasOwn(TYPES, extension)) throw new Error('invalid_media_extension');
  return `${CREATIVE_MEDIA_PREFIX}${owner}/${assetId}.${extension}`;
}

export function parseCreativeMediaKey(key) {
  const match = KEY.exec(typeof key === 'string' ? key : '');
  return match ? { userId: Number(match[1]), assetId: match[2], extension: match[3], contentType: TYPES[match[3]] } : null;
}

// Minimum CAM statement the service identity needs.  Parent applies it
// separately; this module never changes permissions itself.
export function creativeMediaPolicy({ bucket = 'omnihub-media-1319495021', region = 'ap-hongkong' } = {}) {
  const appId = /-(\d+)$/.exec(bucket)?.[1];
  if (!appId) throw new Error('invalid_bucket_name');
  return { version: '2.0', statement: [{ effect: 'allow',
    action: ['name/cos:GetObject', 'name/cos:HeadObject', 'name/cos:PutObject'],
    resource: [`qcs::cos:${region}:uid/${appId}:${bucket}/${CREATIVE_MEDIA_PREFIX}*`] }] };
}

// Opt-in only: OMNIHUB_MEDIA_STORAGE=cos.  Without it every asset stays on the
// server, exactly as before.  Requested but incomplete configuration is
// reported on each new asset rather than silently ignored.
export function createMediaStorage({ env = process.env, cos: providedCos } = {}) {
  const requested = String(env.OMNIHUB_MEDIA_STORAGE || '').trim().toLowerCase() === 'cos';
  const bucket = env.COS_BUCKET || '', region = env.COS_REGION || '';
  const complete = Boolean(bucket && region && (providedCos || (env.COS_SECRET_ID && env.COS_SECRET_KEY)));
  const mode = !requested ? 'local' : complete ? 'cos' : 'misconfigured';
  let client = providedCos;
  async function cos() {
    if (mode !== 'cos') throw storageError('not_configured');
    if (!client) {
      try {
        const { default: COS } = await import('cos-nodejs-sdk-v5');
        client = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY,
          Protocol: 'https:', StrictSsl: true, FollowRedirect: false, Timeout: 30000 });
      } catch { throw storageError('not_configured'); }
    }
    return client;
  }
  const target = Key => ({ Bucket: bucket, Region: region, Key });
  const statusOf = error => Number(error?.statusCode);
  async function put({ userId, assetId, extension, bytes, contentType, sha256: expected }) {
    if (mode === 'local') return { state: 'local' };
    let key;
    try { key = creativeMediaKey(userId, assetId, extension); } catch { throw storageError('invalid_record'); }
    if (TYPES[extension] !== contentType || !Buffer.isBuffer(bytes) || bytes.length < 1) throw storageError('invalid_record');
    if (bytes.length > MAX_OBJECT) throw storageError('too_large');
    const sha256 = digest(bytes);
    if (expected !== undefined && expected !== sha256) throw storageError('local_changed');
    const connection = await cos();
    const matches = response => Number(response?.headers?.['content-length']) === bytes.length
      && response.headers['x-cos-meta-sha256'] === sha256;
    let existing;
    try { existing = await connection.headObject(target(key)); }
    catch (error) {
      if (statusOf(error) === 403) throw storageError('permission');
      if (statusOf(error) !== 404) throw storageError('write_failed');
    }
    if (existing) {
      // An earlier attempt may have written the object before the process
      // stopped; identical bytes are accepted, different bytes never replaced.
      if (!matches(existing)) throw storageError('conflict');
      return { state: 'stored', key, sha256, bytes: bytes.length };
    }
    // No ACL header: the object inherits the private bucket ACL.  Content-MD5
    // makes COS reject a body corrupted in transit.
    try {
      await connection.putObject({ ...target(key), Body: bytes, ContentLength: bytes.length, ContentType: contentType,
        ContentMD5: createHash('md5').update(bytes).digest('base64'),
        StorageClass: 'STANDARD', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store',
        'x-cos-meta-sha256': sha256, Headers: { 'x-cos-forbid-overwrite': 'true' } });
    } catch (error) { throw storageError(statusOf(error) === 403 ? 'permission' : 'write_failed'); }
    let check;
    try { check = await connection.headObject(target(key)); } catch { throw storageError('verify_failed'); }
    if (!matches(check)) throw storageError('verify_failed');
    return { state: 'stored', key, sha256, bytes: bytes.length };
  }
  async function read({ userId, assetId, extension, key, sha256, bytes }) {
    let expected;
    try { expected = creativeMediaKey(userId, assetId, extension); } catch { throw storageError('invalid_record'); }
    if (key !== expected || !SHA256.test(sha256 || '') || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_OBJECT)
      throw storageError('invalid_record');
    const connection = await cos();
    let response;
    try { response = await connection.getObject({ ...target(key), Range: `bytes=0-${bytes - 1}` }); }
    catch (error) { throw storageError(statusOf(error) === 403 ? 'permission' : 'read_failed'); }
    const body = Buffer.isBuffer(response?.Body) ? response.Body : Buffer.from(response?.Body || '');
    if (body.length !== bytes || digest(body) !== sha256) throw storageError('restore_verify_failed');
    return body;
  }
  return { mode, put, read };
}

const STORAGE_COLUMNS = [
  ['storage_state', "storage_state TEXT NOT NULL DEFAULT 'local'"],
  ['storage_key', "storage_key TEXT NOT NULL DEFAULT ''"],
  ['storage_sha256', "storage_sha256 TEXT NOT NULL DEFAULT ''"],
  ['storage_error', "storage_error TEXT NOT NULL DEFAULT ''"],
  ['storage_attempts', 'storage_attempts INTEGER NOT NULL DEFAULT 0'],
  ['storage_next_at', 'storage_next_at INTEGER NOT NULL DEFAULT 0'],
];

// Existing rows default to 'local' and keep reading from the local file.
export function ensureMediaStorageColumns(db) {
  const present = new Set(db.prepare('PRAGMA table_info(media_assets)').all().map(column => column.name));
  for (const [name, definition] of STORAGE_COLUMNS) if (!present.has(name)) db.exec(`ALTER TABLE media_assets ADD COLUMN ${definition}`);
}

const ROW = `id, user_id AS userId, file_name AS fileName, mime_type AS mimeType, size_bytes AS sizeBytes,
  storage_state AS storageState, storage_key AS storageKey, storage_sha256 AS storageSha256,
  storage_attempts AS storageAttempts, storage_next_at AS storageNextAt`;
const extensionOf = row => { const match = FILE.exec(row?.fileName || ''); return match && match[1] === row.id ? match[2] : null; };
const safeLocalName = name => typeof name === 'string' && name.length > 0 && path.basename(name) === name && !name.startsWith('.');

// Durable queue: an asset row is inserted already 'pending' (with its
// expected SHA-256 and size), in the same statement/transaction as the asset
// itself.  A crash at any later point leaves a pending row that the worker
// resumes after restart; an object already written by an interrupted attempt
// is recognised by HEAD and never rewritten.
export function createMediaPersistence({ db, directory, storage, now = Date.now }) {
  ensureMediaStorageColumns(db);
  const inflight = new Map(), rerun = new Set();
  // Uploads and restores each buffer a whole object (up to MAX_OBJECT), so
  // they share a single slot: at most one object is held in memory per
  // persistence instance.  The former uploadConcurrency/restoreConcurrency
  // options are deliberately ignored until transfers stream.
  const transfers = limiter(1);
  const rowFor = (userId, assetId) => db.prepare(`SELECT ${ROW} FROM media_assets WHERE user_id=? AND id=?`).get(userId, assetId);
  const once = (key, work) => {
    if (!inflight.has(key)) inflight.set(key, work().finally(() => inflight.delete(key)));
    return inflight.get(key);
  };

  // Column values for a new asset row.  Callers include them in the INSERT so
  // the queue entry is committed atomically with the asset.
  function initialStorage({ sha256 }) {
    if (!SHA256.test(sha256 || '')) throw new Error('invalid_media_sha256');
    return { storageState: storage.mode === 'local' ? 'local' : 'pending', storageSha256: sha256, storageNextAt: 0 };
  }

  // Attempts are reserved durably before any COS request, so a crash loop
  // still consumes the bounded budget.  finish() records the outcome only
  // while the row still holds this attempt's reservation: a manual retry that
  // reset the budget mid-flight is never overwritten by the older result.
  function finish(row, code) {
    const attempts = Number(row.storageAttempts || 0);
    const final = TERMINAL.has(code) || attempts >= MAX_ATTEMPTS;
    db.prepare(`UPDATE media_assets SET storage_state=?, storage_error=?, storage_next_at=?
      WHERE id=? AND user_id=? AND storage_state='pending' AND storage_attempts=?`)
      .run(final ? 'failed' : 'pending', MEDIA_STORAGE_MESSAGES[code], final ? 0 : now() + mediaStorageRetryDelay(attempts), row.id, row.userId, attempts);
  }
  async function attempt(row) {
    const extension = extensionOf(row);
    if (!extension || !safeLocalName(row.fileName)) return finish(row, 'invalid_record');
    const expectedSize = Number(row.sizeBytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) return finish(row, 'invalid_record');
    if (expectedSize > MAX_OBJECT) return finish(row, 'too_large');
    const file = path.join(directory, row.fileName);
    let bytes;
    try {
      const details = await stat(file);
      if (!details.isFile()) return finish(row, 'local_missing');
      // Truncated or expanded files are rejected before reading them.
      if (details.size !== expectedSize) return finish(row, 'local_changed');
      bytes = await readFile(file);
    } catch { return finish(row, 'local_missing'); }
    if (bytes.length !== expectedSize) return finish(row, 'local_changed');
    const sha256 = digest(bytes);
    // Rows created by this module carry the hash recorded at the initial
    // write; same-size modifications are rejected.  Legacy rows only have the
    // recorded size, which was checked above.
    if (row.storageSha256 && row.storageSha256 !== sha256) return finish(row, 'local_changed');
    try {
      const result = await storage.put({ userId: row.userId, assetId: row.id, extension, bytes, contentType: row.mimeType, sha256 });
      if (result.state !== 'stored') return;
      if (result.sha256 !== sha256 || result.bytes !== expectedSize) return finish(row, 'verify_failed');
      db.prepare(`UPDATE media_assets SET storage_state='stored', storage_key=?, storage_sha256=?, storage_error='', storage_next_at=0
        WHERE id=? AND user_id=? AND storage_state='pending' AND storage_attempts=?`).run(result.key, sha256, row.id, row.userId, row.storageAttempts);
    } catch (error) { finish(row, codeOf(error)); }
  }
  const due = (userId, assetId) => {
    const row = rowFor(userId, assetId);
    return row?.storageState === 'pending' && Number(row.storageNextAt) <= now();
  };
  async function uploadOnce(userId, assetId) {
    let row = rowFor(userId, assetId);
    if (!row || storage.mode === 'local' || row.storageState === 'stored' || row.storageState === 'failed') return;
    if (row.storageState !== 'pending') {
      db.prepare(`UPDATE media_assets SET storage_state='pending', storage_error='', storage_next_at=0
        WHERE id=? AND user_id=? AND storage_state=?`).run(row.id, row.userId, row.storageState);
      row = rowFor(userId, assetId);
      if (row?.storageState !== 'pending') return;
    }
    const previous = Number(row.storageAttempts || 0);
    if (previous >= MAX_ATTEMPTS) return finish(row, 'write_failed');
    const attempts = previous + 1;
    const reserved = db.prepare(`UPDATE media_assets SET storage_attempts=?, storage_next_at=?
      WHERE id=? AND user_id=? AND storage_state='pending' AND storage_attempts=?`)
      .run(attempts, now() + mediaStorageRetryDelay(attempts), row.id, row.userId, previous).changes;
    if (!reserved) return;
    await attempt({ ...row, storageAttempts: attempts });
  }
  // One upload per asset at a time.  A request that arrives while it is in
  // flight (manual retry, kick, direct persist) is remembered: once the
  // current attempt settles, a fresh one runs if the row is still pending and
  // due, e.g. because a manual retry reset it mid-flight.  inflight is cleared
  // in the same tick as the last check, so no request can fall in between.
  function run(userId, assetId) {
    const key = `put:${userId}:${assetId}`;
    if (inflight.has(key)) { rerun.add(key); return inflight.get(key); }
    const work = (async () => {
      try {
        do {
          rerun.delete(key);
          await transfers.run(() => uploadOnce(userId, assetId));
        } while (rerun.has(key) && due(userId, assetId));
      } finally { inflight.delete(key); rerun.delete(key); }
    })();
    inflight.set(key, work);
    return work;
  }
  // Immediate attempt (migration, tests).  Never throws: storage is a copy of
  // a file that is already saved on the server.  Failed rows wait for a
  // manual retry.
  async function persistAsset(userId, assetId) {
    try {
      const row = rowFor(userId, assetId);
      if (!row || row.storageState === 'stored' || row.storageState === 'failed' || storage.mode === 'local') return row || null;
      await run(row.userId, row.id);
      return rowFor(userId, assetId);
    } catch { return null; }
  }
  async function retryDue({ limit = 10 } = {}) {
    if (storage.mode === 'local') return 0;
    const rows = db.prepare(`SELECT user_id AS userId, id FROM media_assets WHERE storage_state='pending' AND storage_next_at<=?
      ORDER BY storage_next_at, id LIMIT ?`).all(now(), limit);
    await Promise.all(rows.map(row => run(row.userId, row.id).catch(() => {})));
    return rows.length;
  }
  // Non-blocking background drain; request handlers call this after their
  // durable commit and respond without waiting for any COS I/O.
  let draining = null, again = false;
  function kick() {
    if (storage.mode === 'local') return;
    if (draining) { again = true; return; }
    draining = (async () => {
      do { again = false; await retryDue(); } while (again);
    })().catch(() => {}).finally(() => { draining = null; });
  }
  const idle = async () => { while (draining) await draining; };
  // Marks an existing asset (e.g. a generated result saved before a crash)
  // for upload, then wakes the worker.
  function enqueue(userId, assetId) {
    if (storage.mode === 'local') return;
    db.prepare(`UPDATE media_assets SET storage_state='pending', storage_error='', storage_next_at=0
      WHERE id=? AND user_id=? AND storage_state='local'`).run(assetId, userId);
    kick();
  }
  // A person asked for another try: durably start a fresh attempt budget and
  // queue it.  Only the storage columns change; the job is untouched.
  async function retryAsset(userId, assetId) {
    const row = rowFor(userId, assetId);
    if (!row) return null;
    if (row.storageState === 'stored' || storage.mode === 'local') return row;
    db.prepare(`UPDATE media_assets SET storage_state='pending', storage_attempts=0, storage_next_at=0, storage_error=''
      WHERE id=? AND user_id=? AND storage_state<>'stored'`).run(row.id, row.userId);
    kick();
    return rowFor(userId, assetId);
  }
  async function restore(row, bytes) {
    const destination = path.join(directory, row.fileName);
    const temp = path.join(directory, `${row.id}.${randomUUID()}.restore`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      const handle = await open(temp, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      // Only a temp file that hashes to the recorded value replaces the
      // server file, so a partial or corrupt write is never put in place.
      if (await hashFile(temp) !== row.storageSha256) throw new Error('restore_mismatch');
      await rename(temp, destination);
      const details = await stat(destination);
      if (!details.isFile() || details.size !== bytes.length) throw new Error('restore_mismatch');
    } catch {
      await rm(temp, { force: true }).catch(() => {});
      throw storageError('restore_failed');
    }
  }
  // Rows with a verified COS copy must match the recorded size and SHA-256
  // before the server file is used; legacy and not-yet-stored rows keep
  // serving the server file as before.
  const verifiable = row => row.storageState === 'stored' && SHA256.test(row.storageSha256 || '');
  const intactBytes = (row, bytes) => !verifiable(row)
    || (bytes.length === Number(row.sizeBytes) && digest(bytes) === row.storageSha256);
  async function intactFile(row, file) {
    const details = await stat(file);
    if (!details.isFile()) return false;
    if (!verifiable(row)) return true;
    return details.size === Number(row.sizeBytes) && await hashFile(file) === row.storageSha256;
  }
  // Server file first (legacy rows and the normal cache); COS only for rows
  // this account has a verified stored copy of, when the server file is
  // missing or no longer matches that copy.
  async function readBytes(userId, assetId) {
    const row = rowFor(userId, assetId);
    if (!row) throw { status: 404, message: '作品不存在' };
    if (safeLocalName(row.fileName)) {
      try {
        const bytes = await readFile(path.join(directory, row.fileName));
        if (intactBytes(row, bytes)) return bytes;
      } catch { /* fall back to the private COS copy */ }
    }
    return recover(row);
  }
  async function recover(row) {
    const extension = extensionOf(row);
    if (row.storageState !== 'stored' || !extension || storage.mode !== 'cos') throw { status: 404, message: '作品文件待恢复' };
    try {
      return await once(`read:${row.userId}:${row.id}`, () => transfers.run(async () => {
        const bytes = await storage.read({ userId: row.userId, assetId: row.id, extension, key: row.storageKey,
          sha256: row.storageSha256, bytes: Number(row.sizeBytes) });
        await restore(row, bytes);
        return bytes;
      }));
    } catch (error) {
      const code = codeOf(error);
      const visible = code === 'restore_failed' || code === 'restore_verify_failed' ? code : 'read_failed';
      throw { status: 503, message: MEDIA_STORAGE_MESSAGES[visible] };
    }
  }
  async function ensureLocal(userId, assetId) {
    const row = rowFor(userId, assetId);
    if (!row) throw { status: 404, message: '作品不存在' };
    if (safeLocalName(row.fileName)) {
      try { if (await intactFile(row, path.join(directory, row.fileName))) return; } catch { /* restore below */ }
    }
    await recover(row);
  }
  async function migrate({ dryRun = true, limit = 50 } = {}) {
    const rows = db.prepare(`SELECT ${ROW} FROM media_assets ORDER BY created_at, id`).all();
    const plan = await planMediaStorageMigration({ rows, directory });
    if (dryRun) return plan;
    if (storage.mode !== 'cos') throw new Error('media_storage_not_enabled');
    const results = { stored: 0, pending: 0, failed: 0 };
    // Each upload re-verifies size (and hash when recorded) at attempt time,
    // so the dry-run check also holds for the actual upload.
    for (const item of plan.items.filter(entry => entry.action === 'upload').slice(0, limit)) {
      const row = await persistAsset(item.userId, item.assetId);
      if (row && Object.hasOwn(results, row.storageState)) results[row.storageState] += 1;
    }
    return { ...plan, dryRun: false, results };
  }
  return { initialStorage, persistAsset, enqueue, kick, idle, retryAsset, retryDue, readBytes, ensureLocal, migrate };
}

// Offline plan: inspects only the database rows and local files.  It makes no
// COS request and writes nothing.
export async function planMediaStorageMigration({ rows, directory }) {
  const items = [], counts = {};
  for (const row of rows) {
    const extension = extensionOf(row);
    let action, key = '';
    if (row.storageState === 'stored') action = 'already_stored';
    else if (!extension || !Number.isSafeInteger(Number(row.userId)) || Number(row.userId) < 1) action = 'invalid_record';
    else {
      try {
        const details = await stat(path.join(directory, row.fileName));
        action = details.size > MAX_OBJECT ? 'too_large' : details.size === Number(row.sizeBytes) ? 'upload' : 'size_mismatch';
      } catch { action = 'missing_local'; }
      if (action === 'upload') key = creativeMediaKey(Number(row.userId), row.id, extension);
    }
    counts[action] = (counts[action] || 0) + 1;
    items.push({ assetId: row.id, userId: Number(row.userId), action, key, bytes: Number(row.sizeBytes) || 0 });
  }
  return { dryRun: true, prefix: CREATIVE_MEDIA_PREFIX, total: rows.length, counts, items };
}

// Usage: node --input-type=module -e "import {dryRunMediaStorageMigration as d} from './lib/media-storage.js';
//   console.log(JSON.stringify(await d({databasePath:'data/app.db',directory:'data/media'}),null,2))"
// Opens the database read-only and tolerates databases without storage columns.
export async function dryRunMediaStorageMigration({ db, databasePath, directory }) {
  let handle = db, close = false;
  if (!handle) {
    const { DatabaseSync } = await import('node:sqlite');
    handle = new DatabaseSync(databasePath, { readOnly: true });
    close = true;
  }
  try {
    const columns = new Set(handle.prepare('PRAGMA table_info(media_assets)').all().map(column => column.name));
    const state = columns.has('storage_state') ? 'storage_state' : "'local'";
    const rows = handle.prepare(`SELECT id, user_id AS userId, file_name AS fileName, size_bytes AS sizeBytes, ${state} AS storageState
      FROM media_assets ORDER BY created_at, id`).all();
    return await planMediaStorageMigration({ rows, directory });
  } finally { if (close) handle.close(); }
}
