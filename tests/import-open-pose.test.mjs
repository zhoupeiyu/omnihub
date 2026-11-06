import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const commit = '9f395ea08623a292c3750bd4780f4322df88a1bd';
const sample = (id, kind, source, original, thumbnail, tags = []) => ({ id, kind, source, title: { zh: id }, category: { zh: '分类' }, tags,
  variants: [{ id, angle: 'front', original, thumbnail }] });

test('open-pose importer counts existing variants and additions without changing dry-run manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'open-pose-import-test-'));
  try {
    const manifest = { version: 1, items: [{ id: 'face:existing', collectionId: 'gia-ai-reference', collectionName: '旧集合', original: { key: 'ai-reference/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bytes: 12, contentType: 'image/png' } }] };
    const snapshot = { items: [
      sample('existing', 'character', 'https://ai-portrait-gallery.pages.dev/', 'https://ai-portrait-gallery.pages.dev/img/full/existing.png', 'https://ai-portrait-gallery.pages.dev/img/thumb/existing.webp', [{ id: 'photo', zh: '写实' }]),
      sample('new-anime', 'costume', 'https://ai-costume-anime-gallery.pages.dev/', 'https://ai-costume-anime-gallery.pages.dev/png/new-anime.png', 'https://ai-costume-anime-gallery.pages.dev/thumbs/new-anime.webp', [{ id: 'anime', zh: '动漫' }]),
    ] };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot));
    const { stdout } = await run(process.execPath, [path.resolve('scripts/import-open-pose.mjs'), '--directory', directory, '--snapshot', path.join(directory, 'snapshot.json'), '--commit', commit]);
    assert.deepEqual(JSON.parse(stdout), { mode: 'dry-run', sourceRows: 2, updated: 1, added: 1, final: 2, counts: { face: 0, pose: 0, costume: 1 } });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'manifest.json'))), manifest);
    await assert.rejects(readFile(path.join(directory, 'sync.lock')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('open-pose importer enriches matched metadata without replacing collection or stored image objects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'open-pose-import-existing-'));
  try {
    const original = { key: 'ai-reference/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bytes: 12, contentType: 'image/png' };
    const thumbnail = { key: 'ai-reference/objects/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp', sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bytes: 12, contentType: 'image/webp' };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, items: [{ id: 'face:existing', collectionId: 'gia-ai-reference', collectionName: '旧集合', original, thumbnail, tags: [], style: 'unmarked', gender: 'unmarked' }] }));
    await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({ items: [sample('existing', 'character', 'https://ai-portrait-gallery.pages.dev/', 'https://ai-portrait-gallery.pages.dev/img/full/existing.png', 'https://ai-portrait-gallery.pages.dev/img/thumb/existing.webp', [{ id: 'photo', zh: '写实' }, { id: 'female', zh: '女性' }])] }));
    await run(process.execPath, [path.resolve('scripts/import-open-pose.mjs'), '--directory', directory, '--snapshot', path.join(directory, 'snapshot.json'), '--commit', commit, '--apply', '--local-only']);
    const item = JSON.parse(await readFile(path.join(directory, 'manifest.json'))).items[0];
    assert.deepEqual({ collectionId: item.collectionId, collectionName: item.collectionName, original: item.original, thumbnail: item.thumbnail, style: item.style, gender: item.gender }, { collectionId: 'gia-ai-reference', collectionName: '旧集合', original, thumbnail, style: 'realistic', gender: 'female' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('facet backfill preserves manual labels and image objects while adding upstream series and codes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'open-pose-facets-'));
  try {
    const original = { key: 'ai-reference/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bytes: 12, contentType: 'image/png' };
    const previous = { id: 'face:existing', kind: 'face', stem: 'existing', collectionId: 'gia-ai-reference', title: 'Manual title', category: 'Manual category', tags: ['Manual tag'], hair: 'long', original, thumbnail: original };
    const row = { ...sample('existing', 'character', 'https://ai-portrait-gallery.pages.dev/', 'https://ai-portrait-gallery.pages.dev/img/full/existing.png', 'https://ai-portrait-gallery.pages.dev/img/thumb/existing.webp'), code: 'UCF-009', series: { zh: '正面人物参考' } };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, items: [previous] }));
    await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({ items: [row] }));
    await run(process.execPath, [path.resolve('scripts/import-open-pose.mjs'), '--directory', directory, '--snapshot', path.join(directory, 'snapshot.json'), '--facets-snapshot', path.join(directory, 'snapshot.json'), '--commit', commit, '--apply', '--local-only']);
    const item = JSON.parse(await readFile(path.join(directory, 'manifest.json'))).items[0];
    assert.deepEqual(item, { ...previous, hair: '长发', code: 'UCF-009', series: '正面人物参考' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
