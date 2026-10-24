// Atomicity coverage for life-guide imports: the opt-in checked timestamp and
// the replacement content must commit or roll back inside the single import
// transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import * as storeModule from '../lib/life-guide-store.js';

const FIXTURE_URL = new URL('./fixtures/life-guide-small.json', import.meta.url);
const PREVIOUS = '2021-05-06T07:08:09.000Z';

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
}

function storeFactory() {
  const candidates = [
    storeModule.createLifeGuideStore,
    storeModule.createStore,
    storeModule.openStore,
    storeModule.default,
  ].filter((candidate) => typeof candidate === 'function');
  assert.ok(candidates.length > 0, 'lib/life-guide-store.js must export a store factory');
  return candidates[0];
}

async function openStore() {
  const db = new DatabaseSync(':memory:');
  const store = await storeFactory()(db);
  return { db, store };
}

function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM life_guide_metadata WHERE key = ?').get(key);
  return row === undefined ? undefined : row.value;
}

function writeMetaRow(db, key, value) {
  const info = db.prepare('UPDATE life_guide_metadata SET value = ? WHERE key = ?').run(value, key);
  if (info.changes === 0) {
    db.prepare('INSERT INTO life_guide_metadata (key, value) VALUES (?, ?)').run(key, value);
  }
}

function withCommit(corpus, commit) {
  const next = structuredClone(corpus);
  if (next.metadata) next.metadata.commit = commit;
  if (Object.prototype.hasOwnProperty.call(next, 'commit')) next.commit = commit;
  return next;
}

function snapshot(db) {
  return {
    commit: readMeta(db, 'commit'),
    updatedAt: readMeta(db, 'updatedAt'),
    checkedAt: readMeta(db, 'checkedAt'),
    docCount: db.prepare('SELECT COUNT(*) AS count FROM life_guide_docs').get().count,
    firstEntryRaw: db.prepare('SELECT raw FROM life_guide_entries ORDER BY position LIMIT 1').get()?.raw,
  };
}

test('recordChecked:true stamps a fresh ISO checkedAt inside the import', async (t) => {
  const { db, store } = await openStore();
  t.after(() => db.close());
  await store.importCorpus(readFixture(), { expectedCommit: null, recordChecked: true });
  const checkedAt = String(readMeta(db, 'checkedAt'));
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
});

test('default import keeps the previously stored checkedAt', async (t) => {
  const { db, store } = await openStore();
  t.after(() => db.close());
  const corpus = readFixture();
  await store.importCorpus(corpus, { expectedCommit: null });
  writeMetaRow(db, 'checkedAt', PREVIOUS);
  writeMetaRow(db, 'commit', 'a'.repeat(40));
  await store.importCorpus(corpus, { expectedCommit: 'a'.repeat(40) });
  assert.equal(readMeta(db, 'checkedAt'), PREVIOUS);
});

test('a failing doc insert rolls the recordChecked import back atomically', async (t) => {
  const { db, store } = await openStore();
  t.after(() => db.close());

  const corpus = readFixture();
  await store.importCorpus(corpus, { expectedCommit: null });
  assert.ok(
    db.prepare('SELECT COUNT(*) AS count FROM life_guide_docs').get().count > 0,
    'fixture must contain docs for the abort trigger to fire',
  );

  writeMetaRow(db, 'checkedAt', PREVIOUS);
  writeMetaRow(db, 'commit', 'a'.repeat(40));
  const before = snapshot(db);

  db.exec(`CREATE TRIGGER abort_docs BEFORE INSERT ON life_guide_docs BEGIN SELECT RAISE(ABORT, 'rollback please'); END;`);

  await assert.rejects(async () => {
    await store.importCorpus(withCommit(corpus, 'b'.repeat(40)), {
      expectedCommit: 'a'.repeat(40),
      recordChecked: true,
    });
  });

  assert.deepEqual(snapshot(db), before);
});
