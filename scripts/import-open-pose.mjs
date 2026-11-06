import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createReferenceStorage, writeReferenceJson } from '../lib/reference-storage.js';
import { validReferenceObject } from '../lib/reference-catalogue.js';

const COLLECTION = { id: 'open-pose-costume', name: '姿势与服装参考 · Open Pose Costume' };
const MAX_BYTES = 32 * 1024 ** 2;
const RAW_ROOT = 'https://raw.githubusercontent.com/hongye007/open-pose-costume';
const PAGES_HOSTS = new Set([
  'ai-pose-gallery.pages.dev', 'ai-costume-gallery.pages.dev',
  'ai-costume-anime-gallery.pages.dev', 'ai-portrait-gallery.pages.dev',
]);

const { values } = parseArgs({ options: {
  directory: { type: 'string' }, snapshot: { type: 'string' }, commit: { type: 'string' },
  apply: { type: 'boolean' }, 'local-only': { type: 'boolean' },
} });
if (!values.directory || !values.snapshot || !/^[a-f0-9]{40}$/.test(values.commit || '')) throw new Error('invalid_import_arguments');

const directory = path.resolve(values.directory);
const manifestFile = path.join(directory, 'manifest.json');
const sourceCommit = values.commit;

function text(value, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback; }
function tagId(tag) { return text(typeof tag === 'string' ? tag : tag?.id).toLowerCase(); }
function tagText(tag) { return text(typeof tag === 'string' ? tag : tag?.zh || tag?.en || tag?.id); }
function kindFor(item) {
  if (item?.kind === 'character') return 'face';
  if (item?.kind === 'pose' || item?.kind === 'costume') return item.kind;
  throw new Error('invalid_catalog_kind');
}
function styleFor(tags) {
  const ids = new Set(tags.map(tagId));
  if (ids.has('photo')) return 'realistic';
  if (ids.has('anime')) return 'anime';
  if (ids.has('line-art')) return 'line-art';
  return 'unmarked';
}
function genderFor(tags) {
  const ids = new Set(tags.map(tagId));
  return ids.has('male') ? 'male' : ids.has('female') ? 'female' : 'unmarked';
}
function sourceUrl(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('invalid_source_url');
  if (raw.startsWith('custom/')) {
    if (!/^custom\/(?:pose|costume|character)\/(?:originals|images|thumbnails)\/[A-Za-z0-9_.-]+\.(?:png|webp|jpg)$/.test(raw)) throw new Error('invalid_custom_asset_path');
    return `${RAW_ROOT}/${sourceCommit}/public/${raw}`;
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid_source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !PAGES_HOSTS.has(url.hostname)) throw new Error('untrusted_source_url');
  if (!/\.(?:png|webp|jpg)$/.test(url.pathname)) throw new Error('invalid_source_image');
  return url.href;
}
function rowsFrom(catalogue) {
  if (!catalogue || !Array.isArray(catalogue.items) || catalogue.items.length < 1 || catalogue.items.length > 10000) throw new Error('invalid_catalogue');
  const rows = [], ids = new Set();
  for (const item of catalogue.items) {
    const kind = kindFor(item), tags = Array.isArray(item.tags) ? item.tags : [];
    if (!Array.isArray(item.variants) || !item.variants.length) throw new Error('invalid_catalog_variants');
    for (const variant of item.variants) {
      const stem = text(variant?.id);
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(stem)) throw new Error('invalid_catalog_id');
      const id = `${kind}:${stem}`;
      if (ids.has(id)) throw new Error('duplicate_catalog_id');
      ids.add(id);
      const originalSourceUrl = sourceUrl(variant.original);
      const thumbnailSourceUrl = sourceUrl(variant.thumbnail || variant.image);
      const depthSourceUrl = variant.depth?.original ? sourceUrl(variant.depth.original) : null;
      rows.push({
        id, stem, kind, collectionId: COLLECTION.id, collectionName: COLLECTION.name,
        thumbnailPath: thumbnailSourceUrl, sourceUrl: text(item.source, RAW_ROOT), originalSourceUrl,
        license: 'user-authorized', title: text(item.title?.zh, stem), category: text(item.category?.zh, '未分类'),
        hair: text(item.portrait?.hair), tags: [...new Set([...tags.map(tagText).filter(Boolean), text(item.series?.zh), text(item.keywords?.zh)].filter(Boolean))].slice(0, 50),
        groupId: `${kind}:${text(item.id, stem)}`, angle: text(variant.angle), style: styleFor(tags), gender: genderFor(tags),
        sourceCommit, sourceMissing: false, thumbnailSourceUrl, depthSourceUrl,
      });
    }
  }
  return rows;
}
async function download(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
      const declared = response.headers.get('content-length');
      if (!response.ok || !response.body || (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))) throw new Error('image_download_failed');
      const reader = response.body.getReader(), chunks = [];
      let received = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_BYTES) {
            await reader.cancel('image_too_large').catch(() => {});
            throw new Error('image_too_large');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      if (!received) throw new Error('image_download_failed');
      return Buffer.concat(chunks, received);
    } catch (error) { if (attempt === 2) throw error; }
  }
  throw new Error('image_download_failed');
}
async function mapPool(items, handler, size = 4) {
  let cursor = 0, stopped = false;
  const failures = [];
  async function worker() {
    while (!stopped) {
      const item = items[cursor++];
      if (!item) return;
      try { await handler(item); }
      catch (error) { failures.push({ id: item.id, error: text(error?.message, 'failed') }); stopped = true; }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, worker));
  return failures;
}
function cleanRow(row, objects, addedAt = new Date().toISOString()) {
  const { thumbnailSourceUrl, depthSourceUrl, ...record } = row;
  return { ...record, ...objects, addedAt };
}
function enrichExisting(previous, row) {
  return { ...previous, title: row.title, category: row.category, hair: row.hair, tags: row.tags,
    groupId: row.groupId, angle: row.angle, style: row.style, gender: row.gender,
    sourceUrl: row.sourceUrl, originalSourceUrl: row.originalSourceUrl, thumbnailPath: row.thumbnailPath,
    sourceCommit: row.sourceCommit, sourceMissing: false };
}
async function readCheckpoint(file, additions) {
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  if (data.version !== 1 || data.sourceCommit !== sourceCommit || !Array.isArray(data.items)) throw new Error('invalid_import_checkpoint');
  const source = new Map(additions.map(row => [row.id, row])), restored = new Map();
  for (const item of data.items) {
    const row = source.get(item?.id);
    if (!row || restored.has(row.id) || !validReferenceObject(item.original) || !validReferenceObject(item.thumbnail) || (item.depth && !validReferenceObject(item.depth))) throw new Error('invalid_import_checkpoint');
    restored.set(row.id, cleanRow(row, { original: item.original, thumbnail: item.thumbnail, ...(item.depth ? { depth: item.depth } : {}) }, item.addedAt));
  }
  return restored;
}

const lock = path.join(directory, 'sync.lock');
await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
try {
  const [rawManifest, rawCatalogue] = await Promise.all([readFile(manifestFile), readFile(path.resolve(values.snapshot), 'utf8')]);
  const manifest = JSON.parse(rawManifest), rows = rowsFrom(JSON.parse(rawCatalogue));
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) throw new Error('invalid_manifest');
  const old = new Map(manifest.items.map(item => [item.id, item]));
  if (old.size !== manifest.items.length) throw new Error('duplicate_manifest_id');
  const additions = rows.filter(row => !old.has(row.id));
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', sourceRows: rows.length, updated: rows.length - additions.length, added: additions.length, final: old.size + additions.length, counts: Object.fromEntries(['face', 'pose', 'costume'].map(kind => [kind, additions.filter(row => row.kind === kind).length])) }));
  if (!values.apply) process.exitCode = 0;
  else {
    const storage = createReferenceStorage({ directory, env: values['local-only'] ? {} : process.env });
    if (!storage.remote && !values['local-only']) throw new Error('private_cloud_storage_required');
    const backup = path.join(directory, 'import-backups', `open-pose-${Date.now()}`);
    const checkpointFile = path.join(directory, 'import-progress', `open-pose-${sourceCommit}.json`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(path.join(backup, 'manifest.json'), rawManifest, { mode: 0o600 });
    for (const row of rows) if (old.has(row.id)) old.set(row.id, enrichExisting(old.get(row.id), row));
    const checkpoint = await readCheckpoint(checkpointFile, additions);
    const resumed = checkpoint.size;
    for (const row of checkpoint.values()) old.set(row.id, row);
    let completed = checkpoint.size, checkpointWrite = Promise.resolve();
    const saveCheckpoint = () => {
      checkpointWrite = checkpointWrite.then(() => writeReferenceJson(checkpointFile, { version: 1, sourceCommit, items: [...checkpoint.values()] }));
      return checkpointWrite;
    };
    const pending = additions.filter(row => !checkpoint.has(row.id));
    const failures = await mapPool(pending, async (row) => {
      const [originalBytes, thumbnailBytes, depthBytes] = await Promise.all([
        download(row.originalSourceUrl), download(row.thumbnailSourceUrl), row.depthSourceUrl ? download(row.depthSourceUrl) : null,
      ]);
      const [original, thumbnail, depth] = await Promise.all([
        storage.put(originalBytes), storage.put(thumbnailBytes, { cache: true }), depthBytes ? storage.put(depthBytes) : null,
      ]);
      const saved = cleanRow(row, { thumbnail, original, ...(depth ? { depth } : {}) });
      checkpoint.set(row.id, saved);
      old.set(row.id, saved);
      await saveCheckpoint();
      completed += 1;
      if (completed % 25 === 0 || completed === additions.length) console.log(JSON.stringify({ completed, total: additions.length }));
    });
    await checkpointWrite;
    if (failures.length) {
      console.log(JSON.stringify({ failed: failures.length, failureIds: failures.map(failure => failure.id).slice(0, 20) }));
      throw new Error('incomplete_import_manifest_unchanged');
    }
    await writeReferenceJson(manifestFile, { ...manifest, updatedAt: new Date().toISOString(), items: [...old.values()] });
    await unlink(checkpointFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log(JSON.stringify({ imported: additions.length, resumed, total: old.size, backup }));
  }
} finally {
  await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
