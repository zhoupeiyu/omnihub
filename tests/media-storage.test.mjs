import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CREATIVE_MEDIA_PREFIX, MEDIA_STORAGE_MESSAGES, creativeMediaKey, parseCreativeMediaKey, creativeMediaPolicy,
  createMediaStorage, createMediaPersistence, planMediaStorageMigration, dryRunMediaStorageMigration, syncAndHashFile,
} from '../lib/media-storage.js';

const COS_ENV = { OMNIHUB_MEDIA_STORAGE: 'cos', COS_BUCKET: 'omnihub-media-1319495021', COS_REGION: 'ap-hongkong' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mockCos() {
  const objects = new Map(), calls = [];
  // 'all' counts PUT and GET together: both carry a whole object.
  const state = { putStatus: 0, delay: 0, active: { put: 0, get: 0, all: 0 }, peak: { put: 0, get: 0, all: 0 } };
  const enter = async kind => {
    for (const name of [kind, 'all']) {
      state.active[name] += 1; state.peak[name] = Math.max(state.peak[name], state.active[name]);
    }
    if (state.delay) await sleep(state.delay);
  };
  const leave = kind => { state.active[kind] -= 1; state.active.all -= 1; };
  return { objects, calls, state,
    async headObject({ Key }) {
      calls.push(['head', Key]);
      const object = objects.get(Key);
      if (!object) throw { statusCode: 404 };
      return { headers: { 'content-length': String(object.body.length), 'x-cos-meta-sha256': object.sha256 } };
    },
    async putObject(params) {
      calls.push(['put', params.Key, params]);
      await enter('put');
      try {
        if (state.putStatus) throw { statusCode: state.putStatus, message: 'signed request detail that must not leak' };
        if (objects.has(params.Key) && params.Headers?.['x-cos-forbid-overwrite'] === 'true') throw { statusCode: 409 };
        objects.set(params.Key, { body: Buffer.from(params.Body), sha256: params['x-cos-meta-sha256'] });
        return {};
      } finally { leave('put'); }
    },
    async getObject({ Key, Range }) {
      calls.push(['get', Key, Range]);
      await enter('get');
      try {
        const object = objects.get(Key);
        if (!object) throw { statusCode: 404 };
        return { Body: object.body };
      } finally { leave('get'); }
    } };
}

async function fixture({ env = COS_ENV, cos = mockCos(), legacy = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'omnihub-media-storage-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE media_assets (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const clock = { now: 1_000_000 };
  // Legacy-style insert: no recorded hash, state defaults to 'local'.
  const add = async (userId, bytes = PNG, extension = 'png', mime = 'image/png') => {
    const id = randomUUID();
    await writeFile(path.join(directory, `${id}.${extension}`), bytes);
    db.prepare('INSERT INTO media_assets (id,user_id,file_name,mime_type,size_bytes) VALUES (?,?,?,?,?)').run(id, userId, `${id}.${extension}`, mime, bytes.length);
    return id;
  };
  // A legacy row exists before the storage columns are introduced.
  const legacyId = legacy ? await add(7) : null;
  const storage = createMediaStorage({ env, cos });
  const make = () => createMediaPersistence({ db, directory, storage, now: () => clock.now });
  const persistence = make();
  // Same path as the request handlers: file flushed and hashed, then one
  // INSERT carrying the queue columns.
  const addQueued = async (userId, bytes = PNG) => {
    const id = randomUUID(), file = path.join(directory, `${id}.png`);
    await writeFile(file, bytes);
    const initial = persistence.initialStorage({ sha256: await syncAndHashFile(file) });
    db.prepare(`INSERT INTO media_assets (id,user_id,file_name,mime_type,size_bytes,storage_state,storage_sha256,storage_next_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, userId, `${id}.png`, 'image/png', bytes.length,
      initial.storageState, initial.storageSha256, initial.storageNextAt);
    return id;
  };
  const row = id => db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
  const cleanup = () => rm(directory, { recursive: true, force: true });
  return { db, directory, storage, persistence, restart: make, cos, clock, add, addQueued, row, legacyId, cleanup };
}

test('keys are account-scoped under the dedicated creative-media prefix and reject unsafe input', () => {
  const id = randomUUID();
  const key = creativeMediaKey(7, id, 'png');
  assert.equal(key, `creative-media/v1/users/7/${id}.png`);
  assert.ok(key.startsWith(CREATIVE_MEDIA_PREFIX));
  assert.ok(!key.startsWith('x-bookmarks/') && !key.startsWith('ai-reference/'));
  assert.deepEqual(parseCreativeMediaKey(key), { userId: 7, assetId: id, extension: 'png', contentType: 'image/png' });
  for (const [owner, asset, extension] of [[0, id, 'png'], ['07', id, 'png'], ['7/../8', id, 'png'], [-1, id, 'png'], [1.5, id, 'png'],
    [7, '../x', 'png'], [7, `${id}/x`, 'png'], [7, id, 'svg'], [7, id, 'png/../../x']]) {
    assert.throws(() => creativeMediaKey(owner, asset, extension));
  }
  assert.equal(parseCreativeMediaKey(`x-bookmarks/originals/ab/${'a'.repeat(64)}.png`), null);
  assert.equal(parseCreativeMediaKey(`creative-media/v1/users/7/../8/${id}.png`), null);
});

test('required policy is exactly Get/Head/Put on creative-media/v1/users/* and never the x prefix', () => {
  const policy = creativeMediaPolicy();
  assert.equal(policy.statement.length, 1);
  assert.deepEqual(policy.statement[0].action, ['name/cos:GetObject', 'name/cos:HeadObject', 'name/cos:PutObject']);
  assert.deepEqual(policy.statement[0].resource, [`qcs::cos:ap-hongkong:uid/1319495021:omnihub-media-1319495021/${CREATIVE_MEDIA_PREFIX}*`]);
  assert.equal(policy.statement[0].resource[0].endsWith('/creative-media/v1/users/*'), true);
  const text = JSON.stringify(policy);
  assert.ok(!text.includes('x-bookmarks') && !text.includes('ai-reference') && !text.includes('cos:*') && !/Delete|Acl/i.test(text));
});

test('without opt-in, assets stay local and legacy rows remain readable', async () => {
  const cos = mockCos();
  const f = await fixture({ env: {}, cos, legacy: true });
  try {
    assert.equal(f.storage.mode, 'local');
    assert.equal(f.row(f.legacyId).storage_state, 'local');
    const id = await f.add(7);
    assert.equal((await f.persistence.persistAsset(7, id)).storageState, 'local');
    const queued = await f.addQueued(7);
    assert.equal(f.row(queued).storage_state, 'local');
    f.persistence.kick(); await f.persistence.idle();
    assert.deepEqual(await f.persistence.readBytes(7, f.legacyId), PNG);
    await f.persistence.ensureLocal(7, id);
    assert.equal(cos.calls.length, 0);
    await assert.rejects(f.persistence.readBytes(8, f.legacyId), error => error.status === 404);
  } finally { await f.cleanup(); }
});

test('opted-in storage writes a private verified object and restores a missing local copy', async () => {
  const f = await fixture();
  try {
    assert.equal(f.storage.mode, 'cos');
    const id = await f.add(7);
    const stored = await f.persistence.persistAsset(7, id);
    assert.equal(stored.storageState, 'stored');
    const key = `creative-media/v1/users/7/${id}.png`;
    assert.equal(f.row(id).storage_key, key);
    const [, putKey, params] = f.cos.calls.find(call => call[0] === 'put');
    assert.equal(putKey, key);
    assert.equal(params.ServerSideEncryption, 'AES256');
    assert.equal(params.Headers['x-cos-forbid-overwrite'], 'true');
    assert.equal(params.ACL, undefined);
    assert.equal(params.Bucket, 'omnihub-media-1319495021');
    assert.match(params['x-cos-meta-sha256'], /^[a-f0-9]{64}$/);
    assert.deepEqual(f.cos.calls.map(call => call[0]), ['head', 'put', 'head']);
    // A second persist is a no-op; the object is never rewritten.
    await f.persistence.persistAsset(7, id);
    assert.equal(f.cos.calls.filter(call => call[0] === 'put').length, 1);

    await rm(path.join(f.directory, `${id}.png`));
    assert.deepEqual(await f.persistence.readBytes(7, id), PNG);
    assert.deepEqual(f.cos.calls.at(-1), ['get', key, `bytes=0-${PNG.length - 1}`]);
    assert.deepEqual(await readFile(path.join(f.directory, `${id}.png`)), PNG);
    await rm(path.join(f.directory, `${id}.png`));
    await f.persistence.ensureLocal(7, id);
    assert.equal((await stat(path.join(f.directory, `${id}.png`))).size, PNG.length);
  } finally { await f.cleanup(); }
});

test('the queue entry is durable at insert: a restart after the asset commit uploads without user action', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    const row = f.row(id);
    // Committed with the asset, before any COS I/O.
    assert.equal(row.storage_state, 'pending');
    assert.equal(row.storage_sha256, sha(PNG));
    assert.equal(row.storage_attempts, 0);
    assert.equal(f.cos.calls.length, 0);
    // Process stops here.  A new process resumes the pending row.
    const restarted = f.restart();
    assert.equal(await restarted.retryDue(), 1);
    assert.equal(f.row(id).storage_state, 'stored');
    assert.equal(f.row(id).storage_attempts, 1);
    assert.equal(f.cos.calls.filter(call => call[0] === 'put').length, 1);
  } finally { await f.cleanup(); }
});

test('a crash after the COS PUT is resumed by HEAD without a second upload', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    const key = `creative-media/v1/users/7/${id}.png`;
    // Simulate: attempt reserved durably, PUT reached COS, process died before
    // the row was marked stored.
    f.db.prepare('UPDATE media_assets SET storage_attempts=1, storage_next_at=? WHERE id=?').run(f.clock.now + 60_000, id);
    f.cos.objects.set(key, { body: Buffer.from(PNG), sha256: sha(PNG) });
    const restarted = f.restart();
    assert.equal(await restarted.retryDue(), 0);
    f.clock.now += 60_000;
    assert.equal(await restarted.retryDue(), 1);
    assert.equal(f.row(id).storage_state, 'stored');
    assert.equal(f.row(id).storage_key, key);
    assert.equal(f.cos.calls.some(call => call[0] === 'put'), false);
  } finally { await f.cleanup(); }
});

test('kick returns immediately; the worker uploads at most one object at a time', async () => {
  const f = await fixture();
  try {
    f.cos.state.delay = 15;
    const ids = [];
    for (let index = 0; index < 4; index += 1) ids.push(await f.addQueued(7 + index, Buffer.concat([PNG, Buffer.from([index])])));
    const started = Date.now();
    f.persistence.kick();
    f.persistence.kick();
    assert.ok(Date.now() - started < 10, 'kick must not wait for COS');
    assert.ok(ids.every(id => f.row(id).storage_state === 'pending'));
    // Concurrent direct attempts share the same bounded limiter.
    await Promise.all([f.persistence.idle(), f.persistence.persistAsset(7, ids[0]), f.persistence.persistAsset(8, ids[1])]);
    await f.persistence.idle();
    assert.ok(ids.every(id => f.row(id).storage_state === 'stored'));
    assert.equal(f.cos.state.peak.put, 1);
    assert.equal(f.cos.calls.filter(call => call[0] === 'put').length, 4);
  } finally { await f.cleanup(); }
});

test('restores from COS are bounded and deduplicated', async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const id = await f.addQueued(7, Buffer.concat([PNG, Buffer.from([index])]));
      await f.persistence.persistAsset(7, id);
      await rm(path.join(f.directory, `${id}.png`));
      ids.push(id);
    }
    f.cos.state.delay = 15;
    const reads = await Promise.all([...ids, ids[0]].map(id => f.persistence.readBytes(7, id)));
    assert.equal(reads.length, 6);
    assert.ok(f.cos.state.peak.get <= 2);
    assert.equal(f.cos.calls.filter(call => call[0] === 'get').length, 5);
  } finally { await f.cleanup(); }
});

test('truncated, expanded and same-size modified server files are never uploaded', async () => {
  const f = await fixture();
  try {
    const truncated = await f.addQueued(7), expanded = await f.addQueued(7), modified = await f.addQueued(7);
    await writeFile(path.join(f.directory, `${truncated}.png`), PNG.subarray(0, PNG.length - 3));
    await writeFile(path.join(f.directory, `${expanded}.png`), Buffer.concat([PNG, Buffer.from('extra')]));
    const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 0xff;
    await writeFile(path.join(f.directory, `${modified}.png`), changed);
    for (const id of [truncated, expanded, modified]) {
      assert.equal((await f.persistence.persistAsset(7, id)).storageState, 'failed');
      assert.equal(f.row(id).storage_error, MEDIA_STORAGE_MESSAGES.local_changed);
    }
    assert.equal(f.cos.calls.some(call => call[0] === 'put'), false);
    // A legacy row without a recorded hash is still size-checked at upload.
    const legacy = await f.add(7);
    await writeFile(path.join(f.directory, `${legacy}.png`), PNG.subarray(0, 4));
    assert.equal((await f.persistence.persistAsset(7, legacy)).storageState, 'failed');
    assert.equal(f.cos.calls.some(call => call[0] === 'put'), false);
  } finally { await f.cleanup(); }
});

test('permission failures are visible, back off, and can be retried without any other work', async () => {
  const f = await fixture();
  try {
    f.cos.state.putStatus = 403;
    const id = await f.add(7);
    const failed = await f.persistence.persistAsset(7, id);
    assert.equal(failed.storageState, 'pending');
    const row = f.row(id);
    assert.equal(row.storage_error, MEDIA_STORAGE_MESSAGES.permission);
    assert.ok(!row.storage_error.includes('signed'));
    assert.equal(row.storage_attempts, 1);
    assert.ok(row.storage_next_at > f.clock.now);
    // The local copy is untouched and still served.
    assert.deepEqual(await f.persistence.readBytes(7, id), PNG);

    assert.equal(await f.persistence.retryDue(), 0);
    f.cos.state.putStatus = 0;
    f.clock.now = row.storage_next_at;
    assert.equal(await f.persistence.retryDue(), 1);
    assert.equal(f.row(id).storage_state, 'stored');
    assert.equal(f.row(id).storage_error, '');
  } finally { await f.cleanup(); }
});

test('exhausted retries stop; a manual retry durably resets the budget and survives transient failure and restart', async () => {
  const f = await fixture();
  try {
    f.cos.state.putStatus = 500;
    const id = await f.addQueued(7);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      f.clock.now += 2 * 60 * 60_000;
      await f.persistence.persistAsset(7, id);
    }
    assert.equal(f.row(id).storage_state, 'failed');
    assert.equal(f.row(id).storage_attempts, 8);
    f.clock.now += 24 * 60 * 60_000;
    assert.equal(await f.persistence.retryDue(), 0);
    const puts = () => f.cos.calls.filter(call => call[0] === 'put').length;
    assert.equal(puts(), 8);

    // Manual retry: reset is committed before any COS work and the call
    // returns without waiting for it.
    const queued = await f.persistence.retryAsset(7, id);
    assert.equal(queued.storageState, 'pending');
    assert.equal(queued.storageAttempts, 0);
    await f.persistence.idle();
    // Still failing transiently: the row stays queued with a fresh budget.
    assert.equal(f.row(id).storage_state, 'pending');
    assert.equal(f.row(id).storage_attempts, 1);
    assert.equal(f.row(id).storage_error, MEDIA_STORAGE_MESSAGES.write_failed);

    // Restart, COS recovers, the worker finishes it on its own.
    f.cos.state.putStatus = 0;
    f.clock.now += 2 * 60 * 60_000;
    const restarted = f.restart();
    assert.equal(await restarted.retryDue(), 1);
    assert.equal(f.row(id).storage_state, 'stored');
    assert.equal(await f.persistence.retryAsset(8, id), null);
  } finally { await f.cleanup(); }
});

test('a crash loop is bounded because attempts are reserved before COS I/O', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    f.db.prepare('UPDATE media_assets SET storage_attempts=8, storage_next_at=0 WHERE id=?').run(id);
    assert.equal((await f.restart().persistAsset(7, id)).storageState, 'failed');
    assert.equal(f.cos.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('a manual retry while the final attempt is in flight is not overwritten and runs once it settles', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    // The next attempt is the last one of the budget.
    f.db.prepare('UPDATE media_assets SET storage_attempts=7, storage_next_at=0 WHERE id=?').run(id);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const put = f.cos.putObject;
    let puts = 0;
    f.cos.putObject = async params => {
      puts += 1;
      if (puts === 1) { await gate; throw { statusCode: 500 }; }
      return put(params);
    };
    const final = f.persistence.persistAsset(7, id);
    while (puts === 0) await sleep(1);
    assert.equal(f.row(id).storage_attempts, 8);
    // The person retries while attempt 8 is still waiting on COS.
    const queued = await f.persistence.retryAsset(7, id);
    assert.equal(queued.storageState, 'pending');
    assert.equal(queued.storageAttempts, 0);
    release();
    await final;
    await f.persistence.idle();
    // The old failure did not mark the reset row failed, and a fresh attempt
    // ran after it settled instead of being absorbed by the in-flight one.
    assert.equal(puts, 2);
    const row = f.row(id);
    assert.equal(row.storage_state, 'stored');
    assert.equal(row.storage_attempts, 1);
    assert.equal(row.storage_error, '');
  } finally { await f.cleanup(); }
});

test('a stored asset whose server file is truncated or modified in place is recovered from the verified COS copy', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    await f.persistence.persistAsset(7, id);
    assert.equal(f.row(id).storage_state, 'stored');
    const file = path.join(f.directory, `${id}.png`);
    const gets = () => f.cos.calls.filter(call => call[0] === 'get').length;
    // Same size, different bytes: only the hash can tell.
    const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 0xff;
    await writeFile(file, changed);
    assert.deepEqual(await f.persistence.readBytes(7, id), PNG);
    assert.deepEqual(await readFile(file), PNG);
    assert.equal(gets(), 1);
    // ensureLocal runs before the file is served: truncation and in-place
    // changes are both replaced by the verified copy.
    await writeFile(file, PNG.subarray(0, 4));
    await f.persistence.ensureLocal(7, id);
    assert.deepEqual(await readFile(file), PNG);
    await writeFile(file, changed);
    await f.persistence.ensureLocal(7, id);
    assert.deepEqual(await readFile(file), PNG);
    assert.equal(gets(), 3);
    // An intact file is served without touching COS.
    await f.persistence.ensureLocal(7, id);
    assert.deepEqual(await f.persistence.readBytes(7, id), PNG);
    assert.equal(gets(), 3);
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.restore')), false);

    // A corrupt COS copy is never served or written; the error stays generic.
    f.cos.objects.get(`creative-media/v1/users/7/${id}.png`).body = changed;
    await writeFile(file, PNG.subarray(0, 4));
    await assert.rejects(f.persistence.readBytes(7, id),
      error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.restore_verify_failed);
    await assert.rejects(f.persistence.ensureLocal(7, id),
      error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.restore_verify_failed);
    assert.deepEqual(await readFile(file), PNG.subarray(0, 4));

    // Rows without a stored copy keep serving the server file as before.
    const legacy = await f.add(7);
    await writeFile(path.join(f.directory, `${legacy}.png`), changed);
    assert.deepEqual(await f.persistence.readBytes(7, legacy), changed);
    await f.persistence.ensureLocal(7, legacy);
    assert.equal(gets(), 5);
  } finally { await f.cleanup(); }
});

test('uploads and restores share one transfer slot, whatever concurrency is configured', async () => {
  const f = await fixture();
  try {
    const restored = [], uploads = [];
    for (let index = 0; index < 3; index += 1) {
      const id = await f.addQueued(7, Buffer.concat([PNG, Buffer.from([index])]));
      await f.persistence.persistAsset(7, id);
      await rm(path.join(f.directory, `${id}.png`));
      restored.push(id);
    }
    for (let index = 0; index < 3; index += 1) uploads.push(await f.addQueued(7, Buffer.concat([PNG, Buffer.from([10 + index])])));
    f.cos.state.delay = 15;
    f.cos.state.peak = { put: 0, get: 0, all: 0 };
    // Older callers may still pass per-kind concurrency; it cannot raise the
    // shared budget of one buffered object.
    const persistence = createMediaPersistence({ db: f.db, directory: f.directory, storage: f.storage, now: () => f.clock.now,
      uploadConcurrency: 4, restoreConcurrency: 4 });
    persistence.kick();
    const results = await Promise.all([...restored.map(id => persistence.readBytes(7, id)),
      ...uploads.map(id => persistence.persistAsset(7, id))]);
    await persistence.idle();
    assert.equal(f.cos.state.peak.all, 1);
    assert.equal(f.cos.state.peak.put, 1);
    assert.equal(f.cos.state.peak.get, 1);
    restored.forEach((id, index) => assert.deepEqual(results[index], Buffer.concat([PNG, Buffer.from([index])])));
    assert.ok(uploads.every(id => f.row(id).storage_state === 'stored'));
  } finally { await f.cleanup(); }
});

test('a server write failure during restore is reported, not hidden as a missing file', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    await f.persistence.persistAsset(7, id);
    const target = path.join(f.directory, `${id}.png`);
    await rm(target);
    // The destination cannot be replaced by a file.
    await mkdir(target);
    await writeFile(path.join(target, 'occupied'), 'x');
    await assert.rejects(f.persistence.readBytes(7, id),
      error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.restore_failed);
    await assert.rejects(f.persistence.ensureLocal(7, id),
      error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.restore_failed);
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.restore')), false);
  } finally { await f.cleanup(); }
});

test('a corrupt COS copy is rejected and never written to the server', async () => {
  const f = await fixture();
  try {
    const id = await f.addQueued(7);
    await f.persistence.persistAsset(7, id);
    const key = `creative-media/v1/users/7/${id}.png`;
    const bad = Buffer.from(PNG); bad[0] ^= 0xff;
    f.cos.objects.set(key, { body: bad, sha256: sha(PNG) });
    await rm(path.join(f.directory, `${id}.png`));
    await assert.rejects(f.persistence.readBytes(7, id),
      error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.restore_verify_failed);
    await assert.rejects(stat(path.join(f.directory, `${id}.png`)));
  } finally { await f.cleanup(); }
});

test('reads stay inside the owning account even when a stored key is tampered with', async () => {
  const f = await fixture();
  try {
    const mine = await f.add(7), theirs = await f.add(8);
    await f.persistence.persistAsset(7, mine); await f.persistence.persistAsset(8, theirs);
    await assert.rejects(f.persistence.readBytes(8, mine), error => error.status === 404);
    f.db.prepare('UPDATE media_assets SET storage_key=? WHERE id=?').run(`creative-media/v1/users/8/${theirs}.png`, mine);
    await rm(path.join(f.directory, `${mine}.png`));
    const before = f.cos.calls.length;
    await assert.rejects(f.persistence.readBytes(7, mine), error => error.status === 503 && error.message === MEDIA_STORAGE_MESSAGES.read_failed);
    assert.equal(f.cos.calls.slice(before).some(call => call[0] === 'get'), false);
  } finally { await f.cleanup(); }
});

test('a different existing object is a conflict and is never overwritten', async () => {
  const f = await fixture();
  try {
    const id = await f.add(7);
    f.cos.objects.set(`creative-media/v1/users/7/${id}.png`, { body: Buffer.from('other'), sha256: 'b'.repeat(64) });
    assert.equal((await f.persistence.persistAsset(7, id)).storageState, 'failed');
    assert.equal(f.row(id).storage_error, MEDIA_STORAGE_MESSAGES.conflict);
    assert.equal(f.cos.calls.some(call => call[0] === 'put'), false);
  } finally { await f.cleanup(); }
});

test('requested but incomplete configuration is reported, not silently ignored', async () => {
  const f = await fixture({ env: { OMNIHUB_MEDIA_STORAGE: 'cos', COS_BUCKET: 'omnihub-media-1319495021' }, cos: undefined });
  try {
    assert.equal(f.storage.mode, 'misconfigured');
    const id = await f.add(7);
    assert.equal((await f.persistence.persistAsset(7, id)).storageState, 'pending');
    assert.equal(f.row(id).storage_error, MEDIA_STORAGE_MESSAGES.not_configured);
  } finally { await f.cleanup(); }
});

test('user-facing messages describe the website server, not the user computer', () => {
  for (const message of Object.values(MEDIA_STORAGE_MESSAGES)) assert.ok(!message.includes('本机'), message);
});

test('migration dry run only inspects rows and local files', async () => {
  const f = await fixture();
  try {
    const ready = await f.add(7), stored = await f.add(7), missing = await f.add(9);
    await f.persistence.persistAsset(7, stored);
    await rm(path.join(f.directory, `${missing}.png`));
    f.db.prepare("INSERT INTO media_assets (id,user_id,file_name,mime_type,size_bytes) VALUES ('bad',7,'../escape.png','image/png',1)").run();
    const before = f.cos.calls.length;
    const plan = await f.persistence.migrate();
    assert.equal(plan.dryRun, true);
    assert.equal(f.cos.calls.length, before);
    assert.deepEqual(plan.counts, { upload: 1, already_stored: 1, missing_local: 1, invalid_record: 1 });
    assert.equal(plan.items.find(item => item.assetId === ready).key, `creative-media/v1/users/7/${ready}.png`);
    assert.equal(f.row(ready).storage_state, 'local');
    const offline = await planMediaStorageMigration({ rows: [], directory: f.directory });
    assert.equal(offline.total, 0);
  } finally { await f.cleanup(); }
});

test('standalone dry run opens an old database read-only without adding columns', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omnihub-media-dry-run-'));
  try {
    const databasePath = path.join(directory, 'app.db'), id = randomUUID();
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE media_assets (id TEXT PRIMARY KEY, user_id INTEGER, file_name TEXT, mime_type TEXT, size_bytes INTEGER, created_at TEXT)');
    db.prepare("INSERT INTO media_assets VALUES (?,7,?,'image/png',?,'2026-01-01')").run(id, `${id}.png`, PNG.length);
    db.close();
    await writeFile(path.join(directory, `${id}.png`), PNG);
    const plan = await dryRunMediaStorageMigration({ databasePath, directory });
    assert.deepEqual(plan.counts, { upload: 1 });
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(reopened.prepare('PRAGMA table_info(media_assets)').all().some(column => column.name === 'storage_state'), false);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
