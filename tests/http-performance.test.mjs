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
    for (const path of [
      '/api/inbox', '/api/inbox/42', '/api/inbox/list',
      '/api/repositories', '/api/repositories/openai/skills',
      '/api/knowledge-library', '/api/knowledge-library/manual-knowledge-42',
      '/api/prompt-library',
    ]) {
      const response=await request(path,{'Accept-Encoding':'gzip',Cookie:'session=owner'});
      assert.equal(response.headers['content-encoding'],'gzip',path);
      assert.equal(response.headers['cache-control'],'no-store',path);
      assert.equal(response.headers.vary,'Accept-Encoding',path);
      assert.equal(JSON.parse(gunzipSync(response.body).toString()).text,content,path);
    }
    const qZero=await request('/api/inbox',{'Accept-Encoding':'br, gzip;q=0',Cookie:'session=owner'});
    assert.equal(qZero.headers['content-encoding'],undefined);
    assert.equal(qZero.headers.vary,'Accept-Encoding');
    for (const [path, method] of [['/api/inbox','POST'],['/api/account/connections','GET'],['/api/me','GET']]) {
      const response=await request(path,{'Accept-Encoding':'gzip',Cookie:'session=owner'},method);
      assert.equal(response.headers['content-encoding'],undefined,`${method} ${path}`);
      assert.equal(response.headers['cache-control'],'no-store',`${method} ${path}`);
      assert.equal(response.headers.vary,undefined,`${method} ${path}`);
    }
  } finally { await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true}); }
});
