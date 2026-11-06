import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenListService, createOpenListTransport, createOpenListHandler, coursePath } from '../lib/openlist.js';
import { createDriveIndex, DRIVE_COLLECTIONS } from '../lib/openlist-library.js';
import { createUserAccessStore } from '../lib/user-access.js';

test('OpenList binding scopes files, encrypts secrets, streams Range without disk writes',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'openlist-test-'));
  const db=new DatabaseSync(':memory:');
  const token='test-private-token'; let origin; let mediaAuth; let qrPending=false; let authorized=false; let listRequests=0;
  const source=http.createServer(async(req,res)=>{
    if(req.url==='/p/lesson.mp4') { mediaAuth=req.headers.authorization;res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 2-5/10','Content-Length':4,'Accept-Ranges':'bytes'});res.end('2345');return; }
    if(req.headers.authorization!==token){res.writeHead(401);res.end();return;}
    if(req.url==='/api/admin/storage/list') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data:{content:[{id:2,mount_path:'/夸克网盘',driver:'QuarkTV',addition:'{}',status:authorized ? 'work':qrPending ? '<img src="data:image/png;base64,YWJj">':'refresh token is empty'}]}}));return;}
    if(req.url==='/api/admin/storage/disable?id=2' || req.url==='/api/admin/storage/enable?id=2') {authorized=req.url.includes('/enable?');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data:null}));return;}
    if(req.url==='/api/admin/storage/disable' || req.url==='/api/admin/storage/enable') {res.end(JSON.stringify({code:500}));return;}
    if(req.url==='/api/admin/storage/update') {qrPending=true;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:500,message:'need verify'}));return;}
    if(req.url==='/api/fs/list')listRequests++;
    let body='';for await(const c of req)body+=c;const input=JSON.parse(body);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({code:200,data:req.url==='/api/fs/get'?{raw_url:'https://public.invalid/p/lesson.mp4',is_dir:false}:{total:1,content:input.path?.endsWith('/wrapper')||input.path?.endsWith('/wrapper/1')?[{name:'1',is_dir:true,size:0}]:[{name:'lesson.mp4',is_dir:false,size:10}]}}));
  });
  await new Promise(r=>source.listen(0,'127.0.0.1',r)); origin='http://127.0.0.1:'+source.address().port;
  const service=createOpenListService({db,directory,internalOrigins:[origin]});
  const server=http.createServer(async(req,res)=>{try{await service.stream(1,'/courses/lesson.mp4',req,res);}catch(e){res.writeHead(e.status||500);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{source.closeAllConnections();source.close();server.closeAllConnections();server.close();db.close();rmSync(directory,{recursive:true,force:true});});
  await service.save(1,{baseUrl:origin,token,root:'/courses'});
  assert.equal(service.status(1).hasToken,true);assert.equal(JSON.stringify(service.status(1)).includes(token),false);
  assert.equal(db.prepare('select secret from openlist_connections').get().secret.includes(token),false);
  assert.equal((await service.courses(1)).items[0].path,'/courses/lesson.mp4');
  await assert.rejects(()=>service.courses(2),/先绑定/);
  await assert.rejects(()=>service.courses(1,'/courses-other'),/只能访问/);
  await assert.rejects(()=>service.save(1,{baseUrl:origin+'/other',root:'/courses'}),/令牌/);
  const outline=await service.libraryOutline(1,'/夸克网盘/30-课程教程/wrapper');
  assert.equal(outline.collapsed.length,2);assert.equal(outline.items[0].kind,'video');
  await assert.rejects(()=>service.libraryOutline(1,'/夸克网盘/private'),/未映射/);
  const coverPath='/夸克网盘/30-课程教程/wrapper/1/1/lesson.mp4';
  assert.ok(db.prepare('SELECT 1 FROM drive_index WHERE user_id=? AND path=?').get(1,coverPath));
  const coverDir=path.join(directory,'drive-covers','1');mkdirSync(coverDir,{recursive:true});
  writeFileSync(path.join(coverDir,createHash('sha256').update(coverPath).digest('hex').slice(0,16)+'.jpg'),'test-cover');
  assert.equal(service.libraryCover(1,coverPath).toString(),'test-cover');
  writeFileSync(path.join(coverDir,'manifest.json'),JSON.stringify([{path:'/夸克网盘/30-课程教程/wrapper',name:'wrapper',kind:'video'},{path:coverPath,name:'lesson.mp4',kind:'video'}]));
  assert.equal(new URL(service.librarySearch(1,'lesson').items[0].coverUrl,'http://localhost').searchParams.get('path'),coverPath);
  assert.throws(()=>service.libraryCover(1,'/夸克网盘/30-课程教程/../private'),/无效/);
  await service.save(2,{baseUrl:origin,token,root:'/courses'});
  assert.throws(()=>service.libraryCover(2,coverPath),/不存在/);
  const before=readdirSync(directory);const result=await fetch('http://127.0.0.1:'+server.address().port,{headers:{Range:'bytes=2-5'}});
  assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 2-5/10');assert.equal(result.headers.get('x-accel-buffering'),'no');assert.match(result.headers.get('cache-control'),/no-store/);assert.equal(await result.text(),'2345');assert.equal(mediaAuth,undefined);assert.deepEqual(readdirSync(directory),before);
  assert.equal(readFileSync(path.join(directory,'openlist.key')).length,32);
  await service.save(1,{baseUrl:origin,token:'',root:'/courses'});
  assert.deepEqual(await service.quark(1,'connect'),{ready:false,qr:'data:image/png;base64,YWJj'});
  assert.equal((await service.quark(1,'confirm')).ready,true);
  const requestsBefore=listRequests;
  assert.equal((await service.libraryCatalog(1)).collections.length,DRIVE_COLLECTIONS.length);
  assert.equal(listRequests-requestsBefore,DRIVE_COLLECTIONS.length);
  const markRoot=db.prepare("INSERT INTO drive_scan_dirs(user_id,path,state) VALUES (?,?,'done')");
  for(const c of DRIVE_COLLECTIONS)markRoot.run(1,c.root);
  const requestsAfter=listRequests;
  assert.equal((await service.libraryCatalog(1)).collections.length,DRIVE_COLLECTIONS.length);
  assert.equal(listRequests,requestsAfter,'indexed catalog must not wait for cloud listings');
  service.disconnect(1);assert.equal(service.status(1).connected,false);
});

test('unsafe paths, private endpoints and credential redirects are rejected',async t=>{
  for(const p of ['/courses/../private','/courses/./x','relative','/x\\y','/x\n'])assert.throws(()=>coursePath(p));
  await assert.rejects(()=>createOpenListTransport()('http://127.0.0.1:1234'),/HTTPS/);
  await assert.rejects(()=>createOpenListTransport()('https://127.0.0.1:1234'),/不允许/);
  const s=http.createServer((req,res)=>{res.writeHead(302,{Location:'/other'});res.end();});
  await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});
  const origin='http://127.0.0.1:'+s.address().port;
  await assert.rejects(()=>createOpenListTransport({internalOrigins:[origin]})(origin,{headers:{Authorization:'secret'}}),/重定向/);
});

test('shared library handler scopes graph, source, Range and progress to a permitted viewer',async t=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'openlist-access-')),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT "now")');
 db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(1,'zane');db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(2,'reader');
 const source=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data:{total:0,content:[]}}));});
 await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${source.address().port}`;
 const service=createOpenListService({db,directory,internalOrigins:[origin]}),access=createUserAccessStore(db),courses=DRIVE_COLLECTIONS[0].root,materials=DRIVE_COLLECTIONS[1].root,title='同名课程合集';
 await service.save(1,{baseUrl:origin,token:'private',root:'/'});
 const index=createDriveIndex(db);
 index.remember(1,{path:courses,items:[{name:title,path:courses+'/'+title,isDir:true}]});index.remember(1,{path:courses+'/'+title,items:[]});
 index.remember(1,{path:materials,items:[{name:title,path:materials+'/'+title,isDir:true}]});index.remember(1,{path:materials+'/'+title,items:[{name:'01.mp4',path:materials+'/'+title+'/01.mp4',isDir:false}]});
 const reader={id:2,username:'reader'},admin={id:1,username:'zane'};access.update(2,{driveCategories:['courses'],tools:['media','markdown']},0);
 const readBody=req=>new Promise((resolve,reject)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{try{resolve(text?JSON.parse(text):{});}catch(error){reject(error);}});req.on('error',reject);});
 const send=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));return true;};
 const handler=createOpenListHandler({service,getUser:req=>req.headers['x-user']==='zane'?admin:reader,access,ownerName:'zane',readBody,send});
 const server=http.createServer(async(req,res)=>{try{await handler(req,res,new URL(req.url,'http://localhost').pathname);}catch(error){res.writeHead(error.status||500);res.end(error.message);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 t.after(()=>{server.closeAllConnections();server.close();source.closeAllConnections();source.close();db.close();rmSync(directory,{recursive:true,force:true});});
 const course=await fetch(`${base}/api/openlist/library/course?path=${encodeURIComponent(courses+'/'+title)}`,{headers:{'x-user':'reader'}});assert.equal(course.status,200);const payload=await course.json();assert.deepEqual(payload.sources.map(item=>item.path),[courses+'/'+title]);assert.equal(payload.files.length,0);
 const deniedSource=await fetch(`${base}/api/openlist/library/course?path=${encodeURIComponent(courses+'/'+title)}&source=${encodeURIComponent(materials+'/'+title)}`,{headers:{'x-user':'reader'}});assert.equal(deniedSource.status,403);
 const deniedRange=await fetch(`${base}/api/openlist/file?path=${encodeURIComponent(materials+'/'+title+'/01.mp4')}`,{method:'HEAD',headers:{'x-user':'reader',Range:'bytes=0-1'}});assert.equal(deniedRange.status,403);
 const progress=await fetch(`${base}/api/openlist/library/progress`,{method:'POST',headers:{'x-user':'reader','Content-Type':'application/json'},body:JSON.stringify({path:courses+'/'+title+'/01.mp4',position:3,duration:10})});assert.equal(progress.status,200);
 assert.equal(index.position(2,courses+'/'+title+'/01.mp4').position,3);assert.equal(index.position(1,courses+'/'+title+'/01.mp4').position,0);assert.equal(access.revision(reader),1);
 access.update(2,{driveCategories:[],tools:['media','markdown']},1);
 const catalog=await fetch(`${base}/api/openlist/library`,{headers:{'x-user':'reader'}});assert.equal(catalog.status,200);const catalogPayload=await catalog.json();assert.deepEqual(catalogPayload.collections,[]);assert.deepEqual(catalogPayload.recent,[]);
 const revoked=await fetch(`${base}/api/openlist/library/course?path=${encodeURIComponent(courses+'/'+title)}`,{headers:{'x-user':'reader'}});assert.equal(revoked.status,403);
});
