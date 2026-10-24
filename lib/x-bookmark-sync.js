import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { normalizeBookmarkPage } from "./x-bookmark-sync-normalize.js";

const API = "https://api.x.com/2";
const TOKEN_API = "https://api.x.com/2/oauth2/token";
const TWO_HOURS = 2 * 60 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const COST_PER_RESOURCE_USD = 0.015;

function cleanError(error) {
  const code = String(error?.code || "upstream");
  const messages = {
    budget: "X 收藏同步已达到本地费用上限", credential_missing: "X 收藏尚未连接", reconnect_required: "X 授权已失效，请重新连接",
    rate_limited: "X 收藏读取过于频繁，稍后重试", page_guard: "X 收藏分页保护已停止本轮同步",
    response_too_large: "X 收藏分页响应过大，未写入", lease_expired: "X 收藏同步租约已失效", cursor_invalid: "X 收藏分页游标已失效，将从头重新扫描", upstream: "X 收藏同步暂时不可用",
  };
  return { code: messages[code] ? code : "upstream", message: messages[code] || messages.upstream };
}
function finitePositive(value) { return Number.isFinite(Number(value)) && Number(value) > 0; }
function validateConfig(config) {
  if (!config?.enabled) return { ok: false, reason: "disabled" };
  if (!/^\d{1,19}$/.test(String(config.xUserId || ""))) return { ok: false, reason: "x_user_id_missing" };
  if (!config.tokenStore?.get || !config.tokenStore?.set) return { ok: false, reason: "credential_missing" };
  const budget = config.budget || {};
  if (![budget.perRunUsd, budget.perDayUsd, budget.perMonthUsd].every(finitePositive)) return { ok: false, reason: "budget_missing" };
  return { ok: true };
}
function safeSnapshot(page, items) {
  // Capture coverage evidence only. Full X text/media belongs solely in inbox and must disappear when deleted there.
  const json = JSON.stringify({ version: 1, result_count: Number(page?.meta?.result_count ?? items.length), next_token: String(page?.meta?.next_token || ""), previous_token: String(page?.meta?.previous_token || ""), post_ids: items.map((item) => item.externalId) });
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error("X 返回分页过大，未写入"), { code: "response_too_large" });
  return json;
}
function errorWith(code, message, status) { return Object.assign(new Error(message), { code, status }); }

/** Only reads declared environment values; absent configuration is deliberately safe and disabled. */
export function loadXBookmarkSyncConfig(env = process.env) {
  const enabled = env.OMNIHUB_X_BOOKMARK_SYNC === "true";
  const budget = { perRunUsd: Number(env.OMNIHUB_X_BOOKMARK_RUN_USD), perDayUsd: Number(env.OMNIHUB_X_BOOKMARK_DAY_USD), perMonthUsd: Number(env.OMNIHUB_X_BOOKMARK_MONTH_USD) };
  return {
    enabled, xUserId: String(env.OMNIHUB_X_BOOKMARK_X_USER_ID || ""), clientId: String(env.OMNIHUB_X_BOOKMARK_CLIENT_ID || ""),
    clientSecret: String(env.OMNIHUB_X_BOOKMARK_CLIENT_SECRET || ""), redirectUri: String(env.OMNIHUB_X_BOOKMARK_REDIRECT_URI || ""),
    budget, intervalMs: TWO_HOURS,
    maxPages: Math.min(100, Math.max(1, Number(env.OMNIHUB_X_BOOKMARK_MAX_PAGES) || 20)),
  };
}

/** AES-256-GCM encrypted token file; caller keeps the 32-byte key outside the file and database. */
export function createEncryptedTokenFile(file, keyMaterial) {
  if (!path.isAbsolute(file) || typeof keyMaterial !== 'string' || !/^[a-fA-F0-9]{64}$/.test(keyMaterial)) throw new Error("X 令牌文件需绝对路径及独立的 32 字节十六进制密钥");
  const key = createHash("sha256").update(String(keyMaterial || "")).digest();
  async function write(value) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const payload = JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporary, `${payload}\n`, { mode: 0o600, flag: "wx" }); await chmod(temporary, 0o600); await rename(temporary, file); await chmod(file, 0o600);
  }
  return {
    async get() {
      let raw; try {
        const stat=await lstat(file);
        if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>64*1024)throw new Error('X 令牌文件权限或大小无效');
        raw = await readFile(file, "utf8");
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      const payload = JSON.parse(raw); if (payload.v !== 1) throw new Error("X 收藏令牌文件版本不支持");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64")); decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8"));
    }, set: write,
  };
}

/** Server-side bookmark collector. It never requests X unless configuration, credentials and all caps are explicit. */
export function createXBookmarkSync({ db, fetchImpl = fetch, now = () => Date.now(), config = {}, onImported = async () => {} }) {
  if (!db?.exec || !db?.prepare) throw new Error("X 收藏同步需要 node:sqlite DatabaseSync");
  config = { intervalMs: TWO_HOURS, maxPages: 20, costPerResourceUsd: COST_PER_RESOURCE_USD, ...config };
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_bookmark_sync_state (user_id INTEGER PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, last_started_at INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', needs_reconnect INTEGER NOT NULL DEFAULT 0, resume_cursor TEXT NOT NULL DEFAULT '', coverage_state TEXT NOT NULL DEFAULT 'full', updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS x_bookmark_sync_reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, run_id TEXT NOT NULL, requested_at INTEGER NOT NULL, estimated_usd REAL NOT NULL, final_usd REAL, state TEXT NOT NULL, UNIQUE(user_id, run_id));
    CREATE TABLE IF NOT EXISTS x_bookmark_sync_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, run_id TEXT NOT NULL, page_number INTEGER NOT NULL, received_at INTEGER NOT NULL, response_json TEXT NOT NULL, UNIQUE(user_id, run_id, page_number));
    CREATE TABLE IF NOT EXISTS x_bookmark_sync_pending_imports (user_id INTEGER NOT NULL, inbox_id INTEGER NOT NULL, run_id TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, inbox_id));
    CREATE TABLE IF NOT EXISTS x_bookmark_sync_tombstones (user_id INTEGER NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,source,external_id));
    CREATE TRIGGER IF NOT EXISTS x_bookmark_sync_inbox_delete AFTER DELETE ON inbox WHEN OLD.source='x' AND OLD.external_id<>'' BEGIN
      INSERT OR REPLACE INTO x_bookmark_sync_tombstones (user_id,source,external_id,deleted_at) VALUES (OLD.user_id,OLD.source,OLD.external_id,CAST(unixepoch('subsec')*1000 AS INTEGER));
    END;
  `);
  const stateColumns = new Set(db.prepare("PRAGMA table_info(x_bookmark_sync_state)").all().map((column) => column.name));
  if (!stateColumns.has("resume_cursor")) db.exec("ALTER TABLE x_bookmark_sync_state ADD COLUMN resume_cursor TEXT NOT NULL DEFAULT ''");
  if (!stateColumns.has("coverage_state")) db.exec("ALTER TABLE x_bookmark_sync_state ADD COLUMN coverage_state TEXT NOT NULL DEFAULT 'full'");
  const state = (userId) => db.prepare("SELECT * FROM x_bookmark_sync_state WHERE user_id=?").get(userId) || { user_id: userId, next_at: 0, lease_until: 0, failure_count: 0, needs_reconnect: 0 };
  const saveOwnedState = (userId, patch, holder) => {
    const current = state(userId); const merged = { ...current, ...patch, updated_at: now() };
    return db.prepare("UPDATE x_bookmark_sync_state SET next_at=?,lease_token=?,lease_until=?,failure_count=?,last_started_at=?,last_success_at=?,last_error=?,needs_reconnect=?,resume_cursor=?,coverage_state=?,updated_at=? WHERE user_id=? AND lease_token=?")
      .run(merged.next_at, merged.lease_token || "", merged.lease_until || 0, merged.failure_count || 0, merged.last_started_at || 0, merged.last_success_at || 0, merged.last_error || "", merged.needs_reconnect || 0, merged.resume_cursor || "", merged.coverage_state || "full", merged.updated_at, userId, holder).changes;
  };
  function status(userId) { const row = state(userId),check=validateConfig(config); return { enabled: Boolean(config.enabled), configured:check.ok, blockedReason:check.reason||'', xUserId: config.xUserId ? String(config.xUserId) : "", nextAt: row.next_at || 0, lastStartedAt: row.last_started_at || 0, lastSuccessAt: row.last_success_at || 0, lastError: row.last_error || "", needsReconnect: Boolean(row.needs_reconnect), running: row.lease_until > now(), failureCount: row.failure_count || 0, coverage: row.last_started_at ? row.coverage_state || "full" : "not_started" }; }
  function reserve(userId, runId, estimate) {
    const budget = config.budget; const current = now(); const day = current - 24 * 3600_000; const month = current - 31 * 24 * 3600_000;
    const sum = (since) => Number(db.prepare("SELECT COALESCE(SUM(COALESCE(final_usd,estimated_usd)),0) AS total FROM x_bookmark_sync_reservations WHERE user_id=? AND requested_at>=? AND state IN ('reserved','final','uncertain')").get(userId, since).total || 0);
    const shared = (since) => Number(db.prepare("SELECT COALESCE(SUM(COALESCE(final_usd,estimated_usd)),0) AS total FROM x_bookmark_sync_reservations WHERE requested_at>=? AND state IN ('reserved','final','uncertain')").get(since).total || 0);
    const run = Number(db.prepare("SELECT COALESCE(SUM(COALESCE(final_usd,estimated_usd)),0) AS total FROM x_bookmark_sync_reservations WHERE user_id=? AND run_id LIKE ? AND state IN ('reserved','final','uncertain')").get(userId, `${runId}:%`).total || 0);
    if (run + estimate > budget.perRunUsd + 1e-9 || sum(day) + estimate > budget.perDayUsd + 1e-9 || sum(month) + estimate > budget.perMonthUsd + 1e-9) throw errorWith("budget", "X 收藏同步已达到本地费用上限");
    // When the runtime supplies a shared budget, every account competes for
    // the same server limit.  Older single-account callers omit this field
    // and retain their existing behavior.
    const sharedBudget=config.sharedBudget;
    if(sharedBudget && (shared(day)+estimate>sharedBudget.perDayUsd+1e-9 || shared(month)+estimate>sharedBudget.perMonthUsd+1e-9))
      throw errorWith("budget", "X 收藏同步已达到服务器共享费用上限");
    return db.prepare("INSERT INTO x_bookmark_sync_reservations (user_id,run_id,requested_at,estimated_usd,state) VALUES (?,?,?,?, 'reserved')").run(userId, `${runId}:${randomBytes(5).toString("hex")}`, current, estimate).lastInsertRowid;
  }
  async function accessToken() {
    let token = await config.tokenStore.get(); if (!token?.refresh_token && !token?.access_token) throw errorWith("credential_missing", "X 收藏尚未连接");
    if (!token.x_user_id || String(token.x_user_id) !== String(config.xUserId)) throw errorWith("reconnect_required", "X 授权账号与配置账号不一致，请重新连接");
    if (token.access_token && Number(token.expires_at || 0) > now() + 60_000) return token.access_token;
    if (!token.refresh_token || !config.clientId) throw errorWith("reconnect_required", "X 授权已过期，请重新连接");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: config.clientId });
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (config.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    let response; try { response = await fetchImpl(TOKEN_API, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(45_000) }); } catch { throw errorWith("upstream", "X 刷新授权暂时不可用"); }
    if (!response.ok) { if (response.status === 400 || response.status === 401) throw errorWith("reconnect_required", "X 授权已失效，请重新连接", response.status); throw errorWith("upstream", `X 刷新授权失败（HTTP ${response.status}）`, response.status); }
    const refreshed = await response.json(); if (!refreshed?.access_token) throw errorWith("upstream", "X 刷新授权返回不完整");
    token = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token, expires_at: now() + Number(refreshed.expires_in || 7200) * 1000 };
    await config.tokenStore.set(token); return token.access_token;
  }
  async function deliverPending(userId) {
    const rows = db.prepare("SELECT inbox_id FROM x_bookmark_sync_pending_imports WHERE user_id=? AND delivered_at=0 ORDER BY created_at").all(userId);
    if (!rows.length) return;
    await onImported({ userId, inboxIds: rows.map((item) => item.inbox_id) });
    db.prepare(`UPDATE x_bookmark_sync_pending_imports SET delivered_at=? WHERE user_id=? AND delivered_at=0 AND inbox_id IN (${rows.map(() => "?").join(",")})`).run(now(), userId, ...rows.map((item) => item.inbox_id));
  }
  async function run(userId, forced = false) {
    if (config.ownerUserId != null && config.ownerUserId !== userId) throw errorWith('owner_required', 'X 收藏只能同步到绑定用户', 403);
    const check = validateConfig(config); if (!check.ok) return { skipped: check.reason, ...status(userId) };
    const before = state(userId); if (!forced && before.next_at > now()) return { skipped: "not_due", ...status(userId) };
    const holder = randomBytes(12).toString("hex");
    db.prepare("INSERT OR IGNORE INTO x_bookmark_sync_state (user_id,updated_at) VALUES (?,?)").run(userId, now());
    const claimed = db.prepare("UPDATE x_bookmark_sync_state SET lease_token=?,lease_until=?,last_started_at=?,last_error='',updated_at=? WHERE user_id=? AND lease_until<=?").run(holder, now() + LEASE_MS, now(), now(), userId, now()).changes;
    if (!claimed) return { skipped: "running", ...status(userId) };
    const runId = `${now()}-${randomBytes(7).toString("hex")}`;
    let added = []; let pageNumber = 0; let partial = false;
    try {
      config.assertCurrent?.();
      await deliverPending(userId); const token = await accessToken(); let cursor = String(before.resume_cursor || ""); const seen = new Set(cursor ? [cursor] : []);
      for (;;) {
        config.assertCurrent?.();
        const renewed = db.prepare("UPDATE x_bookmark_sync_state SET lease_until=?,updated_at=? WHERE user_id=? AND lease_token=? AND lease_until>? ").run(now() + LEASE_MS, now(), userId, holder, now()).changes;
        if (!renewed) throw errorWith("lease_expired", "X 收藏同步租约已失效");
        if (pageNumber >= config.maxPages) { partial = true; break; }
        const perResource = Number(config.costPerResourceUsd) || COST_PER_RESOURCE_USD;
        const params = new URLSearchParams({ max_results: "100", "post.fields": "created_at,entities,attachments,lang,note_post,public_metrics", expansions: "attachments.media_keys,author_id", "user.fields": "username,name", "media.fields": "url,preview_image_url,type,alt_text,width,height,variants" });
        if (cursor) params.set("pagination_token", cursor);
        const reservationId = reserve(userId, runId, 100 * perResource);
        let response; try { response = await fetchImpl(`${API}/users/${config.xUserId}/bookmarks?${params}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(45_000) }); } catch { db.prepare("UPDATE x_bookmark_sync_reservations SET state='uncertain' WHERE user_id=? AND run_id LIKE ? AND state='reserved'").run(userId, `${runId}:%`); throw errorWith("upstream", "X 收藏请求结果不确定，已保留费用预留"); }
        // Definite request rejections return no billable resources; transport/5xx ambiguity stays reserved.
        if ([400, 401, 403, 429].includes(response.status)) db.prepare("UPDATE x_bookmark_sync_reservations SET state='final',final_usd=0 WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM x_bookmark_sync_state WHERE user_id=? AND lease_token=?)").run(reservationId, userId, userId, holder);
        if (response.status === 401) throw errorWith("reconnect_required", "X 收藏授权已失效，请重新连接", 401);
        if (response.status === 400 && cursor) throw errorWith("cursor_invalid", "X 收藏分页游标已失效", 400);
        if (response.status === 429) throw errorWith("rate_limited", "X 收藏读取过于频繁，稍后重试", 429);
        if (!response.ok) throw errorWith("upstream", `X 收藏读取失败（HTTP ${response.status}）`, response.status);
        const page = await response.json(); const items = normalizeBookmarkPage(page); safeSnapshot(page, items); pageNumber += 1;
        const next = String(page.meta?.next_token || "");
        if (next && seen.has(next)) throw errorWith("page_guard", "X 收藏分页游标重复");
        config.assertCurrent?.();
        const beforeWrite = db.prepare("UPDATE x_bookmark_sync_state SET lease_until=?,updated_at=? WHERE user_id=? AND lease_token=? AND lease_until>?").run(now() + LEASE_MS, now(), userId, holder, now()).changes;
        if (!beforeWrite) throw errorWith("lease_expired", "X 收藏同步租约已失效");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT INTO x_bookmark_sync_snapshots (user_id,run_id,page_number,received_at,response_json) VALUES (?,?,?,?,?)").run(userId, runId, pageNumber, now(), safeSnapshot(page, items));
          const insert = db.prepare("INSERT OR IGNORE INTO inbox (user_id,source,external_id,title,url,author,content,media,links,metrics,visibility,status) SELECT ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'pending' WHERE NOT EXISTS (SELECT 1 FROM x_bookmark_sync_tombstones WHERE user_id=? AND source='x' AND external_id=?)");
          for (const item of items) { const result = insert.run(userId, item.externalId, item.title, item.url, item.author, item.content, JSON.stringify(item.media), JSON.stringify(item.links), JSON.stringify(item.metrics), userId, item.externalId); if (result.changes) { const id = Number(result.lastInsertRowid); added.push(id); db.prepare("INSERT OR IGNORE INTO x_bookmark_sync_pending_imports (user_id,inbox_id,run_id,created_at) VALUES (?,?,?,?)").run(userId, id, runId, now()); } }
          const actual = items.length * perResource; db.prepare("UPDATE x_bookmark_sync_reservations SET state='final',final_usd=? WHERE user_id=? AND run_id LIKE ? AND state='reserved'").run(actual, userId, `${runId}:%`);
          db.prepare("UPDATE x_bookmark_sync_state SET resume_cursor=?,coverage_state=?,updated_at=? WHERE user_id=? AND lease_token=?").run(next, next ? "partial" : "full", now(), userId, holder);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        if (!next) break; seen.add(next); cursor = next;
      }
      await deliverPending(userId); saveOwnedState(userId, { next_at: now() + config.intervalMs, lease_token: "", lease_until: 0, failure_count: 0, last_success_at: now(), needs_reconnect: 0, coverage_state: partial ? "partial_page_limit" : "full" }, holder);
      return { ok: true, partial, imported: added.length, pages: pageNumber, ...status(userId) };
    } catch (error) {
      db.prepare("UPDATE x_bookmark_sync_reservations SET state='uncertain' WHERE user_id=? AND run_id LIKE ? AND state='reserved'").run(userId, `${runId}:%`);
      const detail = cleanError(error); const reconnect = detail.code === "reconnect_required";
      const budgetPartial = detail.code === "budget" || detail.code === "page_guard" || detail.code === "cursor_invalid";
      const failures = before.failure_count + 1; const delay = budgetPartial || reconnect ? TWO_HOURS : detail.code === "rate_limited" ? 60 * 60_000 : Math.min(60 * 60_000, 60_000 * (2 ** Math.min(failures, 6)));
      try { await deliverPending(userId); } catch { /* pending marker stays recoverable */ }
      const latest = state(userId);
      saveOwnedState(userId, { next_at: now() + delay, lease_token: "", lease_until: 0, failure_count: failures, last_error: detail.message, needs_reconnect: reconnect ? 1 : latest.needs_reconnect || 0, resume_cursor: detail.code === "cursor_invalid" ? "" : latest.resume_cursor || "", coverage_state: budgetPartial ? `partial_${detail.code}` : latest.coverage_state || "full" }, holder);
      return { ok: false, partial: budgetPartial, imported: added.length, error: detail.code, ...status(userId) };
    }
  }
  return { getStatus: status, runDue: (userId) => run(userId, false), runNow: (userId) => run(userId, true), wakePending: deliverPending };
}
