import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planXImages, prepareXImages } from '../lib/x-cos-archive.js';
import { loadArchiveForUpload, uploadXArchive } from '../lib/x-cos-upload.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=','base64');
const target={bucket:'omnihub-media-1319495021',region:'ap-hongkong'};
async function fixture() {
  const directory=await mkdtemp(path.join(os.tmpdir(),'x-cos-upload-'));
  const plan=planXImages([{id:1,external_id:'123',visibility:'private',status:'pending',media:[{type:'photo',url:'https://pbs.twimg.com/media/example.png'}]}]);
  await prepareXImages(plan,directory,{fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  return directory;
}

test('uploads only manifest objects privately, verifies metadata, and resumes without overwrite',async()=>{
  const directory=await fixture(),objects=new Map();let puts=0;
  try {
    const cos={
      headObject:async({Key})=>{if(!objects.has(Key))throw {statusCode:403};return objects.get(Key);},
      putObject:async p=>{
        puts++;assert.equal(p.ACL,'private');assert.equal(p.ServerSideEncryption,'AES256');
        assert.equal(p.Headers['x-cos-forbid-overwrite'],'true');assert.ok(p.Key.startsWith('x-bookmarks/'));
        objects.set(p.Key,{headers:{'content-length':String(p.Body.length),'x-cos-meta-sha256':p['x-cos-meta-sha256'],'x-cos-server-side-encryption':'AES256'}});
      },
    };
    const first=await uploadXArchive(directory,{...target,cos});assert.equal(first.uploaded,2);assert.equal(first.mediaObjects,1);
    assert.match(first.manifestKey,/^x-bookmarks\/manifests\/[a-f0-9]{64}\.json$/);
    const second=await uploadXArchive(directory,{...target,cos});assert.equal(second.skipped,2);assert.equal(puts,2);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('fails closed for another bucket, corrupt local file, or mismatched remote object',async()=>{
  const directory=await fixture();let puts=0;
  try {
    const cos={headObject:async()=>({headers:{}}),putObject:async()=>{puts++;}};
    await assert.rejects(uploadXArchive('',{...target,cos}),/absolute_archive_required/);
    await assert.rejects(uploadXArchive(directory,{...target,bucket:'another',cos}),/unexpected_cos_target/);
    await assert.rejects(uploadXArchive(directory,{...target,cos}),/cos_existing_object_mismatch/);
    assert.equal(puts,0);
    const archive=await loadArchiveForUpload(directory);
    await writeFile(path.join(directory,archive.objects[0].key),'bad');
    await assert.rejects(loadArchiveForUpload(directory),/local_checksum_mismatch/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('rejects escaped object keys before any COS request',async()=>{
  const directory=await fixture();
  try {
    const file=path.join(directory,'x-bookmarks/manifests/media-index.json');
    const manifest=JSON.parse(await readFile(file));manifest.items[0].key='../private-file';
    await writeFile(file,JSON.stringify(manifest));
    await assert.rejects(loadArchiveForUpload(directory),/invalid_manifest_object/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
