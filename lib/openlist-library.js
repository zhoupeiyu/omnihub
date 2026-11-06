// Only these user-approved folders are exposed through the library.
export const DRIVE_COLLECTIONS = [
  ['courses','课程教程','30-课程教程','系统课程与学习资料'],
  ['materials','素材库','80-素材库','图片、音效与创作素材'],
  ['books','电子书','20-电子书','阅读、思维与生活'],
  ['ai','AI 资源','50-AI资源','AI 创作、工具与智能体'],
  ['development','技术开发','60-技术开发','编程、架构与工程实践'],
  ['business','副业变现','40-副业变现','内容运营与商业实践'],
  ['finance','投资理财','70-投资理财','财经、投资与经济学'],
].map(([id,label,folder,description])=>({id,label,root:'/夸克网盘/'+folder,description}));
export function driveCollection(target) { return DRIVE_COLLECTIONS.find(c=>target === c.root || target.startsWith(c.root+'/')); }
export function driveKind(name, isDir=false) {
  if (isDir) return 'folder';
  const ext=name.split('.').at(-1).toLowerCase();
  return /^(mp4|webm|m4v|mov|mkv)$/.test(ext)?'video':/^(mp3|m4a|wav|ogg|flac|aac)$/.test(ext)?'audio':/^(jpg|jpeg|png|gif|webp|avif)$/.test(ext)?'image':ext==='pdf'?'pdf':/^(txt|md|csv|json|log)$/.test(ext)?'text':ext==='epub'?'epub':'file';
}
export function createDriveIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS drive_index(user_id INTEGER NOT NULL,path TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,path));
  CREATE INDEX IF NOT EXISTS drive_index_parent ON drive_index(user_id,parent);
  CREATE TABLE IF NOT EXISTS drive_recent(user_id INTEGER NOT NULL,path TEXT NOT NULL,position REAL NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,opened_at INTEGER NOT NULL,PRIMARY KEY(user_id,path));`);
  db.exec('CREATE TABLE IF NOT EXISTS drive_reading(user_id INTEGER NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,location TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,path))');
  const item = r=>({path:r.path,name:r.name,kind:r.kind,isDir:r.kind==='folder',video:r.kind==='video',size:r.size,...(r.position!=null?{position:r.position,duration:r.duration,openedAt:r.opened_at}:{})});
  return {
    materials(id,root,page=1,chapter) {
      const offset=(Math.max(1,Number(page)||1)-1)*50,prefix=root+'/';
      const filter="user_id=? AND substr(path,1,?)=? AND kind NOT IN ('video','audio','folder')";
      const current=chapter&&(chapter===root||chapter.startsWith(root+'/'))?db.prepare("SELECT * FROM drive_index WHERE user_id=? AND parent=? AND kind NOT IN ('video','audio','folder') ORDER BY name LIMIT 50").all(id,chapter).map(item):[];
      return {root,chapterItems:current,total:db.prepare('SELECT count(*) n FROM drive_index WHERE '+filter).get(id,prefix.length,prefix).n,items:db.prepare('SELECT * FROM drive_index WHERE '+filter+' ORDER BY parent,name LIMIT 50 OFFSET ?').all(id,prefix.length,prefix,offset).map(item)};
    },
    reading(id,target,body) {
      const kind=driveKind(target);
      if(!['pdf','epub'].includes(kind))throw Object.assign(new Error('此格式不支持阅读位置'),{status:400});
      if(body){const location=String(body.location??'');if(kind==='pdf'?!/^[1-9]\d{0,6}$/.test(location):!/^epubcfi\(.{1,8000}\)$/.test(location))throw Object.assign(new Error('阅读位置无效'),{status:400});
        db.prepare('INSERT INTO drive_reading VALUES (?,?,?,?,?) ON CONFLICT(user_id,path) DO UPDATE SET location=excluded.location,updated_at=excluded.updated_at').run(id,target,kind,location,Date.now());
      }
      return db.prepare('SELECT kind,location,updated_at FROM drive_reading WHERE user_id=? AND path=?').get(id,target)||{kind,location:null};
    },
    remember(id,listing) {
      const put=db.prepare('INSERT INTO drive_index VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,path) DO UPDATE SET name=excluded.name,kind=excluded.kind,size=excluded.size,updated_at=excluded.updated_at');
      db.exec('SAVEPOINT drive_index_refresh');
      try {
        if(listing.page===1 && listing.total<=100) db.prepare('DELETE FROM drive_index WHERE user_id=? AND parent=?').run(id,listing.path);
        for(const r of listing.items)put.run(id,r.path,listing.path,r.name,driveKind(r.name,r.isDir),Number(r.size)||0,Date.now());
        db.exec('RELEASE drive_index_refresh');
      } catch(e) {db.exec('ROLLBACK TO drive_index_refresh');db.exec('RELEASE drive_index_refresh');throw e;}
    },
    search(id,q,category,allowedCategories) {
      q=String(q||'').trim().slice(0,160);const c=DRIVE_COLLECTIONS.find(c=>c.id===category);
      const allowed=Array.isArray(allowedCategories)?new Set(allowedCategories):null;
      const roots=category ? (c&&(!allowed||allowed.has(c.id))?[c]:[]) : (allowed?DRIVE_COLLECTIONS.filter(item=>allowed.has(item.id)):DRIVE_COLLECTIONS);
      if(!roots.length)return {items:[],indexed:0,limited:false};
      const scope=' AND ('+roots.map(()=>'(path=? OR substr(path,1,?)=?)').join(' OR ')+')';
      const values=roots.flatMap(item=>[item.root,item.root.length+1,item.root+'/']);
      const match='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
      const rows=db.prepare("SELECT * FROM drive_index WHERE user_id=? AND name LIKE ? ESCAPE '\\'"+scope+' ORDER BY CASE kind WHEN \'folder\' THEN 0 ELSE 1 END,name LIMIT 200').all(id,match,...values);
      const indexed=db.prepare('SELECT count(*) n FROM drive_index WHERE user_id=?'+scope).get(id,...values).n;
      return {items:rows.map(item),indexed,limited:rows.length===200};
    },
    progress(id,target,position,duration) {
      const pos=Number(position ?? 0),dur=Number(duration ?? 0);
      if(!Number.isFinite(pos)||!Number.isFinite(dur)||pos<0||dur<0||pos>dur&&dur>0||dur>604800)throw Object.assign(new Error('播放进度无效'),{status:400});
      db.prepare('INSERT INTO drive_recent VALUES (?,?,?,?,?) ON CONFLICT(user_id,path) DO UPDATE SET position=excluded.position,duration=excluded.duration,opened_at=excluded.opened_at').run(id,target,pos,dur,Date.now());
      return {ok:true};
    },
    recent(sourceId, viewerId=sourceId) {return db.prepare('SELECT i.*,r.position,r.duration,r.opened_at FROM drive_recent r JOIN drive_index i ON i.user_id=? AND i.path=r.path WHERE r.user_id=? ORDER BY r.opened_at DESC LIMIT 20').all(sourceId,viewerId).filter(r=>driveCollection(r.path)).map(item);},
    position(id,target) {const r=db.prepare('SELECT position,duration FROM drive_recent WHERE user_id=? AND path=?').get(id,target);return r||{position:0,duration:0};},
  };
}
