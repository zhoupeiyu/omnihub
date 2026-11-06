import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseReferenceData, referenceObject, validReferenceObject } from '../lib/reference-catalogue.js';
import { createReferenceStorage } from '../lib/reference-storage.js';
import { syncReferenceSnapshot } from '../lib/reference-sync.js';
import { createReferenceLibraryHandler } from '../lib/reference-library.js';
import { mergeReferenceCosOriginals, verifyReferenceCosOriginals } from '../lib/reference-cos-import.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGfoAAAAASUVORK5CYII=', 'base64');
const fixtures = {
  face: { data: { sections: [{name:'脸部特写'}], hairs: [{name:'短发'}], items: [{id:'f001',s:0,h:0,sz:'短波波',sj:'ボブ'}] }, img:{f001:'thumbs/f001.webp'} },
  pose: { data: { series:[{name:'全身 · 标准系'}], poses:[{id:'P001',key:'standard|P001',s:0,cat:'站立',zh:'自然站立',ang:{正面:'standard_P001_front',侧面:'standard_P001_side'}}] }, img:{standard_P001_front:'thumbs/standard_P001_front.webp',standard_P001_side:'thumbs/standard_P001_side.webp'} },
  costume: { data: { cats:[{name:'春'}], items:[{id:'SPR-001',c:0,zh:['白色','裙子'],kw:['white','skirt']}] }, img:{'SPR-001':'thumbs/SPR-001.webp'} },
};
const source = (kind, value = fixtures[kind]) => `window.LIB_${kind.toUpperCase()}=${JSON.stringify(value)};`;
async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-reference-test-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const snapshot = path.join(directory,'snapshot'), archive = path.join(directory,'archive');
  await mkdir(path.join(snapshot,'data'),{recursive:true}); await mkdir(path.join(snapshot,'thumbs'));
  for (const kind of Object.keys(fixtures)) {
    await writeFile(path.join(snapshot,`data/${kind}.js`),source(kind));
    for (const file of Object.values(fixtures[kind].img)) await writeFile(path.join(snapshot,file),png);
  }
  const storage = createReferenceStorage({directory:archive,env:{}});
  const sync = options => syncReferenceSnapshot({directory:archive,snapshot,commit:'a'.repeat(40),storage,...options});
  return {directory,snapshot,archive,storage,sync};
}
async function startServer(t, w) {
  const handler = createReferenceLibraryHandler({ directory: w.archive, storage: w.storage, getUser: () => ({ username: 'zane' }) });
  const server = http.createServer((req, res) => void handler(req, res, decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, get: async route => (await fetch(`${base}/api/reference-library${route}`)).json() };
}
test('normalizes bilingual labels and keeps pose angles distinct', () => {
  assert.deepEqual(parseReferenceData('face',source('face'))[0].tags,['短发','脸部特写','短波波','ボブ']);
  const poses=parseReferenceData('pose',source('pose')); assert.equal(poses.length,2); assert.equal(poses[0].groupId,poses[1].groupId); assert.notEqual(poses[0].id,poses[1].id);
  assert.equal(parseReferenceData('costume',source('costume'))[0].category,'春');
});
test('upstream assignments cannot execute code or point thumbnails outside the archive', () => {
  for (const value of ['window.LIB_FACE=(()=>globalThis.pwned=true)();','window.LIB_FACE={};process.exit(0)','window.LIB_POSE={};']) assert.throws(()=>parseReferenceData('face',value));
  const bad=structuredClone(fixtures.face); bad.img.f001='../../secret'; assert.throws(()=>parseReferenceData('face',source('face',bad)));
  bad.img.f001='https://example.com/f.webp'; assert.throws(()=>parseReferenceData('face',source('face',bad)));
});
test('objects use content hashes and reject executable files or malformed keys', () => {
  const object=referenceObject(png); assert.ok(validReferenceObject(object)); assert.equal(object.contentType,'image/png');
  assert.ok(object.key.startsWith('ai-reference/objects/'));
  assert.ok(validReferenceObject({ ...object, key: object.key.replace('ai-reference/objects/', 'x-bookmarks/originals/') }));
  assert.equal(validReferenceObject({...object,key:'../../secret'}),false); assert.throws(()=>referenceObject(Buffer.from('<svg onload="alert(1)"></svg>')));
});
test('manual COS paths remain scoped and reject traversal, encoded paths and forged object hashes', () => {
  const original = { ...referenceObject(png), key: 'ai-reference/图片/AI 作图脸库/f001.png' };
  assert.ok(validReferenceObject(original));
  for (const key of ['ai-reference/../secret/f001.png', 'ai-reference//f001.png', 'ai-reference/%2e%2e/f001.png',
    'ai-reference/图片\\secret/f001.png', 'ai-reference/图片/f001.png?download=1', 'other/图片/f001.png',
    'ai-reference/objects/xx/f001.png', 'ai-reference/图片/f001.svg', 'ai-reference/图片/\nf001.png'])
    assert.equal(validReferenceObject({ ...original, key }), false, key);
  assert.equal(validReferenceObject({ ...original, sha256: 'bad' }), false);
  const cas = referenceObject(png);
  assert.equal(validReferenceObject({ ...cas, sha256: 'a'.repeat(64) }), false);
});
test('manual original imports replace only matching pointers and remain idempotent through source sync', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), before = JSON.parse(await readFile(file));
  const original = { ...referenceObject(png), key: 'ai-reference/图片/AI 作图脸库/f001.png', etag: 'a'.repeat(32) };
  const rows = [{ id: 'face:f001', original }];
  const merged = mergeReferenceCosOriginals(before, rows, '2026-10-31T00:00:00.000Z');
  assert.equal(merged.changed, 1); assert.equal(merged.originalCount, 1);
  assert.deepEqual(merged.manifest.items[1], before.items[1]);
  assert.equal(before.items[0].original, null);
  assert.equal(mergeReferenceCosOriginals(merged.manifest, rows).changed, 0);
  assert.throws(() => mergeReferenceCosOriginals(before, [...rows, ...rows]), /duplicate_reference_original/);
  assert.throws(() => mergeReferenceCosOriginals(before, [{ id: 'face:unknown', original }]), /invalid_reference_original/);
  assert.throws(() => mergeReferenceCosOriginals(before, [{ id: 'face:f001', original: { ...original, key: 'ai-reference/图片/wrong.png' } }]), /invalid_reference_original/);
  assert.throws(() => mergeReferenceCosOriginals(merged.manifest, [{ id: 'face:f001', original: { ...original, sha256: 'b'.repeat(64) } }]), /reference_original_conflict/);
  await writeFile(file, JSON.stringify(merged.manifest));
  await w.sync();
  assert.deepEqual(JSON.parse(await readFile(file)).items[0].original, original);
});
test('original import verification stops on denied access or mismatched remote bytes', async () => {
  const rows = [{ original: { key: 'ai-reference/图片/f001.png', bytes: png.length, etag: 'a'.repeat(32) } }];
  await verifyReferenceCosOriginals(rows, async () => ({ headers: { 'content-length': String(png.length), etag: '"' + 'a'.repeat(32) + '"' } }));
  await assert.rejects(verifyReferenceCosOriginals(rows, async () => { throw { statusCode: 403, Authorization: 'must-not-leak' }; }), /reference_original_unreadable/);
  await assert.rejects(verifyReferenceCosOriginals(rows, async () => ({ headers: { 'content-length': String(png.length), etag: 'b'.repeat(32) } })), /reference_original_integrity_failed/);
});
test('console originals are served privately and verified against the trusted content digest', async t => {
  const w = await workspace(t);
  const object = { ...referenceObject(png), key: 'ai-reference/图片/AI 作图姿势库/standard_P001_front.png' };
  let requested;
  const storage = createReferenceStorage({ directory: w.archive, cos: { async getObject(params) { requested = params.Key; return { Body: png }; } } });
  assert.deepEqual(await storage.read(object), png); assert.equal(requested, object.key);
  const corrupted = createReferenceStorage({ directory: path.join(w.archive, 'cold-cache'), cos: { async getObject() { return { Body: Buffer.alloc(png.length) }; } } });
  await assert.rejects(corrupted.read(object), /reference_integrity_failed/);
});
test('daily sync discovers newly uploaded originals without replacing an existing original', async t => {
  const w = await workspace(t); await w.sync();
  const original = { ...referenceObject(png), key: 'ai-reference/图片/AI 作图脸库/f001.png', etag: 'a'.repeat(32) };
  const calls = [];
  const storage = { ...w.storage, async findOriginal(kind, stem) { calls.push(`${kind}:${stem}`); return kind === 'face' ? original : null; } };
  const first = await w.sync({ storage }); assert.equal(first.originalsAdded, 1);
  calls.length = 0;
  const second = await w.sync({ storage }); assert.equal(second.originalsAdded, 0);
  assert.ok(!calls.includes('face:f001'));
});
test('COS original discovery is bounded, conditional and distinguishes missing files from denied reads', async t => {
  const w = await workspace(t); let getParams;
  const storage = createReferenceStorage({ directory: w.archive, cos: {
    async headObject() { return { headers: { 'content-length': String(png.length), etag: '"abc"' } }; },
    async getObject(params) { getParams = params; return { Body: png }; },
  } });
  const original = await storage.findOriginal('face', 'f001');
  assert.equal(original.key, 'ai-reference/图片/AI 作图脸库/f001.png');
  assert.equal(original.sha256, referenceObject(png).sha256);
  assert.equal(getParams.IfMatch, '"abc"'); assert.equal(getParams.Range, `bytes=0-${png.length - 1}`);
  for (const statusCode of [403, 404]) {
    const denied = createReferenceStorage({ directory: w.archive, cos: { async headObject() { throw { statusCode }; } } });
    if (statusCode === 404) assert.equal(await denied.findOriginal('face', 'f001'), null);
    else await assert.rejects(denied.findOriginal('face', 'f001'), /reference_storage_read_failed/);
  }
  await assert.rejects(storage.findOriginal('face', '../secret'), /invalid_reference_id/);
  const oversized = createReferenceStorage({ directory: w.archive, cos: { async headObject() { return { headers: { 'content-length': 40 * 1024 ** 2 } }; }, getObject() { assert.fail('oversized object must not be downloaded'); } } });
  await assert.rejects(oversized.findOriginal('face', 'f001'), /invalid_reference_image/);
});
test('sync is idempotent and local original imports upgrade preview records', async t => {
  const w=await workspace(t); const first=await w.sync(); assert.equal(first.added,4); assert.equal(first.originalCount,0);
  const next=await w.sync({storage:{put(){throw new Error('unexpected_upload');}}}); assert.equal(next.failed,0); assert.equal(next.added,0); assert.equal(next.changed,0);
  const originals=path.join(w.directory,'originals'); await mkdir(originals); await writeFile(path.join(originals,'f001.png'),png);
  const imported=await w.sync({originalsDirectory:originals}); assert.equal(imported.originalCount,1); assert.equal(imported.originalsAdded,1);
  const again=await w.sync({originalsDirectory:originals}); assert.equal(again.originalsAdded,0); assert.equal(again.changed,0);
});
test('incomplete metadata cannot replace a successful manifest', async t => {
  const w=await workspace(t); await w.sync(); const before=await readFile(path.join(w.archive,'manifest.json'),'utf8');
  await writeFile(path.join(w.snapshot,'data/pose.js'),'window.LIB_POSE={};'); await assert.rejects(w.sync());
  assert.equal(await readFile(path.join(w.archive,'manifest.json'),'utf8'),before);
});
test('failed image updates preserve prior readable records', async t => {
  const w=await workspace(t); await w.sync(); await writeFile(path.join(w.snapshot,'thumbs/f001.webp'),Buffer.from('not-an-image'));
  const result=await w.sync(); assert.equal(result.failed,1); assert.equal(result.archived,4);
  const manifest=JSON.parse(await readFile(path.join(w.archive,'manifest.json'),'utf8')); assert.deepEqual(await w.storage.read(manifest.items[0].thumbnail),png);
});
test('COS uploads remain private and a permission failure never becomes an overwrite', async t => {
  const w=await workspace(t); let uploaded;
  const object=referenceObject(png); let exists=false;
  const cos={async headObject(){if(!exists)throw {statusCode:404};return {headers:{'content-length':String(object.bytes),'x-cos-meta-sha256':object.sha256}};},async putObject(value){uploaded=value;exists=true;}};
  const storage=createReferenceStorage({directory:w.archive,env:{COS_BUCKET:'bucket',COS_REGION:'region'},cos}); await storage.put(png);
  assert.equal(uploaded.ACL,'private');assert.equal(uploaded.ServerSideEncryption,'AES256');assert.equal(uploaded.CacheControl,'private, no-store');
  const denied=createReferenceStorage({directory:w.archive,cos:{async headObject(){throw {statusCode:403};},async putObject(){assert.fail('must not upload');}}});
  await assert.rejects(denied.put(png),/head_failed/);
});
test('a local catalogue must upload objects when promoted to COS', async t => {
  const w=await workspace(t);await w.sync();let writes=0;
  await w.sync({storage:{remote:true,async put(bytes){writes++;return referenceObject(bytes);}}});
  assert.equal(writes,4);
});
test('storage outage stops the batch without publishing a partial replacement', async t => {
  const w=await workspace(t);await w.sync();const before=await readFile(path.join(w.archive,'manifest.json'),'utf8');
  let attempts=0;await assert.rejects(w.sync({storage:{remote:true,async put(){attempts++;throw new Error('reference_storage_head_failed');}}}),/head_failed/);
  assert.ok(attempts<=4);assert.equal(await readFile(path.join(w.archive,'manifest.json'),'utf8'),before);
});
test('access revoked during image storage I/O is checked again before sending bytes', async t => {
  const w=await workspace(t);await w.sync();let allowed=true;
  const handler=createReferenceLibraryHandler({directory:w.archive,getUser:()=>allowed?{username:'zane'}:null,storage:{async read(){allowed=false;return png;}}});
  const server=http.createServer((req,res)=>void handler(req,res,decodeURIComponent(new URL(req.url,'http://localhost').pathname)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/reference-library/items/face%3Af001/thumbnail`);
  assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/json/);
});
test('owner-only API protects listing, status, original, thumbnail and HEAD', async t => {
  const w=await workspace(t);await w.sync();let owner=true;
  const handler=createReferenceLibraryHandler({directory:w.archive,storage:w.storage,getUser:req=>req.headers.cookie==='owner'&&owner?{username:'zane'}:req.headers.cookie==='other'?{username:'someone'}:null});
  const server=http.createServer((req,res)=>void handler(req,res,decodeURIComponent(new URL(req.url,'http://localhost').pathname)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const cookie of ['', 'other'])for(const route of ['','/status','/items/face%3Af001','/items/face%3Af001/thumbnail','/items/face%3Af001/original']) {
    const response=await fetch(`${base}/api/reference-library${route}`,{headers:{cookie}});assert.equal(response.status,404);
  }
  const listing=await fetch(`${base}/api/reference-library?kind=face&q=ボブ`,{headers:{cookie:'owner'}}); const data=await listing.json();assert.equal(data.total,1);assert.equal(data.items[0].originalReady,false);
  const file=await fetch(`${base}/api/reference-library/items/face%3Af001/thumbnail?download=1`,{headers:{cookie:'owner'}});assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);assert.match(file.headers.get('cache-control'),/private, no-store/);assert.match(file.headers.get('content-disposition'),/-preview/);
  const missing=await fetch(`${base}/api/reference-library/items/face%3Af001/original`,{headers:{cookie:'owner'}});assert.equal(missing.status,404);
  owner=false;const head=await fetch(`${base}/api/reference-library/items/face%3Af001/thumbnail`,{method:'HEAD',headers:{cookie:'owner','if-none-match':'anything'}});assert.equal(head.status,404);
});

test('collections filter counts and categories while source sync preserves other collections', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  const face = manifest.items.find(item => item.kind === 'face');
  const other = { ...face, id: 'face:my-character', stem: 'my-character', collectionId: 'my-project', collectionName: '我的角色', category: '自建角色' };
  const pose = manifest.items.find(item => item.kind === 'pose');
  const otherPose = { ...pose, id: 'pose:my-pose', stem: 'my-pose', collectionId: 'my-project', collectionName: '我的角色' };
  // Older imported records are still assigned to the original collection.
  for (const item of manifest.items) { delete item.collectionId; delete item.collectionName; }
  manifest.items.push(other, otherPose); await writeFile(file, JSON.stringify(manifest));
  const handler = createReferenceLibraryHandler({ directory: w.archive, storage: w.storage, getUser: () => ({ username: 'zane' }) });
  const server = http.createServer((req, res) => void handler(req, res, decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const get = async route => (await fetch(`http://127.0.0.1:${server.address().port}/api/reference-library${route}`)).json();
  const all = await get('?kind=face'); assert.equal(all.total, 2); assert.equal(all.collections.length, 2);
  const selected = await get('?kind=face&collection=my-project');
  assert.equal(selected.total, 1); assert.deepEqual(selected.categories, ['自建角色']);
  assert.deepEqual(selected.counts, { face: 1, pose: 1, costume: 0 });
  assert.equal((await get('?kind=face&collection=gia-ai-reference')).total, 1);
  assert.equal((await get('?kind=face&collection=missing')).total, 0);
  assert.equal((await get('/items/' + encodeURIComponent(pose.id))).variants.length, 2);
  await w.sync();
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after.items.find(item => item.id === other.id), other);
  assert.deepEqual(after.items.find(item => item.id === otherPose.id), otherPose);
});

test('source sync rejects collection ID collisions and invalid upload concurrency without replacing the manifest', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.items[0].collectionId = 'my-project';
  await writeFile(file, JSON.stringify(manifest)); const before = await readFile(file, 'utf8');
  await assert.rejects(w.sync(), /reference_collection_id_conflict/);
  for (const concurrency of [0, 17, 1.5]) await assert.rejects(w.sync({ concurrency }), /invalid_reference_concurrency/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('group=pose folds same-collection, same-groupId pose variants before pagination, keeps a front-angle canonical and raw kinds ungrouped', async t => {
  const w = await workspace(t); await w.sync();
  const { get } = await startServer(t, w);
  const raw = await get('?kind=pose');
  assert.equal(raw.total, 2); assert.equal(raw.imageTotal, 2);
  assert.ok(raw.items.every(item => !item.variants));
  const grouped = await get('?kind=pose&group=pose');
  assert.equal(grouped.total, 1); assert.equal(grouped.imageTotal, 2); assert.equal(grouped.pages, 1);
  assert.equal(grouped.items.length, 1);
  const group = grouped.items[0];
  assert.equal(group.variantCount, 2); assert.equal(group.variants.length, 2);
  assert.equal(group.angle, '正面'); // canonical defaults to the front angle when present.
  assert.deepEqual(new Set(group.variants.map(v => v.angle)), new Set(['正面', '侧面']));
  // group is not applied to non-pose kinds (legacy contract preserved).
  const face = await get('?kind=face&group=pose');
  assert.ok(!face.items[0].variants);
});

test('action (tags[1]) and angle filters are exact and applied before grouping, so variants are pre-filtered inside each group', async t => {
  const w = await workspace(t); await w.sync();
  const { get } = await startServer(t, w);
  const byAngle = await get('?kind=pose&group=pose&angle=' + encodeURIComponent('正面'));
  assert.equal(byAngle.total, 1); assert.equal(byAngle.imageTotal, 1);
  assert.equal(byAngle.items[0].variantCount, 1); assert.equal(byAngle.items[0].variants.length, 1);
  assert.equal(byAngle.items[0].variants[0].angle, '正面');
  const byAction = await get('?kind=pose&action=' + encodeURIComponent('站立'));
  assert.equal(byAction.total, 2); // both variants share the same action tag.
  const noMatch = await get('?kind=pose&action=' + encodeURIComponent('坐姿'));
  assert.equal(noMatch.total, 0); assert.equal(noMatch.imageTotal, 0);
  const noAngle = await get('?kind=pose&angle=' + encodeURIComponent('背面'));
  assert.equal(noAngle.total, 0);
});

test('facets report global category/hair/action/angle counts independent of active filters, switching between group and image counts', async t => {
  const w = await workspace(t); await w.sync();
  const { get } = await startServer(t, w);
  const ungrouped = await get('?kind=pose&angle=' + encodeURIComponent('正面'));
  const angleFacet = Object.fromEntries(ungrouped.facets.angles.map(f => [f.value, f]));
  // Facets are computed over the whole kind pool, not the angle=正面 filter just applied.
  assert.deepEqual(angleFacet['正面'], { value: '正面', count: 1, imageCount: 1 });
  assert.deepEqual(angleFacet['侧面'], { value: '侧面', count: 1, imageCount: 1 });
  const actionFacet = Object.fromEntries(ungrouped.facets.actions.map(f => [f.value, f]));
  assert.equal(actionFacet['站立'].imageCount, 2); assert.equal(actionFacet['站立'].count, 2);
  const grouped = await get('?kind=pose&group=pose');
  const groupedAngleFacet = Object.fromEntries(grouped.facets.angles.map(f => [f.value, f]));
  // In grouped mode count reflects distinct groups, not raw images, while imageCount stays raw.
  assert.equal(groupedAngleFacet['正面'].count, 1); assert.equal(groupedAngleFacet['正面'].imageCount, 1);
  assert.equal(grouped.groupCounts.pose, 1); assert.equal(grouped.groupCounts.face, 1); assert.equal(grouped.groupCounts.costume, 1);
  assert.ok(Array.isArray(grouped.facets.categories)); assert.ok(Array.isArray(grouped.facets.hairs));
});

test('style and gender filters only use explicit metadata or the trusted anime collection', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  const face = manifest.items.find(item => item.kind === 'face');
  // The collection contract is the only style fallback. Gender remains
  // unmarked unless it is an exact source field/tag, never inferred from image.
  manifest.items.push(
    { ...face, id: 'face:anime-explicit', stem: 'anime-explicit', collectionId: 'taki-anime-reference', collectionName: '动漫角色参考 · たき AI', tags: ['女性'] },
    { ...face, id: 'face:neutral-explicit', stem: 'neutral-explicit', gender: '中性', tags: ['中性'] },
  );
  await writeFile(file, JSON.stringify(manifest));
  const { get } = await startServer(t, w);
  const all = await get('?kind=face');
  const styles = Object.fromEntries(all.facets.styles.map(f => [f.value, f.count]));
  const genders = Object.fromEntries(all.facets.genders.map(f => [f.value, f.count]));
  assert.equal(styles.anime, 1); assert.equal(styles.unmarked, 2);
  assert.equal(genders.female, 1); assert.equal(genders.neutral, 1); assert.equal(genders.unmarked, 1);
  const animeFemale = await get('?kind=face&style=anime&gender=female');
  assert.deepEqual(animeFemale.items.map(item => item.id), ['face:anime-explicit']);
  assert.equal(animeFemale.counts.face, 1);
  assert.equal(animeFemale.groupCounts.face, 1);
  assert.deepEqual(animeFemale.categories, [face.category]);
  assert.deepEqual(animeFemale.facets.styles.map(entry => entry.value), ['anime']);
  assert.deepEqual(animeFemale.facets.genders.map(entry => entry.value), ['female']);
  assert.equal((await get('?kind=face&style=realistic')).total, 0);
  assert.equal((await get('?kind=face&gender=unmarked')).total, 1);
});

test('sort=random returns a full shuffled permutation without dropping or duplicating rows, for both grouped and ungrouped output', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  const pose = manifest.items.find(item => item.kind === 'pose');
  manifest.items.push({ ...pose, id: 'pose:extra-1', stem: 'extra-1', groupId: 'extra-group-1' },
    { ...pose, id: 'pose:extra-2', stem: 'extra-2', groupId: 'extra-group-2' });
  await writeFile(file, JSON.stringify(manifest));
  const { get } = await startServer(t, w);
  const random = await get('?kind=pose&sort=random');
  assert.equal(random.items.length, 4);
  assert.deepEqual(new Set(random.items.map(i => i.id)), new Set(['pose:standard_P001_front', 'pose:standard_P001_side', 'pose:extra-1', 'pose:extra-2']));
  const groupedRandom = await get('?kind=pose&group=pose&sort=random');
  assert.equal(groupedRandom.total, 3);
});

test('groups never merge across different collections and pose rows without a groupId each form their own unique group', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  const pose = manifest.items.find(item => item.kind === 'pose');
  // Same groupId, different collection: must stay separate groups.
  manifest.items.push({ ...pose, id: 'pose:other-collection', stem: 'other-collection', collectionId: 'my-project', collectionName: '我的角色' });
  // No groupId at all: each such item is its own group, never merged with siblings.
  for (const item of manifest.items) if (item.kind === 'pose' && item.id !== 'pose:other-collection') delete item.groupId;
  await writeFile(file, JSON.stringify(manifest));
  const { get } = await startServer(t, w);
  const grouped = await get('?kind=pose&group=pose');
  // standard_P001_front + standard_P001_side now have no groupId -> 2 groups (not merged) + the other-collection row -> 3.
  assert.equal(grouped.total, 3);
  assert.ok(grouped.items.every(item => item.variantCount === 1));
});


test('group pagination spans the entire catalogue and tuple keys cannot collide on delimiters', async t => {
  const w = await workspace(t); await w.sync();
  const file = path.join(w.archive, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  const pose = manifest.items.find(item => item.kind === 'pose');
  manifest.items = [];
  for (let i = 0; i < 50; i++) for (const angle of ['正面', '侧面']) {
    manifest.items.push({ ...pose, id: `pose:g${i}-${angle === '正面' ? 'front' : 'side'}`, groupId: `g${i}`, angle });
  }
  manifest.items.push({ ...pose, id: 'pose:collision-a', collectionId: 'a::b', groupId: 'c' },
    { ...pose, id: 'pose:collision-b', collectionId: 'a', groupId: 'b::c' });
  await writeFile(file, JSON.stringify(manifest));
  const { get } = await startServer(t, w);
  const first = await get('?kind=pose&group=pose'), second = await get('?kind=pose&group=pose&page=2');
  assert.equal(first.total, 52); assert.equal(first.imageTotal, 102); assert.equal(first.pages, 2);
  assert.equal(first.items.length, 48); assert.equal(second.items.length, 4);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 52);
  assert.ok(first.items.every(i => i.variants.length === 2));
  assert.equal(second.items.filter(i => i.id.startsWith('pose:collision-')).length, 2);
});

test('hairstyle facets and filters use the real hairstyle field, not hair length', async t => {
  const w = await workspace(t); await w.sync(); const {get}=await startServer(t,w);
  const all=await get('?kind=face');
  assert.deepEqual(all.facets.hairstyles.map(x=>x.value),['短波波']);
  const found=await get('?kind=face&hairstyle='+encodeURIComponent('短波波'));
  assert.equal(found.total,1);assert.ok(found.items.every(x=>x.kind==='face'));
  assert.equal((await get('?kind=face&hairstyle=missing')).total,0);
  assert.equal((await get('?kind=face&hair=missing')).facets.hairstyles.length,0);
});

 test('private images revalidate without reading storage and deny unauthorized cache hits', async t => {
  const w = await workspace(t); await w.sync();
  let reads = 0, authorized = true;
  const handler = createReferenceLibraryHandler({directory:w.archive, getUser:()=>authorized ? {username:'zane'} : null, storage:{read:async object=>{reads++;return w.storage.read(object);}}});
  const server=http.createServer((req,res)=>void handler(req,res,decodeURIComponent(new URL(req.url,'http://localhost').pathname)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/reference-library/items/face%3Af001/thumbnail`;
  const first=await fetch(url);await first.arrayBuffer();const etag=first.headers.get('etag');
  assert.ok(etag);assert.equal(first.headers.get('cache-control'),'private, no-cache');
  const second=await fetch(url,{headers:{'if-none-match':etag}});assert.equal(second.status,304);assert.equal(reads,1);
  authorized=false;const denied=await fetch(url,{headers:{'if-none-match':etag}});assert.equal(denied.status,404);assert.equal(reads,1);
 });

test('derived previews are used only while their source original still matches', async t => {
  const w=await workspace(t); await w.sync({});
  const file=path.join(w.archive,'manifest.json'), manifest=JSON.parse(await readFile(file));
  const item=manifest.items.find(i=>i.id==='face:f001');item.original=item.thumbnail;await writeFile(file,JSON.stringify(manifest));
  const preview=await w.storage.put(Buffer.concat([png,Buffer.from('preview')]));
  const sidecar=path.join(w.archive,'previews.json');
  await writeFile(sidecar,JSON.stringify({version:1,items:{[item.id]:{originalSha256:item.original.sha256,object:preview}}}));
  const {base}=await startServer(t,w);const url=base+'/api/reference-library/items/face:f001/thumbnail';
  assert.equal((await fetch(url)).headers.get('etag'),`"${preview.sha256}"`);
  await writeFile(sidecar,JSON.stringify({version:1,items:{[item.id]:{originalSha256:'outdated-source',object:preview}}}));
  assert.equal((await fetch(url)).headers.get('etag'),`"${item.thumbnail.sha256}"`);
  assert.equal((await fetch(base+'/api/reference-library/items/face:f001/original')).headers.get('etag'),`"${item.original.sha256}"`);
});
