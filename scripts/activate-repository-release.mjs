import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, readdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const release='/root/omnihub-deploy/repositories-20260928';
const live='/root/omnihub';
const candidate=path.join(release,'candidate');
const manifest=JSON.parse(readFileSync(path.join(release,'manifest.json'),'utf8'));
const allowed=new Set(['lib/api.js','lib/db.js','lib/knowledge-store.js','public/components.jsx',
  'public/repository-taxonomy.js','public/repository-explorer-prototype.html',
  'public/repository-explorer-prototype.css','public/repository-explorer-prototype.js','public/repositories.html']);
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const command=(file,args)=>execFileSync(file,args,{encoding:'utf8',maxBuffer:2_000_000,stdio:['ignore','pipe','pipe']});
if(process.argv.length>3||!['--check','--apply'].includes(process.argv[2]||'--check')) throw new Error('Use --check or --apply');
if(manifest.files.length!==allowed.size||new Set(manifest.files.map(item=>item.path)).size!==allowed.size) throw new Error('Unexpected deployment manifest');
for(const item of manifest.files) {
  if(!allowed.has(item.path)||digest(path.join(candidate,item.path))!==item.sha256) throw new Error('Candidate hash mismatch');
  const current=path.join(live,item.path);
  if(item.before===null ? existsSync(current) : !existsSync(current)||digest(current)!==item.before) throw new Error(`Live file changed: ${item.path}`);
}
for(const [file,expected] of Object.entries(manifest.tools)) if(digest(path.join(candidate,file))!==expected) throw new Error('Release tool hash mismatch');
const packet=path.join(release,'repositories.json');
if(digest(packet)!==manifest.packetSha256) throw new Error('Release data hash mismatch');
console.log(command(process.execPath,[path.join(candidate,'scripts/repository-release.mjs'),'check',path.join(live,'data/app.db'),packet]).trim());
if(process.argv[2]!=='--apply') process.exit(0);

const rollback=path.join(release,'production-backup');
if(existsSync(rollback)) throw new Error('Existing activation backup; reconcile before retrying');
mkdirSync(rollback,{mode:0o700});
for(const item of manifest.files.filter(item=>item.before!==null)) {
  const destination=path.join(rollback,item.path);
  mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  copyFileSync(path.join(live,item.path),destination);chmodSync(destination,0o600);
}
const installed=[];
let stopped=false;
let trafficResumed=false;
try {
  command('systemctl',['stop','omnihub.service']);stopped=true;
  const result=JSON.parse(command(process.execPath,[path.join(candidate,'scripts/repository-release.mjs'),'apply',path.join(live,'data/app.db'),packet,rollback]));
  const before=new DatabaseSync(result.backupPath,{readOnly:true});
  const after=new DatabaseSync(path.join(live,'data/app.db'),{readOnly:true});
  try {
    for(const {name} of before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const columns=before.prepare(`PRAGMA table_info("${name}")`).all().map(row=>`"${row.name}"`).join(',');
      const original=before.prepare(`SELECT ${columns} FROM "${name}" ORDER BY rowid`).all();
      const current=after.prepare(`SELECT ${columns} FROM "${name}" ORDER BY rowid`).all();
      if(name==='inbox') {
        if(JSON.stringify(current.slice(0,original.length))!==JSON.stringify(original)) throw new Error('Existing inbox changed');
        const added=current.slice(original.length);
        assert.equal(added.length,4);
        assert.ok(added.every(row=>row.user_id===result.targetUserId&&row.status==='ignored'&&row.visibility==='unreviewed'));
      } else if(JSON.stringify(current)!==JSON.stringify(original)) throw new Error(`Existing table changed: ${name}`);
    }
  } finally {before.close();after.close();}
  for(const item of manifest.files) {
    const target=path.join(live,item.path);
    const temporary=`${target}.release-20260928`;
    if(existsSync(temporary)) throw new Error('Stale activation file');
    copyFileSync(path.join(candidate,item.path),temporary);chmodSync(temporary,0o644);
    renameSync(temporary,target);installed.push(item);
    assert.equal(digest(target),item.sha256);
  }
  trafficResumed=true;
  command('systemctl',['start','omnihub.service']);
  let response;
  for(let attempt=0;attempt<30;attempt++) {
    try {response=await fetch('http://127.0.0.1:4320/api/repositories',{signal:AbortSignal.timeout(1000)});if(response.ok) break;} catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(response?.ok,'New repository API failed');
  const repos=await response.json();
  assert.equal(repos.length,593);
  assert.ok(repos.every(repo=>repo.metadata?.classification?.uses?.length));
  assert.equal(command('systemctl',['is-active','omnihub.service']).trim(),'active');
  writeFileSync(path.join(release,'deployed.json'),JSON.stringify({deployedAt:new Date().toISOString(),...result,files:manifest.files,originalTables:'preserved'},null,2),{mode:0o600});
  console.log(JSON.stringify({deployed:true,...result,files:installed.length,originalTables:'preserved'}));
} catch(error) {
  // Once traffic resumes, keep additive data changes rather than losing new user writes.
  if(stopped) command('systemctl',['stop','omnihub.service']);
  for(const item of installed.reverse()) {
    const target=path.join(live,item.path);
    if(item.before!==null) copyFileSync(path.join(rollback,item.path),target);
    else {const saved=path.join(rollback,'new-files',item.path);mkdirSync(path.dirname(saved),{recursive:true,mode:0o700});renameSync(target,saved);}
  }
  const databaseBackup=readdirSync(rollback).find(name=>/^app-before-repositories-\d+\.db$/.test(name));
  if(stopped&&!trafficResumed&&databaseBackup) {
    const original=new DatabaseSync(path.join(rollback,databaseBackup),{readOnly:true});
    try {await backup(original,path.join(live,'data/app.db'));} finally {original.close();}
  }
  if(stopped) command('systemctl',['start','omnihub.service']);
  throw error;
}
