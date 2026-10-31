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
  const corrupted = createReferenceStorage({ directory: w.archive, cos: { async getObject() { return { Body: Buffer.alloc(png.length) }; } } });
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
