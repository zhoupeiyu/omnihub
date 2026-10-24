import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClassificationPlan, applyClassificationPlan, classificationCounts } from '../lib/repository-classification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args = process.argv.slice(2);
if (args.some(arg => !['--apply','--user-id','8'].includes(arg)) || args[args.indexOf('--user-id')+1] !== '8' || !args.includes('--user-id')) throw new Error('Usage: node scripts/classify-repositories-local.mjs --user-id 8 [--apply]');
const apply = args.includes('--apply');
const directory = path.join(root,'data/repository-classification/2026-09-28');
const snapshot = JSON.parse(readFileSync(path.join(directory,'snapshot.json'),'utf8'));
const caches = new Map(readdirSync(directory).filter(name=>/^readme-\d+\.json$/.test(name)).map(name=>{
  const cache = JSON.parse(readFileSync(path.join(directory,name),'utf8'));
  return [cache.index,cache];
}));
const db = new DatabaseSync(path.join(root,'data/app.db'),{readOnly:!apply});
db.exec('PRAGMA busy_timeout=5000');
try {
  const rows = db.prepare('SELECT id,user_id AS userId,repo_key AS key,description,repository_url AS url,topics,metadata FROM repository_assets WHERE user_id=8 ORDER BY repo_key').all();
  const plan = buildClassificationPlan(rows,snapshot,{userId:8,caches});
  const counts = classificationCounts(plan);
  let backupPath;
  if (apply) {
    const backupDir = path.join(root,'data/backups');
    mkdirSync(backupDir,{recursive:true,mode:0o700});
    backupPath = path.join(backupDir,`before-repository-classification-${Date.now()}.db`);
    await backup(db,backupPath);
    chmodSync(backupPath,0o600);
    applyClassificationPlan(db,plan);
    writeFileSync(path.join(directory,'applied-audit.json'),JSON.stringify({appliedAt:new Date().toISOString(),backupPath,...counts,keys:plan.map(item=>({key:item.key,...item.metadata.classification}))},null,2),{mode:0o600});
  }
  console.log(JSON.stringify({mode:apply?'applied':'dry-run',backupPath,...counts},null,2));
} finally { db.close(); }
