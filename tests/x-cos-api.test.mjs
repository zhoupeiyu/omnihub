import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { prepareXImages, planXImages } from '../lib/x-cos-archive.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('real API serves archived public/prompt images, authenticates private media, preserves source data',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'omnihub-cos-api-'));
  const archive=path.join(directory,'archive');
  const url='https://pbs.twimg.com/media/test.png';
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=','base64');
  let child,db;
  try {
    await prepareXImages(planXImages([{id:1,media:[{type:'photo',url}]}]),archive,{fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
    const setup=`
      import {db} from './lib/db.js';
      import {replacePromptRefinements} from './lib/knowledge-store.js';
      db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES (1,'zane','unused','unused'),(2,'viewer','unused','unused')").run();
      db.prepare("INSERT INTO sessions(token,user_id) VALUES ('fixture-owner-session',1),('fixture-viewer-session',2)").run();
      for(const [id,visibility,user] of [[1,'public',1],[2,'private',1],[3,'unreviewed',1],[4,'public',2]])
        db.prepare("INSERT INTO inbox(id,user_id,source,external_id,url,title,content,media,visibility) VALUES (?,?,'x',?,?, 'Test','Prompt text',?,?)")
          .run(id,user,String(id),'https://x.com/a/status/'+id,JSON.stringify([{type:'photo',url:${JSON.stringify(url)}}]),visibility);
      replacePromptRefinements(1,[{externalId:'1',source:{title:'Image prompt',content:'Full prompt',media:[]},
        facets:{kind:{value:'image_generation'},completeness:{value:'full_prompt'},subject:{value:'female_character'},scenario:{value:'portrait'},style:{value:'realistic'}}}]);
      db.close();`;
    const env={...process.env,OMNIHUB_DATA_DIR:directory,OMNIHUB_X_MEDIA_ARCHIVE:archive,OMNIHUB_CONTENT_WORKER:'false',OMNIHUB_X_WATCH_ENABLED:'false',OMNIHUB_MEDIA_WORKER:'false'};
    execFileSync(process.execPath,['--input-type=module','-e',setup],{cwd:root,env,stdio:'pipe'});
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
    child=spawn(process.execPath,['server.js'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>{stderr+=b;});
    const request=(route,options={})=>fetch(`http://127.0.0.1:${port}${route}`,options);
    let ready=false;for(let i=0;i<80;i++){try{if((await request('/')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,25));}
    assert.ok(ready,stderr);
    db=new DatabaseSync(path.join(directory,'app.db'));
    const bookmarks=await (await request('/api/x-bookmarks')).json();assert.equal(bookmarks.length,1);
    const mediaUrl=JSON.parse(bookmarks[0].media)[0].url;assert.match(mediaUrl,/^\/api\/x-media\/1\//);
    const prompts=await(await request('/api/prompt-library')).json();assert.equal(prompts.length,1);assert.equal(prompts[0].media[0].url,mediaUrl);
    const image=await request(mediaUrl);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    const etag=image.headers.get('etag');
    const owner={Cookie:'omnihub_session=fixture-owner-session'},guest={Cookie:'omnihub_session=fixture-viewer-session'};
    for (const id of [2,3,4]) assert.equal((await request(mediaUrl.replace('/1/',`/${id}/`))).status,404);
    assert.equal((await request(mediaUrl.replace('/1/','/2/'),{headers:guest})).status,404);
    assert.equal((await request(mediaUrl.replace('/1/','/2/'),{headers:owner})).status,200);
    assert.equal((await request(mediaUrl.replace('/1/','/4/'),{headers:owner})).status,404);
    const inbox=await(await request('/api/inbox/2',{headers:owner})).json();assert.match(JSON.parse(inbox.media)[0].url,/^\/api\/x-media\/2\//);
    const hidden=await request('/api/inbox/1/visibility',{method:'PUT',headers:{...owner,'Content-Type':'application/json'},body:JSON.stringify({visibility:'private'})});
    assert.equal(hidden.status,200);assert.match(JSON.parse((await hidden.json()).media)[0].url,/^\/api\/x-media\/1\//);
    for(const method of ['GET','HEAD']) assert.equal((await request(mediaUrl,{method,headers:{'If-None-Match':etag}})).status,404);
    assert.equal((await request(mediaUrl,{headers:owner})).status,200);
    assert.equal(JSON.parse(db.prepare('SELECT media FROM inbox WHERE id=1').get().media)[0].url,url);
    db.prepare('UPDATE inbox SET media=\'[]\' WHERE id=1').run();assert.equal((await request(mediaUrl,{headers:owner})).status,404);
  } finally {
    db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
    await rm(directory,{recursive:true,force:true});
  }
});
