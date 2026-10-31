import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { createReferenceStorage, writeReferenceJson } from '../lib/reference-storage.js';
import { syncReferenceSnapshot } from '../lib/reference-sync.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { directory: { type: 'string' }, snapshot: { type: 'string' }, commit: { type: 'string' }, originals: { type: 'string' }, 'local-only': { type: 'boolean' } } });
const directory = path.resolve(values.directory || process.env.OMNIHUB_REFERENCE_DIR || path.join(process.env.OMNIHUB_DATA_DIR || path.join(root, 'data'), 'reference-library'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = path.join(directory, 'sync.lock'), statusFile = path.join(directory, 'status.json');
try { await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = JSON.parse(await readFile(lock, 'utf8'));
  let alive = true;
  try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (alive) { console.log(JSON.stringify({ state: 'already_running' })); process.exit(0); }
  await unlink(lock);
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
}
let previous = {};
try { previous = JSON.parse(await readFile(statusFile, 'utf8')); } catch { /* New archive. */ }
const checkedAt = new Date().toISOString(), nextCheckAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
try {
  const storage = createReferenceStorage({ directory, env: values['local-only'] ? {} : process.env });
  if (!values['local-only'] && !storage.remote) throw new Error('reference_storage_not_configured');
  await writeReferenceJson(statusFile, { ...previous, state: 'syncing', checkedAt, nextCheckAt, error: null });
  let snapshot = values.snapshot, commit = values.commit;
  if (!snapshot) {
    const result = await promisify(execFile)('python3', [path.join(root, 'scripts/prepare-reference-snapshot.py'), '--directory', path.join(directory, 'snapshots'), '--current', previous.commit || ''], { timeout: 180000, maxBuffer: 1024 * 1024 });
    ({ snapshot, commit } = JSON.parse(result.stdout));
  }
  const result = await syncReferenceSnapshot({ directory, snapshot, commit, storage, originalsDirectory: values.originals || '', onProgress: progress => console.log(JSON.stringify(progress)) });
  await writeReferenceJson(statusFile, { ...result, state: result.failed ? 'partial' : 'ready', checkedAt,
    completedAt: new Date().toISOString(), nextCheckAt, error: result.failed ? `${result.failed} 张图片待重试` : null });
  console.log(JSON.stringify({ ...result, failures: result.failures.slice(0, 10) }));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  const code = /^[a-z_]+$/.test(error.message) ? error.message : 'upstream_or_storage_unavailable';
  await writeReferenceJson(statusFile, { ...previous, state: 'failed', checkedAt, nextCheckAt, error: code });
  console.error(JSON.stringify({ state: 'failed', error: code })); process.exitCode = 1;
} finally { await unlink(lock); }
