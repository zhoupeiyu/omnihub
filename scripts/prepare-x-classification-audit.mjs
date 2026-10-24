import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination = path.join(root,'data/audits/x-classification-20260928');
if (existsSync(path.join(destination,'manifest.json'))) throw new Error('Existing snapshot must be reused, not overwritten.');
mkdirSync(destination,{recursive:true,mode:0o700});
const db = new DatabaseSync(path.join(root,'data/app.db'),{readOnly:true});
const user = db.prepare("SELECT id FROM users WHERE username='zane'").get();
const rows = db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' ORDER BY id").all(user.id);
const parse = (s, fallback) => {try {return JSON.parse(s);}catch{return fallback;}};
const map = row => {
  const metrics = parse(row.metrics,{}), extract = parse(row.ai_extract,{});
  const prompt = db.prepare('SELECT id FROM prompts WHERE user_id=? AND source_inbox_id=?').get(user.id,row.id);
  const repos = db.prepare('SELECT ra.repo_key FROM repository_assets ra JOIN repository_sources rs ON rs.repository_id=ra.id WHERE ra.user_id=? AND rs.inbox_id=?').all(user.id,row.id);
  const curated = db.prepare("SELECT data FROM library_curation WHERE user_id=? AND asset_type='source' AND asset_key=?").get(user.id,String(row.id));
  return {id:row.id,externalId:row.external_id,visibility:row.visibility,status:row.status,title:row.title,
    text:row.content,quote:metrics.quotedTweet?.full_text || '',links:parse(row.links,[]),media:parse(row.media,[]),
    currentType:row.ai_type,currentTopic:extract.xOrganization?.topic || '',promptId:prompt?.id || null,
    repositories:repos.map(r=>r.repo_key),curation:curated ? parse(curated.data,{}) : null,
    sourceHash:createHash('sha256').update(JSON.stringify([row.content,metrics.quotedTweet?.full_text || '',row.links,row.media,row.ai_extract])).digest('hex')};
};
const publicRows = rows.filter(r=>r.visibility === 'public' && r.status === 'pending').map(map);
const localOnly = rows.filter(r=>!(r.visibility === 'public' && r.status === 'pending')).map(map);
const shards = Array.from({length:4},(_,index)=>publicRows.slice(Math.floor(index*publicRows.length/4),Math.floor((index+1)*publicRows.length/4)));
for(let index=0;index<shards.length;index++) writeFileSync(path.join(destination,`sources-${index}.json`),JSON.stringify(shards[index],null,2),{mode:0o600});
writeFileSync(path.join(destination,'local-only.json'),JSON.stringify(localOnly,null,2),{mode:0o600});
const manifest = {createdAt:new Date().toISOString(),total:rows.length,public:publicRows.length,localOnly:localOnly.length,
  shards:shards.map((rows,index)=>({index,count:rows.length,ids:rows.map(r=>r.id)}))};
writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({destination,total:rows.length,public:publicRows.length,localOnly:localOnly.length,shards:shards.map(rows=>rows.length)}));
db.close();
