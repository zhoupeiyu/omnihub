import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOmnigetQueue } from '../lib/omniget-queue.js';

function fixture(options = {}) {
  let clock = 1000;
  const db = options.db || (options.databasePath ? null : new DatabaseSync(':memory:'));
  const queue = createOmnigetQueue({
    db, now: () => ++clock,
    validateUrl: value => {
      if (!/^https:\/\/ok\.example\/[a-z0-9-]+$/i.test(value)) throw Object.assign(new Error('链接不受支持'), { status: 400 });
      return value.toLowerCase();
    },
    ...options,
  });
  return { db: db || null, queue };
}

test('batch validation is atomic and accepts at most ten public URLs', () => {
  const { db, queue } = fixture();
  assert.throws(() => queue.enqueue('a', ['https://ok.example/a', 'https://bad.example/b']), { status: 400 });
  assert.equal(db.prepare('SELECT count(*) AS total FROM omniget_queue_jobs').get().total, 0);
  const urls = Array.from({ length: 10 }, (_, index) => `https://ok.example/${index}`);
  assert.equal(queue.enqueue('a', urls).length, 10);
  assert.throws(() => queue.enqueue('a', [...urls, 'https://ok.example/11']), { status: 400 });
  assert.throws(() => queue.enqueue('a', ['https://ok.example/a', 'https://ok.example/a']), { status: 400 });
  db.close();
});

test('job histories and mutations are owner-isolated', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('owner-a', ['https://ok.example/a']);
  assert.equal(queue.get('owner-b', job.id), null);
  assert.equal(queue.cancel('owner-b', job.id), null);
  assert.deepEqual(queue.list('owner-b'), []);
  assert.equal(queue.get('owner-a', job.id).state, 'queued');
  assert.equal(queue.cancel('owner-a', job.id).state, 'cancelled');
  db.close();
});

test('claim uses a CAS and enforces both global and per-user concurrency', () => {
  const { db, queue } = fixture({ maxGlobalRunning: 2, maxUserRunning: 1 });
  queue.enqueue('a', ['https://ok.example/a1', 'https://ok.example/a2']);
  queue.enqueue('b', ['https://ok.example/b1']);
  const first = queue.claimNext(), second = queue.claimNext();
  assert.equal(first.url, 'https://ok.example/a1');
  assert.equal(second.url, 'https://ok.example/b1');
  assert.equal(queue.claimNext(), null);
  assert.equal(queue.recordParsed('b', second.id, { metadata: { title: 'choice' } }).state, 'parsed');
  assert.equal(queue.routeParsed('b', second.id).state, 'awaiting_choice');
  assert.equal(queue.beginDownload('b', second.id).state, 'downloading');
  assert.equal(queue.beginDownload('b', second.id), null);
  assert.equal(queue.complete('b', second.id, { state: 'ready', metadata: { title: 'ok' } }).state, 'ready');
  assert.deepEqual(queue.get('b', second.id).metadata, { title: 'ok' });
  assert.equal(queue.complete('a', first.id, { state: 'failed', error: 'upstream' }).state, 'failed');
  assert.equal(queue.claimNext().url, 'https://ok.example/a2');
  db.close();
});

test('worker can gate a durable claim against legacy active work without consuming a job', () => {
  const { db, queue } = fixture();
  const [blocked] = queue.enqueue('legacy-owner', ['https://ok.example/legacy']);
  const [allowed] = queue.enqueue('queue-owner', ['https://ok.example/queue']);
  const examined = [];
  const claimed = queue.claimNext({ canRun: candidate => {
    examined.push({ owner: candidate.owner, url: candidate.url, state: candidate.state });
    return candidate.owner !== 'legacy-owner';
  } });
  assert.equal(claimed.id, allowed.id);
  assert.deepEqual(examined, [
    { owner: 'legacy-owner', url: 'https://ok.example/legacy', state: 'queued' },
    { owner: 'queue-owner', url: 'https://ok.example/queue', state: 'queued' },
  ]);
  assert.equal(queue.get('legacy-owner', blocked.id).state, 'queued');
  assert.equal(queue.get('queue-owner', allowed.id).state, 'parsing');
  db.close();
});

test('a batch can move parsed jobs straight to download while a single item waits for choice', () => {
  const { db, queue } = fixture();
  const [automatic] = queue.enqueue('a', ['https://ok.example/batch'], { options: { autoDownload: true }, source: 'batch' });
  const [choice] = queue.enqueue('b', ['https://ok.example/single']);
  const batchClaim = queue.claimNext(), choiceClaim = queue.claimNext();
  assert.equal(batchClaim.id, automatic.id);
  assert.equal(queue.recordParsed('a', automatic.id, { metadata: { title: 'Batch item' } }).state, 'parsed');
  assert.equal(queue.routeParsed('a', automatic.id).state, 'downloading');
  assert.equal(queue.recordParsed('b', choice.id, { metadata: { title: 'Single item' } }).state, 'parsed');
  assert.equal(queue.routeParsed('b', choice.id).state, 'awaiting_choice');
  assert.equal(queue.get('b', choiceClaim.id).state, 'awaiting_choice');
  db.close();
});

test('running cancellation is a CAS request and never deletes a ready result', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('a', ['https://ok.example/cancel']);
  queue.claimNext();
  assert.equal(queue.cancel('a', job.id).state, 'cancelling');
  assert.equal(queue.cancel('a', job.id), null);
  assert.equal(queue.complete('a', job.id, { state: 'cancelled' }).state, 'cancelled');
  const [ready] = queue.enqueue('a', ['https://ok.example/ready']);
  queue.claimNext();
  queue.recordParsed('a', ready.id);
  queue.routeParsed('a', ready.id);
  queue.beginDownload('a', ready.id);
  queue.complete('a', ready.id, { state: 'ready', metadata: { file: 'manifest-only' } });
  assert.equal(queue.get('a', ready.id).state, 'ready');
  assert.equal(queue.cancel('a', ready.id), null);
  assert.equal(queue.get('a', ready.id).state, 'ready');
  db.close();
});

test('worker-only expiry enumeration omits URLs and marks ready history only after acknowledgement', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('a', ['https://ok.example/retained']);
  queue.claimNext();
  queue.recordParsed('a', job.id);
  queue.routeParsed('a', job.id);
  queue.beginDownload('a', job.id);
  queue.complete('a', job.id, { state: 'ready', metadata: { expiresAt: 1100, fileName: 'clip.mp4' } });
  assert.deepEqual(queue.listExpiredReady(1099), []);
  const [expired] = queue.listExpiredReady(1100);
  assert.deepEqual(Object.keys(expired).sort(), ['id', 'metadata', 'owner']);
  assert.equal(expired.id, job.id);
  assert.equal(queue.expireReady('a', job.id, 1099), null);
  assert.equal(queue.expireReady('a', job.id, 1100).state, 'expired');
  assert.equal(queue.expireReady('a', job.id, 1100), null);
  assert.equal(queue.get('a', job.id).state, 'expired');
  db.close();
});

test('terminal garbage list exposes no URLs and excludes cancelling work', () => {
  const { db, queue } = fixture();
  const [failed] = queue.enqueue('a', ['https://ok.example/failed']);
  queue.claimNext();
  queue.complete('a', failed.id, { state: 'failed' });
  const [cancelled] = queue.enqueue('b', ['https://ok.example/cancelled']);
  queue.cancel('b', cancelled.id);
  const [interrupted] = queue.enqueue('c', ['https://ok.example/interrupted']);
  queue.claimNext();
  queue.recover();
  const [cancelling] = queue.enqueue('d', ['https://ok.example/cancelling']);
  queue.claimNext();
  queue.cancel('d', cancelling.id);
  const garbage = queue.listGcTasks(10);
  assert.deepEqual(garbage.map(item => Object.keys(item).sort()), garbage.map(() => ['id', 'owner', 'state']));
  assert.deepEqual(new Set(garbage.map(item => item.id)), new Set([failed.id, cancelled.id, interrupted.id]));
  assert.equal(garbage.some(item => item.id === cancelling.id), false);
  db.close();
});

test('hasJobId protects every durable record state from legacy orphan cleanup', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('a', ['https://ok.example/known']);
  assert.equal(queue.hasJobId(job.id), true);
  assert.equal(queue.hasJobId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(queue.hasJobId('not-a-uuid'), false);
  queue.claimNext();
  queue.complete('a', job.id, { state: 'failed' });
  assert.equal(queue.hasJobId(job.id), true);
  db.close();
});

test('GC ticket blocks retry until the claimed artifact cleanup is acknowledged', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('a', ['https://ok.example/gc-race']);
  queue.claimNext();
  queue.complete('a', job.id, { state: 'failed', metadata: { fileName: 'partial.mp4' } });
  const [ticket] = queue.claimGcTasks();
  assert.deepEqual(Object.keys(ticket).sort(), ['id', 'owner', 'state', 'ticket']);
  assert.equal(queue.retry('a', job.id), null);
  assert.equal(queue.finishGc('a', job.id, ticket.ticket, { deleted: true }).metadata.artifactCleanedAt > 0, true);
  assert.equal(queue.retry('a', job.id).state, 'queued');
  assert.deepEqual(queue.claimGcTasks(), []);
  db.close();
});

test('retry clears an acknowledged cleanup marker so a later failed run can be collected', () => {
  const { db, queue } = fixture();
  const [job] = queue.enqueue('a', ['https://ok.example/gc-retry']);
  queue.claimNext();
  queue.complete('a', job.id, { state: 'failed' });
  const [firstTicket] = queue.claimGcTasks();
  queue.finishGc('a', job.id, firstTicket.ticket, { deleted: true });
  assert.equal(queue.retry('a', job.id).state, 'queued');
  assert.equal(queue.get('a', job.id).metadata.artifactCleanedAt, undefined);
  queue.claimNext();
  queue.complete('a', job.id, { state: 'failed' });
  const [secondTicket] = queue.claimGcTasks();
  assert.equal(secondTicket.id, job.id);
  assert.notEqual(secondTicket.ticket, firstTicket.ticket);
  db.close();
});

test('restart releases abandoned GC tickets but never reclaims acknowledged cleanup', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'omniget-gc-restart-'));
  const databasePath = path.join(directory, 'queue.sqlite');
  try {
    const first=fixture({databasePath});
    const [job]=first.queue.enqueue('a',['https://ok.example/gc-restart']);
    first.queue.claimNext();first.queue.complete('a',job.id,{state:'failed'});
    const [held]=first.queue.claimGcTasks();
    first.queue.close();
    const second=fixture({databasePath});
    const [reclaimed]=second.queue.claimGcTasks();
    assert.equal(reclaimed.id,job.id);assert.notEqual(reclaimed.ticket,held.ticket);
    second.queue.finishGc('a',job.id,reclaimed.ticket,{deleted:true});
    second.queue.close();
    const third=fixture({databasePath});
    assert.deepEqual(third.queue.claimGcTasks(),[]);
    assert.deepEqual(third.queue.listGcTasks(),[]);
    third.queue.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('restart turns running jobs into interrupted without automatically retrying', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'omniget-queue-'));
  const databasePath = path.join(directory, 'queue.sqlite');
  try {
    const first = fixture({ databasePath });
    const [job] = first.queue.enqueue('a', ['https://ok.example/a']);
    assert.equal(first.queue.claimNext().state, 'parsing');
    first.queue.close();
    const second = fixture({ databasePath });
    assert.equal(second.queue.get('a', job.id).state, 'interrupted');
    assert.equal(second.queue.claimNext(), null);
    assert.equal(second.queue.retry('a', job.id).state, 'queued');
    assert.equal(second.queue.claimNext().id, job.id);
    second.queue.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
