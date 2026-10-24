import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, chmodSync, existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { historyDigest, repairHistoryRow, validateHistoryPlan } from '../lib/x-history-repair.js';

const option = name => { const index=process.argv.indexOf(name); return index<0?'':process.argv[index+1]; };
const database=option('--database'), planFile=option('--plan'), reportFile=option('--report');
if (![database,planFile,reportFile].every(value => value && path.isAbsolute(value))) throw new Error('Absolute database, plan and report paths required');
if (new Set([database,planFile,reportFile].map(value=>path.resolve(value))).size!==3 || existsSync(reportFile)) throw new Error('Report must be a new separate file');
accessSync(path.dirname(reportFile),constants.W_OK);
const apply=process.argv.includes('--apply'), plan=JSON.parse(readFileSync(planFile,'utf8'));
process.umask(0o077);
const db=new DatabaseSync(database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const owner=db.prepare('SELECT id FROM users WHERE username=?').get(plan.username);
if (!owner || owner.id!==plan.userId) throw new Error('History owner mismatch');
const allRows=()=>db.prepare('SELECT * FROM inbox ORDER BY id').all();
const rows=()=>db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' ORDER BY id").all(owner.id);
const before=rows(), allBefore=allRows(), curationsBefore=db.prepare('SELECT * FROM library_curation ORDER BY user_id,asset_type,asset_key').all();
const scope=validateHistoryPlan(plan,owner.id,before), version=db.prepare('PRAGMA data_version').get().data_version;
const outside=items=>items.filter(row=>row.user_id!==owner.id||row.source!=='x'||!scope.has(row.external_id));
const preserved=items=>items.map(row=>[row.id,row.user_id,row.source,row.external_id,row.content,row.visibility,row.dispatched_to,row.created_at]);
let backupFile='', transaction=false;
const report={mode:apply?'apply':'dry-run',batch:plan.batch,sources:plan.sources.length,inserted:0,enriched:0,restored:0,reviewed:0,curations:0};
try {
  if (apply) {
    backupFile=`${database}.before-history-${Date.now()}.db`;
    await backup(db,backupFile); chmodSync(backupFile,0o600);
    const copy=new DatabaseSync(backupFile,{readOnly:true});
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' ||
        historyDigest(copy.prepare('SELECT * FROM inbox ORDER BY id').all())!==historyDigest(allBefore) ||
        historyDigest(copy.prepare('SELECT * FROM library_curation ORDER BY user_id,asset_type,asset_key').all())!==historyDigest(curationsBefore)) throw new Error('Backup verification failed');
    } finally { copy.close(); }
  }
  db.exec('BEGIN IMMEDIATE'); transaction=true;
  if (db.prepare('PRAGMA data_version').get().data_version!==version) throw new Error('Concurrent database change');
  validateHistoryPlan(plan,owner.id,rows());
  const get=db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' AND external_id=?");
  for (const source of plan.sources) {
    const old=get.get(owner.id,source.externalId);
    if (!old) {
      const organization={...source.organization,...(source.review?{assetType:source.review.type,topic:source.review.topic,groupTitle:source.review.title,review:{method:'source_and_image_review',batch:plan.batch}}:{})};
      db.prepare(`INSERT INTO inbox(user_id,source,external_id,title,url,author,content,media,links,metrics,ai_type,ai_extract,status,visibility)
        VALUES(?,'x',?,?,?,?,?,?,?,?,?,?,'pending','private')`).run(owner.id,source.externalId,(source.review?.title || source.title).slice(0,240),source.url,source.author,
          source.content,JSON.stringify(source.media),JSON.stringify(source.links),JSON.stringify(source.metrics),
          source.review?.type || (source.metrics.article?'knowledge':organization.assetType || ''),JSON.stringify({xOrganization:organization}));
      report.inserted++;
    } else {
      const next=repairHistoryRow(old,source,plan.batch);
      db.prepare('UPDATE inbox SET title=?,media=?,links=?,metrics=?,ai_extract=?,ai_type=?,status=?,updated_at=? WHERE id=? AND user_id=?').run(
        next.title,next.media,next.links,next.metrics,next.ai_extract,next.ai_type,next.status,new Date().toISOString(),old.id,owner.id);
      report.enriched++; if (old.status!==next.status) report.restored++;
    }
    if (source.review) report.reviewed++;
    if (source.curation) {
      const row=get.get(owner.id,source.externalId), data=source.curation;
      // Curation is limited to reviewed private sources and never replaces existing work.
      if (!source.review || row.status!=='pending' || row.visibility!=='private' || db.prepare("SELECT 1 FROM library_curation WHERE user_id=? AND asset_type='source' AND asset_key=?").get(owner.id,String(row.id))) throw new Error('Curation would replace or publish existing work');
      if (!['method','prompt'].includes(data.type) || !data.title || (data.type==='prompt'?!data.promptText:!data.body||!data.summary)) throw new Error('Invalid curation');
      const clean={...Object.fromEntries(['type','title','summary','body','promptText','promptCategory','tags'].map(key=>[key,data[key]])),relatedSourceIds:[]}, now=new Date().toISOString(), json=JSON.stringify(clean);
      db.prepare("INSERT INTO library_curation(user_id,asset_type,asset_key,data,revision,origin,updated_at) VALUES(?,'source',?,?,1,'reviewed',?)").run(owner.id,String(row.id),json,now);
      db.prepare(`INSERT INTO library_curation_history(user_id,asset_type,asset_key,actor_id,revision,origin,before_data,after_data,created_at)
        VALUES(?,'source',?,?,1,'reviewed',NULL,?,?)`).run(owner.id,String(row.id),owner.id,json,now);
      report.curations++;
    }
  }
  const after=allRows(), oldIds=new Set(allBefore.map(row=>row.id));
  if (historyDigest(outside(allBefore))!==historyDigest(outside(after)) ||
    historyDigest(preserved(allBefore))!==historyDigest(preserved(after.filter(row=>oldIds.has(row.id))))) throw new Error('Source preservation failed');
  const afterMap=new Map(after.map(row=>[row.id,row]));
  for (const old of allBefore) {
    if (old.user_id!==owner.id || old.source!=='x' || !scope.has(old.external_id)) continue;
    const next=afterMap.get(old.id);
    for (const [column,history] of [['metrics','recoveryPrevious'],['ai_extract','xRecoveryPrevious']]) {
      const saved=JSON.parse(old[column]), current=JSON.parse(next[column]);
      for (const [key,value] of Object.entries(saved)) {
        if (key===history) {
          for (const [batch,entry] of Object.entries(value)) if(historyDigest(entry)!==historyDigest(current[history]?.[batch])) throw new Error('Recovery history changed');
        } else if (historyDigest(value)!==historyDigest(current[key]) &&
          historyDigest(value)!==historyDigest(current[history]?.[plan.batch]?.[key])) throw new Error('Recovered evidence was not preserved');
      }
    }
    if (old.visibility==='public' && ['status','title','ai_type'].some(key=>next[key]!==old[key])) throw new Error('Published classification changed');
  }
  for (const old of curationsBefore) {
    const now=db.prepare('SELECT * FROM library_curation WHERE user_id=? AND asset_type=? AND asset_key=?').get(old.user_id,old.asset_type,old.asset_key);
    if (historyDigest(now)!==historyDigest(old)) throw new Error('Existing curation changed');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
  if (db.prepare("SELECT external_id FROM inbox WHERE user_id=? AND source='x' GROUP BY external_id HAVING count(*)>1").all(owner.id).length) throw new Error('Duplicate X identity');
  report.after=rows().length; report.backup=backupFile; report.originalsPreserved=true;
  db.exec(apply?'COMMIT':'ROLLBACK'); transaction=false;
  report.integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(report));
} catch (error) {
  if (transaction && db.isTransaction) db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
