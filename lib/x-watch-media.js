import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,statSync,createReadStream,renameSync} from 'node:fs';
import {open,unlink,stat,readdir} from 'node:fs/promises';
import path from 'node:path';

const IMAGE_LIMIT=10*1024*1024,VIDEO_LIMIT=64*1024*1024;
const error=code=>Object.assign(new Error(code),{code});
export function watchMediaUrl(value,kind) {
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
      u.hostname===(kind==='video'?'video.twimg.com':'pbs.twimg.com')?u.href:'';
  }catch{return '';}
}
function mimeFor(bytes,kind) {
  if(kind==='video')return bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'?'video/mp4':'';
  if(bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return 'image/jpeg';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return '';
}

export function createXWatchMedia(db,{directory,fetchImpl=fetch,now=()=>Date.now(),storageLimit=2*1024**3}={}) {
  if(!path.isAbsolute(directory)||!Number.isSafeInteger(storageLimit)||storageLimit<=0)throw error('invalid_storage');
  mkdirSync(directory,{recursive:true,mode:0o700});
  db.exec(`CREATE TABLE IF NOT EXISTS x_watch_media(
    id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,post_id INTEGER NOT NULL,source_url TEXT NOT NULL,kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
    lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,filename TEXT NOT NULL DEFAULT '',bytes INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',UNIQUE(user_id,post_id,source_url,kind));`);
  const owner=userId=>{
    if(!db.prepare("SELECT 1 FROM users WHERE id=? AND username='zane'").get(userId))throw Object.assign(error('owner_only'),{status:403});
  };
  function enqueue(userId,postId,post) {
    for(const item of post.media||[]) {
      for(const [url,kind] of [[item.url,item.type==='photo'?'image':'video'],[item.preview_image_url,'image']]) {
        const safe=watchMediaUrl(url,kind);if(!safe)continue;
        db.prepare('INSERT OR IGNORE INTO x_watch_media(user_id,post_id,source_url,kind) VALUES(?,?,?,?)').run(userId,postId,safe,kind);
      }
    }
  }
  function decorate(userId,post) {
    owner(userId);
    const rows=db.prepare('SELECT * FROM x_watch_media WHERE user_id=? AND post_id=?').all(userId,post.id);
    const resolve=(url,kind)=>rows.find(r=>r.source_url===url&&r.kind===kind);
    const local=row=>row?.state==='ready'?`/api/x-watch/media/${row.id}`:'';
    // Quoted provider objects contain arbitrary remote media; expose text only here.
    const quote=post.metrics?.quotedTweet;
    const metrics=post.metrics?{...post.metrics,quotedTweet:quote?{id_str:quote.id_str,full_text:quote.full_text||quote.text||'',user:{screen_name:quote.user?.screen_name}}:null}:undefined;
    return {...post,...(metrics?{metrics}:{}),media:(post.media||[]).map(item=>{
      const main=resolve(item.url,item.type==='photo'?'image':'video'),preview=resolve(item.preview_image_url,'image');
      const relevant=item.type==='photo'?[main]:[main,preview];
      const state=relevant.every(r=>r?.state==='ready')?'ready':relevant.some(r=>!r||r.state==='failed')?'failed':'pending';
      return {type:item.type,alt_text:item.alt_text,url:local(main),preview_image_url:local(preview),archiveState:state};
    })};
  }
  let busy=false;
  async function run(userId) {
    owner(userId);if(busy)return {state:'busy'};
    busy=true;
    let job,temp,handle;
    try {
      // BEGIN IMMEDIATE serializes leases across processes, not just this worker.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE x_watch_media SET state='failed',error_code='download_failed',lease=NULL,lease_until=0 WHERE state='pending' AND attempts>=3 AND lease_until<=?").run(now());
        job=db.prepare(`SELECT * FROM x_watch_media WHERE user_id=? AND state='pending' AND attempts<3
          AND next_at<=? AND lease_until<=? ORDER BY id LIMIT 1`).get(userId,now(),now());
        if(job){job.lease=randomUUID();db.prepare('UPDATE x_watch_media SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=?').run(job.lease,now()+180000,job.id);}
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      if(!job)return {state:'idle'};
      const limit=job.kind==='video'?VIDEO_LIMIT:IMAGE_LIMIT;
      // Include retained and interrupted files in the disk cap. Never delete previously saved media.
      let used=0;
      for(const file of await readdir(directory)){
        const full=path.join(directory,file),s=await stat(full);
        const part=/^(\d+)-([a-f0-9-]{36})\.part$/.exec(file);
        if(part&&now()-s.mtimeMs>180000&&!db.prepare('SELECT 1 FROM x_watch_media WHERE id=? AND lease=? AND lease_until>?').get(Number(part[1]),part[2],now())){await unlink(full);continue;}
        if(s.isFile())used+=s.size;
      }
      const other=db.prepare("SELECT COALESCE(sum(CASE WHEN kind='video' THEN ? ELSE ? END),0) n FROM x_watch_media WHERE lease_until>? AND id<>?").get(VIDEO_LIMIT,IMAGE_LIMIT,now(),job.id).n;
      if(used+other+limit>storageLimit)throw error('storage_limit');
      const url=watchMediaUrl(job.source_url,job.kind);if(!url)throw error('unsupported_url');
      const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
      if(!response.ok||!response.body)throw error('download_failed');
      const length=Number(response.headers.get('content-length'));
      if(Number.isFinite(length)&&length>limit){await response.body.cancel();throw error('file_too_large');}
      temp=path.join(directory,`${job.id}-${job.lease}.part`);
      handle=await open(temp,'wx',0o600);
      let bytes=0,signature=Buffer.alloc(0);const hash=createHash('sha256');
      for await(const chunk of response.body){
        const data=Buffer.from(chunk);bytes+=data.length;if(bytes>limit)throw error('file_too_large');
        if(signature.length<32)signature=Buffer.concat([signature,data.subarray(0,32-signature.length)]);
        hash.update(data);await handle.writeFile(data);
      }
      const mime=mimeFor(signature,job.kind);if(!mime||!bytes)throw error('unsupported_format');
      await handle.close();handle=null;
      const filename=`${job.id}-${hash.digest('hex')}.bin`;
      // A replaced/expired lease must not publish a file into another job's result.
      db.exec('BEGIN IMMEDIATE');
      try{
        const live=db.prepare('SELECT 1 FROM x_watch_media WHERE id=? AND lease=? AND lease_until>?').get(job.id,job.lease,now());
        if(!live)throw error('stale_job');
        renameSync(temp,path.join(directory,filename));temp=null;
        db.prepare("UPDATE x_watch_media SET state='ready',filename=?,bytes=?,mime=?,error_code='',lease=NULL,lease_until=0 WHERE id=? AND lease=?")
          .run(filename,bytes,mime,job.id,job.lease);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return {state:'ready'};
    }catch(e){
      if(job){
        const code=['storage_limit','file_too_large','unsupported_url','unsupported_format'].includes(e.code)?e.code:'download_failed';
        db.prepare(`UPDATE x_watch_media SET state=CASE WHEN attempts>=3 OR ? IN ('file_too_large','unsupported_url','unsupported_format') THEN 'failed' ELSE 'pending' END,
          error_code=?,next_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?`).run(code,code,now()+Math.max(5,5*(job.attempts+1))*60000,job.id,job.lease);
      }
      return {state:'error'};
    }finally{if(handle)await handle.close().catch(()=>{});if(temp)await unlink(temp).catch(()=>{});busy=false;}
  }
  function serve(req,res,userId,id) {
    owner(userId);
    const row=db.prepare("SELECT * FROM x_watch_media WHERE id=? AND user_id=? AND state='ready'").get(id,userId);
    const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin'};
    const reject=code=>{res.writeHead(code,headers);res.end();};
    if(!row||!/^\d+-[a-f0-9]{64}\.bin$/.test(row.filename))return reject(404);
    const file=path.join(directory,row.filename);
    try{if(statSync(file).size!==row.bytes)return reject(404);}catch{return reject(404);}
    let start=0,end=row.bytes-1,partial=false;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2]))return reject(416);
      if(!match[1])start=Math.max(0,row.bytes-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=row.bytes)return reject(416);
      partial=true;
    }
    res.writeHead(partial?206:200,{...headers,'Content-Type':row.mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes',
      ...(partial?{'Content-Range':`bytes ${start}-${end}/${row.bytes}`}:{})});
    if(req.method==='HEAD')return res.end();
    const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  function status(userId) {
    owner(userId);
    const states=db.prepare('SELECT state,count(*) n,COALESCE(sum(bytes),0) bytes FROM x_watch_media WHERE user_id=? GROUP BY state').all(userId);
    return {ready:states.find(s=>s.state==='ready')?.n||0,pending:states.find(s=>s.state==='pending')?.n||0,
      failed:states.find(s=>s.state==='failed')?.n||0,bytes:states.reduce((n,s)=>n+s.bytes,0),storageLimit};
  }
  function retry(userId) {
    owner(userId);
    return db.prepare("UPDATE x_watch_media SET state='pending',attempts=0,next_at=0 WHERE user_id=? AND state='failed' AND error_code IN ('download_failed','storage_limit')").run(userId).changes;
  }
  return {enqueue,decorate,run,serve,status,retry};
}
