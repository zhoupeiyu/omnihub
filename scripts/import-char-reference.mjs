import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseCharCatalogue, CHAR_COLLECTION } from '../lib/reference-char-catalogue.js';
import { createReferenceStorage, writeReferenceJson } from '../lib/reference-storage.js';
const { values } = parseArgs({ options: { directory: { type:'string' }, snapshot:{type:'string'}, commit:{type:'string'}, apply:{type:'boolean'}, 'local-only':{type:'boolean'} } });
if (!values.directory || !values.snapshot || !/^[a-f0-9]{40}$/.test(values.commit || '')) throw new Error('invalid_import_arguments');
const directory = path.resolve(values.directory), file = path.join(directory,'manifest.json');
const rows = parseCharCatalogue(await readFile(path.join(values.snapshot,'data.js'),'utf8'));
const lock = path.join(directory,'sync.lock');
await writeFile(lock, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}), {flag:'wx',mode:0o600});
try {
  const raw = await readFile(file), before = JSON.parse(raw);
  if (before.version !== 1 || !Array.isArray(before.items)) throw new Error('invalid_manifest');
  const old = new Map(before.items.map(x=>[x.id,x]));
  if (rows.some(x=>old.has(x.id) && old.get(x.id).collectionId !== CHAR_COLLECTION.id)) throw new Error('collection_conflict');
  console.log(JSON.stringify({mode:values.apply?'apply':'dry-run',total:rows.length,existing:rows.filter(x=>old.has(x.id)).length,counts:Object.fromEntries(['face','costume','pose'].map(k=>[k,rows.filter(x=>x.kind===k).length]))}));
  if (values.apply) {
    const storage = createReferenceStorage({directory, env:values['local-only']?{}:process.env});
    if (!storage.remote && !values['local-only']) throw new Error('private_cloud_storage_required');
    const backup = path.join(directory,'import-backups',`char-${Date.now()}`);
    await mkdir(backup,{recursive:true,mode:0o700}); await writeFile(path.join(backup,'manifest.json'),raw,{mode:0o600});
    let cursor=0, done=0; const failures=[];
    await Promise.all(Array.from({length:4},async()=>{
      while(cursor<rows.length){
        const row=rows[cursor++];
        try {
          const previous=old.get(row.id);
          const thumbnail=previous?.thumbnail || await storage.put(await readFile(path.join(values.snapshot,row.thumbnailPath)),{cache:true});
          let original=previous?.original;
          if(!original){
            for(let attempt=0;attempt<3;attempt++){
              try { const response=await fetch(row.originalSourceUrl,{signal:AbortSignal.timeout(30000),redirect:'error'});
                if(!response.ok) throw new Error('original_download_failed');
                const bytes=Buffer.from(await response.arrayBuffer());
                original=await storage.put(bytes); break;
              } catch(error){if(attempt===2) throw error;}
            }
          }
          old.set(row.id,{...row,thumbnail,original,sourceCommit:values.commit,addedAt:previous?.addedAt||new Date().toISOString()});
        }catch{failures.push(row.id);}
        done++;if(done%100===0) console.log(JSON.stringify({completed:done,failed:failures.length}));
      }
    }));
    if(failures.length) { console.log(JSON.stringify({failures})); throw new Error('incomplete_import_manifest_unchanged'); }
    await writeReferenceJson(file,{...before,updatedAt:new Date().toISOString(),items:[...old.values()]});
    console.log(JSON.stringify({imported:rows.length,total:old.size,backup}));
  }
}finally{await unlink(lock);}
