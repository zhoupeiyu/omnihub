import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createEncryptedTokenFile, createXBookmarkSync, loadXBookmarkSyncConfig } from "../lib/x-bookmark-sync.js";
import { normalizeBookmarkPage } from "../lib/x-bookmark-sync-normalize.js";

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1),(2);
    CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]', metrics TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'private', status TEXT NOT NULL DEFAULT 'pending', ai_type TEXT NOT NULL DEFAULT '', ai_confidence REAL NOT NULL DEFAULT 0, ai_summary TEXT NOT NULL DEFAULT '', ai_extract TEXT NOT NULL DEFAULT '{}', UNIQUE(user_id,source,external_id));`);
  return db;
}
function enabled(token = { access_token: "access", x_user_id: "42", expires_at: Date.now() + 3600_000 }) {
  return { enabled: true, xUserId: "42", clientId: "client", intervalMs: 2 * 3600_000, maxPages: 5, budget: { perRunUsd: 10, perDayUsd: 10, perMonthUsd: 10 }, tokenStore: { get: async () => token, set: async (value) => Object.assign(token, value) } };
}
function response(page, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => page }; }

test("configuration is disabled unless explicit and all budget caps are positive", () => {
  assert.equal(loadXBookmarkSyncConfig({}).enabled, false);
  const db = createDb(); let calls = 0;
  const sync = createXBookmarkSync({ db, config: { enabled: true, xUserId: "42", tokenStore: { get() {}, set() {} }, budget: {} }, fetchImpl: async () => { calls += 1; } });
  return sync.runNow(1).then((result) => { assert.equal(result.skipped, "budget_missing"); assert.equal(calls, 0); });
});

test("an untouched sync status is explicitly not_started", () => {
  const sync = createXBookmarkSync({ db: createDb(), config: enabled() });
  assert.equal(sync.getStatus(1).coverage, "not_started");
});

test('request rejections release a reservation, while 5xx and malformed responses remain uncertain', async () => {
  for (const httpStatus of [400, 401, 403, 429, 500, 200]) {
    const db = createDb();
    const sync = createXBookmarkSync({db,config:enabled(),fetchImpl:async url=>{
      const params=new URL(url).searchParams;
      assert.ok(params.get('post.fields').includes('note_post'));
      assert.ok(params.get('media.fields').includes('variants'));
      return response({},httpStatus);
    }});
    assert.equal((await sync.runNow(1)).ok,false);
    const row=db.prepare('SELECT state,final_usd FROM x_bookmark_sync_reservations').get();
    if ([400,401,403,429].includes(httpStatus)) { assert.equal(row.state,'final');assert.equal(row.final_usd,0); }
    else { assert.equal(row.state,'uncertain');assert.equal(row.final_usd,null); }
    db.close();
  }
});

test("encrypted token file has no plaintext and can be read only with its external key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-token-")); const file = path.join(directory, "token.json");
  try {
    assert.throws(()=>createEncryptedTokenFile(file,'weak-key'));
    const store = createEncryptedTokenFile(file, "ab".repeat(32)); await store.set({ access_token: "not-in-file", refresh_token: "also-secret" });
    assert.deepEqual(await store.get(), { access_token: "not-in-file", refresh_token: "also-secret" });
    assert.doesNotMatch(await readFile(file, "utf8"), /not-in-file|also-secret/);
    await assert.rejects(createEncryptedTokenFile(file, "cd".repeat(32)).get());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sync paginates, records immutable snapshots and never overwrites an existing manually curated row", async () => {
  const db = createDb(); let calls = 0; const imported = [];
  db.prepare("INSERT INTO inbox (user_id,source,external_id,title,content,visibility,status,ai_type) VALUES (1,'x','99','人工标题','人工内容','public','ignored','knowledge')").run();
  const sync = createXBookmarkSync({ db, config: enabled(), onImported: async ({ inboxIds }) => imported.push(...inboxIds), fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response({ data: [{ id: "99", text: "old tweet newly bookmarked" }, { id: "100", text: "new" }], meta: { next_token: "p2" } }) : response({ data: [], meta: {} });
  } });
  const result = await sync.runNow(1);
  assert.equal(result.ok, true); assert.equal(result.imported, 1); assert.equal(calls, 2);
  assert.equal(db.prepare("SELECT title FROM inbox WHERE external_id='99'").get().title, "人工标题");
  assert.equal(db.prepare("SELECT visibility FROM inbox WHERE external_id='100'").get().visibility, "private");
  assert.equal(db.prepare("SELECT status FROM inbox WHERE external_id='100'").get().status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM x_bookmark_sync_snapshots").get().n, 2);
  assert.equal(imported.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM x_bookmark_sync_pending_imports WHERE delivered_at>0").get().n, 1);
});

test("a refreshed rotated token is persisted and a refresh invalid_grant requires reconnect", async () => {
  const db = createDb(); const token = { access_token: "expired", refresh_token: "old", x_user_id: "42", expires_at: 0 }; let stored;
  const sync = createXBookmarkSync({ db, config: { ...enabled(token), tokenStore: { get: async () => token, set: async (value) => { stored = value; } } }, fetchImpl: async (url) => {
    if (url === "https://api.x.com/2/oauth2/token") return response({ access_token: "new", refresh_token: "rotated", expires_in: 7200 });
    return response({ data: [], meta: {} });
  } });
  assert.equal((await sync.runNow(1)).ok, true); assert.equal(stored.refresh_token, "rotated");
  const failed = createXBookmarkSync({ db: createDb(), config: enabled({ access_token: "", refresh_token: "old", x_user_id: "42", expires_at: 0 }), fetchImpl: async () => response({}, 400) });
  const result = await failed.runNow(1); assert.equal(result.error, "reconnect_required"); assert.equal(result.needsReconnect, true);
  const missingAccount = createXBookmarkSync({ db: createDb(), config: enabled({ access_token: "access", expires_at: Date.now() + 3600_000 }), fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal((await missingAccount.runNow(1)).error, "reconnect_required");
});

test("empty pages complete safely, repeated cursors are guarded, and uncertain request costs remain reserved", async () => {
  const empty = createXBookmarkSync({ db: createDb(), config: enabled(), fetchImpl: async () => response({ meta: {} }) });
  assert.equal((await empty.runNow(1)).ok, true);
  const repeatDb = createDb(); let calls = 0;
  const repeat = createXBookmarkSync({ db: repeatDb, config: enabled(), fetchImpl: async () => { calls += 1; return response({ data: [], meta: { next_token: "same" } }); } });
  const guarded = await repeat.runNow(1); assert.equal(guarded.error, "page_guard"); assert.equal(calls, 2);
  const uncertainDb = createDb(); const uncertain = createXBookmarkSync({ db: uncertainDb, config: enabled(), fetchImpl: async () => { throw new Error("timeout"); } });
  assert.equal((await uncertain.runNow(1)).error, "upstream");
  assert.equal(uncertainDb.prepare("SELECT state FROM x_bookmark_sync_reservations").get().state, "uncertain");
});

test("each additional page rechecks the run cap and delivery does not acknowledge concurrent markers", async () => {
  const db = createDb(); let calls = 0;
  const token = { access_token: "access", x_user_id: "42", expires_at: Date.now() + 3600_000 };
  const config = enabled(token); config.budget.perRunUsd = 1.5;
  const sync = createXBookmarkSync({ db, config, fetchImpl: async () => {
    calls += 1; return response({ data: [{ id: String(calls), text: "one" }], meta: { next_token: calls === 1 ? "more" : "" } });
  } });
  const capped = await sync.runNow(1); assert.equal(capped.error, "budget"); assert.equal(calls, 1);
  const deliveryDb = createDb(); const delivered = createXBookmarkSync({ db: deliveryDb, config: enabled(), onImported: async () => {
    deliveryDb.prepare("INSERT INTO x_bookmark_sync_pending_imports (user_id,inbox_id,run_id,created_at) VALUES (1,999,'other',1)").run();
  }, fetchImpl: async () => response({ data: [{ id: "101", text: "one" }], meta: {} }) });
  assert.equal((await delivered.runNow(1)).ok, true);
  assert.equal(deliveryDb.prepare("SELECT delivered_at FROM x_bookmark_sync_pending_imports WHERE inbox_id=999").get().delivered_at, 0);
});

test('an opted-in second account cannot multiply the server X spending cap', async () => {
  const db=createDb();
  const page={data:Array.from({length:100},(_,index)=>({id:String(1000+index),text:'saved'})),meta:{}};
  const sharedBudget={perRunUsd:1,perDayUsd:.15,perMonthUsd:.15};
  const first=createXBookmarkSync({db,config:{...enabled({access_token:'one',x_user_id:'42',expires_at:Date.now()+3600_000}),costPerResourceUsd:.001,sharedBudget},fetchImpl:async()=>response(page)});
  assert.equal((await first.runNow(1)).ok,true);
  const second=createXBookmarkSync({db,config:{...enabled({access_token:'two',x_user_id:'43',expires_at:Date.now()+3600_000}),xUserId:'43',costPerResourceUsd:.001,sharedBudget},fetchImpl:async()=>{throw new Error('must not call');}});
  const result=await second.runNow(2);
  assert.equal(result.error,'budget');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM x_bookmark_sync_reservations WHERE user_id=2').get().n,0);
});

test("deleted originals leave a tombstone, snapshots contain metadata only, and capped traversal resumes at its persisted cursor", async () => {
  const db = createDb(); const config = enabled(); config.maxPages = 1; let calls = 0;
  const sync = createXBookmarkSync({ db, config, fetchImpl: async (url) => {
    calls += 1; const cursor = new URL(url).searchParams.get("pagination_token");
    if (!cursor) return response({ data: [{ id: "501", text: "private original must not live in snapshots" }], meta: { next_token: "resume-1", result_count: 1 } });
    assert.equal(cursor, "resume-1"); return response({ data: [], meta: {} });
  } });
  const first = await sync.runNow(1); assert.equal(first.ok, true); assert.equal(first.partial, true); assert.equal(first.coverage, "partial_page_limit");
  const snapshot = db.prepare("SELECT response_json FROM x_bookmark_sync_snapshots").get().response_json;
  assert.doesNotMatch(snapshot, /private original|includes|text/); assert.match(snapshot, /501/);
  const second = await sync.runNow(1); assert.equal(second.ok, true); assert.equal(second.coverage, "full"); assert.equal(calls, 2);
  db.prepare("DELETE FROM inbox WHERE user_id=1 AND source='x' AND external_id='501'").run();
  const replay = createXBookmarkSync({ db, config: enabled(), fetchImpl: async () => response({ data: [{ id: "501", text: "do not resurrect" }], meta: {} }) });
  assert.equal((await replay.runNow(1)).ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE external_id='501'").get().n, 0);
});

test("normalization preserves a usable X URL from the expanded author", () => {
  const [item] = normalizeBookmarkPage({ data: [{ id: "701", author_id: "a", text: "hello", referenced_posts: [{ id: "q", type: "quoted" }] }], includes: { users: [{ id: "a", username: "hello_x" }] }, meta: {} });
  assert.equal(item.url, "https://x.com/hello_x/status/701"); assert.deepEqual(item.metrics.referencedPosts, [{ id: "q", type: "quoted" }]);
});

test("a persisted cursor rejected by X is cleared and remains partial until the next safe full scan", async () => {
  const db = createDb(); const config = enabled(); config.maxPages = 1;
  const first = createXBookmarkSync({ db, config, fetchImpl: async () => response({ data: [{ id: "801", text: "first" }], meta: { next_token: "stale-cursor" } }) });
  assert.equal((await first.runNow(1)).partial, true);
  const second = createXBookmarkSync({ db, config: enabled(), fetchImpl: async () => response({}, 400) });
  const result = await second.runNow(1);
  assert.equal(result.error, "cursor_invalid"); assert.equal(result.partial, true); assert.equal(result.coverage, "partial_cursor_invalid");
  assert.equal(db.prepare("SELECT resume_cursor FROM x_bookmark_sync_state WHERE user_id=1").get().resume_cursor, "");
});
