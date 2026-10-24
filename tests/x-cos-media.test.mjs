import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createXCosMedia } from '../lib/x-cos-media.js';
import { planXImages, prepareXImages } from '../lib/x-cos-archive.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=', 'base64');
const source = 'https://pbs.twimg.com/media/fixture.png';
const id = createHash('sha256').update(source).digest('hex');
const media = [{type:'photo',url:source,alt_text:'Example'}, {type:'video',preview_image_url:source,video_url:'https://video.twimg.com/a.mp4'}];
const row = {id:1,source:'x',status:'pending',visibility:'public',media:JSON.stringify(media)};
const requestPath = `/api/x-media/1/${id}`;
async function fixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'omnihub-cos-media-'));
  try {
    await prepareXImages(planXImages([row]), directory, {fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
    await fn(directory);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
async function call(store, context = {}, options = {}) {
  const response = Object.assign(new EventEmitter(), {writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;if(!options.hold)this.emit('finish');}});
  await store.handle({method:'GET',headers:{},...options},response,options.path || requestPath,
    {getRow:()=>row,isPublic:r=>r.visibility==='public',...context});
  return response;
}

test('rewrites only archived images and posters without changing raw URLs or video playback', async()=>fixture(async directory=>{
  const store = createXCosMedia({directory});
  assert.equal(store.has(requestPath),true);
  assert.equal(store.has('/api/x-media/1/'+'0'.repeat(64)),false);
  assert.equal(store.has(requestPath+'/extra'),false);
  const result = store.rewrite(1,media);
  assert.equal(result[0].url,requestPath);assert.equal(result[1].preview_image_url,requestPath);
  assert.equal(result[1].video_url,media[1].video_url);assert.equal(media[0].url,source);
  assert.deepEqual(createXCosMedia().rewrite(1,media),media);
  assert.deepEqual(store.rewrite(1,[{type:'photo',url:'https://pbs.twimg.com/media/missing.jpg'}]),[{type:'photo',url:'https://pbs.twimg.com/media/missing.jpg'}]);
}));

test('enforces live permissions before GET, HEAD and 304; binds image to the current post', async()=>fixture(async directory=>{
  const store = createXCosMedia({directory});
  const ok = await call(store);assert.equal(ok.status,200);assert.deepEqual(ok.body,png);
  assert.equal(ok.headers['Content-Type'],'image/png');assert.match(ok.headers['Cache-Control'],/^private, no-cache/);
  assert.equal(ok.headers.Vary,'Cookie');assert.equal(ok.headers['Cross-Origin-Resource-Policy'],'same-origin');
  assert.equal((await call(store,{}, {headers:{'if-none-match':ok.headers.ETag}})).status,304);
  assert.equal((await call(store,{}, {method:'HEAD'})).body,undefined);
  for (const hidden of [{...row,visibility:'private'},{...row,visibility:'unreviewed'},{...row,status:'ignored'},null,{...row,media:'[]'},{...row,source:'manual'}]) {
    for (const method of ['GET','HEAD']) assert.equal((await call(store,{getRow:()=>hidden},{method,headers:{'if-none-match':ok.headers.ETag}})).status,404);
  }
  assert.equal((await call(store,{getRow:()=>({...row,visibility:'private'}),privateAccess:true})).status,200);
  for (const malformed of ['/api/x-media/1/../../etc/passwd',`/api/x-media/9007199254740993/${id}`,`${requestPath}/extra`]) {
    assert.equal((await call(store,{}, {path:malformed})).status,404);
  }
  assert.equal((await call(store,{}, {method:'POST'})).status,405);
}));

test('falls back to COS on a missing cache, checks checksum, and rechecks revocation after I/O', async()=>fixture(async directory=>{
  const manifest = JSON.parse(await readFile(path.join(directory,'x-bookmarks/manifests/media-index.json')));
  await rm(path.join(directory,manifest.items[0].key));
  let remoteCalls=0, visible=true;
  const store=createXCosMedia({directory,readRemote:async()=>{remoteCalls++;return png;}});
  const [a,b]=await Promise.all([call(store),call(store)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(remoteCalls,1);
  const corrupt=createXCosMedia({directory,readRemote:async()=>Buffer.from('wrong')});
  assert.equal((await call(corrupt)).status,503);
  const revoked=createXCosMedia({directory,readRemote:async()=>{visible=false;return png;}});
  assert.equal((await call(revoked,{getRow:()=>({...row,visibility:visible?'public':'private'})})).status,404);
}));

test('internal creation references require the current owned X row, source URL and manifest reference before and after I/O', async()=>fixture(async directory=>{
  const store=createXCosMedia({directory});
  const reference=await store.readReference({inboxId:1,sourceUrl:source,getOwnedRow:()=>row});
  assert.deepEqual(reference.bytes,png);assert.equal(reference.mimeType,'image/png');
  for(const invalid of [
    {inboxId:2,sourceUrl:source,getOwnedRow:()=>row},
    {inboxId:1,sourceUrl:'https://pbs.twimg.com/media/not-in-manifest.png',getOwnedRow:()=>row},
    {inboxId:1,sourceUrl:source,getOwnedRow:()=>null},
    {inboxId:1,sourceUrl:source,getOwnedRow:()=>({...row,source:'manual'})},
    {inboxId:1,sourceUrl:source,getOwnedRow:()=>({...row,media:'[]'})},
  ]) await assert.rejects(store.readReference(invalid),/x_media_reference_denied/);
  const manifest=JSON.parse(await readFile(path.join(directory,'x-bookmarks/manifests/media-index.json')));
  await rm(path.join(directory,manifest.items[0].key));
  let visible=true;
  const delayed=createXCosMedia({directory,readRemote:async()=>{visible=false;return png;}});
  await assert.rejects(delayed.readReference({inboxId:1,sourceUrl:source,getOwnedRow:()=>visible?row:{...row,media:'[]'}}),/x_media_reference_denied/);
}));

test('rejects forged manifest paths and checksums at startup', async()=>fixture(async directory=>{
  const file=path.join(directory,'x-bookmarks/manifests/media-index.json');
  const manifest=JSON.parse(await readFile(file));manifest.items[0].key='../../etc/passwd';
  await writeFile(file,JSON.stringify(manifest));assert.throws(()=>createXCosMedia({directory}),/invalid_x_media_record/);
}));

test('reserves bytes until a slow response finishes and releases a closed request only after its read settles', async()=>fixture(async directory=>{
  const store=createXCosMedia({directory,maxResponseBytes:png.length});
  const slow=await call(store,{}, {hold:true});assert.equal(slow.status,200);
  assert.equal((await call(store)).status,503);
  slow.emit('finish');slow.emit('close');
  const next=await call(store,{}, {hold:true});assert.equal(next.status,200);
  assert.equal((await call(store)).status,503);next.emit('finish');
  const alreadyClosed=Object.assign(new EventEmitter(),{destroyed:true,writeHead(){throw Error('must_not_write');},end(){throw Error('must_not_write');}});
  assert.equal(await store.handle({method:'GET',headers:{}},alreadyClosed,requestPath,{getRow:()=>row,isPublic:()=>true}),true);
  assert.equal((await call(store)).status,200);
  const manifest=JSON.parse(await readFile(path.join(directory,'x-bookmarks/manifests/media-index.json')));
  await rm(path.join(directory,manifest.items[0].key));
  let resume,started;
  const pending=new Promise(r=>{resume=r;}), ready=new Promise(r=>{started=r;});
  const blocked=createXCosMedia({directory,maxResponseBytes:png.length,readRemote:async()=>{started();await pending;return png;}});
  const res=Object.assign(new EventEmitter(),{writeHead(){},end(){this.emit('finish');}});
  const run=blocked.handle({method:'GET',headers:{}},res,requestPath,{getRow:()=>row,isPublic:()=>true});
  await ready;res.destroyed=true;res.emit('close');
  assert.equal((await call(blocked)).status,503);
  resume();await run;assert.equal((await call(blocked)).status,200);
}));

test('both frontend galleries accept only the precise same-origin archive route', async()=>{
  for (const [file,start,end,name] of [
    ['public/inbox.jsx','function inboxMedia(', '\nfunction inboxThumbnailUrl(', 'inboxMedia'],
    ['public/prompts.jsx','function getPromptMedia(', '\nfunction getPromptAssetScore(', 'getPromptMedia'],
  ]) {
    const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    const snippet=source.slice(source.indexOf(start),source.indexOf(end));
    const context={URL,window:{location:{origin:'http://localhost:4320'}},inboxJson:v=>v};vm.createContext(context);
    vm.runInContext(`${snippet}; this.parse=${name}`,context);
    assert.equal(context.parse({media:[{type:'photo',url:requestPath}]}).length,1);
    assert.equal(context.parse({media:[{type:'photo',url:requestPath} ]})[0].url,`http://localhost:4320${requestPath}`);
    for (const url of ['/api/me','//evil.test/a','javascript:alert(1)','http://evil.test/a']) assert.equal(context.parse({media:[{type:'photo',url}]}).length,0);
  }
});
