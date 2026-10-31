import { REFERENCE_COLLECTION, validReferenceObject } from './reference-catalogue.js';

export function mergeReferenceCosOriginals(manifest, rows, now = new Date().toISOString()) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.items) || !Array.isArray(rows) || !rows.length || rows.length > 60000)
    throw new Error('invalid_reference_import');
  const items = new Map(manifest.items.map(item => [item.id, item]));
  if (items.size !== manifest.items.length) throw new Error('duplicate_reference_id');
  const updates = new Map(), keys = new Set();
  let changed = 0;
  for (const row of rows) {
    const previous = items.get(row.id), object = row.original;
    if (!previous || !validReferenceObject(object) || !object.key.startsWith('ai-reference/')
      || object.key.split('/').at(-1) !== `${previous.stem}.png`
      || !/^[a-f0-9]{32}$/.test(object.etag || '')) throw new Error('invalid_reference_original');
    if (updates.has(row.id) || keys.has(object.key)) throw new Error('duplicate_reference_original');
    if (previous.original && previous.original.sha256 !== object.sha256) throw new Error('reference_original_conflict');
    keys.add(object.key); updates.set(row.id, object);
    if (JSON.stringify(previous.original) !== JSON.stringify(object)) changed++;
  }
  const merged = manifest.items.map(item => updates.has(item.id) ? { ...item, original: updates.get(item.id),
    collectionId: item.collectionId || REFERENCE_COLLECTION.id,
    collectionName: item.collectionName || REFERENCE_COLLECTION.name } : item);
  return { manifest: { ...manifest, items: merged, updatedAt: changed ? now : manifest.updatedAt }, changed,
    verified: rows.length, originalCount: merged.filter(item => item.original).length,
    pendingOriginals: merged.filter(item => !item.original).length };
}

export async function verifyReferenceCosOriginals(rows, headObject, concurrency = 8) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('invalid_reference_concurrency');
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failure && cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const response = await headObject(row.original.key), headers = response.headers || {};
        const etag = String(headers.etag || '').replaceAll('"', '').toLowerCase();
        if (Number(headers['content-length']) !== row.original.bytes || etag !== row.original.etag)
          throw new Error('reference_original_integrity_failed');
      } catch (error) {
        failure ||= new Error(error.message === 'reference_original_integrity_failed'
          ? error.message : 'reference_original_unreadable');
      }
    }
  }));
  if (failure) throw failure;
}
