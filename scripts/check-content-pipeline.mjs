import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// Explicitly isolated evaluation only. Never defaults to the live database or enables a resident worker.
const option=name=>{const index=process.argv.indexOf(name);return index<0?'':process.argv[index+1]||'';};
const directory=option('--data-dir');
const limit=Number(option('--limit')||5);
if(!path.isAbsolute(directory)||!Number.isInteger(limit)||limit<1||limit>10||!process.argv.includes('--run')){
  console.error('Usage: node scripts/check-content-pipeline.mjs --data-dir /absolute/isolated-copy --limit 5 --run');process.exit(2);
}
if(directory===path.resolve('data'))throw new Error('Use an isolated database copy for calibration');
const check=new DatabaseSync(path.join(directory,'app.db'),{readOnly:true});
const owner=check.prepare("SELECT id FROM users WHERE username='zane'").get();
if(!owner)throw new Error('Owner not found');
const selected=[];
const explicit=option('--ids').split(',').filter(Boolean).map(Number);
if(explicit.some(id=>!Number.isSafeInteger(id)||id<1)||explicit.length>limit)throw new Error('Invalid sample IDs');
for(const id of explicit){
  if(!check.prepare("SELECT 1 FROM inbox WHERE id=? AND user_id=? AND source='x' AND status='pending' AND visibility='public'").get(id,owner.id))throw new Error('Samples must be public bookmarks');
  selected.push(id);
}
for(const kind of ['knowledge','prompt','resource','']){
  if(explicit.length)break;
  const rows=check.prepare(`SELECT id FROM inbox WHERE user_id=? AND source='x' AND status='pending' AND visibility='public'
    AND ai_type=? AND length(content) BETWEEN 120 AND 7000 ORDER BY id DESC LIMIT ?`).all(owner.id,kind,Math.ceil(limit/4));
  selected.push(...rows.map(r=>r.id));
}
check.close();
process.env.OMNIHUB_DATA_DIR=directory;
const {db}=await import('../lib/db.js');
const {createContentStore}=await import('../lib/content-store.js');
const {createContentPipeline}=await import('../lib/content-pipeline.js');
const {createContentModel}=await import('../lib/content-model.js');
const store=createContentStore(db);
const before=JSON.stringify(db.prepare('SELECT id,content,media,visibility,status FROM inbox ORDER BY id').all());
store.seed(owner.id);store.configure(owner.id,{includePrivate:false,sampleSize:limit});store.setEnabled(owner.id,true);
// Freeze unrelated queued work in this disposable copy; selected samples span existing types.
const ids=selected.slice(0,limit);
if(process.argv.includes('--retry'))for(const id of ids){
  const jobs=db.prepare("SELECT j.id FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id WHERE s.inbox_id=? AND j.version=?").all(id,store.version);
  for(const job of jobs)store.retry(owner.id,job.id);
}
db.prepare(`UPDATE content_jobs SET state='protected' WHERE snapshot_id NOT IN (SELECT id FROM content_snapshots WHERE inbox_id IN (${ids.map(()=>'?').join(',')}))`).run(...ids);
const observedFetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(process.argv.includes('--diagnostics'))try{
    const data=await response.clone().json();
    if(data.content)console.log(JSON.stringify({modelResponse:{status:response.status,stop:data.stop_reason,
      blocks:data.content.map(block=>({type:block.type,chars:typeof block.text==='string'?block.text.length:0})),usage:data.usage}}));
  }catch{/* Never log upstream bodies or credentials. */}
  return response;
};
const pipeline=createContentPipeline({store,model:createContentModel({fetchImpl:observedFetch}),budget:{daily:40,hourly:40},
  onError:error=>{if(process.argv.includes('--diagnostics'))console.log(JSON.stringify({validationFailure:error.code,
    detail:error.code==='invalid_result'?error.message:undefined}));}});
try{
  for(let i=0;i<ids.length;i++){
    const result=await pipeline.run(owner.id);if(!result.processed)break;
    const state=store.status(owner.id);
    console.log(JSON.stringify({processed:i+1,counts:state.counts,calls:state.callsToday}));
  }
}finally{
  store.setEnabled(owner.id,false);
  const unchanged=before===JSON.stringify(db.prepare('SELECT id,content,media,visibility,status FROM inbox ORDER BY id').all());
  const results=ids.map(id=>{const r=store.resultFor(id,{includeReview:true});return {sourceId:id,kind:r?.kind,state:r?.state,score:r?.score,summary:r?.article.summary||'',limitations:r?.article.limitations||[]};});
  console.log(JSON.stringify({originalsUnchanged:unchanged,version:store.version,results}));db.close();
  if(!unchanged)process.exitCode=1;
}
