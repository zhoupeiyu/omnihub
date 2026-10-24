// In-memory SQLite tests for the life guide store and its HTTP handler.
// Run with a Node that exposes node:sqlite (Node 22.5+/23+, e.g. --experimental-sqlite).
//
// The corpus shape under test is the canonical output of reference/build-life-guide.mjs
// (nested sections[].entries[]), and the real fixture-small.json is imported directly,
// without reshaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { createLifeGuideStore, GUIDE_TABLES, LIFE_GUIDE_REPOSITORY } from '../lib/life-guide-store.js';
import { createLifeGuideHandler } from '../lib/life-guide-api.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const FIXTURE_URL = new URL('./fixtures/life-guide-small.json', import.meta.url);

// --- Canonical corpus builders -------------------------------------------------

const DEFAULT_SECTION = { id: 's1', number: 1, title: 'Basics', file: 'book/01.md', markdown: '# 1. Basics\n\nbody % _ \\', intro: 'Intro\nline two' };
const DEFAULT_ENTRY = {
  id: 's1-e1', number: 1, title: 'Entry One', sectionId: 's1', file: 'book/01.md',
  markdown: '# 1. Entry One\n\noriginal text % _ \\ kept', human: 'human text',
  cost: 'cost text', grade: 'A', money: '0', time: '少', will: '否',
};
const DEFAULT_DOC = { file: 'README.md', title: 'Readme', markdown: '# Readme\nraw doc % _ \\' };

// Builds a canonical corpus from a flat entry list grouped under the given sections.
// Entries keep their input order within each section (as the builder does).
function canonicalCorpus({ sections = [DEFAULT_SECTION], entries = [DEFAULT_ENTRY], docs = [DEFAULT_DOC], metadata = {} } = {}) {
  const grouped = sections.map(section => ({
    ...section,
    entries: entries.filter(entry => entry.sectionId === section.id),
  }));
  return {
    metadata: {
      repository: LIFE_GUIDE_REPOSITORY,
      commit: COMMIT_A,
      date: '2024-01-01',
      generatedAt: '2024-01-01T00:00:00.000Z',
      chapterCount: grouped.length,
      entryCount: entries.length,
      sourceHashes: { 'LICENSE': 'c'.repeat(64), 'README.md': 'd'.repeat(64) },
      ...metadata,
    },
    sections: grouped,
    docs,
    readme: '# Readme top',
    featuredDocs: [],
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE fixture_sentinel (k TEXT PRIMARY KEY, v TEXT); INSERT INTO fixture_sentinel VALUES ('keep', 'unchanged');");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, 'alice');");
  return db;
}

function loadFixture() {
  const full = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  const rawEntries = {};
  for (const section of full.sections) {
    for (const entry of section.entries) rawEntries[entry.id] = entry;
  }
  const rawDocs = {};
  for (const doc of full.docs) rawDocs[doc.file] = doc;
  return { full, rawEntries, rawDocs };
}

// --- HTTP helpers --------------------------------------------------------------

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    destroyed: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { if (chunk) this.body = Buffer.concat([this.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); },
  };
}

function decodeBody(res) {
  const encoding = res.headers && res.headers['Content-Encoding'];
  return (encoding === 'gzip' ? gunzipSync(res.body) : res.body).toString('utf8');
}

function makeReq(method, url, headers = {}) {
  return { method, url, headers };
}

function callHandler(handler, method, url, headers) {
  const req = makeReq(method, url, headers);
  const res = makeRes();
  const handled = handler(req, res, new URL(url, 'http://localhost').pathname);
  const text = decodeBody(res);
  return { handled, res, text, json: text ? JSON.parse(text) : null };
}

// Compression is asynchronous (gzip callback), so wait for the response to finish.
async function callHandlerAsync(handler, method, url, headers, timeoutMs = 2000) {
  const req = makeReq(method, url, headers);
  const res = makeRes();
  const originalEnd = res.end;
  let settle;
  let timer;
  const finished = new Promise(resolve => { settle = resolve; });
  res.end = function end(chunk) {
    originalEnd.call(this, chunk);
    if (timer) clearTimeout(timer);
    settle();
  };
  const handled = handler(req, res, new URL(url, 'http://localhost').pathname);
  timer = setTimeout(settle, timeoutMs);
  await finished;
  if (timer) clearTimeout(timer);
  const text = decodeBody(res);
  return { handled, res, text, json: text ? JSON.parse(text) : null };
}

// --- Exact preservation --------------------------------------------------------

test('exact raw roundtrip preserves text, structure and hash metadata', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const entry = { ...DEFAULT_ENTRY };
  const doc = { ...DEFAULT_DOC };
  store.importCorpus(canonicalCorpus({ entries: [entry], docs: [doc] }));

  const detail = store.detail({ view: 'entries', id: 's1-e1' });
  assert.deepEqual(detail.selected, entry);
  assert.equal(detail.selected.markdown, '# 1. Entry One\n\noriginal text % _ \\ kept');
  assert.equal(detail.section.id, 's1');
  assert.equal(detail.section.intro, 'Intro\nline two');
  assert.equal(detail.section.number, 1);
  assert.equal(detail.version, COMMIT_A);

  const docDetail = store.detail({ view: 'docs', id: 'README.md' });
  assert.deepEqual(docDetail.selected, doc);
  assert.equal(docDetail.section, null);

  // Full original metadata incl sourceHashes is retained, but metadata() must not
  // include bulk markdown or sourceHashes.
  const meta = store.metadata();
  assert.equal(meta.metadata.repository, LIFE_GUIDE_REPOSITORY);
  assert.equal(meta.metadata.commit, COMMIT_A);
  assert.equal(meta.metadata.chapterCount, 1);
  assert.equal(meta.metadata.entryCount, 1);
  assert.equal(meta.metadata.docCount, 1);
  assert.ok(!('sourceHashes' in meta.metadata));
  assert.ok(!('readme' in meta.metadata));
  const metaText = JSON.stringify(meta);
  assert.ok(!metaText.includes('# 1. Basics'));
  assert.ok(!metaText.includes('sourceHashes'));
  assert.equal(meta.sections[0].count, 1);
  assert.deepEqual(meta.docs, [{ file: 'README.md', title: 'Readme' }]);

  db.close();
});

test('real fixture-small.json imports directly without reshaping and preserves originals', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const { full, rawEntries, rawDocs } = loadFixture();

  // Import the parsed fixture verbatim: no flattening, no key remapping.
  const result = store.importCorpus(full);
  assert.equal(result.chapterCount, 1);
  assert.equal(result.entryCount, 2);
  assert.equal(result.commit, full.metadata.commit);

  // Original metadata is returned unchanged (deep equal, incl sourceHashes).
  assert.deepEqual(store.sourceMetadata(), full.metadata);

  // Selected entry detail deep-equals the first original raw entry.
  const first = store.detail({ view: 'entries', id: 's1-e1' });
  assert.deepEqual(first.selected, rawEntries['s1-e1']);
  assert.equal(first.selected.markdown, rawEntries['s1-e1'].markdown);
  assert.ok('markdown' in first.selected);
  assert.ok(!('fullMarkdown' in first.selected));
  assert.equal(first.selected.number, 1);
  assert.equal(first.selected.file, rawEntries['s1-e1'].file);
  assert.equal(first.section.id, 's1');
  assert.equal(first.section.intro, full.sections[0].intro);

  const second = store.detail({ view: 'entries', id: 's1-e2' });
  assert.deepEqual(second.selected, rawEntries['s1-e2']);

  // Selected doc detail deep-equals the original raw doc.
  const docFile = full.docs[0].file;
  const docDetail = store.detail({ view: 'docs', id: docFile });
  assert.deepEqual(docDetail.selected, rawDocs[docFile]);
  assert.equal(docDetail.section, null);

  // Canonical counts: 1 chapter, 2 entries, 1 doc.
  const meta = store.metadata();
  assert.equal(meta.metadata.chapterCount, 1);
  assert.equal(meta.metadata.entryCount, 2);
  assert.equal(meta.metadata.docCount, 1);
  assert.equal(meta.sections.length, 1);
  assert.equal(meta.sections[0].count, 2);
  assert.equal(meta.docs.length, 1);
  assert.ok(!JSON.stringify(meta).includes('sourceHashes'));

  // List summaries include the small scalar fields but no bulk markdown.
  const list = store.list({ view: 'entries' });
  assert.equal(list.count, 2);
  const firstRow = list.rows.find(row => row.id === 's1-e1');
  assert.equal(firstRow.grade, 'A');
  assert.equal(firstRow.money, '0');
  assert.equal(firstRow.human, rawEntries['s1-e1'].human);
  assert.equal(firstRow.cost, rawEntries['s1-e1'].cost);
  assert.ok(!('markdown' in firstRow));
  assert.ok(!('fullMarkdown' in firstRow));
  assert.ok(!JSON.stringify(list).includes('NHTSA'));

  db.close();
});

// --- Validation / atomic rollback ---------------------------------------------

test('invalid import rolls back and leaves previous data intact', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus());
  const before = store.metadata();
  const beforeMeta = store.sourceMetadata();

  const reject = corpus => assert.throws(
    () => store.importCorpus(corpus, {}),
    error => error.code === 'INVALID_CORPUS',
  );

  // Foreign sectionId on an entry (the entry lives under a section but points elsewhere).
  const foreign = canonicalCorpus();
  foreign.sections[0].entries.push({ ...DEFAULT_ENTRY, id: 's1-e9', number: 9, sectionId: 'ghost' });
  foreign.metadata.entryCount = 2;
  reject(foreign);
  // Duplicate section id.
  reject(canonicalCorpus({ sections: [DEFAULT_SECTION, { ...DEFAULT_SECTION, entries: [] }], entries: [] }));
  // Duplicate entry id across chapters.
  reject(canonicalCorpus({ entries: [DEFAULT_ENTRY, { ...DEFAULT_ENTRY, number: 2 }] }));
  // Bad commit shape.
  reject(canonicalCorpus({ metadata: { commit: 'nothex' } }));
  // Declared chapter/entry count mismatch.
  reject(canonicalCorpus({ metadata: { entryCount: 9 } }));
  reject(canonicalCorpus({ metadata: { chapterCount: 4 } }));
  // Missing license / malformed source hash.
  reject(canonicalCorpus({ metadata: { sourceHashes: { 'README.md': 'd'.repeat(64) } } }));
  reject(canonicalCorpus({ metadata: { sourceHashes: { 'LICENSE': 'xyz', 'README.md': 'd'.repeat(64) } } }));
  // Wrong repository.
  reject(canonicalCorpus({ metadata: { repository: 'https://example.com/other' } }));
  // Invalid grade.
  reject(canonicalCorpus({ entries: [{ ...DEFAULT_ENTRY, grade: 'Z' }] }));
  // Missing required string (foreign sectionId also breaks the declared count).
  reject(canonicalCorpus({ entries: [{ ...DEFAULT_ENTRY, sectionId: '' }] }));

  const after = store.metadata();
  assert.deepEqual(after, before);
  assert.deepEqual(store.sourceMetadata(), beforeMeta);
  assert.equal(store.getCommit(), COMMIT_A);
  assert.equal(store.list({ view: 'entries' }).count, 1);

  // A valid replacement is atomic and swaps the whole dataset.
  store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_B, generatedAt: '2024-02-02T00:00:00.000Z' } }));
  assert.equal(store.getCommit(), COMMIT_B);
  assert.equal(store.list({ view: 'entries' }).count, 1);

  db.close();
});

// --- Version / expected-commit guard -------------------------------------------

test('stale expectedCommit is rejected inside the transaction', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_B } }));

  assert.throws(
    () => store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_A } }), { expectedCommit: COMMIT_B.substring(0, 39) + 'c' }),
    error => error.code === 'VERSION_CHANGED' && error.status === 409,
  );
  // Matching expectation succeeds.
  store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_A } }), { expectedCommit: COMMIT_B });
  assert.equal(store.getCommit(), COMMIT_A);

  db.close();
});

test('explicit expectedCommit:null guards the initial empty state', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);

  // Empty table + explicit null => allowed.
  store.importCorpus(canonicalCorpus(), { expectedCommit: null });
  assert.equal(store.getCommit(), COMMIT_A);

  // Data exists + explicit null => rejected, table unchanged.
  assert.throws(
    () => store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_B } }), { expectedCommit: null }),
    error => error.code === 'VERSION_CHANGED' && error.status === 409,
  );
  assert.equal(store.getCommit(), COMMIT_A);

  // Missing option => caller-owned import is allowed even with data present.
  store.importCorpus(canonicalCorpus({ metadata: { commit: COMMIT_B } }));
  assert.equal(store.getCommit(), COMMIT_B);

  db.close();
});

test('version mismatch throws VERSION_CHANGED 409', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus());

  assert.throws(() => store.list({ view: 'entries', version: COMMIT_B }), error => error.code === 'VERSION_CHANGED' && error.status === 409);
  assert.throws(() => store.detail({ view: 'entries', id: 's1-e1', version: COMMIT_B }), error => error.code === 'VERSION_CHANGED');
  assert.equal(store.list({ view: 'entries', version: COMMIT_A }).version, COMMIT_A);

  db.close();
});

test('NOT_READY before any import', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  assert.throws(() => store.metadata(), error => error.code === 'NOT_READY' && error.status === 503);
  assert.throws(() => store.list({ view: 'entries' }), error => error.code === 'NOT_READY');
  db.close();
});

// --- Query / filter / pagination -----------------------------------------------

test('LIKE metacharacters match literally', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const entries = [
    { id: 'e1', number: 1, title: '100% pure', sectionId: 's1', file: 'f', markdown: 'a', grade: 'A' },
    { id: 'e2', number: 2, title: '100x pure', sectionId: 's1', file: 'f', markdown: 'a', grade: 'A' },
    { id: 'e3', number: 3, title: 'a_b token', sectionId: 's1', file: 'f', markdown: 'a', grade: 'A' },
    { id: 'e4', number: 4, title: 'axb token', sectionId: 's1', file: 'f', markdown: 'a', grade: 'A' },
    { id: 'e5', number: 5, title: 'path a\\b here', sectionId: 's1', file: 'f', markdown: 'a', grade: 'A' },
  ];
  store.importCorpus(canonicalCorpus({
    sections: [{ ...DEFAULT_SECTION, entries: [] }],
    entries,
    docs: [],
  }));

  assert.deepEqual(store.list({ view: 'entries', q: '100%' }).rows.map(r => r.id), ['e1']);
  assert.deepEqual(store.list({ view: 'entries', q: 'a_b' }).rows.map(r => r.id), ['e3']);
  assert.deepEqual(store.list({ view: 'entries', q: 'a\\b' }).rows.map(r => r.id), ['e5']);

  db.close();
});

test('query is case-insensitive Unicode AND of substrings across title and markdown', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const entries = [
    { id: 'e1', number: 1, title: 'Café Über', sectionId: 's1', file: 'f', markdown: 'Résumé deep text', grade: 'A' },
    { id: 'e2', number: 2, title: 'Other', sectionId: 's1', file: 'f', markdown: 'café only here', grade: 'A' },
    { id: 'e3', number: 3, title: 'Nothing', sectionId: 's1', file: 'f', markdown: 'plain', grade: 'A' },
  ];
  store.importCorpus(canonicalCorpus({ sections: [{ ...DEFAULT_SECTION, entries: [] }], entries, docs: [] }));

  assert.deepEqual(store.list({ view: 'entries', q: 'CAFÉ' }).rows.map(r => r.id).sort(), ['e1', 'e2']);
  assert.deepEqual(store.list({ view: 'entries', q: 'café résumé' }).rows.map(r => r.id), ['e1']);
  assert.equal(store.list({ view: 'entries', q: 'café zzz' }).count, 0);
  assert.deepEqual(store.list({ view: 'entries', q: '  café   résumé  ' }).rows.map(r => r.id), ['e1']);

  db.close();
});

test('filters, chapter scope, pagination and focus outside the first page', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  // Two chapters; ids run in document order so positional order is e00..e44.
  const entries = [];
  for (let i = 0; i < 45; i += 1) {
    const idx = String(i).padStart(2, '0');
    entries.push({
      id: `e${idx}`,
      number: i + 1,
      sectionId: i < 23 ? 's1' : 's2',
      file: 'f',
      title: `Entry ${i}`,
      markdown: `body ${i}`,
      human: `human ${i}`,
      cost: 'c',
      grade: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C',
      money: i % 2 === 0 ? '0' : '多',
      time: '中',
      will: '是',
    });
  }
  store.importCorpus(canonicalCorpus({
    sections: [
      { id: 's1', number: 1, title: 'One', file: 'one.md', markdown: 'm1', intro: 'i1', entries: [] },
      { id: 's2', number: 2, title: 'Two', file: 'two.md', markdown: 'm2', intro: 'i2', entries: [] },
    ],
    entries,
    docs: [DEFAULT_DOC],
  }));

  const paged = store.list({ view: 'entries' });
  assert.equal(paged.limit, 40);
  assert.equal(paged.offset, 0);
  assert.equal(paged.count, 45);
  assert.equal(paged.rows.length, 40);
  assert.equal(paged.rows[0].id, 'e00');
  assert.equal(paged.rows[39].id, 'e39');
  assert.ok(!('markdown' in paged.rows[0]));
  assert.ok(!('fullMarkdown' in paged.rows[0]));

  const page2 = store.list({ view: 'entries', limit: 10, offset: 40 });
  assert.equal(page2.rows.length, 5);
  assert.equal(page2.rows[0].id, 'e40');

  // Focus resolves even for an item past the first page; rows stay the first 40.
  const focused = store.list({ view: 'entries', selected: 'e44' });
  assert.equal(focused.rows.length, 40);
  assert.equal(focused.rows[0].id, 'e00');
  assert.ok(focused.focus);
  assert.equal(focused.focus.id, 'e44');
  assert.equal(focused.focus.position, 44);
  // No fallback when the selected id is not in the current result set (e44 is C).
  assert.equal(store.list({ view: 'entries', selected: 'e44', grade: 'A' }).focus, null);

  assert.equal(store.list({ view: 'entries', chapter: 's2' }).count, 22);
  assert.equal(store.list({ view: 'entries', grade: 'B' }).count, 15);
  assert.equal(store.list({ view: 'entries', money: '多' }).count, 22);
  assert.equal(store.list({ view: 'entries', time: '中' }).count, 45);
  assert.equal(store.list({ view: 'entries', will: '是' }).count, 45);
  assert.equal(store.list({ view: 'entries', grade: 'A', money: '0' }).count, 8);

  // Docs view ignores entry-only filters.
  assert.equal(store.list({ view: 'docs', grade: 'A' }).count, 1);
  assert.throws(() => store.list({ view: 'entries', limit: 'x' }), error => error.code === 'BAD_REQUEST');
  assert.throws(() => store.list({ view: 'entries', limit: 0 }), error => error.code === 'BAD_REQUEST');
  assert.throws(() => store.list({ view: 'entries', limit: 999 }), error => error.code === 'BAD_REQUEST');
  assert.throws(() => store.list({ view: 'entries', grade: 'Z' }), error => error.code === 'BAD_REQUEST');
  assert.throws(() => store.detail({ view: 'entries', id: 'e01', version: 'x' }), error => error.code === 'VERSION_CHANGED');

  db.close();
});

// --- Isolation and timestamps --------------------------------------------------

test('store creates only guide tables and leaves unrelated tables untouched', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus());

  const before = store.metadata().metadata;
  const check = store.markChecked();
  const after = store.metadata().metadata;
  assert.ok(typeof check.checkedAt === 'string');
  assert.equal(after.checkedAt, check.checkedAt);
  // markChecked only changes checkedAt; content updatedAt is never touched.
  assert.equal(after.updatedAt, before.updatedAt);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const name of tables) {
    assert.ok(GUIDE_TABLES.includes(name) || name === 'fixture_sentinel' || name === 'users', `unexpected table ${name}`);
  }
  for (const name of GUIDE_TABLES) assert.ok(tables.includes(name), `missing ${name}`);

  const sentinel = db.prepare('SELECT v FROM fixture_sentinel WHERE k = ?').get('keep');
  assert.equal(sentinel.v, 'unchanged');
  const user = db.prepare('SELECT name FROM users WHERE id = 1').get();
  assert.equal(user.name, 'alice');

  db.close();
});

// --- HTTP handler --------------------------------------------------------------

test('handler: read-only methods, unknown paths and safe errors', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus());
  const handler = createLifeGuideHandler(store);

  assert.equal(callHandler(handler, 'GET', '/api/other').handled, false);
  assert.equal(callHandler(handler, 'GET', '/api/life-guidex').handled, false);

  const meta = callHandler(handler, 'GET', '/api/life-guide/meta');
  assert.equal(meta.res.statusCode, 200);
  assert.equal(meta.json.metadata.commit, COMMIT_A);
  assert.ok(!meta.text.includes('sourceHashes'));

  const list = callHandler(handler, 'GET', '/api/life-guide/list?view=entries&q=Entry');
  assert.equal(list.res.statusCode, 200);
  assert.equal(list.json.count, 1);
  assert.ok(!list.text.includes('original text'));
  assert.equal(list.res.headers['Cache-Control'], 'no-store');

  const detail = callHandler(handler, 'GET', '/api/life-guide/detail?view=entries&id=s1-e1');
  assert.equal(detail.res.statusCode, 200);
  assert.deepEqual(detail.json.selected, DEFAULT_ENTRY);

  // HEAD returns headers and no body.
  const head = callHandler(handler, 'HEAD', '/api/life-guide/meta');
  assert.equal(head.res.statusCode, 200);
  assert.equal(head.res.body.length, 0);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = callHandler(handler, method, '/api/life-guide/list');
    assert.equal(res.res.statusCode, 405, `${method} should be 405`);
    assert.equal(res.res.headers.Allow, 'GET, HEAD');
    assert.equal(res.json.error, 'METHOD_NOT_ALLOWED');
  }

  const unknown = callHandler(handler, 'GET', '/api/life-guide/nope');
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error, 'NOT_FOUND');

  const missing = callHandler(handler, 'GET', '/api/life-guide/detail?view=entries&id=zzz');
  assert.equal(missing.res.statusCode, 404);
  assert.equal(missing.json.error, 'NOT_FOUND');

  const bad = callHandler(handler, 'GET', '/api/life-guide/list?view=entries&limit=abc');
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.json.error, 'BAD_REQUEST');
  const stale = callHandler(handler, 'GET', '/api/life-guide/list?view=entries&version=' + COMMIT_B);
  assert.equal(stale.res.statusCode, 409);
  assert.equal(stale.json.error, 'VERSION_CHANGED');
  const body = JSON.stringify([bad.json, stale.json, missing.json, unknown.json]);
  assert.ok(!/sqlite|SELECT|INSERT|life_guide_entries/i.test(body));

  db.close();
});

test('handler: public reads compress gzip even for cookie-bearing requests', async () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const { full, rawDocs } = loadFixture();
  store.importCorpus(full);
  const handler = createLifeGuideHandler(store);
  const docFile = full.docs[0].file;
  const docUrl = `/api/life-guide/detail?view=docs&id=${encodeURIComponent(docFile)}`;

  // Large detail payload over 1 KiB is gzip-compressed for an anonymous read.
  const anon = await callHandlerAsync(handler, 'GET', docUrl, { 'accept-encoding': 'gzip' });
  assert.equal(anon.res.statusCode, 200);
  assert.equal(anon.res.headers['Content-Encoding'], 'gzip');
  assert.match(anon.res.headers.Vary, /Accept-Encoding/);
  assert.deepEqual(anon.json.selected, rawDocs[docFile]);

  // Cookies do not alter the payload: same body, still compressed.
  const withCookie = await callHandlerAsync(handler, 'GET', docUrl, { 'accept-encoding': 'gzip', cookie: 'session=secret' });
  assert.equal(withCookie.res.statusCode, 200);
  assert.equal(withCookie.res.headers['Content-Encoding'], 'gzip');
  assert.deepEqual(withCookie.json.selected, rawDocs[docFile]);

  // Clients that do not accept gzip still get plain JSON.
  const plain = await callHandlerAsync(handler, 'GET', docUrl, {});
  assert.equal(plain.res.statusCode, 200);
  assert.ok(!('Content-Encoding' in plain.res.headers));
  assert.deepEqual(plain.json.selected, rawDocs[docFile]);

  db.close();
});

test('handler: NOT_READY maps to 503', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  const handler = createLifeGuideHandler(store);
  const res = callHandler(handler, 'GET', '/api/life-guide/meta');
  assert.equal(res.res.statusCode, 503);
  assert.equal(res.json.error, 'NOT_READY');
  db.close();
});

test('oversized q is rejected with BAD_REQUEST before SQL compile', () => {
  const db = freshDb();
  const store = createLifeGuideStore(db);
  store.importCorpus(canonicalCorpus());
  const handler = createLifeGuideHandler(store);

  const manyTokens = Array.from({ length: 1000 }, () => 'a').join(' ');
  const longSingle = 'x'.repeat(513);

  for (const q of [manyTokens, longSingle]) {
    assert.throws(() => store.list({ view: 'entries', q }), error => error.code === 'BAD_REQUEST' && error.status === 400);
    const viaHandler = callHandler(handler, 'GET', '/api/life-guide/list?view=entries&q=' + encodeURIComponent(q));
    assert.equal(viaHandler.res.statusCode, 400);
    assert.equal(viaHandler.json.error, 'BAD_REQUEST');
  }

  // At the caps the query still runs: 32 identical tokens (191 chars) hit via AND.
  const maxTokens = Array.from({ length: 32 }, () => 'entry').join(' ');
  const within = store.list({ view: 'entries', q: maxTokens });
  assert.equal(within.version, COMMIT_A);
  assert.equal(within.count, 1);
  assert.equal(within.rows[0].id, 's1-e1');

  // Exactly 512 characters is allowed; 513 is not (boundary).
  assert.equal(store.list({ view: 'entries', q: 'x'.repeat(512) }).count, 0);
  assert.throws(() => store.list({ view: 'entries', q: 'x'.repeat(513) }), error => error.code === 'BAD_REQUEST');

  db.close();
});

test('WAL read snapshot keeps metadata/list/detail coherent when a commit races in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-guide-wal-'));
  const file = join(dir, 'guide.db');
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA journal_mode = WAL;');
  writer.exec('PRAGMA busy_timeout = 5000;');
  const writerStore = createLifeGuideStore(writer);
  const { full, rawEntries } = loadFixture();
  writerStore.importCorpus(full);

  const v2 = canonicalCorpus({ metadata: { commit: COMMIT_B, generatedAt: '2024-02-02T00:00:00.000Z' } });

  function race(operation) {
    let fired = false;
    const reader = new DatabaseSync(file);
    reader.exec('PRAGMA journal_mode = WAL;');
    reader.exec('PRAGMA busy_timeout = 5000;');
    const proxy = {
      exec: sql => reader.exec(sql),
      prepare(sql) {
        const stmt = reader.prepare(sql);
        return {
          get(...args) {
            const row = stmt.get(...args);
            if (!fired && sql.includes('life_guide_metadata') && args[0] === 'commit') {
              fired = true;
              writerStore.importCorpus(v2);
            }
            return row;
          },
          all: (...args) => stmt.all(...args),
          run: (...args) => stmt.run(...args),
        };
      },
    };
    const readerStore = createLifeGuideStore(proxy);
    try {
      const result = operation(readerStore);
      assert.equal(fired, true, 'the current-commit read should have been intercepted');
      return result;
    } finally {
      reader.close();
      writerStore.importCorpus(full);
    }
  }

  try {
    const detail = race(store => store.detail({ view: 'entries', id: 's1-e1' }));
    assert.equal(detail.version, full.metadata.commit);
    assert.deepEqual(detail.selected, rawEntries['s1-e1']);
    assert.equal(detail.selected.title, rawEntries['s1-e1'].title);
    assert.notEqual(detail.selected.title, DEFAULT_ENTRY.title);
    assert.equal(detail.section.id, 's1');

    const meta = race(store => store.metadata());
    assert.equal(meta.metadata.commit, full.metadata.commit);
    assert.equal(meta.metadata.chapterCount, 1);
    assert.equal(meta.metadata.entryCount, 2);
    assert.equal(meta.sections.length, 1);
    assert.equal(meta.sections[0].count, 2);

    const list = race(store => store.list({ view: 'entries', version: full.metadata.commit }));
    assert.equal(list.version, full.metadata.commit);
    assert.equal(list.count, 2);
    assert.deepEqual(list.rows.map(row => row.id).sort(), ['s1-e1', 's1-e2']);
    assert.ok(!JSON.stringify(list).includes(DEFAULT_ENTRY.title));
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
