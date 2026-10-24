import { createHash } from 'node:crypto';
import { isValidClassification } from '../public/repository-taxonomy.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const sourceHash = row => hash(JSON.stringify([row.external_id,row.url,row.content]));
const fields = ['repo_key','owner','name','repository_url','description','topics','personal_status',
  'personal_note','source_post_count','target_link_count','metadata','created_at','updated_at'];
const sourceFields=['source','external_id','title','url','author','content','media','links','metrics',
  'ai_type','ai_confidence','ai_summary','ai_extract','status','dispatched_to','created_at','updated_at','visibility'];

export function exportRepositoryRelease(db, username) {
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!user) throw new Error('Release owner does not exist');
  const repositories = db.prepare('SELECT * FROM repository_assets WHERE user_id=? ORDER BY repo_key').all(user.id).map(row=>({
    ...Object.fromEntries(fields.map(field=>[field,row[field]])),
    sources:db.prepare(`SELECT i.* FROM repository_sources s
      JOIN inbox i ON i.id=s.inbox_id WHERE s.repository_id=? AND i.user_id=? AND i.source='x'
      ORDER BY i.external_id`).all(row.id,user.id).map(source=>({externalId:source.external_id,url:source.url,
        hash:sourceHash(source),visibility:source.visibility,status:source.status,
        ...(source.visibility==='unreviewed'&&source.status==='ignored' ? {archivedRecord:Object.fromEntries(sourceFields.map(field=>[field,source[field]]))} : {})})),
    links:db.prepare('SELECT url,kind FROM repository_links WHERE repository_id=? ORDER BY url').all(row.id),
  }));
  return {format:'omnihub-repository-release-v1',username,expectedCount:repositories.length,
    expectedPublicCount:repositories.filter(repo=>repo.sources.some(s=>s.visibility==='public'&&s.status==='pending')).length,repositories};
}

export function validateRepositoryRelease(db, packet) {
  if (packet.format !== 'omnihub-repository-release-v1' || !packet.username || !Array.isArray(packet.repositories) || !packet.repositories.length || packet.repositories.length !== packet.expectedCount) throw new Error('Invalid release packet');
  const user=db.prepare('SELECT id FROM users WHERE username=?').get(packet.username);
  if (!user) throw new Error('Target owner does not exist');
  const findSource=db.prepare("SELECT id,external_id,url,content,visibility,status FROM inbox WHERE user_id=? AND source='x' AND external_id=?");
  const keys=new Set();
  const archivedSources=new Map();
  let visible=0;
  const rows=packet.repositories.map(repo=>{
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo.repo_key) || keys.has(repo.repo_key) || !isValidClassification(JSON.parse(repo.metadata).classification)) throw new Error('Invalid or duplicate repository');
    keys.add(repo.repo_key);
    if (!Array.isArray(repo.sources)||!repo.sources.length||!Array.isArray(repo.links)) throw new Error('Repository has no source evidence');
    const sources=repo.sources.map(source=>{
      const matches=findSource.all(user.id,source.externalId);
      if (matches.length>1) throw new Error(`Ambiguous source for ${repo.repo_key}`);
      let found=matches[0];
      if(!found) {
        const original=source.archivedRecord;
        if(!original||original.source!=='x'||original.external_id!==source.externalId||original.visibility!=='unreviewed'||original.status!=='ignored'||sourceHash(original)!==source.hash) throw new Error(`Missing source for ${repo.repo_key}`);
        if(archivedSources.has(source.externalId)&&JSON.stringify(archivedSources.get(source.externalId))!==JSON.stringify(original)) throw new Error('Conflicting archived source');
        archivedSources.set(source.externalId,original);
        found={...original,id:null};
      }
      if (sourceHash(found)!==source.hash || found.visibility!==source.visibility || found.status!==source.status) throw new Error(`Source changed for ${repo.repo_key}`);
      return found;
    });
    if (new Set(sources.map(s=>s.external_id)).size!==sources.length) throw new Error('Duplicate source');
    if (sources.some(s=>s.visibility==='public'&&s.status==='pending')) visible++;
    return {repo,sources};
  });
  if (visible!==packet.expectedPublicCount) throw new Error('Public visibility count mismatch');
  return {userId:user.id,rows,visible,archivedSources};
}

// This release only adds derived repositories. It never upserts or rewrites inbox rows.
export function importRepositoryRelease(db, packet) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan=validateRepositoryRelease(db,packet);
    const existing=db.prepare('SELECT count(*) AS count FROM repository_assets WHERE user_id=?').get(plan.userId).count;
    if (existing!==0) throw new Error('Target already has repository assets; stop and reconcile, do not overwrite');
    const archive=db.prepare(`INSERT INTO inbox(user_id,${sourceFields.join(',')}) VALUES(${Array(sourceFields.length+1).fill('?').join(',')})`);
    const archiveIds=new Map();
    for(const [externalId,original] of plan.archivedSources) archiveIds.set(externalId,Number(archive.run(plan.userId,...sourceFields.map(field=>original[field])).lastInsertRowid));
    const insert=db.prepare(`INSERT INTO repository_assets(user_id,${fields.join(',')}) VALUES(${Array(fields.length+1).fill('?').join(',')})`);
    const insertSource=db.prepare('INSERT INTO repository_sources(repository_id,inbox_id,external_id) VALUES(?,?,?)');
    const insertLink=db.prepare('INSERT INTO repository_links(repository_id,url,kind) VALUES(?,?,?)');
    let sources=0,links=0;
    for (const {repo,sources:matched} of plan.rows) {
      const id=Number(insert.run(plan.userId,...fields.map(field=>repo[field])).lastInsertRowid);
      for(const source of matched) {insertSource.run(id,source.id ?? archiveIds.get(source.external_id),source.external_id);sources++;}
      for(const link of repo.links) {insertLink.run(id,link.url,link.kind);links++;}
      const saved=db.prepare('SELECT metadata FROM repository_assets WHERE id=?').get(id);
      if(saved.metadata!==repo.metadata) throw new Error('Metadata read-back mismatch');
    }
    if(db.prepare('SELECT count(*) AS count FROM repository_assets WHERE user_id=?').get(plan.userId).count!==packet.expectedCount) throw new Error('Import count mismatch');
    db.exec('COMMIT');
    return {repositories:plan.rows.length,publicRepositories:plan.visible,sources,links,archivedSourcesAdded:plan.archivedSources.size,targetUserId:plan.userId};
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
