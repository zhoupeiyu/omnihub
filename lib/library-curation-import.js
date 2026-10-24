import {createHash} from 'node:crypto';
import {createLibraryCuration} from './library-curation.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceSnapshot = (db,userId) => hash(db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' ORDER BY id").all(userId));

// Resolve stable external IDs against the target database; local numeric IDs are never imported.
export function prepareCurationImport(db,decisions,digests) {
  const owner = db.prepare("SELECT id FROM users WHERE username='zane'").get();
  if (!owner) throw new Error('Curation owner missing');
  if (new Set(decisions.map(x=>x.externalId)).size !== decisions.length) throw new Error('Duplicate decisions');
  const rows = db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x'").all(owner.id);
  const byExternal = new Map(rows.map(row=>[row.external_id,row]));
  const source = id => {
    const row = byExternal.get(id);
    if (!row || hash([row.content,JSON.parse(row.metrics || '{}').quotedTweet?.full_text || '']) !== digests[id]) throw new Error(`Reviewed source changed: ${id}`);
    return row;
  };
  const plans = decisions.map(decision=>{
    const row = source(decision.externalId);
    let promptText = '';
    if (decision.extract) {
      const {start,end,quoted,brackets} = decision.extract;
      const text = quoted ? JSON.parse(row.metrics).quotedTweet.full_text : row.content;
      if (brackets) {
        const matches = [...text.matchAll(/「([^」]+)」/g)];
        if (matches.length !== 2) throw new Error('Prompt spans changed');
        promptText = matches.map(x=>x[1]).join('\n\n');
      } else {
        const from = text.indexOf(start);
        const to = end ? text.indexOf(end,from+start.length) : text.length;
        if (from < 0 || to < 0) throw new Error(`Prompt boundaries changed: ${decision.externalId}`);
        promptText = text.slice(from,to).trim();
      }
    }
    const relatedSourceIds = (decision.related || []).map(id=>source(id).id);
    const citations = [decision.externalId,...(decision.related || [])].map(id=>`[S:${id}]`).join(' ');
    return {id:row.id,data:{type:decision.type,title:decision.title || row.title,summary:decision.summary || '',
      body:decision.body ? `${decision.body}\n\n## 来源\n\n${citations}` : '',promptText,
      promptCategory:decision.promptCategory || '其他',tags:decision.tags || [],relatedSourceIds}};
  });
  return {ownerId:owner.id,sourceHash:sourceSnapshot(db,owner.id),plans};
}

export function applyCurationImport(db,plan) {
  if (sourceSnapshot(db,plan.ownerId) !== plan.sourceHash) throw new Error('Source changed before import');
  const store = createLibraryCuration(db);
  let written=0,preserved=0;
  for (const item of plan.plans) {
    const current = store.record(plan.ownerId,'source',String(item.id));
    if (current?.origin === 'manual' || JSON.stringify(current?.data) === JSON.stringify(item.data)) {preserved++;continue;}
    store.write(plan.ownerId,'source',String(item.id),current?.revision || 0,item.data,'reviewed');
    written++;
  }
  if (sourceSnapshot(db,plan.ownerId) !== plan.sourceHash) throw new Error('Original sources changed during import');
  return {written,preserved,sourceSnapshotUnchanged:true,methods:store.methods(plan.ownerId,{publicOnly:true}).length};
}
