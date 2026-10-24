import {createHash} from 'node:crypto';
export const promptSeedFields=['title','text','category','tags','kind','summary','prompt_text_raw','prompt_text_clean','variables','media','source_url','source_author','source_content','status','rating','facet_data'];
export const knowledgeSeedFields=['title','summary','body','tags','source_url','status','subject_id','verification_status','version'];
export const claimSeedFields=['claim_id','section','claim_text','source_ids','verdict','confidence','needs_review'];
export const seedSourceHash=row=>createHash('sha256').update(JSON.stringify([row.content,row.metrics,row.media])).digest('hex');

export function prepareLibrarySeed(db,seed) {
  const owner=db.prepare("SELECT id FROM users WHERE username='zane'").get();
  if(!owner || seed.version!==1) throw new Error('Invalid library seed');
  const source=externalId=>{
    const row=db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' AND external_id=?").get(owner.id,externalId);
    if(!row || row.visibility!=='public' || row.status!=='pending' || seedSourceHash(row)!==seed.sources[externalId]) throw new Error(`Public seed source changed: ${externalId}`);
    return row;
  };
  const prompts=seed.prompts.map(item=>({...item,inboxId:source(item.externalId).id}));
  const articles=seed.articles.map(item=>{
    if(!['ready','published'].includes(item.data.status) || !item.sources.length) throw new Error('Unpublished article in seed');
    const ids=new Set(item.sources);
    for(const match of item.data.body.matchAll(/\[S:([A-Za-z0-9_-]+)\]/g)) if(!ids.has(match[1])) throw new Error('Unknown article citation');
    for(const claim of item.claims) for(const id of JSON.parse(claim.source_ids)) if(!ids.has(id)) throw new Error('Unknown claim source');
    return {...item,links:item.sources.map(id=>({externalId:id,inboxId:source(id).id}))};
  });
  return {ownerId:owner.id,prompts,articles};
}

// Seed only missing assets. Existing online records and manual corrections always win.
export function applyLibrarySeed(db,plan) {
  let promptsAdded=0,articlesAdded=0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertPrompt=db.prepare(`INSERT INTO prompts(user_id,source_inbox_id,${promptSeedFields.join(',')}) VALUES(${Array(promptSeedFields.length+2).fill('?')})`);
    for(const item of plan.prompts) {
      if(db.prepare('SELECT id FROM prompts WHERE user_id=? AND source_inbox_id=?').get(plan.ownerId,item.inboxId)) continue;
      insertPrompt.run(plan.ownerId,item.inboxId,...promptSeedFields.map(key=>item.data[key]));promptsAdded++;
    }
    const insertArticle=db.prepare(`INSERT INTO knowledge(user_id,${knowledgeSeedFields.join(',')}) VALUES(${Array(knowledgeSeedFields.length+1).fill('?')})`);
    const insertClaim=db.prepare(`INSERT INTO knowledge_claims(knowledge_id,${claimSeedFields.join(',')}) VALUES(${Array(claimSeedFields.length+1).fill('?')})`);
    for(const item of plan.articles) {
      if(db.prepare('SELECT id FROM knowledge WHERE user_id=? AND subject_id=?').get(plan.ownerId,item.data.subject_id)) continue;
      const id=Number(insertArticle.run(plan.ownerId,...knowledgeSeedFields.map(key=>item.data[key])).lastInsertRowid);
      for(const link of item.links) db.prepare('INSERT INTO knowledge_sources(knowledge_id,inbox_id,external_id,citation_key) VALUES(?,?,?,?)').run(id,link.inboxId,link.externalId,`S:${link.externalId}`);
      for(const claim of item.claims) insertClaim.run(id,...claimSeedFields.map(key=>claim[key]));
      articlesAdded++;
    }
    db.exec('COMMIT');return {promptsAdded,articlesAdded};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
