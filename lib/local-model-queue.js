import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { CONTENT_SCHEMAS, CONTENT_PROMPTS, CONTENT_POLICY } from './content-policy.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const failure=(code,status=409)=>Object.assign(new Error(`本地整理：${code}`),{code,status});
const LEASE_MS=10*60_000;
const MAX_BYTES=256*1024;
const schemaFor=stage=>CONTENT_SCHEMAS[stage==='classify'?'classify_detail':stage];
const safeCodes=new Set(['configuration','tool_isolation_unavailable','timeout','invalid_result','upstream']);

// Shape checks happen before retention. The pipeline additionally checks exact
// source quotes, Chinese summaries, taxonomy and evidence before saving assets.
function matches(value,schema) {
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(!types.includes(type)&&!(type==='number'&&types.includes('integer')&&Number.isSafeInteger(value)))return false;
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(type==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)))return false;
  if(type==='string'&&((schema.minLength!==undefined&&value.length<schema.minLength)||(schema.maxLength!==undefined&&value.length>schema.maxLength)))return false;
  if(type==='array')return value.length<=(schema.maxItems??100)&&value.length>=(schema.minItems??0)&&value.every(v=>matches(v,schema.items));
  if(type==='object')return (schema.required||[]).every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>
    Object.hasOwn(schema.properties||{},k)?matches(value[k],schema.properties[k]):schema.additionalProperties!==false);
  return true;
}

export function createLocalModelQueue({db,store,now=()=>Date.now(),budget={daily:40,hourly:12}}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_model_settings(user_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,model TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS local_model_devices(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
      owner_name TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER NOT NULL DEFAULT 0,last_seen_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS local_model_tasks(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,job_id INTEGER NOT NULL,request_key TEXT NOT NULL UNIQUE,
      stage TEXT NOT NULL,input_json TEXT NOT NULL,source_refs TEXT NOT NULL,model TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
      device_id TEXT NOT NULL DEFAULT '',lease_token TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,response_json TEXT,error_code TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS local_model_tasks_due ON local_model_tasks(user_id,state,next_at);
    CREATE TRIGGER IF NOT EXISTS local_model_forget_source AFTER DELETE ON inbox BEGIN
      DELETE FROM content_local_sources WHERE inbox_id=OLD.id;
      UPDATE local_model_tasks SET state='stale',input_json='{}',source_refs='[]',response_json=NULL,lease_token=''
        WHERE id IN(SELECT t.id FROM local_model_tasks t,json_each(t.source_refs) ref WHERE json_extract(ref.value,'$.id')=OLD.id);
    END;
  `);
  if(!db.prepare('PRAGMA table_info(local_model_devices)').all().some(column=>column.name==='owner_name'))
    db.exec("ALTER TABLE local_model_devices ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''");
  // Migration binds existing tokens to their current account name once.  A
  // later database reassignment cannot turn an old device token into another
  // person's worker credential.
  db.prepare(`UPDATE local_model_devices SET owner_name=(SELECT username FROM users WHERE users.id=local_model_devices.user_id)
    WHERE owner_name='' AND EXISTS(SELECT 1 FROM users WHERE users.id=local_model_devices.user_id)`).run();
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  const validUser=userId=>Number.isSafeInteger(userId)&&!!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  const settings=userId=>db.prepare('SELECT enabled,model FROM local_model_settings WHERE user_id=?').get(userId)||{enabled:0,model:''};
  const isEnabled=userId=>!!settings(userId).enabled&&store.localMode(userId)&&store.enabled(userId);
  function configure(userId,{enabled,model}) {
    if(typeof enabled!=='boolean'||typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model))throw failure('invalid_configuration',400);
    store.setLocalMode(userId);
    transaction(()=>{
      db.prepare('INSERT INTO local_model_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,model=excluded.model').run(userId,Number(enabled),model);
      db.prepare("UPDATE local_model_tasks SET state='stale',input_json='{}',response_json=NULL,lease_token='' WHERE user_id=? AND state IN ('queued','leased') AND model<>?").run(userId,model);
      if(!enabled)db.prepare("UPDATE local_model_tasks SET state='queued',lease_token='',device_id='' WHERE user_id=? AND state='leased'").run(userId);
    });
    store.configure(userId,{sampleSize:0});
    store.setEnabled(userId,enabled);
    return status(userId);
  }
  function issueDevice(userId,label='我的电脑') {
    if(!validUser(userId))throw failure('user_required',403);
    if(typeof label!=='string'||label.length>80)throw failure('invalid_label',400);
    const id=randomUUID(),token=randomBytes(32).toString('base64url'),expiresAt=now()+90*86400_000;
    const account=db.prepare('SELECT username FROM users WHERE id=?').get(userId);
    db.prepare('INSERT INTO local_model_devices(id,user_id,token_hash,label,owner_name,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,digest(token),label,account.username,now(),expiresAt);
    return {id,deviceToken:token,expiresAt};
  }
  function revoke(userId,id) {
    transaction(()=>{
      db.prepare('UPDATE local_model_devices SET revoked_at=? WHERE id=? AND user_id=?').run(now(),id,userId);
      db.prepare("UPDATE local_model_tasks SET state='queued',lease_token='',device_id='',next_at=0 WHERE device_id=? AND user_id=? AND state='leased'").run(id,userId);
    });
  }
  function authenticate(token) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw failure('device_unauthorized',401);
    const row=db.prepare('SELECT * FROM local_model_devices WHERE token_hash=? AND revoked_at=0 AND expires_at>?').get(digest(token),now());
    const account=row&&db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id);
    if(!row||!account||account.username!==row.owner_name)throw failure('device_unauthorized',401);
    db.prepare('UPDATE local_model_devices SET last_seen_at=? WHERE id=?').run(now(),row.id);
    return {id:row.id,userId:row.user_id};
  }
  function assertDevice(device) {
    if(!device||!validUser(device.userId))throw failure('device_unauthorized',401);
    if(!db.prepare(`SELECT 1 FROM local_model_devices d JOIN users u ON u.id=d.user_id
      WHERE d.id=? AND d.user_id=? AND d.owner_name=u.username AND d.revoked_at=0 AND d.expires_at>?`).get(device.id,device.userId,now()))throw failure('device_unauthorized',401);
  }
  function current(task) {
    const config=settings(task.user_id);
    return isEnabled(task.user_id)&&config.model===task.model&&JSON.parse(task.source_refs).every(ref=>{
      const source=store.latest(ref.id);
      return source?.userId===task.user_id&&source.snapshotId===ref.snapshotId&&store.eligible(source)&&!store.protectedItem(ref.id,task.user_id);
    });
  }
  function enqueue(stage,input,context) {
    const config=settings(context.userId);
    if(!config.enabled||!config.model||!store.dispatchable(context.jobId,context.userId))throw failure('configuration');
    if(!schemaFor(stage))throw failure('invalid_stage',400);
    let row=db.prepare('SELECT * FROM local_model_tasks WHERE request_key=?').get(context.requestKey);
    if(row?.state==='stale') {
      // A model switch back or an explicitly restored source may produce the
      // same input key. Rebuild only after the current job passed scope checks.
      db.prepare('DELETE FROM local_model_tasks WHERE id=?').run(row.id);
      row=null;
    }
    if(row) {
      if(!current(row)||row.state==='stale')throw failure('stale');
      if(row.state==='done')return JSON.parse(row.response_json);
      if(row.state==='failed')throw failure('invalid_result');
      throw failure('local_pending');
    }
    const json=JSON.stringify(input);
    if(Buffer.byteLength(json)>MAX_BYTES)throw failure('invalid_result');
    const job=db.prepare('SELECT snapshot_id FROM content_jobs WHERE id=?').get(context.jobId);
    const primary=store.snapshot(job.snapshot_id);
    const ids=new Set([primary.id,input.id,input.source?.id,...(input.sources||[]).map(s=>s.id),...(input.candidates||[]).flatMap(c=>(c.sources||[]).map(s=>s.id))].filter(Number.isSafeInteger));
    const refs=[...ids].map(id=>{const source=store.latest(id);if(!source||source.userId!==context.userId)throw failure('stale');return {id,snapshotId:source.snapshotId};});
    db.prepare('INSERT INTO local_model_tasks(id,user_id,job_id,request_key,stage,input_json,source_refs,model,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),context.userId,context.jobId,context.requestKey,stage,json,JSON.stringify(refs),config.model,now());
    throw failure('local_pending');
  }
  function claim(device) {
    return transaction(()=>{
      assertDevice(device);
      if(!isEnabled(device.userId))return null;
      db.prepare("UPDATE local_model_tasks SET state='queued',lease_token='',device_id='' WHERE user_id=? AND state='leased' AND lease_until<?").run(device.userId,now());
      const rows=db.prepare("SELECT * FROM local_model_tasks WHERE user_id=? AND state='queued' AND next_at<=? ORDER BY updated_at,id LIMIT 100").all(device.userId,now());
      for(const task of rows) {
        if(!current(task)||!store.dispatchable(task.job_id,device.userId)) {
          db.prepare("UPDATE local_model_tasks SET state='stale',input_json='{}',response_json=NULL WHERE id=?").run(task.id);continue;
        }
        if(task.attempts>=CONTENT_POLICY.maxAttempts) {
          db.prepare("UPDATE local_model_tasks SET state='failed',error_code='attempts_exhausted' WHERE id=?").run(task.id);continue;
        }
        const count=db.prepare(`SELECT count(*) AS daily,sum(c.created_at>?) AS hourly FROM content_calls c
          JOIN content_jobs j ON j.id=c.job_id JOIN content_snapshots s ON s.id=j.snapshot_id
          WHERE s.user_id=? AND c.created_at>?`).get(now()-3600_000,device.userId,now()-86400_000);
        if(count.daily>=budget.daily||count.hourly>=budget.hourly)return null;
        const leaseToken=randomUUID(),leaseUntil=now()+LEASE_MS;
        db.prepare("UPDATE local_model_tasks SET state='leased',device_id=?,lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
          .run(device.id,leaseToken,leaseUntil,now(),task.id);
        db.prepare('INSERT INTO content_calls(job_id,created_at) VALUES(?,?)').run(task.job_id,now());
        return {id:task.id,leaseToken,leaseUntil,requestKey:task.request_key,stage:task.stage,model:task.model,
          input:JSON.parse(task.input_json),schema:schemaFor(task.stage),instructions:CONTENT_PROMPTS[task.stage]};
      }
      return null;
    });
  }
  function owned(device,id,body) {
    assertDevice(device);
    const task=db.prepare('SELECT * FROM local_model_tasks WHERE id=? AND user_id=?').get(id,device.userId);
    if(!task||task.device_id!==device.id||task.lease_token!==body.leaseToken||task.request_key!==body.requestKey||!current(task))throw failure('stale_lease');
    return task;
  }
  function complete(device,id,body) {
    return transaction(()=>{
      const task=owned(device,id,body);
      if(body.model!==task.model||Buffer.byteLength(JSON.stringify(body.value)??'')>MAX_BYTES||!matches(body.value,schemaFor(task.stage)))throw failure('invalid_result',400);
      const response=JSON.stringify({value:body.value,model:body.model,usage:{}});
      if(task.state==='done') {
        if(task.response_json!==response)throw failure('idempotency_conflict');
        return {ok:true,replayed:true};
      }
      if(task.state!=='leased'||task.lease_until<now()||!store.dispatchable(task.job_id,device.userId))throw failure('stale_lease');
      db.prepare("UPDATE local_model_tasks SET state='done',response_json=?,error_code='',updated_at=? WHERE id=?").run(response,now(),id);
      return {ok:true};
    });
  }
  function heartbeat(device,id,body) {
    return transaction(()=>{
    const task=owned(device,id,body);
    if(task.state!=='leased'||task.lease_until<now()||!store.dispatchable(task.job_id,device.userId))throw failure('stale_lease');
    const leaseUntil=now()+LEASE_MS;
    db.prepare('UPDATE local_model_tasks SET lease_until=?,updated_at=? WHERE id=?').run(leaseUntil,now(),id);
    return {ok:true,leaseUntil};
    });
  }
  function fail(device,id,body) {
    return transaction(()=>{
    const task=owned(device,id,body);
    const code=safeCodes.has(body.code)?body.code:'upstream';
    if(['queued','failed'].includes(task.state)&&task.error_code===code)return {ok:true,replayed:true};
    if(task.state!=='leased'||task.lease_until<now())throw failure('stale_lease');
    db.prepare('UPDATE local_model_tasks SET state=?,error_code=?,next_at=?,updated_at=? WHERE id=?')
      .run(task.attempts>=CONTENT_POLICY.maxAttempts?'failed':'queued',code,now()+5*60_000,now(),id);
    return {ok:true};
    });
  }
  function status(userId) {
    const config=settings(userId);
    return {enabled:isEnabled(userId),model:config.model,intervalHours:2,
      counts:Object.fromEntries(db.prepare('SELECT state,count(*) n FROM local_model_tasks WHERE user_id=? GROUP BY state').all(userId).map(r=>[r.state,r.n])),
      devices:db.prepare('SELECT id,label,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt,last_seen_at AS lastSeenAt FROM local_model_devices WHERE user_id=?').all(userId),
      limits:{dailyCalls:budget.daily,hourlyCalls:budget.hourly}};
  }
  const model={deferred:()=>true,identity:(_stage,{userId})=>`local-codex:${userId}:${settings(userId).model}`,
    call:async(stage,input,context)=>enqueue(stage,input,context)};
  return {model,configure,settings,isEnabled,issueDevice,revoke,authenticate,claim,complete,fail,heartbeat,status};
}
