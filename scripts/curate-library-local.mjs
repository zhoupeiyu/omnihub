import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisions, sourceDigests } from '../content/library-curation-20260928.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root,'data');
if (process.env.OMNIHUB_DATA_DIR && path.resolve(process.env.OMNIHUB_DATA_DIR) !== dataDir) throw new Error('This command only supports the explicit local data directory.');
if (process.argv.slice(2).some(x => !['--dry-run','--apply'].includes(x))) throw new Error('Use --dry-run or --apply.');
const apply = process.argv.includes('--apply');
const reader = new DatabaseSync(path.join(dataDir,'app.db'),{readOnly:true});
const owner = reader.prepare("SELECT id FROM users WHERE username='zane'").get();
if (!owner) throw new Error('Local owner missing.');
const allSources = reader.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x'").all(owner.id);
const byExternal = new Map(allSources.map(row => [row.external_id,row]));
const fingerprint = row => createHash('sha256').update(JSON.stringify([row.content,JSON.parse(row.metrics).quotedTweet?.full_text || ''])).digest('hex');
const originalSnapshot = createHash('sha256').update(JSON.stringify(allSources)).digest('hex');
const plans = decisions.map(decision => {
  const row = byExternal.get(decision.externalId);
  if (!row || fingerprint(row) !== sourceDigests[decision.externalId]) throw new Error(`Reviewed source changed or missing: ${decision.externalId}`);
  let promptText = '';
  if (decision.extract) {
    const {start,end,quoted,brackets} = decision.extract;
    const text = quoted ? JSON.parse(row.metrics).quotedTweet.full_text : row.content;
    if (brackets) {
      const matches = [...text.matchAll(/「([^」]+)」/g)];
      if (matches.length !== 2) throw new Error('Expected two reviewed prompt spans.');
      promptText = matches.map(x => x[1]).join('\n\n');
    } else {
      const startIndex = text.indexOf(start);
      const endIndex = end ? text.indexOf(end,startIndex+start.length) : text.length;
      if (startIndex < 0 || endIndex < 0) throw new Error(`Prompt boundaries changed: ${decision.externalId}`);
      promptText = text.slice(startIndex,endIndex).trim();
    }
  }
  const relatedSourceIds = (decision.related || []).map(id => {
    const related = byExternal.get(id);
    if (!related || fingerprint(related) !== sourceDigests[id]) throw new Error(`Related source changed: ${id}`);
    return related.id;
  });
  const citations = [decision.externalId,...(decision.related || [])].map(id => `[S:${id}]`).join(' ');
  return {id:row.id,data:{type:decision.type,title:decision.title || row.title,summary:decision.summary || '',
    body:decision.body ? `${decision.body}\n\n## 来源\n\n${citations}` : '', promptText,
    promptCategory:decision.promptCategory || '其他',tags:decision.tags || [],relatedSourceIds}};
});
console.log(JSON.stringify({mode:apply ? 'apply' : 'dry-run',local:true,reviewed:plans.length,
  methods:plans.filter(x => x.data.type === 'method').length,promptSpans:plans.filter(x => x.data.promptText).length,
  sourceOnly:plans.filter(x => x.data.type === 'source').length}));
if (apply) {
  const backupDir = path.join(dataDir,'backups');
  mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backupPath = path.join(backupDir,`before-library-curation-${Date.now()}.db`);
  await backup(reader,backupPath); chmodSync(backupPath,0o600);
  const {db} = await import('../lib/db.js');
  await import('../lib/knowledge-store.js');
  const {createLibraryCuration} = await import('../lib/library-curation.js');
  const store = createLibraryCuration(db);
  let written = 0, preserved = 0;
  for (const plan of plans) {
    const current = store.record(owner.id,'source',String(plan.id));
    if (current?.origin === 'manual' || JSON.stringify(current?.data) === JSON.stringify(plan.data)) {preserved++;continue;}
    store.write(owner.id,'source',String(plan.id),current?.revision || 0,plan.data,'reviewed'); written++;
  }
  const after = db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x'").all(owner.id);
  if (createHash('sha256').update(JSON.stringify(after)).digest('hex') !== originalSnapshot) throw new Error('Source data changed; stop and inspect the backup.');
  console.log(JSON.stringify({written,preserved,sourceSnapshotUnchanged:true,backupPath,
    methodsReadBack:store.methods(owner.id,{publicOnly:true}).length}));
  db.close();
}
reader.close();
