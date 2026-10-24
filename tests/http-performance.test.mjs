import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createStaticHandler} from '../lib/http-static.js';
import {sendJson,acceptsGzip} from '../lib/http-response.js';

test('gzip negotiation respects explicit refusal',()=>{
  assert.equal(acceptsGzip('br, gzip'),true);
  assert.equal(acceptsGzip('gzip;q=0, *;q=1'),false);
  assert.equal(acceptsGzip('br'),false);
  assert.equal(acceptsGzip('*;q=0.5'),true);
});
test('immutable static caching, revalidation and compression preserve private API boundaries',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'omnihub-http-'));
  const version='/assets/build-0123456789abcdef';
  const content='const value = "compressible";\n'.repeat(200);
  await mkdir(path.join(root,version),{recursive:true});
  await writeFile(path.join(root,version,'app.js'),content);
  await writeFile(path.join(root,'index.html'),'<html>'+content+'</html>');
  const serve=createStaticHandler(root);
  const server=http.createServer((req,res)=>req.url.startsWith('/api/')
    ? sendJson(req,res,200,{text:content}) : serve(req,res,req.url));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(url,headers={},method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,headers,method},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
  });
  try {
    const plain=await request(version+'/app.js');
    assert.match(plain.headers['cache-control'],/max-age=31536000, immutable/);
    const zipped=await request(version+'/app.js',{'Accept-Encoding':'gzip'});
    assert.equal(zipped.headers['content-encoding'],'gzip');
    assert.equal(gunzipSync(zipped.body).toString(),content);
    assert.ok(zipped.body.length<plain.body.length/4);
    assert.equal(zipped.headers.vary,'Accept-Encoding');
    assert.equal((await request('/')).headers['cache-control'],'no-cache');
    const hit=await request(version+'/app.js',{'If-None-Match':plain.headers.etag});
    assert.equal(hit.status,304);assert.equal(hit.body.length,0);
    assert.equal((await request(version+'/app.js',{'If-None-Match':'"stale"','If-Modified-Since':plain.headers['last-modified']})).status,200);
    assert.equal((await request(version+'/app.js',{},'HEAD')).body.length,0);
    assert.equal((await request(version+'/app.js',{},'POST')).status,405);
    const guest=await request('/api/repositories',{'Accept-Encoding':'gzip'});
    assert.equal(guest.headers['content-encoding'],'gzip');assert.equal(guest.headers['cache-control'],'no-store');
    for(const headers of [{Cookie:'session=owner'}, {Authorization:'Bearer example'}]) {
      const privateResponse=await request('/api/repositories',{'Accept-Encoding':'gzip',...headers});
      assert.equal(privateResponse.headers['content-encoding'],undefined);assert.equal(privateResponse.headers['cache-control'],'no-store');
    }
    const auth=await request('/api/me',{'Accept-Encoding':'gzip'});
    assert.equal(auth.headers['content-encoding'],undefined);assert.equal(auth.headers['cache-control'],'no-store');
  } finally { await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true}); }
});
