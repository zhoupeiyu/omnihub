import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

const directory = new URL('../data/audits/x-classification-20260928/',import.meta.url);
const readJson = name => JSON.parse(readFileSync(new URL(name,directory),'utf8'));
const readLines = name => readFileSync(new URL(name,directory),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
// Only reviewed ranges are eligible. Early machine-generated baseline rows are excluded.
const segments = [
  [[0,150,'decisions-0.jsonl'],[150,240,'decisions-0-middle.jsonl'],[240,368,'decisions-0-tail.jsonl']],
  [[0,110,'decisions-1.jsonl'],[110,240,'decisions-1-middle.jsonl'],[240,368,'decisions-1-tail.jsonl']],
  [[0,160,'decisions-2.jsonl'],[160,240,'decisions-2-middle.jsonl'],[240,368,'decisions-2-tail.jsonl']],
  [[0,220,'decisions-3.jsonl'],[220,320,'decisions-3-tail.jsonl'],[320,368,'decisions-3-final.jsonl']],
];
const types = new Set(['prompt','method','repository','resource','knowledge','idea','reference','unavailable']);
const verdicts = new Set(['keep','reclassify','split','insufficient']);
const required = ['id','verdict','primary','secondary','tool','purpose','reason','evidence','suggestedTitle','uncertainty'];
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/gu,'');
const decisions=[],sources=[],missing=[],issues=[];
for (let shard=0;shard<segments.length;shard++) {
  const input=readJson(`sources-${shard}.json`);
  sources.push(...input);
  for (const [start,end,name] of segments[shard]) {
    if (!existsSync(new URL(name,directory))) {missing.push({name,start,end});continue;}
    const rows=readLines(name),byId=new Map(rows.map(row=>[row.id,row]));
    if (rows.length !== byId.size) issues.push({file:name,issue:'duplicate ids'});
    for (const row of input.slice(start,end)) {
      const decision=byId.get(row.id);
      if (!decision) missing.push({file:name,id:row.id});
      else decisions.push({...decision,sourceHash:row.sourceHash});
    }
  }
}
const local=readJson('local-only.json');
sources.push(...local);
const localById=new Map(readLines('decisions-local.jsonl').map(row=>[row.id,row]));
for (const source of local) {
  const decision=localById.get(source.id);
  if (!decision) missing.push({file:'decisions-local.jsonl',id:source.id});
  else decisions.push({...decision,sourceHash:source.sourceHash});
}
const sourceById=new Map(sources.map(row=>[row.id,row]));
for (const row of decisions) {
  if (required.some(key=>!(key in row)) || !types.has(row.primary) || !verdicts.has(row.verdict) ||
    !Array.isArray(row.secondary) || row.secondary.some(value=>!types.has(value))) issues.push({id:row.id,issue:'schema'});
  for (const key of ['tool','purpose','reason','suggestedTitle']) {
    if (typeof row[key] !== 'string' || !row[key].trim() || !row[key].isWellFormed()) issues.push({id:row.id,issue:`invalid ${key}`});
  }
  const source=sourceById.get(row.id);
  const evidence=normalize(row.evidence);
  const material=normalize([source.text,source.quote,...source.links].join('\n'));
  if (evidence && !material.includes(evidence)) issues.push({id:row.id,issue:'evidence is not a verbatim span'});
  if (!evidence && source.text) issues.push({id:row.id,issue:'missing evidence'});
}
const db=new DatabaseSync(new URL('../data/app.db',import.meta.url),{readOnly:true});
const user=db.prepare("SELECT id FROM users WHERE username='zane'").get();
const actual=db.prepare("SELECT * FROM inbox WHERE user_id=? AND source='x' ORDER BY id").all(user.id);
if(actual.length!==sources.length) issues.push({issue:'source count drift'});
for(const row of actual) {
  const source=sourceById.get(row.id);
  const quote=JSON.parse(row.metrics || '{}').quotedTweet?.full_text || '';
  const hash=createHash('sha256').update(JSON.stringify([row.content,quote,row.links,row.media,row.ai_extract])).digest('hex');
  if(!source || source.sourceHash!==hash || source.status!==row.status || source.visibility!==row.visibility) issues.push({id:row.id,issue:'source changed since snapshot'});
}
db.close();
const countBy = key => decisions.reduce((acc,row)=>(acc[row[key]]=(acc[row[key]]||0)+1,acc),{});
const result={expected:sources.length,assembled:decisions.length,publicExpected:1472,localOnly:385,
  missingBody:375,missing,issues,byVerdict:countBy('verdict'),byType:countBy('primary'),
  scope:'Database text and quoted text only. Linked articles and uncaptioned media were not reviewed. No database writes.',
  complete:missing.length===0 && issues.length===0 && new Set(decisions.map(row=>row.id)).size===sources.length};
console.log(JSON.stringify(process.argv.includes('--details') ? result : {
  ...result,missingCount:missing.length,issueCount:issues.length,
  missing:missing.slice(0,8),issues:issues.slice(0,30),
},null,2));
if(process.argv.includes('--write')) {
  if(!result.complete) throw new Error('Audit is incomplete; no final output written.');
  writeFileSync(new URL('decisions-final.jsonl',directory),decisions.sort((a,b)=>a.id-b.id).map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  writeFileSync(new URL('validation.json',directory),JSON.stringify(result,null,2),{mode:0o600});
}
if (!result.complete) process.exitCode=1;
