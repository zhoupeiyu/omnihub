import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,stat} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import os from 'node:os';import {createMediaPreviewer} from '../lib/media-preview.js';
const exec=promisify(execFile);
test('large artwork is resized once and invalidates when source changes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'media-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source.png');
 await exec('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(1600,1200),"blue").save(sys.argv[1])',source]);
 const c=createMediaPreviewer(dir);const [a,b]=await Promise.all([c.preview(source),c.preview(source)]);assert.equal(a,b);
 const info=JSON.parse((await exec('python3',['-c','from PIL import Image;import sys,json;im=Image.open(sys.argv[1]);print(json.dumps([im.format,*im.size]))',a])).stdout);assert.deepEqual(info,['WEBP',800,600]);
 assert((await stat(a)).size<(await stat(source)).size);assert.equal(await c.preview(source),a);
 await exec('python3',['-c','from PIL import Image;import sys;Image.new("RGB",(1200,1600),"red").save(sys.argv[1])',source]);assert.notEqual(await c.preview(source),a);
});
