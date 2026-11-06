import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMediaStorage } from '../lib/media-storage.js';
const root=process.env.OMNIHUB_DATA_DIR || '/root/omnihub/data';
const plan=JSON.parse(await readFile(process.argv[2],'utf8'));
const db=new DatabaseSync(`${root}/app.db`);db.exec('PRAGMA busy_timeout=10000');
const user=db.prepare('SELECT id FROM users WHERE username=?').get('zane');if(!user)throw Error('Owner missing');
await backup(db,`${root}/opennana-before-${Date.now()}.db`);
const storage=createMediaStorage();await mkdir(`${root}/media`,{recursive:true});
let complete=0,failed=[];
const sha=b=>createHash('sha256').update(b).digest('hex');
async function image(entry){
 const hash=sha(Buffer.from(entry.sourceUrl));const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
 const exists=db.prepare('SELECT id,storage_state FROM media_assets WHERE id=? AND user_id=?').get(id,user.id);
 if(exists?.storage_state==='stored')return `/api/media/assets/${id}/file`;
 const response=await fetch(entry.sourceUrl,{signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error(`image HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>25*1024*1024)throw Error('Image too large');
 const ext=bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(1,4).toString()==='PNG'?'png':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':bytes.subarray(0,3).toString()==='GIF'?'gif':'';if(!ext)throw Error('Invalid image');
 const mime={jpg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'}[ext];const digest=sha(bytes);
 const stored=await storage.put({userId:user.id,assetId:id,extension:ext,bytes,contentType:mime,sha256:digest});if(stored.state!=='stored')throw Error('Cloud not stored');
 await writeFile(`${root}/media/${id}.${ext}`,bytes,{mode:0o600});
 db.prepare(`INSERT OR IGNORE INTO media_assets(id,user_id,kind,origin,file_name,mime_type,size_bytes,title,storage_state,storage_key,storage_sha256) VALUES(?,?,'image','reference',?,?,?,'OpenNana reference','stored',?,?)`).run(id,user.id,`${id}.${ext}`,mime,bytes.length,stored.key,digest);
 return `/api/media/assets/${id}/file`;
}
async function item(p){
 if(db.prepare("SELECT id FROM prompts WHERE user_id=? AND json_extract(facet_data,'$.importKey')=?").get(user.id,p.importKey))return;
 const media=[];for(const e of p.imagePlan){const url=await image(e);media.push({type:'image',url,originalUrl:url});}
 db.prepare(`INSERT INTO prompts(user_id,title,text,category,image,model,tags,kind,summary,prompt_text_raw,prompt_text_clean,media,source_url,source_author,source_content,facet_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id,p.title,p.text,p.category,media[0]?.url||'',p.model,p.tags.join(','),p.kind,p.summary,p.promptTextRaw,p.promptTextClean,JSON.stringify(media),p.sourceUrl,p.sourceAuthor,p.sourceContent,JSON.stringify(p.facetData));
}
let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<plan.items.length){const p=plan.items[cursor++];try{await item(p);complete++;}catch(e){failed.push({key:p.importKey,error:e.message});}if((complete+failed.length)%25===0)console.log(JSON.stringify({complete,failed:failed.length,total:plan.items.length}));}}));
await writeFile(`${root}/opennana-import-result.json`,JSON.stringify({complete,failed,total:plan.items.length}));console.log(JSON.stringify({complete,failed:failed.length,total:plan.items.length}));db.close();
