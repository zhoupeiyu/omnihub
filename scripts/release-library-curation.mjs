import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,renameSync,chmodSync,readdirSync,readlinkSync,statSync,lstatSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const live='/root/omnihub';
const release='/root/omnihub-deploy/library-curation-20260928';
const mode=process.argv[2] || '--check';
if(process.argv.length>3 || !['--check','--apply','--rollback','--finalize'].includes(mode)) throw new Error('Use --check, --apply, --rollback or --finalize');
const manifest=JSON.parse(readFileSync(path.join(release,'manifest.json'),'utf8'));
const prefix='public/releases/library-curation-20260928/';
const frontend=['app.jsx','components.jsx','inbox.jsx','refinery.jsx','classification-editor.jsx','classification-editor.css','prompt-library.css','repository-workspace.css','repository-tab.js','repository-tab.html','repository-tab.css','repository-explorer-prototype.js','repository-explorer-prototype.css','repository-localization.js','repository-navigation.js','repository-translations.zh.js'];
frontend.push('repository-taxonomy.js');
const allowed=new Set(['public/index.html','lib/api.js','lib/knowledge-store.js','lib/library-curation.js',...frontend.map(x=>prefix+x)]);
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const candidate=path.join(release,'candidate');
const backupDir=path.join(release,'backup');
const database=path.join(live,'data/app.db');
if(manifest.files.length!==allowed.size || new Set(manifest.files.map(x=>x.path)).size!==allowed.size) throw new Error('Unexpected release manifest');
for(const item of manifest.files) if(!allowed.has(item.path) || hash(path.join(candidate,item.path))!==item.sha256) throw new Error('Candidate mismatch');
const inputPaths=['content/library-curation-20260928.mjs','lib/library-curation-import.js','content/library-seed.json','lib/library-seed.js'];
if(JSON.stringify(manifest.inputs.map(x=>x.path).sort())!==JSON.stringify([...inputPaths].sort())) throw new Error('Unexpected import inputs');
for(const item of manifest.inputs) if(hash(path.join(candidate,item.path))!==item.sha256) throw new Error('Import input changed');
const dependencyPaths=['lib/db.js','lib/auth.js','server.js','public/repository-taxonomy.js'];
if(JSON.stringify(manifest.dependencies.map(x=>x.path).sort())!==JSON.stringify([...dependencyPaths].sort())) throw new Error('Unexpected dependencies');
for(const item of manifest.dependencies) if(hash(path.join(live,item.path))!==item.sha256) throw new Error('Runtime dependency changed');
function stopped() {
  let state='';
  try {state=execFileSync('systemctl',['is-active','omnihub'],{encoding:'utf8'}).trim();}
  catch(error) {state=String(error.stdout || '').trim();}
  if(state!=='inactive') throw new Error('Stop omnihub before applying or rolling back');
  for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x) && Number(x)!==process.pid)) {
    let names=[];try {names=readdirSync(`/proc/${pid}/fd`);} catch {continue;}
    for(const name of names) {let target;try {target=readlinkSync(`/proc/${pid}/fd/${name}`);}catch{continue;}
      if([database,database+'-wal',database+'-shm'].includes(target)) throw new Error(`Another database process is open: ${pid}`);
    }
  }
}
function integrity(file) {
  if(!existsSync(file) || statSync(file).size===0) throw new Error('Database backup missing or empty');
  const check=new DatabaseSync(file,{readOnly:true});
  try {if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Backup integrity failure');} finally {check.close();}
}
function baseline() {
  for(const item of manifest.files) {const target=path.join(live,item.path);
    if(item.before===null ? existsSync(target) : !existsSync(target) || hash(target)!==item.before) throw new Error(`Live baseline changed: ${item.path}`);
  }
  for(const item of manifest.dependencies) if(hash(path.join(live,item.path))!==item.sha256) throw new Error('Runtime dependency changed');
}
function publish(from,to) {
  mkdirSync(path.dirname(to),{recursive:true});
  const temporary=to+'.library-curation-release';
  if(existsSync(temporary)) throw new Error('Stale release file');
  copyFileSync(from,temporary);chmodSync(temporary,0o644);renameSync(temporary,to);
}
function restore() {
  stopped();
  if(!existsSync(path.join(backupDir,'ready.json'))) throw new Error('Complete backup missing');
  if(existsSync(path.join(release,'accepted.json'))) throw new Error('Healthy release finalized; historical rollback is forbidden');
  const ready=JSON.parse(readFileSync(path.join(backupDir,'ready.json'),'utf8'));
  if(hash(path.join(backupDir,'app.db'))!==ready.databaseHash) throw new Error('Backup database changed');
  integrity(path.join(backupDir,'app.db'));
  if(existsSync(path.join(release,'deployed.json'))) {
    const deployed=JSON.parse(readFileSync(path.join(release,'deployed.json'),'utf8'));
    if(hash(database)!==deployed.databaseHash || (existsSync(database+'-wal') && statSync(database+'-wal').size>0)) throw new Error('Database changed after activation; do not discard later writes');
  }
  for(const item of manifest.files.filter(x=>x.before!==null)) {
    const saved=path.join(backupDir,item.path);
    if(hash(saved)!==item.before) throw new Error('Backup hash mismatch');
  }
  // Save the failed database and sidecars before replacing; never delete user data.
  const failed=path.join(backupDir,`failed-${Date.now()}`);
  mkdirSync(failed,{mode:0o700});
  for(const suffix of ['','-wal','-shm']) if(existsSync(database+suffix)) renameSync(database+suffix,path.join(failed,'app.db'+suffix));
  copyFileSync(path.join(backupDir,'app.db'),database);chmodSync(database,0o600);
  for(const item of manifest.files) {
    const target=path.join(live,item.path);
    if(item.before!==null) publish(path.join(backupDir,item.path),target);
    else if(existsSync(target)) {const saved=path.join(failed,item.path);mkdirSync(path.dirname(saved),{recursive:true});renameSync(target,saved);}
  }
  console.log(JSON.stringify({rolledBack:true,backup:backupDir,failed}));
}
if(mode==='--rollback') {restore();process.exit(0);}
if(mode==='--finalize') {
  if(!existsSync(path.join(release,'deployed.json'))) throw new Error('No activated release');
  for(const item of manifest.files) if(hash(path.join(live,item.path))!==item.sha256) throw new Error('Activated file mismatch');
  writeFileSync(path.join(release,'accepted.json'),JSON.stringify({acceptedAt:new Date().toISOString()}),{mode:0o600});
  // Remove only disposable rehearsal databases. The verified rollback backup stays.
  const disposable=[];
  const staging=[];
  for(const name of readdirSync(release)) {
    const target=path.join(release,name);
    if(/^rehearsal-\d+\.db(?:-wal|-shm)?$/.test(name) && lstatSync(target).isFile()) disposable.push(target);
    if(/^staging-data(?:-\d+)?$/.test(name) && lstatSync(target).isDirectory()) {
      staging.push(target);
      for(const file of ['app.db','app.db-wal','app.db-shm']) {
        const databaseCopy=path.join(target,file);
        if(existsSync(databaseCopy) && lstatSync(databaseCopy).isFile()) disposable.push(databaseCopy);
      }
    }
  }
  for(const file of disposable) unlinkSync(file);
  for(const directory of staging) if(readdirSync(directory).length===0) rmdirSync(directory);
  console.log(JSON.stringify({finalized:true,historicalDatabaseRollbackDisabled:true,rehearsalFilesRemoved:disposable.length,backupPreserved:backupDir}));process.exit(0);
}
if(mode==='--apply') stopped();
baseline();
const {decisions,sourceDigests}=await import(pathToFileURL(path.join(candidate,'content/library-curation-20260928.mjs')));
const {prepareCurationImport,applyCurationImport}=await import(pathToFileURL(path.join(candidate,'lib/library-curation-import.js')));
const {prepareLibrarySeed,applyLibrarySeed}=await import(pathToFileURL(path.join(candidate,'lib/library-seed.js')));
const seed=JSON.parse(readFileSync(path.join(candidate,'content/library-seed.json'),'utf8'));
const reader=new DatabaseSync(database,{readOnly:true});
const plan=prepareCurationImport(reader,decisions,sourceDigests);
const seedPlan=prepareLibrarySeed(reader,seed);
if(mode==='--check') {
  const testDb=path.join(release,`rehearsal-${Date.now()}.db`);
  await backup(reader,testDb);reader.close();chmodSync(testDb,0o600);
  const db=new DatabaseSync(testDb);
  const seeded=applyLibrarySeed(db,seedPlan);
  const result={...seeded,...applyCurationImport(db,plan)};
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Rehearsal integrity failure');
  db.close();
  writeFileSync(path.join(release,'checked.json'),JSON.stringify({files:manifest.files,inputs:manifest.inputs,sourceHash:plan.sourceHash,result,rehearsal:testDb}),{mode:0o600});
  console.log(JSON.stringify({checked:true,files:manifest.files.length,reviewed:plan.plans.length,...result,productionDatabaseChanged:false}));
  process.exit(0);
}
stopped();
if(existsSync(backupDir)) throw new Error('Backup already exists; reconcile before retry');
const check=JSON.parse(readFileSync(path.join(release,'checked.json'),'utf8'));
if(JSON.stringify(check.files)!==JSON.stringify(manifest.files) || JSON.stringify(check.inputs)!==JSON.stringify(manifest.inputs) || check.sourceHash!==plan.sourceHash) throw new Error('Rehearsal is stale');
mkdirSync(backupDir,{mode:0o700});
await backup(reader,path.join(backupDir,'app.db'));reader.close();chmodSync(path.join(backupDir,'app.db'),0o600);
integrity(path.join(backupDir,'app.db'));
baseline();
for(const item of manifest.files.filter(x=>x.before!==null)) {
  const saved=path.join(backupDir,item.path);mkdirSync(path.dirname(saved),{recursive:true,mode:0o700});
  copyFileSync(path.join(live,item.path),saved);chmodSync(saved,0o600);
}
writeFileSync(path.join(backupDir,'ready.json'),JSON.stringify({sourceHash:plan.sourceHash,files:manifest.files,databaseHash:hash(path.join(backupDir,'app.db'))}),{mode:0o600});
let writer;
try {
  writer=new DatabaseSync(database);
  const result={...applyLibrarySeed(writer,seedPlan),...applyCurationImport(writer,plan)};
  if(writer.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Database integrity failure');
  writer.close();writer=null;
  baseline();
  for(const item of [...manifest.files].sort((a,b)=>Number(a.path==='public/index.html')-Number(b.path==='public/index.html'))) {
    const target=path.join(live,item.path);publish(path.join(candidate,item.path),target);
    if(hash(target)!==item.sha256) throw new Error('Published hash mismatch');
  }
  writeFileSync(path.join(release,'deployed.json'),JSON.stringify({deployedAt:new Date().toISOString(),result,files:manifest.files,backup:backupDir,databaseHash:hash(database)}),{mode:0o600});
  console.log(JSON.stringify({deployed:true,...result,backup:backupDir}));
} catch(error) {
  writer?.close();restore();throw error;
}
