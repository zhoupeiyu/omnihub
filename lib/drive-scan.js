import {DRIVE_COLLECTIONS} from './openlist-library.js';
export function createDriveScanner(db,{list,remember,delay=120,concurrency=3}) {
 db.exec(`CREATE TABLE IF NOT EXISTS drive_scan_jobs(user_id INTEGER PRIMARY KEY,state TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER);
 CREATE TABLE IF NOT EXISTS drive_scan_dirs(user_id INTEGER NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',page INTEGER NOT NULL DEFAULT 1,total INTEGER,seen INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(user_id,path));`);
 db.exec('CREATE TABLE IF NOT EXISTS drive_scan_seen(user_id INTEGER NOT NULL,path TEXT NOT NULL,parent TEXT NOT NULL,PRIMARY KEY(user_id,path))');
 db.prepare("UPDATE drive_scan_dirs SET state='pending' WHERE state='working'").run();
 const active=new Set();
 const enqueue=db.prepare('INSERT OR IGNORE INTO drive_scan_dirs(user_id,path) VALUES (?,?)');
 function status(id) {const job=db.prepare('SELECT state,started_at,finished_at FROM drive_scan_jobs WHERE user_id=?').get(id);if(!job)return {state:'not_started',directories:0,done:0,pending:0,failed:0,files:0};const counts=db.prepare('SELECT state,count(*) n FROM drive_scan_dirs WHERE user_id=? GROUP BY state').all(id);const count=s=>counts.find(r=>r.state===s)?.n||0;return {...job,directories:counts.reduce((n,r)=>n+r.n,0),done:count('done'),pending:count('pending')+count('working'),failed:count('failed'),files:db.prepare("SELECT count(*) n FROM drive_index WHERE user_id=? AND kind!='folder' AND updated_at>=?").get(id,job.started_at).n,failures:db.prepare("SELECT path,error FROM drive_scan_dirs WHERE user_id=? AND state='failed' LIMIT 30").all(id)};}
 async function run(id){if(active.has(id))return;active.add(id);try{
  const worker=async()=>{while(db.prepare('SELECT state FROM drive_scan_jobs WHERE user_id=?').get(id)?.state==='running'){
   const row=db.prepare("SELECT * FROM drive_scan_dirs WHERE user_id=? AND state='pending' ORDER BY rowid LIMIT 1").get(id);
   if(!row){if(db.prepare("SELECT count(*) n FROM drive_scan_dirs WHERE user_id=? AND state='working'").get(id).n){await new Promise(r=>setTimeout(r,100));continue;}break;}
   db.prepare("UPDATE drive_scan_dirs SET state='working' WHERE user_id=? AND path=?").run(id,row.path);
   try{
    const data=await list(id,row.path,row.page);
    if(!Number.isInteger(data.total)||data.total<0 || (!data.items.length && row.seen<data.total))throw new Error('目录分页返回不完整');
    db.exec('SAVEPOINT drive_scan_page');
    try{for(const item of data.items){const result=db.prepare('INSERT OR IGNORE INTO drive_scan_seen VALUES (?,?,?)').run(id,item.path,row.path);if(!result.changes)throw new Error('分页重复或目录在扫描期间发生变化');}remember(id,data);for(const item of data.items)if(item.isDir)enqueue.run(id,item.path);
     const seen=row.seen+data.items.length;const done=seen>=data.total;
     db.prepare('UPDATE drive_scan_dirs SET state=?,page=?,total=?,seen=?,attempts=0,error=NULL WHERE user_id=? AND path=?').run(done?'done':'pending',row.page+1,data.total,seen,id,row.path);db.exec('RELEASE drive_scan_page');
    }catch(e){db.exec('ROLLBACK TO drive_scan_page');db.exec('RELEASE drive_scan_page');throw e;}
   }catch(e){const attempts=row.attempts+1;db.prepare('UPDATE drive_scan_dirs SET state=?,attempts=?,error=? WHERE user_id=? AND path=?').run(attempts>=3?'failed':'pending',attempts,String(e.message).slice(0,200),id,row.path);await new Promise(r=>setTimeout(r,Math.min(5000,attempts*1000)));}
   if(delay)await new Promise(r=>setTimeout(r,delay));
  }};await Promise.all(Array.from({length:concurrency},()=>worker()));
  const summary=status(id);if(summary.state==='running' && !summary.pending)db.prepare('UPDATE drive_scan_jobs SET state=?,finished_at=? WHERE user_id=?').run(summary.failed?'incomplete':'complete',Date.now(),id);
 }finally{active.delete(id);}}
 function start(id,{retry=false}={}){const current=status(id);if(current.state==='running'){void run(id);return current;}
  if(retry && current.state==='incomplete'){db.prepare("UPDATE drive_scan_dirs SET state='pending',attempts=0 WHERE user_id=? AND state='failed'").run(id);db.prepare("UPDATE drive_scan_jobs SET state='running',finished_at=NULL WHERE user_id=?").run(id);}
  else {db.exec('SAVEPOINT drive_scan_start');try{db.prepare('DELETE FROM drive_scan_dirs WHERE user_id=?').run(id);db.prepare('DELETE FROM drive_scan_seen WHERE user_id=?').run(id);db.prepare("INSERT INTO drive_scan_jobs VALUES (?,'running',?,NULL) ON CONFLICT(user_id) DO UPDATE SET state='running',started_at=excluded.started_at,finished_at=NULL").run(id,Date.now());for(const root of DRIVE_COLLECTIONS)enqueue.run(id,root.root);db.exec('RELEASE drive_scan_start');}catch(e){db.exec('ROLLBACK TO drive_scan_start');db.exec('RELEASE drive_scan_start');throw e;}}
  void run(id);return status(id);
 }
 return {start,status,resume(){for(const r of db.prepare("SELECT user_id FROM drive_scan_jobs WHERE state='running'").all())void run(r.user_id);}};
}
