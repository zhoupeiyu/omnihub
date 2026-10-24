import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const root=process.cwd();
const directory=path.join(root,'data/deployment/library-curation-20260928');
const refresh=process.argv[2]==='--refresh';
if(process.argv.length>3 || (process.argv[2] && !refresh)) throw new Error('Use --refresh only for a prepared, unactivated release');
if(existsSync(directory) && !refresh) throw new Error('Release directory already exists; reconcile it instead of overwriting');
const previous=refresh ? JSON.parse(readFileSync(path.join(directory,'manifest.json'),'utf8')) : null;
const prefix='public/releases/library-curation-20260928/';
const frontend=['app.jsx','components.jsx','inbox.jsx','refinery.jsx','classification-editor.jsx','classification-editor.css','prompt-library.css','repository-workspace.css','repository-tab.js','repository-tab.html','repository-tab.css','repository-explorer-prototype.js','repository-explorer-prototype.css','repository-localization.js','repository-navigation.js','repository-translations.zh.js'];
frontend.push('repository-taxonomy.js');
const targets=['public/index.html','lib/api.js','lib/knowledge-store.js','lib/library-curation.js',...frontend.map(x=>prefix+x)];
const inputs=['content/library-curation-20260928.mjs','lib/library-curation-import.js','lib/library-seed.js','content/library-seed.json'];
const dependencies=['lib/db.js','lib/auth.js','server.js','public/repository-taxonomy.js'];
const hash=value=>createHash('sha256').update(value).digest('hex');
// SSH returns code-file hashes only; no credentials, database rows or configuration are read.
const remoteCode=`const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(${JSON.stringify([...targets,...dependencies])}.map(p=>({path:p,hash:fs.existsSync('/root/omnihub/'+p)?c.createHash('sha256').update(fs.readFileSync('/root/omnihub/'+p)).digest('hex'):null}))));`;
const remote=JSON.parse(execFileSync('ssh',['-p','22','-o','BatchMode=yes','tencent-sv','node'],{encoding:'utf8',input:remoteCode}));
const before=new Map(remote.map(x=>[x.path,x.hash]));
if(previous) for(const item of previous.files) if(before.get(item.path)!==item.before) throw new Error('Live baseline changed; do not refresh');
for(const file of dependencies) if(hash(readFileSync(path.join(root,file)))!==before.get(file)) throw new Error(`Dependency mismatch: ${file}`);
const candidate=path.join(directory,'candidate');
mkdirSync(candidate,{recursive:true,mode:0o700});
const write=(file,value)=>{const target=path.join(candidate,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,value,{mode:0o600});};
for(const file of ['lib/api.js','lib/knowledge-store.js','lib/library-curation.js',...inputs.filter(x=>x!=='content/library-seed.json'),...dependencies]) write(file,readFileSync(path.join(root,file)));
for(const file of frontend) {
  let content=readFileSync(path.join(root,'public',file),'utf8');
  if(file==='repository-tab.js') for(const name of ['repository-explorer-prototype.js','repository-tab.html','repository-explorer-prototype.css','repository-tab.css']) content=content.replaceAll('/'+name,'/'+prefix.slice(7)+name);
  write(prefix+file,content);
}
let index=readFileSync(path.join(root,'public/index.html'),'utf8');
for(const file of frontend) for(const lead of ['','/']) index=index.replaceAll(`="${lead}${file}"`,`="/${prefix.slice(7)}${file}"`);
write('public/index.html',index);
write('package.json','{"type":"module"}\n');
if(!existsSync(path.join(candidate,'content/library-seed.json'))) await import('./export-library-seed.mjs');
const manifest={files:targets.map(file=>({path:file,before:before.get(file),sha256:hash(readFileSync(path.join(candidate,file)))})),
  inputs:inputs.map(file=>({path:file,sha256:hash(readFileSync(path.join(candidate,file)))})),
  dependencies:dependencies.map(file=>({path:file,sha256:before.get(file)}))};
writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
copyFileSync(path.join(root,'scripts/release-library-curation.mjs'),path.join(directory,'release.mjs'));
console.log(JSON.stringify({directory,files:targets.length,sourceRecords:34,privateImportFiles:inputs.length}));
