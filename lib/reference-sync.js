import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { REFERENCE_KINDS, REFERENCE_COLLECTION, parseReferenceData, referenceDigest, validReferenceObject } from './reference-catalogue.js';
import { writeReferenceJson } from './reference-storage.js';

export async function scanReferenceOriginals(directory) {
  const entries = new Map();
  if (!directory) return entries;
  if (!(await lstat(directory)).isDirectory()) throw new Error('originals_directory_required');
  let visited = 0;
  async function walk(folder, depth = 0) {
    if (depth > 12) throw new Error('originals_directory_too_deep');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++visited > 100000) throw new Error('originals_file_limit');
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
      const match = /^([A-Za-z0-9_-]{1,100})\.png$/i.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      if ((await lstat(file)).size > 32 * 1024 ** 2) throw new Error('original_file_too_large');
      const previous = entries.get(match[1]);
      if (previous && referenceDigest(await readFile(previous)) !== referenceDigest(await readFile(file))) throw new Error('ambiguous_original_filename');
      entries.set(match[1], file);
    }
  }
  await walk(directory);
  return entries;
}

export async function syncReferenceSnapshot({ directory, snapshot, commit, storage, originalsDirectory = '', concurrency = originalsDirectory || storage?.findOriginal ? 4 : 12, now = () => new Date(), onProgress = () => {} }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid_reference_commit');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('invalid_reference_concurrency');
  const at = now().toISOString();
  let before = { version: 1, items: [] };
  try { before = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before.version !== 1 || !Array.isArray(before.items)) throw new Error('invalid_previous_manifest');
  const old = new Map(before.items.map(item => [item.id, item]));
  const storageMode = storage.remote ? 'cos' : 'local', storageChanged = before.storage && before.storage !== storageMode;
  const originals = await scanReferenceOriginals(originalsDirectory);
  const rows = [];
  for (const kind of REFERENCE_KINDS) rows.push(...parseReferenceData(kind, await readFile(path.join(snapshot, `data/${kind}.js`), 'utf8')));
  if (rows.some(row => old.has(row.id) && (old.get(row.id).collectionId || REFERENCE_COLLECTION.id) !== row.collectionId)) throw new Error('reference_collection_id_conflict');
  const next = new Map(old), failures = [], found = new Set(rows.map(row => row.id));
  let cursor = 0, added = 0, changed = 0, originalsAdded = 0, completed = 0, fatalError;
  const stats = () => ({ total: rows.length, completed, added, changed, originalsAdded, failed: failures.length });
  // Thumbnails are a few KB; original imports keep a lower memory ceiling.
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!fatalError && cursor < rows.length) {
      const row = rows[cursor++], previous = old.get(row.id);
      try {
        const file = path.join(snapshot, row.thumbnailPath);
        if ((await lstat(file)).isSymbolicLink()) throw new Error('invalid_thumbnail_file');
        const thumbnailBytes = await readFile(file), thumbnailHash = referenceDigest(thumbnailBytes);
        const thumbnail = !storageChanged && validReferenceObject(previous?.thumbnail) && previous.thumbnail.sha256 === thumbnailHash ? previous.thumbnail : await storage.put(thumbnailBytes, { cache: true });
        let original = previous?.original || null;
        if (original && storageChanged) original = await storage.put(await storage.read(original));
        const originalPath = originals.get(row.stem);
        if (originalPath) {
          const info = await lstat(originalPath);
          if (!info.isFile() || info.size > 32 * 1024 ** 2) throw new Error('invalid_original_file');
          const bytes = await readFile(originalPath);
          if (original?.sha256 !== referenceDigest(bytes)) { original = await storage.put(bytes); originalsAdded++; }
        } else if (!original && storage.findOriginal) {
          original = await storage.findOriginal(row.kind, row.stem);
          if (original) originalsAdded++;
        }
        const item = { ...row, thumbnail, original, sourceMissing: false, addedAt: previous?.addedAt || at };
        if (!previous) added++;
        else if (JSON.stringify(item) !== JSON.stringify(previous)) changed++;
        next.set(row.id, item);
      } catch (error) {
        if (error.message.startsWith('reference_storage_')) fatalError ||= error;
        failures.push({ id: row.id, code: /^[a-z_]+$/.test(error.message) ? error.message : 'reference_import_failed' });
      }
      completed++;
      if (completed % 100 === 0) onProgress(stats());
    }
  }));
  if (fatalError) throw fatalError;
  // Missing upstream entries stay available. An incomplete source must never erase an archive.
  for (const [id, item] of next) if (!found.has(id) && (item.collectionId || REFERENCE_COLLECTION.id) === REFERENCE_COLLECTION.id) {
    if (!item.sourceMissing) changed++;
    next.set(id, { ...item, sourceMissing: true });
  }
  const items = [...rows.map(row => next.get(row.id)).filter(Boolean), ...[...next.values()].filter(item => !found.has(item.id))];
  const manifest = { version: 1, repository: 'sleepy-zone/ai-ref-library-cn', storage: storageMode, commit,
    updatedAt: added || changed || before.items.length !== items.length ? at : before.updatedAt || at, items };
  await writeReferenceJson(path.join(directory, 'manifest.json'), manifest);
  return { ...stats(), failures, commit, originalCount: items.filter(item => item.original).length,
    pendingOriginals: items.filter(item => !item.original).length, archived: items.length };
}
