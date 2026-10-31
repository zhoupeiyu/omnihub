import { randomUUID } from 'node:crypto';

const MIN_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_PER_OWNER = 5;
const MAX_TOTAL = 20;
const PAGE_LIMIT = 20;
// Eight upstream polls may each consume their 20-second request timeout, plus
// bounded retry waits. Keep the lease above that real worst case.
const LEASE_MS = 5 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_CAP_PER_OWNER = 5000;
const SNAPSHOT_CAP_PER_CONTENT = 200;
const fail = (status, message) => Object.assign(new Error(message), { status });
const clip = (value, limit = 500) => String(value || '').slice(0, limit);
const safeId = value => /^[a-f0-9-]{36}$/.test(String(value || ''));
const safeCursor = value => typeof value === 'string' && value.length <= 512 ? value : '';
const contentWithId = value => {
  const contentId = String(value?.contentId || value?.id || '');
  if (!/^[\w-]{1,100}$/.test(contentId)) throw fail(502, '平台没有返回有效的作品编号。');
  return { ...value, contentId };
};

function metricsOf(value) {
  const stats = value?.stats || value?.statistics || {};
  const number = name => {
    const raw = stats[name];
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim()) || typeof raw === 'boolean') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return { playCount: number('play_count') ?? number('view_count'), diggCount: number('digg_count') ?? number('like_count'), commentCount: number('comment_count'), shareCount: number('share_count'), collectCount: number('collect_count') ?? number('favorite_count') };
}

function json(value) { return JSON.stringify(value); }
function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

/**
 * Owner-isolated author watches and metric snapshots.
 *
 * `upstream(path)` returns the ordinary OmniHub DTK envelope data. It never
 * receives an owner, browser cookie, or user-controlled headers. The caller
 * owns origin/CSRF validation and passes only its already-derived owner.
 */
export function createMediaWatchStore({ db, upstream, extractCollectionLink, extractVideoLink, normalizeVideoContent, contentUrl, now = () => Date.now(), pollLimit = 8, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof upstream !== 'function') throw new TypeError('db and upstream are required');
  db.exec(`CREATE TABLE IF NOT EXISTS media_watchlists(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, platform TEXT NOT NULL, url TEXT NOT NULL,
    mode TEXT NOT NULL, resource_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
    interval_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'paused', next_run INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0, task_id TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL, updated INTEGER NOT NULL, expires_at INTEGER, last_run INTEGER, last_success INTEGER,
    last_error TEXT NOT NULL DEFAULT '', seen_truncated INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
  ); CREATE INDEX IF NOT EXISTS media_watch_due ON media_watchlists(enabled,next_run,lease_until);
  CREATE INDEX IF NOT EXISTS media_watch_owner ON media_watchlists(owner,created DESC);
  CREATE TABLE IF NOT EXISTS media_watch_items(
    watch_id TEXT NOT NULL, content_key TEXT NOT NULL, payload TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(watch_id,content_key)
  ); CREATE TABLE IF NOT EXISTS media_metric_snapshots(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, watch_id TEXT, platform TEXT NOT NULL,
    content_id TEXT NOT NULL, observed_at INTEGER NOT NULL, metrics TEXT NOT NULL,
    content TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS media_snapshot_owner ON media_metric_snapshots(owner,platform,content_id,observed_at DESC);`);
  if (!db.prepare('PRAGMA table_info(media_watchlists)').all().some(column => column.name === 'expires_at')) db.exec('ALTER TABLE media_watchlists ADD COLUMN expires_at INTEGER');
  if (!db.prepare('PRAGMA table_info(media_watchlists)').all().some(column => column.name === 'seen_truncated')) db.exec('ALTER TABLE media_watchlists ADD COLUMN seen_truncated INTEGER NOT NULL DEFAULT 0');

  const ownerOf = context => {
    if (!context || typeof context.owner !== 'string' || !context.owner) throw fail(401, '无法确认记录归属，请刷新后重试。');
    return context.owner;
  };
  const isPublic = context => context?.scope === 'public' || ownerOf(context) === 'public';
  const row = id => db.prepare('SELECT * FROM media_watchlists WHERE id=?').get(id);
  const present = value => value && ({ id:value.id, platform:value.platform, url:value.url, mode:value.mode, resourceId:value.resource_id, enabled:Boolean(value.enabled), state:value.state, intervalMs:value.interval_ms, nextRun:value.next_run, created:value.created, updated:value.updated, expiresAt:value.expires_at, lastRun:value.last_run, lastSuccess:value.last_success, lastError:value.last_error, cursor:value.cursor, seenTruncated:Boolean(value.seen_truncated), visibility:value.owner === 'public' ? 'public' : 'private' });
  const owned = (context, id, write = false) => {
    const value = row(id);
    if (!value || value.deleted_at) throw fail(404, '找不到这条关注记录。');
    const owner = ownerOf(context);
    if (value.owner !== owner) throw fail(404, '找不到这条关注记录。');
    // Anonymous records are deliberately shared. They may be checked manually,
    // but cannot start a background schedule that any visitor could create.
    if (write && value.owner === 'public' && context?.automatic === true) throw fail(403, '公开关注不支持自动追更，请登录后开启。');
    return value;
  };
  const count = owner => Number(db.prepare('SELECT count(*) AS n FROM media_watchlists WHERE owner=? AND deleted_at IS NULL').get(owner).n || 0);
  const total = () => Number(db.prepare('SELECT count(*) AS n FROM media_watchlists WHERE deleted_at IS NULL').get().n || 0);
  const checkedInterval = value => {
    const interval = value === undefined ? MIN_INTERVAL : Number(value);
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL || interval > 30 * 86400000) throw fail(400, '关注间隔须在 6 小时至 30 天之间。');
    return interval;
  };
  const queryPath = watch => {
    const routes = { posts:'user/posts', mix:'mix/posts', collection:'collection/posts' };
    if (!routes[watch.mode]) throw fail(400, '这个关注类型暂不支持。');
    const params = new URLSearchParams({ wait:'0', count:String(PAGE_LIMIT), include_raw:'false', refresh:'true' });
    if (watch.mode === 'posts') params.set('url', watch.url);
    else params.set(watch.mode === 'mix' ? 'mix_id' : 'collection_id', watch.resource_id);
    // A follow is a recurring latest-page check. A cursor belongs to historical
    // browsing, and using it here would silently skip new posts forever.
    return `/api/v1/${watch.platform}/${routes[watch.mode]}?${params}`;
  };
  const awaitTask = async taskId => {
    if (!taskId || typeof taskId !== 'string') throw fail(502, '平台没有返回采集任务。');
    let last;
    for (let index = 0; index < pollLimit; index += 1) {
      last = await upstream(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
      if (last?.state === 'done') return last.data;
      if (['failed','cancelled'].includes(last?.state)) throw fail(502, '平台暂时限制了这次采集，请稍后重试。');
      if (index + 1 < pollLimit) await wait(Math.min(1000 * (index + 1), 5000));
    }
    throw fail(504, '采集仍在处理中，请稍后手动检查。');
  };
  const writeError = (watch, message, stamp = now()) => {
    const current = row(watch.id);
    if (!current || current.deleted_at) return;
    db.prepare('UPDATE media_watchlists SET state=?, lease_until=0, next_run=?, updated=?, last_error=? WHERE id=? AND deleted_at IS NULL').run(current.enabled ? 'scheduled' : 'paused', stamp + current.interval_ms, stamp, clip(message, 500), current.id);
  };
  const normalizeItems = (watch, data, stamp) => {
    if (!Array.isArray(data?.items)) throw fail(502, '平台没有返回可用的作品列表。');
    const accepted = [];
    for (const raw of data.items.slice(0, PAGE_LIMIT)) {
      try {
        if (raw?.platform !== watch.platform || raw?.is_private || raw?.is_deleted || raw?.is_public === false) continue;
        const content = contentWithId(normalizeVideoContent(raw, watch.platform));
        const url = contentUrl(raw);
        if (!url) continue;
        accepted.push({ ...content, url });
      } catch { /* One malformed platform item must not erase a whole run. */ }
    }
    return accepted.map(content => ({ content, key:`${content.platform}:${content.contentId}`, stamp }));
  };
  const recordSnapshot = (owner, watchId, content, raw, stamp) => {
    const metrics = metricsOf(raw);
    if (Object.values(metrics).every(value => value === null)) return { stored:false, reason:'no_metrics', lastObservedAt:null };
    const previous = db.prepare('SELECT observed_at FROM media_metric_snapshots WHERE owner=? AND platform=? AND content_id=? ORDER BY observed_at DESC LIMIT 1').get(owner, content.platform, content.contentId);
    if (previous && stamp - previous.observed_at < MIN_INTERVAL) return { stored:false, reason:'recent', lastObservedAt:previous.observed_at };
    db.prepare('INSERT INTO media_metric_snapshots VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), owner, watchId || null, content.platform, content.contentId, stamp, json(metrics), json(content));
    db.prepare('DELETE FROM media_metric_snapshots WHERE id IN (SELECT id FROM media_metric_snapshots WHERE owner=? AND platform=? AND content_id=? ORDER BY observed_at DESC LIMIT -1 OFFSET ?)').run(owner, content.platform, content.contentId, SNAPSHOT_CAP_PER_CONTENT);
    db.prepare('DELETE FROM media_metric_snapshots WHERE id IN (SELECT id FROM media_metric_snapshots WHERE owner=? ORDER BY observed_at DESC LIMIT -1 OFFSET ?)').run(owner, SNAPSHOT_CAP_PER_OWNER);
    return { stored:true, reason:'stored', lastObservedAt:stamp };
  };
  const pruneItems = (watchId, stamp = now()) => {
    db.prepare('DELETE FROM media_watch_items WHERE watch_id=? AND last_seen<?').run(watchId, stamp - RETENTION_MS);
    const overflow = Number(db.prepare('SELECT count(*) AS n FROM media_watch_items WHERE watch_id=?').get(watchId).n || 0) > 5000;
    if (overflow) {
      db.prepare('DELETE FROM media_watch_items WHERE rowid IN (SELECT rowid FROM media_watch_items WHERE watch_id=? ORDER BY last_seen DESC LIMIT -1 OFFSET 5000)').run(watchId);
      db.prepare('UPDATE media_watchlists SET seen_truncated=1 WHERE id=?').run(watchId);
    }
    return overflow;
  };
  const acquireLease = (id, stamp = now()) => {
    const acquired = db.prepare('UPDATE media_watchlists SET lease_until=?,state=?,updated=? WHERE id=? AND deleted_at IS NULL AND lease_until<=?').run(stamp + LEASE_MS, 'running', stamp, id, stamp);
    if (!acquired.changes) throw fail(409, '这条关注正在检查，请稍后刷新结果。');
    const current = row(id);
    if (!current || current.deleted_at) throw fail(404, '找不到这条关注记录。');
    return current;
  };
  const finish = (watch, data, stamp = now()) => {
    const current = row(watch.id);
    if (!current || current.deleted_at) return { deleted:true, newItems:[] };
    const entries = normalizeItems(current, data, stamp);
    const seen = new Set(db.prepare('SELECT content_key FROM media_watch_items WHERE watch_id=?').all(current.id).map(item => item.content_key));
    const newlySeen = [];
    for (const entry of entries) {
      const previous = db.prepare('SELECT content_key FROM media_watch_items WHERE watch_id=? AND content_key=?').get(current.id, entry.key);
      db.prepare('INSERT INTO media_watch_items(watch_id,content_key,payload,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(watch_id,content_key) DO UPDATE SET payload=excluded.payload,last_seen=excluded.last_seen').run(current.id, entry.key, json(entry.content), stamp, stamp);
      recordSnapshot(current.owner, current.id, entry.content, data.items.find(raw => String(raw?.content_id) === entry.content.contentId), stamp);
      if (!previous) newlySeen.push(entry.content);
    }
    const cursor = data?.has_more ? safeCursor(data?.cursor) : '';
    const truncated = pruneItems(current.id, stamp);
    db.prepare('UPDATE media_watchlists SET state=?, task_id=?, cursor=?, lease_until=0, next_run=?, updated=?, last_run=?, last_success=?, last_error=? WHERE id=? AND deleted_at IS NULL').run(current.enabled ? 'scheduled' : 'paused', '', cursor, stamp + current.interval_ms, stamp, stamp, stamp, '', current.id);
    return { watch:present(row(current.id)), newItems:newlySeen, retained:Math.min(seen.size + newlySeen.length, 5000), hasMore:Boolean(cursor), truncated };
  };
  const collect = async (watch, stamp = now()) => {
    try {
      const initial = await upstream(queryPath(watch));
      const data = initial?.task_id ? await awaitTask(initial.task_id) : initial;
      return finish(watch, data, stamp);
    } catch (error) {
      writeError(watch, error?.message || '采集失败，请稍后重试。', stamp);
      throw error;
    }
  };

  return {
    create(context, input = {}) {
      const owner = ownerOf(context);
      if (count(owner) >= MAX_PER_OWNER) throw fail(429, '每个账号最多关注 5 个作者或合集。');
      if (total() >= MAX_TOTAL) throw fail(429, '当前关注任务已达到 20 个上限。');
      const link = extractCollectionLink(input.text, { mode:input.mode, platform:input.platform });
      if (!['posts','mix','collection'].includes(link.mode)) throw fail(400, '只能关注公开作者作品或公开合集。');
      const stamp = now(); const watch = { id:randomUUID(), owner, platform:link.platform, url:link.url, mode:link.mode, resourceId:link.resourceId || '', interval:checkedInterval(input.intervalMs) };
      db.prepare('INSERT INTO media_watchlists(id,owner,platform,url,mode,resource_id,enabled,interval_ms,state,next_run,lease_until,created,updated,expires_at) VALUES(?,?,?,?,?,?,0,? ,?,?,0,?,?,NULL)').run(watch.id,watch.owner,watch.platform,watch.url,watch.mode,watch.resourceId,watch.interval,'paused',stamp,stamp,stamp);
      return present(row(watch.id));
    },
    list(context) { const owner=ownerOf(context); return db.prepare('SELECT * FROM media_watchlists WHERE owner=? AND deleted_at IS NULL ORDER BY created DESC LIMIT 20').all(owner).map(present); },
    get(context,id) { return present(owned(context,id)); },
    update(context, id, input = {}) {
      const current=owned(context,id,true); const stamp=now();
      if (Object.prototype.hasOwnProperty.call(input,'enabled')) {
        if (typeof input.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值。');
        if (current.owner === 'public' && input.enabled) throw fail(403, '公开关注不支持自动追更，请登录后开启。');
      }
      const enabled=Object.prototype.hasOwnProperty.call(input,'enabled') ? input.enabled : Boolean(current.enabled);
      const interval=Object.prototype.hasOwnProperty.call(input,'intervalMs') ? checkedInterval(input.intervalMs) : current.interval_ms;
      const expires = enabled ? stamp + RETENTION_MS : current.expires_at;
      db.prepare('UPDATE media_watchlists SET enabled=?, interval_ms=?, state=?, next_run=?, expires_at=?, updated=?, last_error=? WHERE id=? AND deleted_at IS NULL').run(enabled ? 1:0, interval, enabled ? (current.lease_until > stamp ? 'running' : 'scheduled') : (current.lease_until > stamp ? 'running' : 'paused'), enabled ? stamp : current.next_run, expires, stamp, enabled?'':current.last_error, current.id);
      return present(row(id));
    },
    remove(context,id) { const current=owned(context,id,true); const stamp=now(); db.prepare('UPDATE media_watchlists SET enabled=0,state=?,deleted_at=?,lease_until=0,updated=? WHERE id=? AND deleted_at IS NULL').run('deleted',stamp,stamp,current.id); return { removed:true,id:current.id }; },
    async run(context,id) { owned(context,id); return collect(acquireLease(id)); },
    async tick(stamp = now()) {
      db.prepare('UPDATE media_watchlists SET enabled=0,state=?,updated=?,last_error=? WHERE enabled=1 AND expires_at IS NOT NULL AND expires_at<=? AND deleted_at IS NULL').run('expired',stamp,'自动关注已在 30 天后暂停，可重新开启续期。',stamp);
      const candidates=db.prepare('SELECT * FROM media_watchlists WHERE enabled=1 AND owner!=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND next_run<=? AND lease_until<=? ORDER BY next_run ASC LIMIT 20').all('public',stamp,stamp,stamp);
      const results=[];
      for (const candidate of candidates) {
        let leased;
        try { leased=acquireLease(candidate.id,stamp); } catch { continue; }
        if (!leased.enabled || leased.owner === 'public') continue;
        try { results.push(await collect(leased,stamp)); } catch (error) { results.push({id:candidate.id,error:clip(error?.message,500)}); }
      }
      return results;
    },
    async snapshot(context, input = {}) {
      const owner=ownerOf(context); const link=extractVideoLink(input.text); const stamp=now();
      const initial=await upstream(`/api/v1/parse?wait=0&refresh=true`, { url:link.url, include_raw:false });
      const data=initial?.task_id ? await awaitTask(initial.task_id) : initial;
      const content=contentWithId({ ...normalizeVideoContent(data,link.platform), url:contentUrl(data) });
      const snapshot=recordSnapshot(owner,null,content,data,stamp);
      return { content, ...snapshot };
    },
    snapshots(context, { platform, contentId, limit = 100 } = {}) {
      const owner=ownerOf(context); if (!/^[a-z]{2,20}$/.test(String(platform||'')) || !/^[\w-]{1,100}$/.test(String(contentId||''))) throw fail(400,'请提供有效的平台和作品编号。');
      const rows=db.prepare('SELECT observed_at,metrics,content FROM media_metric_snapshots WHERE owner=? AND platform=? AND content_id=? ORDER BY observed_at ASC LIMIT ?').all(owner,platform,contentId,Math.min(Math.max(1,Number(limit)||100),200));
      return rows.map(item=>({observedAt:item.observed_at,metrics:parse(item.metrics,{}),content:parse(item.content,{})}));
    },
    recentSnapshots(context, { limit = 30 } = {}) {
      const owner=ownerOf(context); const take=Math.min(Math.max(1,Number(limit)||30),100);
      const rows=db.prepare('SELECT platform,content_id,observed_at,content FROM media_metric_snapshots WHERE owner=? ORDER BY observed_at DESC LIMIT 1000').all(owner);
      const seen=new Set(); const recent=[];
      for (const row of rows) {
        const key=`${row.platform}:${row.content_id}`;
        if (seen.has(key)) continue;
        seen.add(key); const content=parse(row.content,{});
        recent.push({ platform:row.platform, contentId:String(content.contentId || row.content_id), title:clip(content.title || '未命名作品',500), url:typeof content.url === 'string' ? content.url : '', lastObservedAt:row.observed_at });
        if (recent.length >= take) break;
      }
      return recent;
    },
    items(context,id,{limit=50}={}) { const current=owned(context,id); return db.prepare('SELECT payload,first_seen,last_seen FROM media_watch_items WHERE watch_id=? ORDER BY first_seen DESC LIMIT ?').all(current.id,Math.min(Math.max(1,Number(limit)||50),200)).map(item=>({...parse(item.payload,{}),firstSeen:item.first_seen,lastSeen:item.last_seen})); },
    cleanup(stamp = now()) {
      db.prepare('DELETE FROM media_metric_snapshots WHERE observed_at<?').run(stamp-RETENTION_MS);
      for (const watch of db.prepare('SELECT id FROM media_watchlists WHERE deleted_at IS NULL').all()) pruneItems(watch.id, stamp);
      const removed=db.prepare('SELECT id FROM media_watchlists WHERE deleted_at IS NOT NULL AND deleted_at<?').all(stamp-RETENTION_MS);
      for (const watch of removed) db.prepare('DELETE FROM media_watch_items WHERE watch_id=?').run(watch.id);
      return db.prepare('DELETE FROM media_watchlists WHERE deleted_at IS NOT NULL AND deleted_at<?').run(stamp-RETENTION_MS).changes;
    },
  };
}
