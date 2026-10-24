import { randomUUID } from 'node:crypto';
import { CONTENT_VERSION, CONTENT_POLICY, parseContentJson, hashContent, articleMarkdown } from './content-policy.js';

const rawExpression = alias => `json_object('id',${alias}.id,'source',${alias}.source,'externalId',${alias}.external_id,
  'title',${alias}.title,'url',${alias}.url,'author',${alias}.author,'content',${alias}.content,
  'media',${alias}.media,'links',${alias}.links,'metrics',${alias}.metrics)`;
const materialExpression=alias=>`json_array(${alias}.title,${alias}.url,${alias}.author,${alias}.content,${alias}.media,${alias}.links,
  json_extract(CASE WHEN json_valid(${alias}.metrics) THEN ${alias}.metrics ELSE '{}' END,'$.quotedTweet'))`;

export function createContentStore(db, {now=()=>Date.now(),version=CONTENT_VERSION}={}) {
  // Early local previews used restrictive inbox foreign keys. Keep billing history
  // after source deletion, but erase retained source material through a tombstone.
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_snapshots'").get() &&
    db.prepare('PRAGMA foreign_key_list(content_snapshots)').all().some(row=>row.table==='inbox')) {
    db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS content_capture_insert; DROP TRIGGER IF EXISTS content_capture_update;
      CREATE TABLE content_snapshots_v2(id INTEGER PRIMARY KEY,inbox_id INTEGER NOT NULL,user_id INTEGER NOT NULL,raw_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO content_snapshots_v2 SELECT * FROM content_snapshots;
      DROP TABLE content_snapshots; ALTER TABLE content_snapshots_v2 RENAME TO content_snapshots;
      CREATE TABLE content_members_v2(group_id INTEGER NOT NULL REFERENCES content_groups(id),inbox_id INTEGER NOT NULL,
        snapshot_id INTEGER NOT NULL REFERENCES content_snapshots(id),version TEXT NOT NULL,PRIMARY KEY(inbox_id,version));
      INSERT INTO content_members_v2 SELECT * FROM content_members;
      DROP TABLE content_members; ALTER TABLE content_members_v2 RENAME TO content_members;
      COMMIT; PRAGMA foreign_keys=ON;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_snapshots (
      id INTEGER PRIMARY KEY, inbox_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      raw_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS content_snapshots_item ON content_snapshots(inbox_id,id DESC);
    CREATE TABLE IF NOT EXISTS content_jobs (
      id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES content_snapshots(id), version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      UNIQUE(snapshot_id,version)
    );
    CREATE INDEX IF NOT EXISTS content_jobs_due ON content_jobs(state,next_at);
    CREATE TABLE IF NOT EXISTS content_receipts (
      request_key TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES content_jobs(id), stage TEXT NOT NULL,
      provider TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_calls (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES content_jobs(id), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_results (
      snapshot_id INTEGER NOT NULL REFERENCES content_snapshots(id), version TEXT NOT NULL,
      kind TEXT NOT NULL, score INTEGER NOT NULL, state TEXT NOT NULL, classification TEXT NOT NULL, article TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(snapshot_id,version)
    );
    CREATE TABLE IF NOT EXISTS content_groups (
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,
      problem TEXT NOT NULL,topics TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_members (
      group_id INTEGER NOT NULL REFERENCES content_groups(id),inbox_id INTEGER NOT NULL,
      snapshot_id INTEGER NOT NULL REFERENCES content_snapshots(id),version TEXT NOT NULL,
      PRIMARY KEY(inbox_id,version)
    );
    CREATE TABLE IF NOT EXISTS content_articles (
      id INTEGER PRIMARY KEY,group_id INTEGER NOT NULL REFERENCES content_groups(id),version TEXT NOT NULL,
      input_hash TEXT NOT NULL,source_snapshots TEXT NOT NULL,article TEXT NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(group_id,version,input_hash)
    );
    CREATE TABLE IF NOT EXISTS content_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS content_local_mode(user_id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS content_local_sources(user_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,PRIMARY KEY(user_id,inbox_id));
    CREATE TABLE IF NOT EXISTS content_active_versions(user_id INTEGER PRIMARY KEY,version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content_scope (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),include_private INTEGER NOT NULL DEFAULT 0,
      sample_size INTEGER NOT NULL DEFAULT 50,sample_started INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS content_publications (
      user_id INTEGER NOT NULL REFERENCES users(id),asset_key TEXT NOT NULL,version TEXT NOT NULL,
      PRIMARY KEY(user_id,asset_key,version)
    );
    DROP TRIGGER IF EXISTS content_capture_insert;
    DROP TRIGGER IF EXISTS content_capture_update;
    CREATE TRIGGER content_capture_insert AFTER INSERT ON inbox
    WHEN NEW.source IN ('x','feed','manual') BEGIN
      INSERT INTO content_snapshots(inbox_id,user_id,raw_json,created_at)
      VALUES(NEW.id,NEW.user_id,${rawExpression('NEW')},unixepoch()*1000);
    END;
    CREATE TRIGGER content_capture_update AFTER UPDATE OF title,url,author,content,media,links,metrics ON inbox
    WHEN NEW.source IN ('x','feed','manual')
      AND ${materialExpression('NEW')} IS NOT ${materialExpression('OLD')} BEGIN
      INSERT INTO content_snapshots(inbox_id,user_id,raw_json,created_at)
      VALUES(NEW.id,NEW.user_id,${rawExpression('NEW')},unixepoch()*1000);
    END;
    CREATE TRIGGER IF NOT EXISTS content_forget_deleted AFTER DELETE ON inbox BEGIN
      DELETE FROM content_articles WHERE id IN(SELECT a.id FROM content_articles a,json_each(a.source_snapshots) ref
        JOIN content_snapshots s ON s.id=ref.value WHERE s.inbox_id=OLD.id);
      DELETE FROM content_members WHERE inbox_id=OLD.id;
      DELETE FROM content_results WHERE snapshot_id IN(SELECT id FROM content_snapshots WHERE inbox_id=OLD.id);
      DELETE FROM content_receipts WHERE job_id IN(SELECT j.id FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id WHERE s.user_id=OLD.user_id);
      UPDATE content_jobs SET state='protected',error_code='source_deleted',lease_token=NULL
        WHERE snapshot_id IN(SELECT id FROM content_snapshots WHERE inbox_id=OLD.id);
      UPDATE content_snapshots SET raw_json='{}' WHERE inbox_id=OLD.id;
    END;
  `);
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try {const result=callback();db.exec('COMMIT');return result;}
    catch(error){db.exec('ROLLBACK');throw error;}
  };
  function owner(userId) {return Number.isSafeInteger(userId)&&!!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);}
  const zaneUser=userId=>!!db.prepare("SELECT 1 FROM users WHERE id=? AND username='zane'").get(userId);
  function enabled(userId) {return owner(userId) && db.prepare(`SELECT 1 FROM content_settings s JOIN content_active_versions v ON v.user_id=s.user_id
    WHERE s.user_id=? AND s.enabled=1 AND v.version=?`).get(userId,version)!==undefined;}
  function setEnabled(userId,value) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    db.prepare('INSERT INTO content_settings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(userId,value?1:0);
    if(value) {
      db.prepare('INSERT INTO content_active_versions VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version').run(userId,version);
      db.prepare('INSERT OR IGNORE INTO content_scope(user_id) VALUES(?)').run(userId);
      db.prepare('UPDATE content_scope SET sample_started=? WHERE user_id=?').run(now(),userId);
    }
  }
  function scope(userId) {
    const row=db.prepare('SELECT * FROM content_scope WHERE user_id=?').get(userId);
    return {includePrivate:row?.include_private===1,sampleSize:row?.sample_size??50,sampleStarted:row?.sample_started||0};
  }
  function configure(userId,{includePrivate,sampleSize}={}) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    if((includePrivate!==undefined && typeof includePrivate!=='boolean') ||
      (sampleSize!==undefined && (!Number.isSafeInteger(sampleSize)||sampleSize<0||sampleSize>1000)))
      throw Object.assign(new Error('整理范围无效'),{status:400});
    const old=scope(userId);
    db.prepare(`INSERT INTO content_scope(user_id,include_private,sample_size) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET include_private=excluded.include_private,sample_size=excluded.sample_size`)
      .run(userId,(includePrivate??old.includePrivate)?1:0,sampleSize??old.sampleSize);
    // Explicit scope changes can resume eligible entries; old versions and snapshots still cannot run.
    db.prepare(`UPDATE content_jobs SET state='queued',next_at=0 WHERE state='protected' AND version=?
      AND snapshot_id IN(SELECT id FROM content_snapshots WHERE user_id=?)`).run(version,userId);
  }
  function snapshotRow(row) {
    if(!row)return null;
    const raw=parseContentJson(row.raw_json);
    const metrics=parseContentJson(raw.metrics);
    return {...raw,id:row.inbox_id,snapshotId:row.id,userId:row.user_id,
      media:parseContentJson(raw.media,[]),links:parseContentJson(raw.links,[]),metrics,
      quotedText:metrics.quotedTweet?.full_text || metrics.quotedTweet?.text || ''};
  }
  function snapshot(id) {return snapshotRow(db.prepare('SELECT * FROM content_snapshots WHERE id=?').get(id));}
  function latest(inboxId) {return snapshotRow(db.prepare('SELECT * FROM content_snapshots WHERE inbox_id=? ORDER BY id DESC LIMIT 1').get(inboxId));}
  function protectedItem(inboxId,userId) {
    const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_curation'").get();
    return !!table && !!db.prepare("SELECT 1 FROM library_curation WHERE user_id=? AND asset_type='source' AND asset_key=?").get(userId,String(inboxId));
  }
  function eligible(source) {
    if(!source || !owner(source.userId))return false;
    const row=db.prepare('SELECT user_id,source,status FROM inbox WHERE id=?').get(source.id);
    return row?.user_id===source.userId && ['x','feed','manual'].includes(row.source) && row.status==='pending' &&
      latest(source.id)?.snapshotId===source.snapshotId;
  }
  const isPublic=source=>db.prepare("SELECT 1 FROM inbox WHERE id=? AND user_id=? AND visibility='public' AND status='pending'").get(source.id,source.userId);
  // Only zane may use the legacy server-side provider. Every other account is
  // deliberately local-device only, even if a caller forgets to persist mode.
  const localMode=userId=>!zaneUser(userId)||!!db.prepare('SELECT 1 FROM content_local_mode WHERE user_id=?').get(userId);
  const localSource=source=>!!source&&!!db.prepare('SELECT 1 FROM content_local_sources WHERE user_id=? AND inbox_id=?').get(source.userId,source.id);
  const usable=source=>eligible(source)&&(isPublic(source)||scope(source.userId).includePrivate||(localMode(source.userId)&&localSource(source)));
  const processable=source=>usable(source)&&(!localMode(source.userId)||(localSource(source)&&!protectedItem(source.id,source.userId)));
  function setLocalMode(userId) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    db.prepare('INSERT OR IGNORE INTO content_local_mode VALUES(?)').run(userId);
  }
  function allowLocalSources(userId,inboxIds) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    transaction(()=>{
      for(const id of inboxIds) {
        const source=latest(id);
        if(!source||source.userId!==userId||source.source!=='x'||!eligible(source))continue;
        db.prepare('INSERT OR IGNORE INTO content_local_sources VALUES(?,?)').run(userId,id);
        db.prepare("UPDATE content_jobs SET state='queued',next_at=0 WHERE snapshot_id=? AND version=? AND state='protected'").run(source.snapshotId,version);
      }
    });
  }
  function dispatchable(jobId,userId) {
    const job=db.prepare('SELECT * FROM content_jobs WHERE id=? AND version=?').get(jobId,version);
    const source=job&&snapshot(job.snapshot_id);
    return !!job&&enabled(userId)&&source?.userId===userId&&localMode(userId)&&localSource(source)&&processable(source)&&
      ['queued','retry','running'].includes(job.state)&&!protectedItem(source.id,userId);
  }
  function seed(userId) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    const added=db.prepare(`INSERT INTO content_snapshots(inbox_id,user_id,raw_json,created_at)
      SELECT i.id,i.user_id,${rawExpression('i')},? FROM inbox i WHERE i.user_id=?
      AND i.source IN ('x','feed','manual')
      AND NOT EXISTS(SELECT 1 FROM content_snapshots s WHERE s.inbox_id=i.id)`).run(now(),userId).changes;
    sync();return {captured:added};
  }
  function sync() {
    db.prepare(`INSERT OR IGNORE INTO content_jobs(snapshot_id,version,updated_at)
      SELECT s.id,?,? FROM content_snapshots s JOIN users u ON u.id=s.user_id
      JOIN inbox i ON i.id=s.inbox_id
      WHERE i.source IN ('x','feed','manual') AND i.status='pending'
      AND s.id=(SELECT max(n.id) FROM content_snapshots n WHERE n.inbox_id=s.inbox_id)
      AND (NOT EXISTS(SELECT 1 FROM content_local_mode m WHERE m.user_id=s.user_id)
        OR EXISTS(SELECT 1 FROM content_local_sources l WHERE l.user_id=s.user_id AND l.inbox_id=s.inbox_id))`).run(version,now());
  }
  function claim(userId) {
    if(!enabled(userId))return null;
    const currentScope=scope(userId);
    const completed=db.prepare(`SELECT count(*) AS n FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id
      WHERE s.user_id=? AND j.version=? AND j.state IN ('done','review') AND j.updated_at>=?`)
      .get(userId,version,currentScope.sampleStarted).n;
    if(currentScope.sampleSize>0 && completed>=currentScope.sampleSize){setEnabled(userId,false);return null;}
    return transaction(()=>{
      const current=now();
      db.prepare("UPDATE content_jobs SET state='retry',lease_token=NULL WHERE state='running' AND lease_until<?").run(current);
      const rows=db.prepare(`SELECT j.* FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id
        WHERE s.user_id=? AND j.version=? AND j.state IN ('queued','retry') AND j.next_at<=? ORDER BY j.id LIMIT 100`).all(userId,version,current);
      for(const job of rows){
        const source=snapshot(job.snapshot_id);
        if(!processable(source)){
          db.prepare("UPDATE content_jobs SET state='protected',updated_at=? WHERE id=?").run(current,job.id);continue;
        }
        const token=randomUUID();
        db.prepare("UPDATE content_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
          .run(token,current+CONTENT_POLICY.leaseMs,current,job.id);
        return {...job,lease_token:token,attempts:job.attempts+1,source};
      }
      return null;
    });
  }
  function owns(job) {
    return !!db.prepare("SELECT 1 FROM content_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>=?").get(job.id,job.lease_token,now());
  }
  function assertLive(job) {
    if(!enabled(job.source.userId)||!processable(job.source))throw Object.assign(new Error('来源或任务状态已改变'),{code:'stale'});
    if(!owns(job))throw Object.assign(new Error('任务租约已过期'),{code:'lease_expired'});
  }
  function stage(job,name) {
    assertLive(job);
    db.prepare('UPDATE content_jobs SET stage=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=?')
      .run(name,now()+CONTENT_POLICY.leaseMs,now(),job.id,job.lease_token);
  }
  function reserve(job,{daily=CONTENT_POLICY.defaultDailyCalls,hourly=CONTENT_POLICY.defaultHourlyCalls}={}) {
    return transaction(()=>{
      assertLive(job);
      const counts=db.prepare(`SELECT count(*) AS daily,sum(c.created_at>?) AS hourly FROM content_calls c
        JOIN content_jobs j ON j.id=c.job_id JOIN content_snapshots s ON s.id=j.snapshot_id
        WHERE s.user_id=? AND c.created_at>?`).get(now()-3600_000,job.source.userId,now()-86400_000);
      if(counts.daily>=daily || counts.hourly>=hourly)throw Object.assign(new Error('达到内容整理调用上限'),{code:'budget'});
      db.prepare('INSERT INTO content_calls(job_id,created_at) VALUES(?,?)').run(job.id,now());
    });
  }
  function receipt(key) {const row=db.prepare('SELECT response FROM content_receipts WHERE request_key=?').get(key);return row?parseContentJson(row.response):null;}
  function saveReceipt(job,key,name,provider,response) {
    // A completed paid response survives a stale source; publication still rechecks the lease.
    db.prepare('INSERT OR IGNORE INTO content_receipts VALUES(?,?,?,?,?,?)').run(key,job.id,name,provider,JSON.stringify(response),now());
  }
  function finish(job,state,errorCode='') {
    db.prepare('UPDATE content_jobs SET state=?,error_code=?,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?')
      .run(state,errorCode,now(),job.id,job.lease_token);
  }
  function fail(job,error) {
    if(error.code==='local_pending') {
      db.prepare("UPDATE content_jobs SET state='retry',error_code='local_pending',attempts=max(0,attempts-1),next_at=0,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?")
        .run(now(),job.id,job.lease_token);
      return;
    }
    const code=['budget','configuration','upstream','invalid_result','stale','lease_expired'].includes(error.code)?error.code:'internal';
    const retry=code==='budget'||code==='configuration'||(job.attempts<CONTENT_POLICY.maxAttempts && code!=='stale');
    db.prepare('UPDATE content_jobs SET state=?,error_code=?,next_at=?,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?')
      .run(code==='stale'?'protected':retry?'retry':'review',code,now()+(code==='budget'?3600_000:code==='configuration'?300_000:Math.min(job.attempts,10)*60_000),now(),job.id,job.lease_token);
  }
  function saveResult(job,classification,article,state) {
    assertLive(job);
    db.prepare(`INSERT INTO content_results VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_id,version) DO UPDATE SET
      kind=excluded.kind,score=excluded.score,state=excluded.state,classification=excluded.classification,article=excluded.article,updated_at=excluded.updated_at`)
      .run(job.snapshot_id,version,classification.kind,article?.score||0,state,JSON.stringify(classification),JSON.stringify(article||{}),now());
  }
  function resultFor(inboxId,{includeReview=false}={}) {
    const source=latest(inboxId);
    if(!eligible(source))return null;
    const row=db.prepare('SELECT * FROM content_results WHERE snapshot_id=? AND version=?').get(source.snapshotId,version);
    if(!row || (!includeReview&&row.state!=='ready'))return null;
    const article=parseContentJson(row.article);
    return {...row,score:Number.isFinite(article.score)?article.score:null,article,classification:parseContentJson(row.classification),source};
  }
  function candidates(userId,article,kind) {
    const terms=new Set(`${article.problem} ${article.topics.join(' ')}`.toLowerCase().match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g)||[]);
    return db.prepare('SELECT * FROM content_groups WHERE user_id=? AND kind=? ORDER BY id DESC LIMIT 500').all(userId,kind)
      .map(group=>({...group,topics:parseContentJson(group.topics,[]),overlap:[...terms].filter(t=>`${group.problem} ${group.topics}`.toLowerCase().includes(t)).length}))
      .filter(group=>group.overlap>0&&members(group.id).length>0).sort((a,b)=>b.overlap-a.overlap).slice(0,CONTENT_POLICY.groupCandidates)
      .map(group=>({id:group.id,problem:group.problem,topics:group.topics,sources:members(group.id).slice(-3).map(s=>({id:s.id,title:s.title,content:s.content.slice(0,5000)}))}));
  }
  function attach(job,classification,article,groupId) {
    return transaction(()=>{
      assertLive(job);
      const existing=db.prepare('SELECT group_id FROM content_members WHERE inbox_id=? AND version=? AND snapshot_id=?').get(job.source.id,version,job.snapshot_id);
      if(existing)return existing.group_id;
      let group=groupId && db.prepare('SELECT id FROM content_groups WHERE id=? AND user_id=? AND kind=?').get(groupId,job.source.userId,classification.kind);
      if(groupId&&!group)throw Object.assign(new Error('候选组已失效'),{code:'stale'});
      if(!group)group={id:Number(db.prepare('INSERT INTO content_groups(user_id,kind,problem,topics,created_at) VALUES(?,?,?,?,?)')
        .run(job.source.userId,classification.kind,article.problem,JSON.stringify(article.topics),now()).lastInsertRowid)};
      db.prepare(`INSERT INTO content_members VALUES(?,?,?,?) ON CONFLICT(inbox_id,version) DO UPDATE SET
        group_id=excluded.group_id,snapshot_id=excluded.snapshot_id`).run(group.id,job.source.id,job.snapshot_id,version);
      return group.id;
    });
  }
  function members(groupId) {
    return db.prepare('SELECT snapshot_id FROM content_members WHERE group_id=? AND version=? ORDER BY inbox_id').all(groupId,version)
      .map(row=>snapshot(row.snapshot_id)).filter(source=>usable(source)&&!protectedItem(source.id,source.userId)&&resultFor(source.id));
  }
  function saveArticle(job,groupId,sources,article) {
    return transaction(()=>{
      assertLive(job);
      if(sources.some(source=>!usable(source)||protectedItem(source.id,source.userId)))throw Object.assign(new Error('引用来源已改变'),{code:'stale'});
      const ids=sources.map(s=>s.snapshotId).sort((a,b)=>a-b);
      const fingerprint=hashContent(ids);
      db.prepare('INSERT OR IGNORE INTO content_articles(group_id,version,input_hash,source_snapshots,article,created_at) VALUES(?,?,?,?,?,?)')
        .run(groupId,version,fingerprint,JSON.stringify(ids),JSON.stringify(article),now());
    });
  }
  function hasArticle(groupId,sources) {
    return !!db.prepare('SELECT 1 FROM content_articles WHERE group_id=? AND version=? AND input_hash=?')
      .get(groupId,version,hashContent(sources.map(s=>s.snapshotId).sort((a,b)=>a-b)));
  }
  function safeSourceUrl(value) {try {const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
  function sourceView(source) {return {id:source.id,externalId:String(source.id),originalExternalId:source.externalId,title:source.title,url:safeSourceUrl(source.url),author:source.author,excerpt:source.content.slice(0,420),citationKey:`S:${source.id}`};}
  function articleView(id,article,sources,type,updatedAt) {
    return {id,type,sourceInboxId:type==='method'?sources[0].id:undefined,title:article.title,summary:article.summary,body:articleMarkdown(article),tags:article.topics||[],
      status:'ready',verificationStatus:'source_checked',version:1,policyVersion:version,sourceCount:sources.length,claimCount:article.sections.length,
      updatedAt:new Date(updatedAt).toISOString(),sources:sources.map(sourceView),claims:article.sections.map((s,i)=>({id:String(i+1),text:s.text,sourceIds:s.evidence.map(e=>String(e.sourceId)),verdict:'supported',confidence:article.verification?.confidence||0,needsReview:false})),repositories:[]};
  }
  const published=(userId,key)=>!!db.prepare('SELECT 1 FROM content_publications WHERE user_id=? AND asset_key=? AND version=?').get(userId,key,version);
  const visible=(source,publicOnly)=>eligible(source)&&!protectedItem(source.id,source.userId)&&(!publicOnly||isPublic(source));
  function knowledge(userId,{publicOnly=true}={}) {
    const composed=db.prepare(`SELECT a.* FROM content_articles a JOIN content_groups g ON g.id=a.group_id
      WHERE g.user_id=? AND a.version=? AND a.id=(SELECT max(n.id) FROM content_articles n WHERE n.group_id=a.group_id AND n.version=a.version)`)
      .all(userId,version).flatMap(row=>{
        const sources=parseContentJson(row.source_snapshots,[]).map(snapshot);
        if(!sources.length||sources.some(s=>!visible(s,publicOnly)||(publicOnly&&!published(userId,`source:${s.snapshotId}`)))||
          (publicOnly&&!published(userId,`article:${row.id}`)))return [];
        return [articleView(`pipeline-${row.id}`,parseContentJson(row.article),sources,'knowledge',row.created_at)];
      });
    const used=new Set(composed.flatMap(article=>article.sources.map(s=>s.id)));
    const individual=db.prepare(`SELECT DISTINCT s.inbox_id FROM content_results r JOIN content_snapshots s ON s.id=r.snapshot_id
      WHERE s.user_id=? AND r.version=? AND r.state='ready'`).all(userId,version)
      .flatMap(row=>{const r=resultFor(row.inbox_id);return r&&(r.article.assets||[r.kind]).some(k=>['method','code','template','reference','research'].includes(k))&&visible(r.source,publicOnly)&&!used.has(row.inbox_id)&&
        (!publicOnly||published(userId,`source:${r.snapshot_id}`))?[articleView(`pipeline-source-${row.inbox_id}`,r.article,[r.source],'method',r.updated_at)]:[];});
    return [...composed,...individual];
  }
  function prompts(userId,{publicOnly=true}={}) {
    return db.prepare(`SELECT DISTINCT s.inbox_id FROM content_results r JOIN content_snapshots s ON s.id=r.snapshot_id
      WHERE s.user_id=? AND r.version=? AND r.state='ready'`).all(userId,version).flatMap(row=>{
        const r=resultFor(row.inbox_id);if(!r?.article.promptText||!visible(r.source,publicOnly)||
          (publicOnly&&!published(userId,`source:${r.snapshot_id}`)))return [];
        return [{id:`pipeline-prompt-${row.inbox_id}`,sourceInboxId:row.inbox_id,title:r.article.title,summary:r.article.summary,
          text:r.article.promptText,category:r.article.promptCategory,tags:r.article.topics,kind:'task_prompt',facets:{},
          sourceUrl:safeSourceUrl(r.source.url),sourceAuthor:r.source.author,media:r.source.media,updatedAt:new Date(r.updated_at).toISOString(),pipeline:true}];
      });
  }
  function publish(userId,jobId,{onPublish}={}) {
    if(!owner(userId))throw Object.assign(new Error('账户不存在或已失效'),{status:403});
    const job=db.prepare(`SELECT j.*,s.inbox_id FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id WHERE j.id=? AND s.user_id=?`).get(jobId,userId);
    const r=job&&resultFor(job.inbox_id);
    if(!r||r.snapshot_id!==job.snapshot_id||job.version!==version||!visible(r.source,true))
      throw Object.assign(new Error('仅可发布未被人工归类锁定的公开来源最新结果'),{status:409});
    return transaction(()=>{
      onPublish?.({source:r.source,article:r.article,kind:r.kind});
      db.prepare('INSERT OR IGNORE INTO content_publications VALUES(?,?,?)').run(userId,`source:${r.snapshot_id}`,version);
      for(const item of knowledge(userId,{publicOnly:false}).filter(k=>k.type==='knowledge'&&k.sources.some(s=>s.id===r.source.id))){
        if(item.sources.every(s=>visible(latest(s.id),true)&&published(userId,`source:${latest(s.id).snapshotId}`)))db.prepare('INSERT OR IGNORE INTO content_publications VALUES(?,?,?)')
          .run(userId,`article:${item.id.replace('pipeline-','')}`,version);
      }
      return true;
    });
  }
  function status(userId) {
    const selected=db.prepare(`SELECT s.inbox_id FROM content_results r JOIN content_snapshots s ON s.id=r.snapshot_id
      WHERE s.user_id=? AND r.version=? AND r.state='ready' AND r.score>=?
      AND s.id=(SELECT max(n.id) FROM content_snapshots n WHERE n.inbox_id=s.inbox_id) ORDER BY r.score DESC,r.updated_at DESC LIMIT 50`)
      .all(userId,version,CONTENT_POLICY.selectionScore).flatMap(row=>{
        const result=resultFor(row.inbox_id);return result?[{sourceId:row.inbox_id,title:result.article.title,summary:result.article.summary,score:result.score}]:[];
      });
    const counts=Object.fromEntries(db.prepare(`SELECT j.state,count(*) AS n FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id
      WHERE s.user_id=? AND j.version=? GROUP BY j.state`).all(userId,version).map(row=>[row.state,row.n]));
    const recent=db.prepare(`SELECT j.id,j.state,j.stage,j.error_code AS errorCode,s.inbox_id AS sourceId,i.title
      FROM content_jobs j JOIN content_snapshots s ON s.id=j.snapshot_id JOIN inbox i ON i.id=s.inbox_id
      WHERE s.user_id=? AND j.version=? ORDER BY j.updated_at DESC,j.id DESC LIMIT 12`).all(userId,version);
    return {enabled:enabled(userId),version,scope:scope(userId),counts,selected,selectionScore:CONTENT_POLICY.selectionScore,recent:recent.map(row=>{
      const result=resultFor(row.sourceId,{includeReview:true});
      return {...row,score:result?.score??null,kind:result?.kind||'',summary:result?.article.summary||'',
        scores:result?.article.scores||null,scoreReasons:result?.article.scoreReasons||null,
        reviewReasons:result?.article.verification?.issues||[],classificationReason:result?.classification.reason||'',limitations:result?.article.limitations||[],
        manualProtected:protectedItem(row.sourceId,userId),canPublish:!!result&&result.state==='ready'&&visible(result.source,true),
        published:!!result&&published(userId,`source:${result.snapshot_id}`)};
    }),callsToday:db.prepare(`SELECT count(*) AS n FROM content_calls c
      JOIN content_jobs j ON j.id=c.job_id JOIN content_snapshots s ON s.id=j.snapshot_id
      WHERE s.user_id=? AND c.created_at>?`).get(userId,now()-86400_000).n};
  }
  function retry(userId,jobId) {
    return transaction(()=>{
      const changed=db.prepare(`UPDATE content_jobs SET state='queued',attempts=0,next_at=0,error_code='',updated_at=?
        WHERE id=? AND state IN ('retry','review','protected') AND snapshot_id IN(SELECT id FROM content_snapshots WHERE user_id=?)`)
        .run(now(),jobId,userId).changes>0;
      // Explicit owner retry releases a failed model response, while validated
      // receipts from earlier stages remain reusable. Old leases become invalid.
      if(changed&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_model_tasks'").get())
        db.prepare('DELETE FROM local_model_tasks WHERE job_id=? AND user_id=?').run(jobId,userId);
      return changed;
    });
  }
  return {version,seed,sync,claim,stage,reserve,receipt,saveReceipt,finish,fail,saveResult,resultFor,candidates,attach,members,saveArticle,
    knowledge,prompts,eligible,latest,snapshot,status,enabled,setEnabled,configure,publish,protectedItem,retry,assertLive,hasArticle,
    setLocalMode,localMode,allowLocalSources,dispatchable};
}
