import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readIndexedCollections} from '../lib/drive-catalog.js';
import {DRIVE_COLLECTIONS, createDriveIndex} from '../lib/openlist-library.js';

// Build an in-memory DB with the real drive_index schema (via the actual
// createDriveIndex from openlist-library.js) plus a drive_scan_dirs table
// matching the schema defined in lib/drive-scan.js. No network, no disk.
function setupDb() {
  const db = new DatabaseSync(':memory:');
  createDriveIndex(db);
  db.exec(`CREATE TABLE drive_scan_dirs(
    user_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    page INTEGER NOT NULL DEFAULT 1,
    total INTEGER,
    seen INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY(user_id,path)
  )`);
  return db;
}

const markScanDir = (db, userId, path, state) =>
  db
    .prepare(
      'INSERT INTO drive_scan_dirs(user_id,path,state) VALUES (?,?,?) ' +
        'ON CONFLICT(user_id,path) DO UPDATE SET state=excluded.state'
    )
    .run(userId, path, state);

const insertIndexRow = (db, userId, path, parent, name, kind, size = 0) =>
  db
    .prepare('INSERT INTO drive_index VALUES (?,?,?,?,?,?,?)')
    .run(userId, path, parent, name, kind, size, Date.now());

test('returns null when no scan has ever run for the user', t => {
  const db = setupDb();
  t.after(() => db.close());
  assert.equal(readIndexedCollections(db, 1), null);
});

test('returns null when at least one of the seven roots is not done', t => {
  const db = setupDb();
  t.after(() => db.close());
  const userId = 1;
  // Mark all roots but the last one as done; leave the last pending.
  DRIVE_COLLECTIONS.slice(0, -1).forEach((c) => markScanDir(db, userId, c.root, 'done'));
  markScanDir(db, userId, DRIVE_COLLECTIONS.at(-1).root, 'pending');

  assert.equal(readIndexedCollections(db, userId), null);
});

test('returns accurate direct-child totals once all roots are done, isolating users and excluding nested grandchildren', t => {
  const db = setupDb();
  t.after(() => db.close());
  const userId = 1;
  const otherUserId = 2;

  // Mark every approved root as done for userId.
  for (const c of DRIVE_COLLECTIONS) markScanDir(db, userId, c.root, 'done');

  const coursesRoot = DRIVE_COLLECTIONS.find((c) => c.id === 'courses').root;
  const materialsRoot = DRIVE_COLLECTIONS.find((c) => c.id === 'materials').root;

  // Two direct children under the courses root for userId.
  insertIndexRow(db, userId, `${coursesRoot}/a.txt`, coursesRoot, 'a.txt', 'text');
  insertIndexRow(db, userId, `${coursesRoot}/b-folder`, coursesRoot, 'b-folder', 'folder');

  // A nested grandchild (child of b-folder, not a direct child of coursesRoot)
  // must NOT be counted toward coursesRoot's total.
  insertIndexRow(
    db,
    userId,
    `${coursesRoot}/b-folder/nested.txt`,
    `${coursesRoot}/b-folder`,
    'nested.txt',
    'text'
  );

  // Another user's row under the same parent must not inflate userId's count.
  insertIndexRow(db, otherUserId, `${coursesRoot}/other-user-file.txt`, coursesRoot, 'other-user-file.txt', 'text');

  // materialsRoot is a completed root with zero children (empty library case).
  // No drive_index rows inserted for materialsRoot on purpose.

  const result = readIndexedCollections(db, userId);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, DRIVE_COLLECTIONS.length);

  for (const descriptor of result) {
    assert.equal(descriptor.available, true);
    assert.equal(typeof descriptor.total, 'number');
  }

  const courses = result.find((d) => d.id === 'courses');
  assert.equal(courses.total, 2);
  assert.equal(courses.root, coursesRoot);
  assert.equal(courses.label, DRIVE_COLLECTIONS.find((c) => c.id === 'courses').label);

  const materials = result.find((d) => d.id === 'materials');
  assert.equal(materials.total, 0);
  assert.equal(materials.available, true);
});
