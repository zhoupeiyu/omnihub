import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,readdirSync,statSync,writeFileSync,utimesSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createXWatchMedia,watchMediaUrl} from '../lib/x-watch-media.js';
import {createXWatch} from '../lib/x-watch.js';

const png=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
const mp4=Buffer.from('000000186674797069736f6d00000200','hex');
const post={id:1,media:[{type:'photo',url:'https://pbs.twimg.com/media/test.png',preview_image_url:'https://pbs.twimg.com/media/test.png'}]};
function fixture(t,fetchImpl=async()=>new Response(png),options={}) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'watch-media-')),db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);INSERT INTO users VALUES(1,'zane'),(2,'reader');");
  let now=0;const media=createXWatchMedia(db,{directory,fetchImpl,now:()=>now,...options});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return {media,db,directory,advance:ms=>{now+=ms;}};
}
test('only exact HTTPS X media hosts are accepted',()=>{
  for(const url of ['http://pbs.twimg.com/x','https://pbs.twimg.com.evil.com/x','https://pbs.twimg.com@localhost/x','https://pbs.twimg.com:444/x','https://127.0.0.1/x','file:///secret'])assert.equal(watchMediaUrl(url,'image'),'');
  assert.equal(watchMediaUrl('https://video.twimg.com/x.mp4','image'),'');
  assert.equal(watchMediaUrl('https://pbs.twimg.com/x.jpg','image'),'https://pbs.twimg.com/x.jpg');
});
test('deduplicated images are saved privately and browser URLs never fall back to X',async t=>{
  let calls=0;const {media,directory}=fixture(t,async(url,options)=>{calls++;assert.equal(options.redirect,'error');return new Response(png);});
  media.enqueue(1,1,post);media.enqueue(1,1,post);
  let output=media.decorate(1,post);assert.equal(output.media[0].url,'');assert.equal(output.media[0].archiveState,'pending');
  assert.equal((await media.run(1)).state,'ready');assert.equal(calls,1);
  output=media.decorate(1,post);assert.match(output.media[0].url,/^\/api\/x-watch\/media\/\d+$/);
  assert.equal(output.media[0].archiveState,'ready');assert.ok(!JSON.stringify(output).includes('twimg.com'));
  const file=path.join(directory,readdirSync(directory)[0]);assert.deepEqual(readFileSync(file),png);assert.equal(statSync(file).mode&0o777,0o600);
  assert.equal((await media.run(1)).state,'idle');assert.throws(()=>media.decorate(2,post),e=>e.status===403);
});
test('quoted provider objects do not expose nested media or profile URLs',t=>{
  const {media}=fixture(t);const quoted={...post,metrics:{quotedTweet:{id_str:'88',full_text:'quoted text',user:{screen_name:'quoted',profile_image_url_https:'https://pbs.twimg.com/avatar.png'},extended_entities:{media:post.media}}}};
  const result=media.decorate(1,quoted);assert.equal(result.metrics.quotedTweet.full_text,'quoted text');assert.ok(!JSON.stringify(result).includes('twimg.com'));
});
test('expired partial downloads are cleaned without deleting retained media',async t=>{
  const {media,directory,advance}=fixture(t);const temp=path.join(directory,'999-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.part');
  writeFileSync(temp,'incomplete');utimesSync(temp,0,0);advance(3600000);
  media.enqueue(1,1,post);await media.run(1);assert.ok(!readdirSync(directory).some(f=>f.endsWith('.part')));assert.equal(media.status(1).ready,1);
});
test('video and poster jobs are distinct; MP4 supports authenticated byte ranges',async t=>{
  const {media}=fixture(t,async url=>new Response(url.includes('video.twimg')?mp4:png));
  const video={id:1,media:[{type:'video',url:'https://video.twimg.com/test.mp4',preview_image_url:post.media[0].url}]};
  media.enqueue(1,1,video);await media.run(1);await media.run(1);
  const result=media.decorate(1,video);assert.equal(result.media[0].archiveState,'ready');assert.notEqual(result.media[0].url,result.media[0].preview_image_url);
  const server=http.createServer((req,res)=>media.serve(req,res,1,Number(req.url.slice(1))));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/`,id=result.media[0].url.split('/').at(-1);
  let response=await fetch(base+id,{headers:{Range:'bytes=4-7'}});
  assert.equal(response.status,206);assert.equal(await response.text(),'ftyp');assert.equal(response.headers.get('content-type'),'video/mp4');assert.match(response.headers.get('cache-control'),/private, no-store/);
  assert.equal((await fetch(base+id,{headers:{Range:'bytes=900-1000'}})).status,416);
  response=await fetch(base+id,{method:'HEAD'});assert.equal(response.headers.get('content-length'),String(mp4.length));assert.equal(await response.text(),'');
  assert.equal((await fetch(base+'999')).status,404);
});
test('executable media is rejected without leaving a temporary file',async t=>{
  const {media,directory}=fixture(t,async()=>new Response('<html>not an image</html>'));
  media.enqueue(1,1,post);assert.equal((await media.run(1)).state,'error');assert.equal(media.status(1).failed,1);assert.deepEqual(readdirSync(directory),[]);
  assert.equal(media.retry(1),0);
});
test('download length and storage ceilings prevent unbounded writes',async t=>{
  const first=fixture(t,async()=>new Response(png,{headers:{'content-length':String(11*1024*1024)}}));
  first.media.enqueue(1,1,post);await first.media.run(1);assert.equal(first.media.status(1).failed,1);assert.equal(readdirSync(first.directory).length,0);
  let calls=0;const second=fixture(t,async()=>{calls++;return new Response(png);},{storageLimit:5});
  second.media.enqueue(1,1,post);await second.media.run(1);assert.equal(calls,0);assert.equal(second.media.status(1).pending,1);
});
test('failures retry with backoff, stop after three, and can be retried by owner',async t=>{
  let calls=0;const {media,advance}=fixture(t,async()=>{calls++;throw Error('private upstream error');});
  media.enqueue(1,1,post);await media.run(1);assert.equal((await media.run(1)).state,'idle');
  for(let i=0;i<2;i++){advance(3600000);await media.run(1);}
  assert.equal(calls,3);assert.equal(media.status(1).failed,1);
  assert.throws(()=>media.retry(2),e=>e.status===403);assert.equal(media.retry(1),1);
  assert.equal(media.decorate(1,post).media[0].archiveState,'pending');
});
test('concurrent media workers do not download one job twice',async t=>{
  let release;const {media}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));media.enqueue(1,1,post);
  const first=media.run(1);assert.equal((await media.run(1)).state,'busy');
  while(!release)await new Promise(resolve=>setImmediate(resolve));release(new Response(png));await first;
});
test('collected text and media queue commit together, while original bookmarks remain separate',async t=>{
  const {media,db}=fixture(t);
  db.exec('CREATE TABLE inbox(id INTEGER PRIMARY KEY,user_id INTEGER,source TEXT,external_id TEXT)');
  const store=createXWatch(db,{onPost:media.enqueue,env:{OMNIHUB_X_WATCH_ENABLED:'true',SOCIALDATA_API_KEY:'fixture',OMNIHUB_SOCIALDATA_MONTH_USD:'5.90'},fetchImpl:async()=>new Response(JSON.stringify({tweets:[{
    id_str:'123',full_text:'Saved original text',user:{screen_name:'example'},created_at:'2026-10-02',extended_entities:{media:[{type:'photo',media_url_https:post.media[0].url}]}}]}))});
  store.configure(1,{handle:'example',group:'test',intervalMinutes:30,enabled:true,includeReplies:false,includeReposts:false,dailyRequests:10,dailyBudgetUsd:1});
  assert.equal((await store.collect(1)).added,1);assert.equal(store.posts(1)[0].content,'Saved original text');assert.equal(media.status(1).pending,1);
  assert.equal(db.prepare('SELECT count(*) n FROM inbox').get().n,0);
});
