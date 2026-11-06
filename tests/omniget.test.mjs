import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, chmod, access, utimes, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateOmnigetUrl, parseOmnigetOutput, classifyOmnigetFailure, normalizeOmnigetDownloadOptions, buildOmnigetRunnerArgs, createOmnigetHandler } from '../lib/omniget.js';
import { createOmnigetQueue } from '../lib/omniget-queue.js';
test('allows only exact public platform hosts and one-item routes',()=>{
  assert.equal(validateOmnigetUrl('https://www.bilibili.com/video/BV123'), 'https://www.bilibili.com/video/BV123');
  assert.equal(validateOmnigetUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(validateOmnigetUrl('https://www.youtube.com/watch?v=abc&utm_source=tracker'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(validateOmnigetUrl('https://www.bilibili.com/video/BV123?spm_id_from=333.1'), 'https://www.bilibili.com/video/BV123');
  assert.equal(validateOmnigetUrl('https://x.com/someone/status/123'), 'https://x.com/someone/status/123');
  for(const u of ['http://youtu.be/abc','https://youtube.com.evil.org/watch?v=x','https://evil.youtube.com/watch?v=x','https://a:b@youtube.com/watch?v=x','https://youtube.com/watch?v=x&list=y','https://youtube.com/watch','https://127.0.0.1/video/x','https://youtube.com/channel/foo','https://youtube.com:8080/watch?v=x','https://x.com/explore'])assert.throws(()=>validateOmnigetUrl(u));
});
test('handles malformed upstream progress without accepting missing completion',()=>{
  assert.equal(parseOmnigetOutput('{"downloaded":Some(12)}\n{"type":"complete","success":true,"file_path":"/tmp/x"}', 'download').file_path,'/tmp/x');
  assert.throws(()=>parseOmnigetOutput('{"downloaded":None}','download'));
});
test('only maps the confirmed Bilibili extractor signature to an access rejection',()=>{
  const bilibili=classifyOmnigetFailure('Error: bilibili extractor failed first: Failed to access the page. Check the link and your connection.; generic fallback also failed','https://www.bilibili.com/video/BV1GJ411x7h7');
  assert.equal(bilibili.status,422);assert.equal(bilibili.message,'B站当前拒绝服务器解析请求，请稍后重试或使用平台允许的下载方式');
  assert.equal(classifyOmnigetFailure('Failed to access the page','https://www.bilibili.com/video/BV1GJ411x7h7').status,502);
});
test('normalizes only bounded download preferences and builds safe runner arguments',()=>{
  assert.deepEqual(normalizeOmnigetDownloadOptions({}),{quality:720,format:'mp4',audioOnly:false});
  assert.deepEqual(normalizeOmnigetDownloadOptions({quality:1080,format:'webm',audioOnly:false}),{quality:1080,format:'webm',audioOnly:false});
  assert.deepEqual(normalizeOmnigetDownloadOptions({audioOnly:true}),{audioOnly:true});
  for(const input of [{quality:2160},{format:'avi'},{audioOnly:'true'},{audioOnly:true,format:'mp4'},{subs:true}])assert.throws(()=>normalizeOmnigetDownloadOptions(input));
  const job={url:'https://youtu.be/example',options:{quality:480,format:'mkv',audioOnly:false}};
  assert.deepEqual(buildOmnigetRunnerArgs('download',job,'/var/lib/omnihub-omniget/id'),['download','https://youtu.be/example','/var/lib/omnihub-omniget/id','480','mkv','0']);
  assert.deepEqual(buildOmnigetRunnerArgs('download',{url:job.url,options:{audioOnly:true}},'/var/lib/omnihub-omniget/id'),['download','https://youtu.be/example','/var/lib/omnihub-omniget/id','','','1']);
});
test('requires auth, same origin and ownership, then serves a bounded result',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-test-'));
  let downloadCalls=0;
  const handler=createOmnigetHandler({directory:root,origin:'http://localhost',getUser:r=>r.headers['x-user']?{id:r.headers['x-user']}:null,runImpl:async(mode,j,dir)=>{
    if(mode==='info')return{title:'Example',platform:'youtube',duration:3};
    downloadCalls++;
    await mkdir(dir,{recursive:true});const file=path.join(dir,'clip.mp4');await writeFile(file,'test media');return{file_path:file};
  }});
  const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(url,method='GET',user='one',body)=>fetch(base+url,{method,headers:{'x-user':user,Origin:'http://localhost','Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  assert.equal((await call('/api/omniget/status','GET','')).status,401);
  const status=await (await call('/api/omniget/status')).json();
  assert.deepEqual(status.capabilities,{qualities:[360,480,720,1080],videoFormats:['mp4','webm','mkv'],audioOnly:true,subtitles:false});
  assert.equal((await fetch(base+'/api/omniget/jobs',{method:'POST',headers:{'x-user':'one'},body:'{}'})).status,403);
  const response=await call('/api/omniget/jobs','POST','one',{url:'https://youtu.be/example'});assert.equal(response.status,202);const j=await response.json();
  assert.equal((await call(`/api/omniget/jobs/${j.id}`,'GET','two')).status,404);
  assert.equal((await call(`/api/omniget/jobs/${j.id}`)).status,200);
  const downloads=await Promise.all([
    call(`/api/omniget/jobs/${j.id}/download`,'POST','one',{quality:480,format:'mp4',audioOnly:false}),
    call(`/api/omniget/jobs/${j.id}/download`,'POST','one',{quality:480,format:'mp4',audioOnly:false})
  ]);
  assert.deepEqual(downloads.map(response=>response.status).sort(),[202,409]);
  const downloading=downloads.find(response=>response.status===202);assert.deepEqual((await downloading.json()).options,{quality:480,format:'mp4',audioOnly:false});
  let result;for(let n=0;n<20;n++){result=await(await call(`/api/omniget/jobs/${j.id}`)).json();if(result.status==='ready')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'ready');assert.equal(downloadCalls,1);assert.equal((await call(result.downloadUrl,'GET','two')).status,404);const file=await call(result.downloadUrl);assert.equal(file.headers.get('content-type'),'video/mp4');assert.equal(await file.text(),'test media');
});
test('does not terminate an info job when the isolated tool creates HOME state',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-runner-test-'));
  const runner=path.join(root,'fake-runner.sh');
  await writeFile(runner,'#!/bin/sh\nmkdir -p "$3/cache"\nsleep 1\nprintf \'{"title":"Works","platform":"generic","duration":1}\\n\'\n');
  await chmod(runner,0o700);
  const handler=createOmnigetHandler({directory:path.join(root,'jobs'),origin:'http://localhost',runner,getUser:()=>({id:'one'})});
  const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/omniget/jobs',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({url:'https://youtu.be/example'})});
  assert.equal(response.status,202);const {id}=await response.json();
  let result;for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,100));result=await(await fetch(base+`/api/omniget/jobs/${id}`)).json();if(result.status!=='parsing')break;}
  assert.equal(result.status,'parsed');assert.equal(result.title,'Works');
});
test('stages a user cookie only for one runner call and removes it before the job is exposed',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-cookie-runner-'));
  const fakeCookie='# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tfake-cookie-value\n';
  const consumed=[];
  const cookieStore={consumeForRunner(owner,site,callback){consumed.push({owner,site});callback(fakeCookie);return {consumed:true,site};}};
  const handler=createOmnigetHandler({directory:root,origin:'http://localhost',cookieStore,getUser:req=>req.headers['x-user']?{id:req.headers['x-user']}:null,runImpl:async(mode,job,dir)=>{
    const file=path.join(dir,'.omniget-cookie');assert.equal(await readFile(file,'utf8'),fakeCookie);assert.equal((await lstat(file)).mode&0o077,0);
    return {title:'Cookie work',platform:'youtube',duration:1};
  }});
  const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{handler.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/omniget/jobs',{method:'POST',headers:{'x-user':'cookie-owner',Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({url:'https://www.youtube.com/watch?v=abc'})});
  const job=await response.json();assert.equal(JSON.stringify(job).includes('fake-cookie-value'),false);
  let result;for(let attempt=0;attempt<20;attempt++){result=await(await fetch(base+`/api/omniget/jobs/${job.id}`,{headers:{'x-user':'cookie-owner'}})).json();if(result.status!=='parsing')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(result.status,'parsed');assert.deepEqual(consumed,[{owner:'cookie-owner',site:'youtube'}]);await assert.rejects(access(path.join(root,job.id,'.omniget-cookie')));
});
test('runner passes cookie only through a systemd credential and removes its sandbox copy',async()=>{
  const source=await readFile(new URL('../scripts/omniget-runner.sh',import.meta.url),'utf8');
  assert.match(source,/credential_prop="LoadCredential=omniget-cookie:\$credential_source"/);
  assert.match(source,/if \[ -n "\$credential_prop" \]; then\s+set -- -p "\$credential_prop" "\$@"/);
  assert.doesNotMatch(source,/--load-credential=/);
  assert.match(source,/CREDENTIALS_DIRECTORY/);
  assert.match(source,/OMNIGET_DATA_DIR=\/work/);
  assert.match(source,/rm -rf \/work\/cookies/);
  assert.doesNotMatch(source,/--cookies(?:=|\s)/);
});
test('runs an owner-isolated batch through the persistent queue and serves its manifest file',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-queue-handler-'));
  const queue=createOmnigetQueue({validateUrl:validateOmnigetUrl});
  const handler=createOmnigetHandler({directory:root,origin:'http://localhost',queue,getUser:req=>req.headers['x-user']?{id:req.headers['x-user']}:null,runImpl:async(mode,job,dir)=>{
    if(mode==='info')return {title:'Queued work',platform:'generic',duration:9};
    await mkdir(dir,{recursive:true});const file=path.join(dir,'queued.mp4');await writeFile(file,'queued media');return {file_path:file};
  }});
  const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{handler.close();queue.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(url,method='GET',user='one',body)=>fetch(base+url,{method,headers:{'x-user':user,Origin:'http://localhost','Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  const created=await call('/api/omniget/queue/batch','POST','one',{urls:['https://youtu.be/example'],quality:720,format:'mp4',audioOnly:false});
  assert.equal(created.status,202);const {jobs:[queued]}=await created.json();assert.equal(queued.state,'queued');
  assert.deepEqual(await (await call('/api/omniget/queue','GET','two')).json(),{jobs:[]});
  let job;for(let attempt=0;attempt<30;attempt++){job=await (await call(`/api/omniget/queue/${queued.id}`)).json();if(['ready','failed'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(job.state,'ready');assert.equal(job.metadata.fileName,'queued.mp4');
  const file=await call(`/api/omniget/queue/${queued.id}/file`);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'video/mp4');assert.equal(await file.text(),'queued media');
});
test('removes only acknowledged expired queue payloads',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-expiry-'));
  const id='0f0e0d0c-0b0a-4908-8706-050403020100', directory=path.join(root,id);
  await mkdir(directory);await writeFile(path.join(directory,'result.mp4'),'expired');
  let expired;
  const queue={listExpiredReady:()=>[{owner:'one',id,metadata:{expiresAt:1}}],expireReady:(owner,jobId,before)=>{expired={owner,jobId,before};return {state:'expired'};}};
  const handler=createOmnigetHandler({directory:root,queue,getUser:()=>null,runImpl:async()=>({})});
  t.after(async()=>{handler.close();await rm(root,{recursive:true,force:true});});
  await handler.cleanup();
  assert.deepEqual({owner:expired.owner,jobId:expired.jobId},{owner:'one',jobId:id});
  await assert.rejects(access(directory));
});
test('reclaims failed, cancelled and interrupted queue artifacts only after units stop',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-terminal-gc-'));
  const ids=['1f0e0d0c-0b0a-4908-8706-050403020100','2f0e0d0c-0b0a-4908-8706-050403020100','3f0e0d0c-0b0a-4908-8706-050403020100'];
  for(const id of ids){await mkdir(path.join(root,id));await writeFile(path.join(root,id,'partial.mp4'),'partial');}
  const finished=[];const queue={listExpiredReady:()=>[],claimGcTasks:()=>ids.map((id,index)=>({owner:'one',id,state:['failed','cancelled','interrupted'][index],ticket:`ticket-${id}`})),finishGc:(owner,id,ticket,result)=>{finished.push({owner,id,ticket,result});return {};}};
  const stopped=[];const handler=createOmnigetHandler({directory:root,queue,getUser:()=>null,stopQueueUnits:async id=>{stopped.push(id);return true;}});
  t.after(async()=>{handler.close();await rm(root,{recursive:true,force:true});});
  await handler.cleanup();
  assert.deepEqual(stopped.sort(),[...ids].sort());
  assert.equal(finished.every(item=>item.result.deleted===true),true);
  for(const id of ids)await assert.rejects(access(path.join(root,id)));
});
test('keeps unexpired or not-yet-stopped queue artifacts',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-gc-guard-'));
  const ready='4f0e0d0c-0b0a-4908-8706-050403020100', running='5f0e0d0c-0b0a-4908-8706-050403020100';
  for(const id of [ready,running]){await mkdir(path.join(root,id));await writeFile(path.join(root,id,'partial.mp4'),'keep');}
  const queue={listExpiredReady:()=>[],claimGcTasks:()=>[{owner:'one',id:running,state:'interrupted',ticket:'held'}],finishGc:()=>({})};
  const handler=createOmnigetHandler({directory:root,queue,getUser:()=>null,stopQueueUnits:async()=>false});
  t.after(async()=>{handler.close();await rm(root,{recursive:true,force:true});});
  await handler.cleanup();
  await access(path.join(root,ready));await access(path.join(root,running));
});
test('reclaims legacy restart orphans but rechecks queue ownership after units stop',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-legacy-gc-'));
  const old='6f0e0d0c-0b0a-4908-8706-050403020100', raced='7f0e0d0c-0b0a-4908-8706-050403020100';
  for(const id of [old,raced]){const directory=path.join(root,id);await mkdir(directory);await writeFile(path.join(directory,'partial.mp4'),'legacy');await utimes(directory,0,0);}
  let racedReads=0;
  const queue={listExpiredReady:()=>[],claimGcTasks:()=>[],hasJobId:id=>id===raced&&++racedReads>=3};
  const handler=createOmnigetHandler({directory:root,queue,getUser:()=>null,stopQueueUnits:async()=>true});
  t.after(async()=>{handler.close();await rm(root,{recursive:true,force:true});});
  await handler.cleanup();
  await assert.rejects(access(path.join(root,old)));
  await access(path.join(root,raced));
});
test('shares the two-worker and one-owner limit between legacy and queue jobs',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'omniget-shared-capacity-'));
  const queue=createOmnigetQueue({validateUrl:validateOmnigetUrl});
  const handler=createOmnigetHandler({directory:root,origin:'http://localhost',queue,getUser:req=>req.headers['x-user']?{id:req.headers['x-user']}:null,runImpl:async(mode,job,dir)=>{
    if(mode==='info'){await new Promise(resolve=>setTimeout(resolve,80));return {title:'slow',platform:'generic',duration:1};}
    await mkdir(dir,{recursive:true});const file=path.join(dir,'result.mp4');await writeFile(file,'media');return {file_path:file};
  }});
  const server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost').pathname));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{handler.close();queue.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(url,method='GET',user='one',body)=>fetch(base+url,{method,headers:{'x-user':user,Origin:'http://localhost','Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  assert.equal((await call('/api/omniget/jobs','POST','one',{url:'https://youtu.be/legacy'})).status,202);
  const added=await call('/api/omniget/queue/batch','POST','one',{urls:['https://youtu.be/queued'],quality:720,format:'mp4',audioOnly:false});assert.equal(added.status,202);const {jobs:[queued]}=await added.json();
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal((await (await call(`/api/omniget/queue/${queued.id}`)).json()).state,'queued');
  for(let attempt=0;attempt<30;attempt++){const job=await (await call(`/api/omniget/queue/${queued.id}`)).json();if(job.state==='ready')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal((await (await call(`/api/omniget/queue/${queued.id}`)).json()).state,'ready');
});
