import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'interrupted', 'expired']);
const RUNNING = new Set(['parsing', 'downloading', 'cancelling']);
const NEXT = {
  queued: new Set(['parsing', 'cancelled']),
  parsing: new Set(['parsed', 'failed', 'cancelling', 'interrupted']),
  parsed: new Set(['awaiting_choice', 'downloading', 'cancelled']),
  awaiting_choice: new Set(['downloading', 'cancelled']),
  downloading: new Set(['ready', 'failed', 'cancelling', 'interrupted']),
  cancelling: new Set(['cancelled', 'failed', 'interrupted']),
  interrupted: new Set(['queued', 'cancelled']),
  failed: new Set(['queued', 'cancelled']),
  ready: new Set(['expired']),
  cancelled: new Set(),
  expired: new Set(['queued']),
};

const failure = (status, message) => Object.assign(new Error(message), { status });
const MAX_JSON_BYTES = 8 * 1024;
const MAX_ERROR_BYTES = 512;

function ownerId(owner) {
  const value = String(owner ?? '');
  if (!value || value.length > 160) throw failure(400, '无效的用户标识');
  return value;
}

function json(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, `${label}必须是对象`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure(400, `${label}无法序列化`); }
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw failure(413, `${label}过大`);
  return encoded;
}

function displayUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return ''; }
}

function publicRow(record) {
  if (!record) return null;
  let options = {}, metadata = {};
  try { options = JSON.parse(record.options_json); } catch { /* legacy corrupt rows are not exposed */ }
  try { metadata = JSON.parse(record.metadata_json); } catch { /* legacy corrupt rows are not exposed */ }
  return {
    // Keep query strings (which can contain platform identifiers or signing
    // tokens) out of browser history/list responses. Workers get rawUrl only.
    id: record.id, url: displayUrl(record.url), state: record.state, source: record.source,
    options, metadata, error: record.error || '', attempts: record.attempts,
    createdAt: record.created_at, updatedAt: record.updated_at,
    startedAt: record.started_at || null, finishedAt: record.finished_at || null,
  };
}
function workerRow(record) {
  const result = publicRow(record);
  return result && { ...result, owner: record.owner, url: record.url };
}

/**
 * Durable, owner-isolated scheduling state for OmniGet. It deliberately has
 * no network or filesystem execution capability: the HTTP handler validates
 * URLs before enqueueing, and a local runner claims then completes jobs.
 */
export function createOmnigetQueue({
  db: providedDb,
  databasePath = ':memory:',
  now = () => Date.now(),
  validateUrl = value => value,
  maxBatch = 10,
  maxQueuedPerUser = 20,
  maxQueuedGlobal = 200,
  maxGlobalRunning = 2,
  maxUserRunning = 1,
} = {}) {
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 10) throw new TypeError('maxBatch必须在1至10之间');
  const db = providedDb || new DatabaseSync(databasePath);
  const ownsDb = !providedDb;
  if (ownsDb && databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS omniget_queue_jobs(
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      options_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      gc_token TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS omniget_queue_owner_created ON omniget_queue_jobs(owner, created_at DESC);
    CREATE INDEX IF NOT EXISTS omniget_queue_state_created ON omniget_queue_jobs(state, created_at, id);`);
  if (!db.prepare("PRAGMA table_info(omniget_queue_jobs)").all().some(column => column.name === 'gc_token')) {
    db.exec("ALTER TABLE omniget_queue_jobs ADD COLUMN gc_token TEXT NOT NULL DEFAULT ''");
  }
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const recover = () => {
    const at = now();
    return transaction(() => {
      const interrupted=db.prepare(`UPDATE omniget_queue_jobs
        SET state='interrupted', error='服务重启，任务未自动重试', updated_at=?, finished_at=?
        WHERE state IN ('parsing','downloading','cancelling')`).run(at, at).changes;
      // A previous process cannot finish an in-flight GC. Release its ticket
      // after restart; no runner from this process is treated as cleanup proof.
      db.prepare(`UPDATE omniget_queue_jobs SET gc_token=''
        WHERE state IN ('failed','cancelled','interrupted') AND gc_token<>''`).run();
      return interrupted;
    });
  };
  recover();

  function visible(owner, id) {
    return db.prepare('SELECT * FROM omniget_queue_jobs WHERE id=? AND owner=?').get(id, ownerId(owner));
  }
  function count(owner, states) {
    const clauses = states.map(() => '?').join(',');
    return db.prepare(`SELECT count(*) AS total FROM omniget_queue_jobs WHERE owner=? AND state IN (${clauses})`)
      .get(owner, ...states).total;
  }
  function queueTotal() {
    return db.prepare(`SELECT count(*) AS total FROM omniget_queue_jobs
      WHERE state IN ('queued','parsing','parsed','awaiting_choice','downloading','cancelling')`).get().total;
  }
  function transition(owner, id, from, to, values = {}) {
    if (!Array.isArray(from) || !from.length || !NEXT[from[0]]?.has(to) && from.length === 1) throw new TypeError('无效的状态变迁');
    const at = now(), error = String(values.error || '').slice(0, MAX_ERROR_BYTES);
    const metadata = values.metadata === undefined ? null : json(values.metadata, 'metadata');
    const started = RUNNING.has(to) ? at : 0;
    const finished = TERMINAL.has(to) ? at : 0;
    const stateSql = from.map(() => '?').join(',');
    const result = db.prepare(`UPDATE omniget_queue_jobs
      SET state=?, updated_at=?, error=?, metadata_json=COALESCE(?,metadata_json),
          started_at=CASE WHEN ? > 0 THEN ? ELSE started_at END,
          finished_at=CASE WHEN ? > 0 THEN ? ELSE finished_at END
      WHERE id=? AND owner=? AND state IN (${stateSql})`)
      .run(to, at, error, metadata, started, started, finished, finished, id, ownerId(owner), ...from);
    return result.changes === 1 ? publicRow(visible(owner, id)) : null;
  }

  function enqueue(owner, urls, { options = {}, source = 'manual' } = {}) {
    owner = ownerId(owner);
    if (!Array.isArray(urls) || !urls.length || urls.length > maxBatch) throw failure(400, `一次最多添加${maxBatch}条链接`);
    if (typeof source !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(source)) throw failure(400, '无效的任务来源');
    const optionsJson = json(options, 'options');
    // Every URL is checked before opening a write transaction, so invalid
    // batches cannot create a partial task history.
    const canonical = urls.map(value => {
      if (typeof value !== 'string' || value.length > 2048) throw failure(400, '请输入有效的作品链接');
      const checked = validateUrl(value);
      if (typeof checked !== 'string' || !checked) throw failure(400, '请输入有效的作品链接');
      return checked;
    });
    if (new Set(canonical).size !== canonical.length) throw failure(400, '批量链接不能重复');
    return transaction(() => {
      const active = ['queued', 'parsing', 'parsed', 'awaiting_choice', 'downloading', 'cancelling'];
      if (count(owner, active) + canonical.length > maxQueuedPerUser) throw failure(429, '当前账号任务较多，请稍后再试');
      if (queueTotal() + canonical.length > maxQueuedGlobal) throw failure(429, '下载队列已满，请稍后再试');
      const insert = db.prepare(`INSERT INTO omniget_queue_jobs
        (id,owner,url,source,options_json,state,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)`);
      return canonical.map(url => {
        const id = randomUUID(), createdAt = now();
        insert.run(id, owner, url, source, optionsJson, createdAt, createdAt);
        return publicRow(visible(owner, id));
      });
    });
  }

  function claimNext({ canRun } = {}) {
    if (canRun !== undefined && typeof canRun !== 'function') throw new TypeError('canRun必须是函数');
    return transaction(() => {
      const globalRunning = db.prepare(`SELECT count(*) AS total FROM omniget_queue_jobs
        WHERE state IN ('parsing','downloading','cancelling')`).get().total;
      if (globalRunning >= maxGlobalRunning) return null;
      const candidates = db.prepare(`SELECT * FROM omniget_queue_jobs WHERE state='queued'
        ORDER BY created_at,id LIMIT 100`).all();
      for (const candidate of candidates) {
        if (count(candidate.owner, ['parsing', 'downloading', 'cancelling']) >= maxUserRunning) continue;
        // Let the caller include legacy in-memory work before a durable claim.
        // A rejected candidate remains queued; the conditional UPDATE below is
        // still the final compare-and-swap acquisition.
        if (canRun?.(workerRow(candidate)) === false) continue;
        const at = now();
        const changed = db.prepare(`UPDATE omniget_queue_jobs
          SET state='parsing', attempts=attempts+1, error='', started_at=?, updated_at=?, finished_at=0
          WHERE id=? AND owner=? AND state='queued'`).run(at, at, candidate.id, candidate.owner).changes;
        if (changed) return workerRow(visible(candidate.owner, candidate.id));
      }
      return null;
    });
  }

  function beginDownload(owner, id) {
    return transition(owner, id, ['awaiting_choice'], 'downloading');
  }
  function recordParsed(owner, id, { metadata = {} } = {}) {
    return transition(owner, id, ['parsing'], 'parsed', { metadata });
  }
  function routeParsed(owner, id) {
    const current = visible(owner, id);
    if (!current || current.state !== 'parsed') return null;
    let options = {};
    try { options = JSON.parse(current.options_json); } catch { /* validated on write */ }
    return transition(owner, id, ['parsed'], options.autoDownload === true ? 'downloading' : 'awaiting_choice');
  }
  function requestCancel(owner, id) {
    const current = visible(owner, id);
    if (!current) return null;
    if (current.state === 'cancelling') return null;
    if (RUNNING.has(current.state)) return transition(owner, id, [current.state], 'cancelling');
    if (['queued', 'parsed', 'awaiting_choice', 'failed', 'interrupted'].includes(current.state))
      return transition(owner, id, [current.state], 'cancelled');
    return null;
  }
  function complete(owner, id, { state, error = '', metadata } = {}) {
    if (!['ready', 'failed', 'cancelled'].includes(state)) throw failure(400, '无效的完成状态');
    const from = state === 'ready' ? ['downloading'] : ['parsing', 'downloading', 'cancelling'];
    return transition(owner, id, from, state, { error, metadata });
  }
  function cancel(owner, id) {
    return requestCancel(owner, id);
  }
  function retry(owner, id) {
    owner = ownerId(owner);
    return transaction(() => {
      const changed = db.prepare(`UPDATE omniget_queue_jobs
        SET state='queued',error='',gc_token='',metadata_json=json_remove(metadata_json,'$.artifactCleanedAt'),
            updated_at=?,started_at=0,finished_at=0
        WHERE owner=? AND id=? AND state IN ('failed','interrupted','expired') AND gc_token=''`)
        .run(now(), owner, id).changes;
      return changed === 1 ? publicRow(visible(owner, id)) : null;
    });
  }
  function get(owner, id) {
    return publicRow(visible(owner, id));
  }
  function list(owner, { limit = 50 } = {}) {
    owner = ownerId(owner);
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.prepare('SELECT * FROM omniget_queue_jobs WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(owner, limit).map(publicRow);
  }
  function status(owner) {
    owner = ownerId(owner);
    const counts = Object.fromEntries(db.prepare('SELECT state,count(*) AS total FROM omniget_queue_jobs WHERE owner=? GROUP BY state')
      .all(owner).map(item => [item.state, item.total]));
    return { counts, limits: { maxBatch, maxQueuedPerUser, maxQueuedGlobal, maxGlobalRunning, maxUserRunning } };
  }
  // Worker-only retention helpers. Do not expose them through an HTTP route:
  // they intentionally enumerate owners but never disclose source URLs or
  // filesystem paths. The caller must remove only path.join(itsFixedRoot,id)
  // after independently validating the UUID, then acknowledge with
  // expireReady; a failed delete leaves the ready record untouched.
  function listExpiredReady(before, limit = 50) {
    before = Number(before);
    if (!Number.isSafeInteger(before) || before < 0) throw new TypeError('无效的过期时间');
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.prepare(`SELECT owner,id,metadata_json FROM omniget_queue_jobs
      WHERE state='ready' AND CAST(json_extract(metadata_json,'$.expiresAt') AS INTEGER)>0
        AND CAST(json_extract(metadata_json,'$.expiresAt') AS INTEGER)<=?
      ORDER BY finished_at,id LIMIT ?`).all(before, limit).map(record => {
      let metadata = {};
      try { metadata = JSON.parse(record.metadata_json); } catch { /* impossible for new records */ }
      return { owner: record.owner, id: record.id, metadata };
    });
  }
  function expireReady(owner, id, before = now()) {
    owner = ownerId(owner);
    before = Number(before);
    if (!Number.isSafeInteger(before) || before < 0) throw new TypeError('无效的过期时间');
    const at = now();
    const changed = db.prepare(`UPDATE omniget_queue_jobs
      SET state='expired', error='成品已过期', updated_at=?, finished_at=?
      WHERE owner=? AND id=? AND state='ready'
        AND CAST(json_extract(metadata_json,'$.expiresAt') AS INTEGER)>0
        AND CAST(json_extract(metadata_json,'$.expiresAt') AS INTEGER)<=?`)
      .run(at, at, owner, id, before).changes;
    return changed === 1 ? publicRow(visible(owner, id)) : null;
  }
  // Worker-only cleanup candidates. This does not mutate a terminal record:
  // first stop/confirm the runner, then remove only a fixed-root UUID
  // directory. The cancelling state is deliberately excluded to prevent a race.
  function listGcTasks(limit = 50) {
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.prepare(`SELECT owner,id,state FROM omniget_queue_jobs
      WHERE state IN ('failed','cancelled','interrupted')
        AND json_extract(metadata_json,'$.artifactCleanedAt') IS NULL
      ORDER BY updated_at,id LIMIT ?`).all(limit);
  }
  // Internal orphan-GC guard: true for any durable record, including terminal
  // history, so a legacy directory scan cannot delete a queue-owned UUID.
  function hasJobId(id) {
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
      && Boolean(db.prepare('SELECT 1 FROM omniget_queue_jobs WHERE id=?').get(id));
  }
  function claimGcTasks(limit = 50) {
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    return transaction(() => {
      const candidates=db.prepare(`SELECT * FROM omniget_queue_jobs
        WHERE state IN ('failed','cancelled','interrupted') AND gc_token=''
          AND json_extract(metadata_json,'$.artifactCleanedAt') IS NULL
        ORDER BY updated_at,id LIMIT ?`).all(limit);
      const claim=db.prepare(`UPDATE omniget_queue_jobs SET gc_token=?
        WHERE id=? AND owner=? AND state=? AND gc_token=''`);
      const tasks=[];
      for(const candidate of candidates) {
        const ticket=randomUUID();
        if(claim.run(ticket,candidate.id,candidate.owner,candidate.state).changes===1)tasks.push({owner:candidate.owner,id:candidate.id,state:candidate.state,ticket});
      }
      return tasks;
    });
  }
  function finishGc(owner,id,ticket,{deleted=false}={}) {
    if(typeof ticket!=='string'||!/^[0-9a-f-]{36}$/.test(ticket))throw failure(400,'无效的清理凭据');
    const current=visible(owner,id);if(!current||current.gc_token!==ticket||!['failed','cancelled','interrupted'].includes(current.state))return null;
    let metadataJson=current.metadata_json;
    if(deleted) { let metadata={};try{metadata=JSON.parse(metadataJson);}catch{} metadata={...metadata,artifactCleanedAt:now()};metadataJson=json(metadata,'metadata'); }
    const changed=db.prepare(`UPDATE omniget_queue_jobs SET gc_token='',metadata_json=?,updated_at=?
      WHERE id=? AND owner=? AND gc_token=? AND state IN ('failed','cancelled','interrupted')`)
      .run(metadataJson,now(),id,owner,ticket).changes;
    return changed===1?publicRow(visible(owner,id)):null;
  }

  return { enqueue, claimNext, recordParsed, routeParsed, beginDownload, complete, cancel, retry, get, list, status,
    listExpiredReady, expireReady, listGcTasks, hasJobId, claimGcTasks, finishGc, recover, close: () => ownsDb && db.close() };
}
