import {DatabaseSync} from 'node:sqlite';
import {writeFileSync,existsSync} from 'node:fs';
import {promptSeedFields,knowledgeSeedFields,claimSeedFields,seedSourceHash} from '../lib/library-seed.js';
const output='data/deployment/library-curation-20260928/candidate/content/library-seed.json';
if(existsSync(output)) throw new Error('Seed already exists');
const db=new DatabaseSync('data/app.db',{readOnly:true});
const owner=db.prepare("SELECT id FROM users WHERE username='zane'").get();
const sources={};
const source=id=>{
  const row=db.prepare("SELECT * FROM inbox WHERE id=? AND user_id=? AND source='x' AND visibility='public' AND status='pending'").get(id,owner.id);
  if(!row) throw new Error('Non-public source in seed');
  sources[row.external_id]=seedSourceHash(row);return row.external_id;
};
const pick=(row,fields)=>Object.fromEntries(fields.map(key=>[key,row[key]]));
const prompts=db.prepare("SELECT p.* FROM prompts p JOIN inbox i ON i.id=p.source_inbox_id AND i.user_id=p.user_id WHERE p.user_id=? AND i.source='x' AND i.visibility='public' AND i.status='pending'").all(owner.id)
  .map(row=>({externalId:source(row.source_inbox_id),data:pick(row,promptSeedFields)}));
const articles=db.prepare("SELECT * FROM knowledge WHERE user_id=? AND status IN ('ready','published') AND subject_id!=''").all(owner.id).map(row=>({
  data:pick(row,knowledgeSeedFields),sources:db.prepare('SELECT inbox_id FROM knowledge_sources WHERE knowledge_id=?').all(row.id).map(s=>source(s.inbox_id)),
  claims:db.prepare('SELECT * FROM knowledge_claims WHERE knowledge_id=?').all(row.id).map(c=>pick(c,claimSeedFields)),
}));
writeFileSync(output,JSON.stringify({version:1,prompts,articles,sources}),{mode:0o600});db.close();
console.log(JSON.stringify({prompts:prompts.length,articles:articles.length,publicSources:Object.keys(sources).length,output}));
