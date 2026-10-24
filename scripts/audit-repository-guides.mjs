import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {guideFilename,extractDocument,unsafeCommand,unverifiedProseCommand,boundedResponse} from '../lib/repository-guide-pipeline.js';
import {validateRepositoryGuide} from '../public/repository-guides.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=path.resolve(process.argv.slice(2).find(x=>!x.startsWith('--'))||path.join(root,'data/repository-guides',new Date().toISOString().slice(0,10)));
const assets=path.join(root,'public/assets/repository-guides');
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
const inventory=await readJson(path.join(run,'inventory.json'));
const allowed=new Set(inventory.keys),failures=[],totals={publicInventory:allowed.size,ready:0,partial:0,unavailable:0,withMedia:0,media:0,bytes:0};
let publicVerifiedAt=null;
if(process.argv.includes('--verify-public')) {
  const response=await fetch('https://omnihub.noxhub.org/api/repositories',{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Public inventory verification failed');
  const value=JSON.parse((await boundedResponse(response,8_000_000)).toString());
  const keys=new Set((Array.isArray(value)?value:value.repositories).map(x=>x.key.toLowerCase()));
  if(keys.size!==allowed.size||[...allowed].some(key=>!keys.has(key)))failures.push({reason:'public_inventory_changed'});
  else publicVerifiedAt=new Date().toISOString();
}
const files=(await readdir(assets)).filter(f=>f.endsWith('.json'));
for(const file of files) {
  const guide=await readJson(path.join(assets,file));
  if(/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKID[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(JSON.stringify(guide)))failures.push({file,reason:'credential_like_content'});
  if(!allowed.has(guide.key)){failures.push({file,reason:'not_in_public_inventory'});continue;}
  if(guideFilename(guide.key)!==file)failures.push({file,reason:'key_filename_mismatch'});
  if(!validateRepositoryGuide(guide,guide.key))failures.push({file,reason:'invalid_frontend_schema'});
  totals[guide.status]++;totals.bytes+=(await stat(path.join(assets,file))).size;
  if(guide.media?.length)totals.withMedia++;
  for(const media of guide.media||[]) {
    totals.media++;
    if(!/^\/assets\/repository-guides\/(?:media-[a-f0-9]{24}|toonflow-[a-z]+)\.webp$/.test(media.url)){failures.push({file,reason:'non_local_media'});continue;}
    try {const bytes=await readFile(path.join(root,'public',media.url));if(bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP')failures.push({file,reason:'invalid_image_signature'});}
    catch {failures.push({file,reason:'missing_media_file'});}
  }
  if(guide.curated||guide.status==='unavailable')continue;
  const source=await readJson(path.join(run,'sources',file));
  if(source.status!=='collected'||!source.documents?.length)failures.push({file,reason:'missing_official_evidence'});
  const blocks=source.documents.flatMap(extractDocument).flatMap(d=>d.codes).map(c=>c.code);
  for(const step of guide.steps||[]) {
    if(!step.link?.url||!source.documents.some(d=>step.link.url.startsWith(d.sourceUrl+'#L')||step.link.url.startsWith(d.sourceUrl+'?plain=1#L')))failures.push({file,reason:'uncited_step'});
    if(unverifiedProseCommand(step.text,source.documents))failures.push({file,reason:'unverified_prose_command',title:step.title});
    if(!step.code)continue;
    if(unsafeCommand(step.code))failures.push({file,reason:'unsafe_copyable_code'});
    // A displayed block may concatenate source blocks, but cannot alter their contents.
    let rest=step.code;
    while(rest) {
      const exactExcerpt=blocks.some(b=>('\n'+b+'\n').includes('\n'+rest+'\n'));
      if(exactExcerpt)break;
      const block=blocks.filter(b=>rest===b||rest.startsWith(b+'\n\n')).sort((a,b)=>b.length-a.length)[0];
      if(!block){failures.push({file,reason:'code_not_verbatim'});break;}
      rest=rest.slice(block.length).replace(/^\n\n/,'');
    }
  }
}
for(const key of allowed)if(!files.includes(guideFilename(key)))failures.push({key,reason:'missing_guide'});
const report={checkedAt:new Date().toISOString(),publicVerifiedAt,totals,passed:failures.length===0,failures};
await writeFile(path.join(run,'acceptance.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({totals,passed:report.passed,failures:failures.length,samples:failures.slice(0,15)},null,2));
if(failures.length)process.exitCode=1;
