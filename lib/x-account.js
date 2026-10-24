import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const X_CALLBACK_PATH = '/api/account/x/callback';
const SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

// App credentials belong to the server. Each grant belongs to one website user/session.
export function createXAccount({ db, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const clientId = env.OMNIHUB_X_BOOKMARK_CLIENT_ID || '';
  const secret = env.OMNIHUB_X_BOOKMARK_CLIENT_SECRET || '';
  const redirectUri = env.OMNIHUB_X_BOOKMARK_REDIRECT_URI || '';
  const keyHex = env.OMNIHUB_X_BOOKMARK_TOKEN_KEY || '';
  const connectBudget = Number(env.OMNIHUB_X_BOOKMARK_CONNECT_USD);
  const key = /^[a-f0-9]{64}$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
  const appKey = digest(`${clientId}\n${redirectUri}`);
  let callback;
  try {
    const url = new URL(redirectUri);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
        !url.username && !url.password && !url.search && !url.hash && url.pathname === X_CALLBACK_PATH) callback = url;
  } catch { /* Invalid configuration must fail closed. */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_account_connections (
      user_id INTEGER PRIMARY KEY, x_user_id TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      app_key TEXT NOT NULL DEFAULT '', credentials TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL,
      sync_enabled INTEGER NOT NULL DEFAULT 0, connected_at INTEGER NOT NULL DEFAULT 0, oauth_attempt TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS x_account_oauth (
      state_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_hash TEXT NOT NULL,
      verifier TEXT NOT NULL, revision TEXT NOT NULL, app_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_account_connection_reads (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, requested_at INTEGER NOT NULL, reserved_usd REAL NOT NULL);
  `);
  // A connection is personal data.  The HTTP layer authenticates the caller;
  // this layer only accepts a real account id and never falls back to zane.
  function owner(userId) {
    if (!Number.isSafeInteger(userId) || !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))
      throw fail('user_required', '账户不存在或已失效', 403);
  }
  const rowFor = userId => db.prepare('SELECT * FROM x_account_connections WHERE user_id=?').get(userId);
  const configured = () => Boolean(clientId && callback && key);
  function seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  function unseal(value, context) {
    const payload = JSON.parse(value), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    if (payload.v !== 1) throw fail('credential_invalid', '请重新连接 X');
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString());
  }
  const context = (userId, revision) => `${appKey}:${userId}:${revision}`;
  // Profile validation is billable server infrastructure, so its configured
  // ceiling is shared across accounts.  Do not expose this aggregate or any
  // other account's usage through status.
  const connectionSpend = () => Number(db.prepare('SELECT COALESCE(SUM(reserved_usd),0) AS total FROM x_account_connection_reads WHERE requested_at>?').get(now() - 31 * 86400_000).total);
  const budgetReady = () => Number.isFinite(connectBudget) && connectBudget >= 0.01 && connectionSpend() + 0.01 <= connectBudget + 1e-9;
  function status(userId) {
    owner(userId);
    const row = rowFor(userId);
    let connected = Boolean(key && row?.credentials && row.app_key === appKey), needsReconnect = Boolean(row?.credentials && row.app_key !== appKey);
    if (connected) { try { unseal(row.credentials, context(userId, row.revision)); } catch { connected = false; needsReconnect = true; } }
    const blockedReason = !clientId ? 'client_id_missing' : !callback ? 'callback_missing' : !key ? 'encryption_key_missing' : !budgetReady(userId) ? 'connect_budget_missing' : '';
    return { configured: configured(), canConnect: !blockedReason, blockedReason, connected, needsReconnect,
      username: connected ? row.username : '', xUserId: connected ? row.x_user_id : '',
      syncEnabled: connected && Boolean(row.sync_enabled), connectedAt: connected ? row.connected_at : 0,
      callbackUrl: callback?.href || '', scopes: SCOPES, intervalHours: 2 };
  }
  function start(user) {
    owner(user.id);
    if (!user.token) throw fail('session_required', '请重新登录', 401);
    if (!configured()) throw fail('configuration_missing', '服务器尚未配置 X 应用、回调地址或加密密钥');
    if (!budgetReady(user.id)) throw fail('connect_budget_missing', '尚未设置 X 账号校验费用上限，或已达到上限');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const revision = randomBytes(16).toString('hex');
    db.prepare("INSERT OR IGNORE INTO x_account_connections(user_id,revision) VALUES (?,?)").run(user.id, revision);
    const current = rowFor(user.id);
    // Starting again invalidates an older in-flight callback, without changing the existing grant.
    db.prepare('DELETE FROM x_account_oauth WHERE user_id=? OR expires_at<=?').run(user.id, now());
    db.prepare('UPDATE x_account_connections SET oauth_attempt=? WHERE user_id=?').run(digest(state), user.id);
    db.prepare('INSERT INTO x_account_oauth VALUES (?,?,?,?,?,?,?)').run(digest(state), user.id, digest(user.token),
      seal(verifier, `${context(user.id, current.revision)}:pkce`), current.revision, appKey, now() + 10 * 60_000);
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: SCOPES.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { authorizationUrl: `https://x.com/i/oauth2/authorize?${params}` };
  }
  async function finish(user, params) {
    owner(user.id);
    if (!configured() || !user.token) throw fail('configuration_missing', 'X 授权配置不可用');
    const state = String(params.get('state') || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw fail('invalid_state', '授权已过期或不是在当前登录会话发起的', 400);
    const pending = db.prepare('SELECT * FROM x_account_oauth WHERE state_hash=?').get(digest(state));
    const current = rowFor(user.id);
    if (!pending || pending.user_id !== user.id || pending.session_hash !== digest(user.token) || pending.expires_at <= now() ||
        pending.app_key !== appKey || current?.revision !== pending.revision || current.oauth_attempt !== digest(state)) throw fail('invalid_state', '授权已过期或不是在当前登录会话发起的', 400);
    // Consume once, before either upstream call. A cancelled/failed attempt cannot be replayed.
    db.prepare('DELETE FROM x_account_oauth WHERE state_hash=?').run(digest(state));
    if (params.has('error')) throw fail('authorization_cancelled', '你取消了 X 授权', 400);
    const code = params.get('code');
    if (!code || code.length > 4096) throw fail('invalid_code', 'X 授权码无效', 400);
    if (!budgetReady(user.id)) throw fail('connect_budget_missing', 'X 账号校验费用上限不足');
    const verifier = unseal(pending.verifier, `${context(user.id, pending.revision)}:pkce`);
    const assertCurrent = () => {
      owner(user.id);
      const latest = rowFor(user.id);
      if (latest?.revision !== pending.revision || latest.oauth_attempt !== digest(state) || !db.prepare('SELECT 1 FROM sessions WHERE token=? AND user_id=?').get(user.token, user.id))
        throw fail('connection_changed', '连接或登录状态已改变，请重新授权');
    };
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (secret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    let token;
    try {
      const response = await fetchImpl('https://api.x.com/2/oauth2/token', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }) });
      if (!response.ok) throw 0;
      token = await response.json();
    } catch { throw fail('exchange_failed', 'X 授权交换失败，请重新连接'); }
    assertCurrent();
    const scopes = new Set(String(token?.scope || '').split(' '));
    if (!token?.access_token || !token.refresh_token || !SCOPES.every(scope => scopes.has(scope)) || [...scopes].some(scope => !SCOPES.includes(scope)))
      throw fail('scope_mismatch', 'X 未返回完整的只读收藏权限，请重新授权');
    // Reserve the account lookup before the paid request; uncertain failures keep the reservation.
    if (!budgetReady(user.id)) throw fail('connect_budget_missing', 'X 账号校验费用上限不足');
    db.prepare('INSERT INTO x_account_connection_reads(user_id,requested_at,reserved_usd) VALUES (?,?,0.01)').run(user.id, now());
    let profile;
    try {
      const response = await fetchImpl('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw 0;
      profile = (await response.json()).data;
    } catch { throw fail('profile_failed', '未能确认 X 账号身份，请重新连接'); }
    assertCurrent();
    if (!/^\d{1,19}$/.test(String(profile?.id || '')) || !/^[A-Za-z0-9_]{1,15}$/.test(profile?.username || '')) throw fail('profile_invalid', 'X 账号信息不完整');
    // Keep the account binding even after disconnect, so another account is never silently merged.
    // OMNIHUB_X_BOOKMARK_X_USER_ID is a pre-OAuth migration guard for zane's
    // old collector only.  Applying it to a new website user would make their
    // own account impossible to connect (or silently bind them to zane).
    const zane = db.prepare("SELECT id FROM users WHERE username='zane'").get();
    const expectedXId = current.x_user_id || (zane?.id === user.id ? String(env.OMNIHUB_X_BOOKMARK_X_USER_ID || '') : '');
    if (expectedXId && expectedXId !== profile.id) throw fail('account_mismatch', '请授权之前绑定的 X 账号；切换账号需另行迁移收藏');
    const revision = randomBytes(16).toString('hex');
    const credentials = seal({ ...token, x_user_id: profile.id, expires_at: now() + Number(token.expires_in || 7200) * 1000 }, context(user.id, revision));
    db.prepare('UPDATE x_account_connections SET x_user_id=?,username=?,app_key=?,credentials=?,revision=?,sync_enabled=0,connected_at=? WHERE user_id=? AND revision=?')
      .run(profile.id, profile.username, appKey, credentials, revision, now(), user.id, pending.revision);
    invalidateSync(user.id);
    return status(user.id);
  }
  function invalidateSync(userId) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x_bookmark_sync_state'").get())
      db.prepare("UPDATE x_bookmark_sync_state SET lease_token='',lease_until=0,needs_reconnect=0,last_error='' WHERE user_id=?").run(userId);
  }
  function setSync(userId, enabled) {
    owner(userId);
    if (typeof enabled !== 'boolean') throw fail('invalid_input', '同步开关无效', 400);
    if (!status(userId).connected) throw fail('not_connected', '请先连接 X');
    db.prepare('UPDATE x_account_connections SET sync_enabled=? WHERE user_id=?').run(enabled ? 1 : 0, userId);
    if (!enabled) invalidateSync(userId);
    return status(userId);
  }
  function disconnect(userId) {
    owner(userId);
    db.prepare("UPDATE x_account_connections SET credentials='',sync_enabled=0,revision=? WHERE user_id=?").run(randomBytes(16).toString('hex'), userId);
    db.prepare('DELETE FROM x_account_oauth WHERE user_id=?').run(userId);
    invalidateSync(userId);
    return status(userId);
  }
  function syncConfig(userId) {
    owner(userId);
    const row = rowFor(userId);
    if (!configured() || !row?.credentials || row.app_key !== appKey) return { enabled: false };
    const assertCurrent = () => {
      owner(userId);
      const current = rowFor(userId);
      if (current?.revision !== row.revision || !current.credentials || !current.sync_enabled) throw fail('reconnect_required', 'X 同步已暂停或授权已断开');
    };
    return { enabled: Boolean(row.sync_enabled), ownerUserId: userId, xUserId: row.x_user_id, assertCurrent,
      tokenStore: {
        async get() {
          assertCurrent();
          try { return unseal(rowFor(userId).credentials, context(userId, row.revision)); }
          catch { throw fail('reconnect_required', 'X 授权密钥已更改或凭证损坏，请重新连接'); }
        },
        async set(token) {
          assertCurrent();
          if (token.x_user_id !== row.x_user_id) throw fail('account_mismatch', 'X 账号不匹配');
          db.prepare('UPDATE x_account_connections SET credentials=? WHERE user_id=? AND revision=?')
            .run(seal(token, context(userId, row.revision)), userId, row.revision);
        },
      } };
  }
  return { status, start, finish, setSync, disconnect, syncConfig };
}
