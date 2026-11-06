import { mkdir, readFile, writeFile, readdir, stat, unlink, rename, utimes } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { referenceDigest } from './reference-catalogue.js';

const states = new Map();

// Only disposable remote copies live here; archive files are never evicted.
export function createReferenceReadCache(directory, maxBytes = 512 * 1024 ** 2) {
  const folder = path.join(directory, 'read-cache');
  if (!states.has(folder)) states.set(folder, { pending: new Map(), writes: Promise.resolve() });
  const state = states.get(folder), pending = state.pending;
  const filename = object => path.join(folder, `${object.sha256}.cache`);
  async function cached(object) {
    try {
      const file = filename(object), bytes = await readFile(file);
      if (bytes.length !== object.bytes || referenceDigest(bytes) !== object.sha256) return null;
      const now = new Date(); await utimes(file, now, now).catch(() => {});
      return bytes;
    } catch { return null; }
  }
  async function store(object, bytes) {
    if (bytes.length > maxBytes) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const entries = [];
    for (const name of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.cache$/.test(name)) continue;
      const file = path.join(folder, name), info = await stat(file);
      entries.push({ file, size: info.size, time: info.mtimeMs });
    }
    let size = entries.reduce((sum, entry) => sum + entry.size, 0);
    const target = filename(object);
    for (const entry of entries.sort((a,b) => a.time - b.time)) {
      if (entry.file !== target && size + bytes.length <= maxBytes) continue;
      await unlink(entry.file); size -= entry.size;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function read(object, fetchRemote) {
    const key = object.sha256;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const hit = await cached(object); if (hit) return hit;
      const bytes = await fetchRemote();
      if (bytes.length !== object.bytes || referenceDigest(bytes) !== key) throw new Error('reference_integrity_failed');
      const saving = state.writes.then(() => store(object, bytes));
      state.writes = saving.catch(() => {});
      await state.writes; // Cache failure must not prevent viewing a valid remote image.
      return bytes;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return { read };
}
