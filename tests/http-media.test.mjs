import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createServer} from 'node:http';
import {serveLocalMedia} from '../lib/http-media.js';
test('private revalidation preserves auth, HEAD, suffix ranges and If-Range semantics',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'http-media-')),file=path.join(dir,'video');await writeFile(file,'0123456789');
 const server=createServer(async(req,res)=>{if(req.headers.cookie!=='owner'){res.writeHead(401);res.end();return;}await serveLocalMedia(req,res,file,{contentType:'video/mp4',etag:'"version1"'});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});const url=`http://127.0.0.1:${server.address().port}`;
 const req=(headers={},method='GET')=>fetch(url,{method,headers:{Cookie:'owner',...headers}});
 let r=await req();assert.equal(await r.text(),'0123456789');assert.match(r.headers.get('cache-control'),/private.*no-cache/);
 r=await req({'If-None-Match':'W/"version1"'});assert.equal(r.status,304);assert.equal(await r.text(),'');
 r=await fetch(url,{headers:{'If-None-Match':'"version1"'}});assert.equal(r.status,401);
 r=await req({Range:'bytes=-3'});assert.equal(r.status,206);assert.equal(await r.text(),'789');
 r=await req({Range:'bytes=0-2','If-Range':'"version1"'});assert.equal(await r.text(),'012');
 r=await req({Range:'bytes=0-2','If-Range':'"older"'});assert.equal(r.status,200);assert.equal(await r.text(),'0123456789');
 for(const range of ['bytes=-0','bytes=20-','bytes=0-1,4-5','bytes=9007199254740992-']){r=await req({Range:range});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */10');}
 r=await req({},'HEAD');assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'10');assert.equal(await r.text(),'');
});
