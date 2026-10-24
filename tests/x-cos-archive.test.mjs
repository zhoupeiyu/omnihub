import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planXImages, prepareXImages, xImageUrl } from '../lib/x-cos-archive.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=', 'base64');
const url = 'https://pbs.twimg.com/media/test?format=png&name=orig';
const row = (visibility='public') => ({ id: 1, external_id: '123', visibility, status: 'pending', media: [{type:'photo', url}] });

test('restricts downloads to X image paths and keeps visibility of each reference', () => {
  for (const raw of ['http://pbs.twimg.com/media/a', 'https://pbs.twimg.com.evil/media/a','https://user@pbs.twimg.com/media/a','https://pbs.twimg.com:444/media/a','https://video.twimg.com/media/a','https://pbs.twimg.com/other/a']) assert.equal(xImageUrl(raw), '');
  const plan=planXImages([row(),{...row('private'),id:2}]);
  assert.equal(plan.items.length,1);
  assert.deepEqual(plan.items[0].references.map(r=>r.visibility),['public','private']);
  assert.equal(planXImages([{media:null},{media:''}]).rejected,0);
});

test('deduplicates concurrent content writes and applies the same capacity rule on resume', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'x-cos-test-'));
  try {
    const plan=planXImages([row(),{...row(),id:2,media:[{type:'photo',url:url.replace('test','other')}]}]);
    const result=await prepareXImages(plan,dir,{fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
    assert.equal(result.prepared,2);assert.equal(result.uniqueObjects,1);assert.equal(result.bytes,png.length);
    const manifest=JSON.parse(await readFile(path.join(dir,'x-bookmarks/manifests/media-index.json')));
    assert.equal(manifest.items[0].key,manifest.items[1].key);
    assert.deepEqual(await readFile(path.join(dir,manifest.items[0].key)),png);
    const resumed=await prepareXImages(plan,dir,{maxTotalBytes:1,fetchImpl:async()=>{throw new Error('must not download');}});
    assert.equal(resumed.failed,2);assert.equal(resumed.bytes,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('holds the lock until all started workers settle after a fatal error', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'x-cos-test-'));
  let release, started;
  const blocked=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  try {
    const plan=planXImages([row()]);plan.items.push({id:'invalid',sourceUrl:url,references:[]});
    const run=prepareXImages(plan,dir,{fetchImpl:async()=>{started();await blocked;return new Response(png,{headers:{'content-type':'image/png'}});}});
    const rejected=assert.rejects(run,/invalid_plan/);
    await ready;await access(path.join(dir,'prepare.lock'));
    await assert.rejects(prepareXImages(plan,dir),{code:'EEXIST'});
    release();await rejected;
    await assert.rejects(access(path.join(dir,'prepare.lock')),{code:'ENOENT'});
  } finally {release();await rm(dir,{recursive:true,force:true});}
});

test('archives images by checksum, falls back from orig to large, and resumes without refetch', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'x-cos-test-'));let calls=0;
  try {
    const plan=planXImages([row()]);
    const fetchImpl=async(raw,options)=>{calls++;assert.equal(options.redirect,'error');return raw.includes('name=orig')?new Response(null,{status:404}):new Response(png,{headers:{'content-type':'image/png'}});};
    const first=await prepareXImages(plan,dir,{fetchImpl});assert.equal(first.prepared,1);assert.equal(first.bytes,png.length);
    const manifest=JSON.parse(await readFile(path.join(dir,'x-bookmarks/manifests/media-index.json')));
    assert.equal(manifest.items[0].sourceUrl,url);assert.match(manifest.items[0].downloadUrl,/name=large/);
    assert.deepEqual(await readFile(path.join(dir,manifest.items[0].key)),png);
    await prepareXImages(plan,dir,{fetchImpl});assert.equal(calls,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('records oversize, invalid bytes, and archive quota failures without publishing URLs', async () => {
  for (const kind of ['oversize','invalid','quota']) {
    const dir=await mkdtemp(path.join(os.tmpdir(),'x-cos-test-'));
    try {
      const options={fetchImpl:async()=>new Response(kind==='invalid'?'not an image':png,{headers:{'content-type':'image/png'}})};
      if(kind==='oversize')options.maxImageBytes=5;if(kind==='quota')options.maxTotalBytes=5;
      const result=await prepareXImages(planXImages([row()]),dir,options);assert.equal(result.failed,1);assert.equal(result.prepared,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
});
