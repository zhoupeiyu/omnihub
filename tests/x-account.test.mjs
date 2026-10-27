import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createXAccount } from '../lib/x-account.js';
import { createXBookmarkSync } from '../lib/x-bookmark-sync.js';

const user = { id: 1, username: 'zane', token: 'fixture-session' };
const grant = { access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', expires_in: 7200, scope: 'tweet.read users.read bookmark.read offline.access' };
function fixture(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES(1,'zane'),(2,'viewer'),(3,'Zane');
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER); INSERT INTO sessions VALUES('fixture-session',1),('other-session',1),('viewer-session',2);
    CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT,title TEXT,url TEXT,author TEXT,content TEXT,media TEXT,links TEXT,metrics TEXT,visibility TEXT,status TEXT,UNIQUE(user_id,source,external_id));`);
  const calls = []; let clock = Date.now();
  const env = { OMNIHUB_X_BOOKMARK_CLIENT_ID: 'fixture-client', OMNIHUB_X_BOOKMARK_REDIRECT_URI: 'https://example.test/api/account/x/callback',
    OMNIHUB_X_BOOKMARK_TOKEN_KEY: 'ab'.repeat(32), OMNIHUB_X_BOOKMARK_CONNECT_USD: '0.10', ...overrides.env };
  const account = createXAccount({ db, env, now: () => clock, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (overrides.fetchImpl) return overrides.fetchImpl(url, options);
    return Response.json(url.endsWith('/token') ? grant : { data: { id: '42', username: 'fixture_x' } });
  } });
  const params = () => { const url = new URL(account.start(user).authorizationUrl); return new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }); };
  return { db, account, calls, params, advance: ms => { clock += ms; } };
}

test('OAuth uses readonly PKCE, binds the website session, encrypts tokens and defaults to paused', async () => {
  const f = fixture();
  const url = new URL(f.account.start(user).authorizationUrl);
  assert.equal(url.origin, 'https://x.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), grant.scope);
  const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' });
  await assert.rejects(f.account.finish({ ...user, token: 'other-session' }, params), { code: 'invalid_state' });
  assert.equal(f.calls.length, 0);
  const result = await f.account.finish(user, params);
  assert.equal(result.connected, true); assert.equal(result.syncEnabled, false); assert.equal(result.username, 'fixture_x');
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => !c.url.includes('/bookmarks')));
  const stored = f.db.prepare('SELECT * FROM x_account_connections').get();
  assert.doesNotMatch(JSON.stringify(stored), /fixture-access-secret|fixture-refresh-secret/);
  assert.doesNotMatch(JSON.stringify(result), /secret|access_token|refresh_token/);
  f.account.setSync(1, true);
  assert.equal((await f.account.syncConfig(1).tokenStore.get()).access_token, grant.access_token);
  await assert.rejects(f.account.finish(user, params), { code: 'invalid_state' });
});

test('every real OmniHub user has a separate X connection; missing users are denied', () => {
  const f = fixture();
  for (const id of [999]) {
    for (const method of ['status', 'disconnect', 'syncConfig']) assert.throws(() => f.account[method](id), { status: 403 });
    assert.throws(() => f.account.start({ ...user, id }), { status: 403 });
    assert.throws(() => f.account.setSync(id, true), { status: 403 });
  }
  const viewer={id:2,username:'viewer',token:'viewer-session'};
  assert.match(f.account.start(viewer).authorizationUrl,/x\.com/);
  assert.equal(f.account.status(2).connected,false);
  assert.equal(f.account.status(1).connected,false);
});

test('missing config and budgets never contact X; expired/cancelled state cannot be reused', async () => {
  for (const env of [{ OMNIHUB_X_BOOKMARK_CLIENT_ID: '' }, { OMNIHUB_X_BOOKMARK_TOKEN_KEY: '' }, { OMNIHUB_X_BOOKMARK_CONNECT_USD: '' }, { OMNIHUB_X_BOOKMARK_REDIRECT_URI: 'http://evil.test/api/account/x/callback' }]) {
    const f = fixture({ env }); assert.throws(() => f.account.start(user)); assert.equal(f.calls.length, 0);
  }
  const f = fixture(), expired = f.params(); f.advance(600_001);
  await assert.rejects(f.account.finish(user, expired), { code: 'invalid_state' });
  const cancelled = f.params(); cancelled.set('error', 'access_denied');
  await assert.rejects(f.account.finish(user, cancelled), { code: 'authorization_cancelled' });
  cancelled.delete('error'); await assert.rejects(f.account.finish(user, cancelled), { code: 'invalid_state' });
  assert.equal(f.calls.length, 0);
});

test('scope mismatch is rejected before paid profile lookup; connection cap survives new attempts', async () => {
  const f = fixture({ fetchImpl: async () => Response.json({ ...grant, scope: `${grant.scope} tweet.write` }) });
  await assert.rejects(f.account.finish(user, f.params()), { code: 'scope_mismatch' }); assert.equal(f.calls.length, 1);
  const capped = fixture({ env: { OMNIHUB_X_BOOKMARK_CONNECT_USD: '0.01' } });
  await capped.account.finish(user, capped.params()); assert.equal(capped.account.status(1).canConnect, false);
  assert.throws(() => capped.account.start(user), { code: 'connect_budget_missing' });
});

test('two pending OAuth callbacks share the profile-validation budget without exposing other account usage', async () => {
  let profileCalls=0;
  const f=fixture({env:{OMNIHUB_X_BOOKMARK_CONNECT_USD:'0.01'},fetchImpl:async url=>{
    if(url.endsWith('/token')) return Response.json(grant);
    profileCalls+=1;return Response.json({data:{id:'42',username:'fixture_x'}});
  }});
  const viewer={id:2,username:'viewer',token:'viewer-session'};
  const paramsFor=account=>{const url=new URL(f.account.start(account).authorizationUrl);return new URLSearchParams({state:url.searchParams.get('state'),code:'fixture-code'});};
  const [first,second]=await Promise.allSettled([f.account.finish(user,paramsFor(user)),f.account.finish(viewer,paramsFor(viewer))]);
  assert.equal([first,second].filter(result=>result.status==='fulfilled').length,1);
  const rejected=[first,second].find(result=>result.status==='rejected').reason;
  assert.equal(rejected.code,'connect_budget_missing');
  assert.equal(profileCalls,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM x_account_connection_reads').get().n,1);
  // Per-account status reports only this account's capability, never global
  // spend or another user's connection details.
  assert.deepEqual(Object.keys(f.account.status(1)).filter(key=>/spend|read|other/i.test(key)),[]);
  assert.deepEqual(Object.keys(f.account.status(2)).filter(key=>/spend|read|other/i.test(key)),[]);
});

test('disconnect keeps originals, prevents late refresh writes and requires the same X account on reconnect', async () => {
  let xId = '42'; const f = fixture({ fetchImpl: async url => Response.json(url.endsWith('/token') ? grant : { data: { id: xId, username: 'fixture_x' } }) });
  await f.account.finish(user, f.params()); f.account.setSync(1, true);
  const config = f.account.syncConfig(1);
  f.db.prepare("INSERT INTO inbox(id,user_id,source,external_id,content) VALUES (1,1,'x','99','retained')").run();
  f.account.disconnect(1);
  assert.equal(f.account.status(1).connected, false);
  await assert.rejects(config.tokenStore.set({ ...grant, x_user_id: '42' }));
  assert.equal(f.db.prepare('SELECT content FROM inbox').get().content, 'retained');
  xId = '43'; await assert.rejects(f.account.finish(user, f.params()), { code: 'account_mismatch' });
});

test('logout, disconnect and superseding authorization cancel an in-flight callback', async () => {
  for (const change of ['logout', 'disconnect', 'restart']) {
    let resume; const waiting = new Promise(resolve => { resume = resolve; });
    const f = fixture({ fetchImpl: async () => { await waiting; return Response.json(grant); } });
    const pending = f.account.finish(user, f.params());
    if (change === 'logout') f.db.prepare('DELETE FROM sessions WHERE token=?').run(user.token);
    else if (change === 'disconnect') f.account.disconnect(1);
    else f.account.start(user);
    resume(); await assert.rejects(pending, { code: 'connection_changed' });
    assert.equal(f.calls.length, 1); assert.equal(f.account.status(1).connected, false);
  }
});

test('first OAuth must match a configured legacy identity; unreadable credentials require reconnect', async () => {
  const legacy = fixture({ env: { OMNIHUB_X_BOOKMARK_X_USER_ID: '43' } });
  await assert.rejects(legacy.account.finish(user, legacy.params()), { code: 'account_mismatch' });
  assert.equal(legacy.account.status(1).connected, false);
  const f = fixture(); await f.account.finish(user, f.params()); f.account.setSync(1, true);
  const config = f.account.syncConfig(1);
  f.db.prepare("UPDATE x_account_connections SET credentials='corrupted' WHERE user_id=1").run();
  assert.equal(f.account.status(1).needsReconnect, true);
  assert.equal(f.account.status(1).connected, false);
  await assert.rejects(config.tokenStore.get(), { code: 'reconnect_required' });
});

test('the legacy X identity guard applies to zane only, never to a new website user', async () => {
  const f=fixture({env:{OMNIHUB_X_BOOKMARK_X_USER_ID:'43'}});
  const viewer={id:2,username:'viewer',token:'viewer-session'};
  await f.account.finish(viewer,(() => {const url=new URL(f.account.start(viewer).authorizationUrl);return new URLSearchParams({state:url.searchParams.get('state'),code:'fixture-code'});})());
  assert.equal(f.account.status(2).connected,true);
  assert.equal(f.account.status(2).xUserId,'42');
  assert.equal(f.account.status(1).connected,false);
});

test('bound collector imports private originals only to zane and stops writes after disconnect', async () => {
  const f = fixture(); await f.account.finish(user, f.params()); f.account.setSync(1, true);
  const config = { clientId: 'fixture-client', budget: { perRunUsd: 5, perDayUsd: 5, perMonthUsd: 5 }, ...f.account.syncConfig(1) };
  const deliveries = [];
  const sync = createXBookmarkSync({ db: f.db, config, onImported: async value => deliveries.push(value), fetchImpl: async () => Response.json({ data: [{ id: '99', text: 'private post' }], meta: {} }) });
  await assert.rejects(sync.runNow(2), { status: 403 });
  assert.equal((await sync.runNow(1)).imported, 1);
  assert.deepEqual({ ...f.db.prepare('SELECT user_id,visibility,content FROM inbox').get() }, { user_id: 1, visibility: 'private', content: 'private post' });
  assert.equal(deliveries[0].userId, 1);
  const revoked = createXBookmarkSync({ db: f.db, config, fetchImpl: async () => { f.account.disconnect(1); return Response.json({ data: [{ id: '100', text: 'must not import' }], meta: {} }); } });
  assert.equal((await revoked.runNow(1)).ok, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
});

test('manual sync keeps the automatic schedule off and preserves interval, ownership and budget limits', async () => {
  const f = fixture(); await f.account.finish(user, f.params());
  assert.equal(f.account.syncConfig(1).enabled, false);
  const binding = f.account.syncConfig(1, { manual: true });
  assert.equal(binding.enabled, true);
  let requests = 0;
  const config = { clientId: 'fixture-client', intervalMs: 7200000, budget: { perRunUsd: 5, perDayUsd: 5, perMonthUsd: 5 }, ...binding };
  const sync = createXBookmarkSync({ db: f.db, config, fetchImpl: async () => { requests++; return Response.json({ data: [{ id: '99001', text: 'private bookmark' }], meta: {} }); } });
  await assert.rejects(sync.runDue(2), { status: 403 });
  assert.equal((await sync.runDue(1)).imported, 1);
  assert.equal(f.account.status(1).syncEnabled, false);
  assert.equal((await sync.runDue(1)).skipped, 'not_due');
  assert.equal(requests, 1);
  const blocked = createXBookmarkSync({ db: f.db, config: { ...config, budget: {} }, fetchImpl: async () => { throw Error('Budget must block the request'); } });
  assert.equal((await blocked.runDue(1)).skipped, 'budget_missing');
  f.account.disconnect(1);
  assert.equal(f.account.syncConfig(1, { manual: true }).enabled, false);
  await assert.rejects(binding.tokenStore.get(), { code: 'reconnect_required' });
  f.db.close();
});

test('disconnect during a manual sync prevents a late response from importing bookmarks', async () => {
  const f = fixture(); await f.account.finish(user, f.params());
  const config = { clientId: 'fixture-client', budget: { perRunUsd: 5, perDayUsd: 5, perMonthUsd: 5 }, ...f.account.syncConfig(1, { manual: true }) };
  const sync = createXBookmarkSync({ db: f.db, config, fetchImpl: async () => { f.account.disconnect(1); return Response.json({ data: [{ id: '99002', text: 'must not import' }], meta: {} }); } });
  assert.equal((await sync.runDue(1)).ok, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  f.db.close();
});

test('manual sync endpoint uses the manual path without enabling a schedule', async () => {
  const { createXAccountHandler } = await import('../lib/x-account-api.js');
  const calls = [];
  const handler = createXAccountHandler({
    account: { status: () => ({ connected: true, syncEnabled: false }), setSync: () => { throw Error('Must not enable schedule'); } },
    sync: { getStatus: () => ({ serverReady: true }), runNow: async id => { calls.push(id); return { ok: true }; }, runDue: () => { throw Error('Must use manual path'); } },
    requireOwner: (req, write) => { assert.equal(write, true); return user; }, readBody: async () => ({}),
    send: (res, status, body) => { assert.equal(status, 200); assert.equal(body.syncEnabled, false); assert.equal(body.result.ok, true); return true; }
  });
  assert.equal(await handler({ method: 'POST' }, {}, '/api/account/x/sync'), true);
  assert.deepEqual(calls, [1]);
});
