import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportRepositoryRelease, validateRepositoryRelease, importRepositoryRelease } from '../lib/repository-release.js';

const [mode,database,packetFile,...rest]=process.argv.slice(2);
if(!['export','check','apply'].includes(mode)||!path.isAbsolute(database||'')||!path.isAbsolute(packetFile||'')) throw new Error('Usage: repository-release.mjs export|check|apply /absolute/app.db /absolute/packet.json [backup-dir]');
const db=new DatabaseSync(database,{readOnly:mode!=='apply'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
try {
  if(mode==='export') {
    const packet=exportRepositoryRelease(db,'zane');
    writeFileSync(packetFile,JSON.stringify(packet),{mode:0o600});
    console.log(JSON.stringify({exported:packet.expectedCount,public:packet.expectedPublicCount}));
  } else {
    const packet=JSON.parse(readFileSync(packetFile,'utf8'));
    if(packet.username!=='zane'||packet.expectedCount!==597||packet.expectedPublicCount!==593) throw new Error('Unexpected release scope');
    const plan=validateRepositoryRelease(db,packet);
    if(mode==='check') console.log(JSON.stringify({checked:plan.rows.length,public:plan.visible,targetUserId:plan.userId,archivedSourcesToAdd:plan.archivedSources.size}));
    else {
      const backupDir=rest[0];
      if(!path.isAbsolute(backupDir||'')) throw new Error('Explicit backup directory required');
      mkdirSync(backupDir,{recursive:true,mode:0o700});
      const backupPath=path.join(backupDir,`app-before-repositories-${Date.now()}.db`);
      await backup(db,backupPath);chmodSync(backupPath,0o600);
      // Initialize only after the untouched production database has been backed up.
      process.env.OMNIHUB_DATA_DIR=path.dirname(database);
      const {db:storeDb}=await import(pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname),'../lib/db.js')).href);
      await import('../lib/knowledge-store.js');
      storeDb.close();
      console.log(JSON.stringify({...importRepositoryRelease(db,packet),backupPath}));
    }
  }
} finally {db.close();}
