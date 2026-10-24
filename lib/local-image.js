import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';
import { getSessionUser } from './auth.js';
import { mediaSourceInfo, getMediaJob, requireSameOriginWrite } from './media.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const LEASE_MS = 120_000;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_USER_IMAGES = 256 * 1024 * 1024;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const failure = (status, message) => { throw { status, message }; };
db.exec(`
 CREATE TABLE IF NOT EXISTS local_image_pairs (
  code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS local_image_devices (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS local_image_tasks (
  job_id TEXT PRIMARY KEY REFERENCES media_jobs(id), device_id TEXT NOT NULL REFERENCES local_image_devices(id),
  lease_hash TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0,
  result_hash TEXT NOT NULL DEFAULT '');
 CREATE INDEX IF NOT EXISTS local_image_devices_owner ON local_image_devices(user_id);
`);
if (!db.prepare('PRAGMA table_info(local_image_devices)').all().some(row=>row.name==='runtime_state'))
  db.exec("ALTER TABLE local_image_devices ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'unknown'");
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function userFor(req) {
  const user = getSessionUser(req);
  if (!user) failure(401, '请先登录');
  requireSameOriginWrite(req);
  return user;
}
function deviceFor(req) {
  const authorization = String(req.headers.authorization || '');
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) failure(401, '设备授权无效');
  const row = db.prepare('SELECT * FROM local_image_devices WHERE token_hash=? AND revoked_at=0 AND expires_at>?')
    .get(hash(authorization.slice(7)), Date.now());
  if (!row) failure(401, '设备授权已失效，请重新配对');
  db.prepare('UPDATE local_image_devices SET last_seen_at=? WHERE id=?').run(Date.now(), row.id);
  return row;
}
function devices(userId) {
  return db.prepare(`SELECT id,label,expires_at AS expiresAt,revoked_at AS revokedAt,last_seen_at AS lastSeenAt,
    is_default AS isDefault,runtime_state AS runtimeState FROM local_image_devices WHERE user_id=? ORDER BY is_default DESC,rowid DESC`).all(userId);
}
async function readBody(req, limit = 64 * 1024, binary = false) {
  if (!binary && !String(req.headers['content-type'] || '').startsWith('application/json')) failure(415, '请使用 JSON');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > limit) failure(413, '请求内容过大'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (binary) return bytes;
  try { const value = JSON.parse(bytes.toString() || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { failure(400, '无效的 JSON'); }
}
function expireStarted() {
  db.prepare(`UPDATE media_jobs SET status='needs_review',error='设备离线或执行中断，等待原设备回传；不会自动重生成'
    WHERE module='codex-local' AND status='generating' AND id IN
    (SELECT job_id FROM local_image_tasks WHERE started_at>0 AND lease_until<?)`).run(Date.now());
}
export function startLocalImageMonitor() {
  const timer=setInterval(expireStarted,30_000); timer.unref();
  expireStarted();
}
function leased(device, jobId, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) failure(409, '任务租约无效');
  const task = db.prepare(`SELECT t.*,j.user_id,j.status FROM local_image_tasks t JOIN media_jobs j ON j.id=t.job_id
    WHERE t.job_id=? AND t.device_id=? AND j.user_id=? AND t.lease_hash=?`).get(jobId, device.id, device.user_id, hash(token));
  if (!task) failure(409, '任务已变更或不属于当前设备');
  return task;
}
function submit(userId, input) {
  if (input.acceptCodexUsage !== true) failure(400, '请确认本次任务使用本机 Codex 额度');
  const key = String(input.requestKey || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) failure(400, '请求标识无效');
  const existing = db.prepare('SELECT id,module FROM media_jobs WHERE user_id=? AND request_key=?').get(userId, key);
  if (existing) {
    if (existing.module !== 'codex-local') failure(409, '请求标识已用于其他生成方式');
    return getMediaJob(userId, existing.id);
  }
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 16000) failure(400, '请输入 1 至 16000 字的提示词');
  if (input.referenceAssetIds?.length || input.parentAssetId) failure(400, '本机生图当前仅支持文字生成；参考图编辑尚未开放');
  if (input.provider && input.provider !== 'codex') failure(400, '当前仅支持 Codex 原生生图');
  const ratio = String(input.aspectRatio || 'auto');
  if (!['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'].includes(ratio)) failure(400, '画面比例无效');
  const target = input.deviceId
    ? db.prepare('SELECT id FROM local_image_devices WHERE id=? AND user_id=? AND revoked_at=0 AND expires_at>?').get(String(input.deviceId), userId, Date.now())
    : db.prepare('SELECT id FROM local_image_devices WHERE user_id=? AND revoked_at=0 AND expires_at>? AND last_seen_at>0 ORDER BY is_default DESC,rowid DESC LIMIT 1').get(userId, Date.now());
  if (!target || !db.prepare('SELECT 1 FROM local_image_devices WHERE id=? AND last_seen_at>0').get(target.id)) failure(409, '请先配对并连接自己的生图设备');
  if (db.prepare("SELECT count(*) AS n FROM media_jobs WHERE user_id=? AND module='codex-local' AND status IN ('local_queued','local_claimed','generating')").get(userId).n >= 5)
    failure(429, '最多保留 5 个待处理任务，请等待或取消旧任务');
  if(db.prepare("SELECT count(*) AS n FROM media_jobs WHERE user_id=? AND module='codex-local' AND created_at>datetime('now','-1 day')").get(userId).n>=20)
    failure(429,'每个账号每日最多创建 20 个本机生图任务');
  if(db.prepare("SELECT COALESCE(sum(a.size_bytes),0) AS n FROM media_assets a JOIN media_jobs j ON j.id=a.job_id WHERE a.user_id=? AND j.module='codex-local'").get(userId).n>=MAX_USER_IMAGES)
    failure(429,'本机作品存储已达 256 MB 上限，请先联系管理员整理作品');
  const source = mediaSourceInfo(userId, input.sourceType || '', input.sourceId);
  const id = randomUUID();
  transaction(() => {
    db.prepare(`INSERT INTO media_jobs (id,user_id,request_key,kind,module,model,mode,title,prompt,args,source_type,source_id,status)
      VALUES (?,?,?,'image','codex-local','Codex 原生生图','image',?,?,?,?,?,'local_queued')`)
      .run(id,userId,key,String(input.title || prompt.slice(0,60)).trim().slice(0,160),prompt,JSON.stringify({aspectRatio:ratio}),source.type,source.id);
    db.prepare('INSERT INTO local_image_tasks(job_id,device_id) VALUES (?,?)').run(id,target.id);
  });
  return getMediaJob(userId, id);
}

export async function handleLocalImageApi(req, res, pathname) {
  if (!pathname.startsWith('/api/local-image/')) return false;
  const reply = (data, status = 200) => {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(data)); return true;
  };
  try {
    expireStarted();
    const route = `${req.method} ${pathname}`;
    if (route === 'GET /api/local-image/devices') return reply({devices:devices(userFor(req).id)});
    if (route === 'POST /api/local-image/pair') {
      const user = userFor(req), input = await readBody(req);
      if (devices(user.id).filter(d => !d.revokedAt && d.expiresAt>Date.now()).length >= 10) failure(429, '请先撤销不再使用的设备');
      const code = randomBytes(16).toString('hex'), expiresAt = Date.now()+10*60_000;
      transaction(() => {
        db.prepare('DELETE FROM local_image_pairs WHERE user_id=? OR expires_at<?').run(user.id, Date.now());
        db.prepare('INSERT INTO local_image_pairs VALUES (?,?,?,?)').run(hash(code),user.id,String(input.label||'我的电脑').slice(0,80),expiresAt);
      });
      return reply({code,expiresAt});
    }
    if (route === 'POST /api/local-image/exchange') {
      // Pairing codes have 128 bits of entropy and are consumed exactly once.
      requireSameOriginWrite(req);
      const {code} = await readBody(req);
      if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) failure(400, '配对码无效');
      return reply(transaction(() => {
        const pair = db.prepare('SELECT * FROM local_image_pairs WHERE code_hash=? AND expires_at>?').get(hash(code),Date.now());
        if (!pair) failure(400, '配对码已使用或过期');
        const token = secret(), id = randomUUID(), expiresAt = Date.now()+90*24*60*60_000;
        db.prepare('INSERT INTO local_image_devices(id,user_id,label,token_hash,expires_at,is_default) VALUES (?,?,?,?,?,0)')
          .run(id,pair.user_id,pair.label,hash(token),expiresAt);
        db.prepare('DELETE FROM local_image_pairs WHERE code_hash=?').run(hash(code));
        return {deviceId:id,deviceToken:token,expiresAt};
      }));
    }
    const deviceAction = pathname.match(/^\/api\/local-image\/devices\/([a-f0-9-]+)\/(revoke|default)$/);
    if (deviceAction && req.method==='POST') {
      const user=userFor(req); await readBody(req);
      transaction(() => {
        const row=db.prepare('SELECT id FROM local_image_devices WHERE id=? AND user_id=? AND revoked_at=0 AND expires_at>?').get(deviceAction[1],user.id,Date.now());
        if (!row) failure(404,'设备不存在');
        if (deviceAction[2]==='default') {
          if (!db.prepare('SELECT 1 FROM local_image_devices WHERE id=? AND last_seen_at>0').get(row.id)) failure(409,'请先启动这台电脑的接收程序');
          db.prepare('UPDATE local_image_devices SET is_default=0 WHERE user_id=?').run(user.id);
          db.prepare('UPDATE local_image_devices SET is_default=1 WHERE id=?').run(row.id);
        } else {
          db.prepare('UPDATE local_image_devices SET revoked_at=?,is_default=0 WHERE id=?').run(Date.now(),row.id);
          db.prepare(`UPDATE media_jobs SET status='needs_review',error='执行设备已撤销；任务不会自动转交或重新生成'
            WHERE id IN (SELECT job_id FROM local_image_tasks WHERE device_id=?) AND status IN ('local_queued','local_claimed','generating')`).run(row.id);
        }
      });
      return reply({devices:devices(user.id)});
    }
    if (route==='POST /api/local-image/jobs') return reply(submit(userFor(req).id,await readBody(req)),201);
    const cancel=pathname.match(/^\/api\/local-image\/jobs\/([a-f0-9-]+)\/cancel$/);
    if (cancel && req.method==='POST') {
      const user=userFor(req); await readBody(req);
      if (!db.prepare("UPDATE media_jobs SET status='cancelled',error='',updated_at=datetime('now') WHERE id=? AND user_id=? AND module='codex-local' AND status IN ('local_queued','local_claimed')").run(cancel[1],user.id).changes)
        failure(409,'任务已开始或不存在，不能取消执行');
      return reply(getMediaJob(user.id,cancel[1]));
    }
    const device=deviceFor(req);
    if (route==='GET /api/local-image/status') {
      if (!db.prepare('SELECT 1 FROM local_image_devices WHERE user_id=? AND revoked_at=0 AND expires_at>? AND last_seen_at>0 AND is_default=1').get(device.user_id,Date.now())) {
        transaction(() => {
          db.prepare('UPDATE local_image_devices SET is_default=0 WHERE user_id=?').run(device.user_id);
          db.prepare('UPDATE local_image_devices SET is_default=1 WHERE id=?').run(device.id);
        });
      }
      return reply({deviceId:device.id,label:device.label,expiresAt:device.expires_at});
    }
    if (route==='POST /api/local-image/status') {
      const {state}=await readBody(req); deviceFor(req);
      if(!['ready','credits_confirmation_required','quota_unavailable','quota_exhausted','login_required','worker_error'].includes(state)) failure(400,'设备状态无效');
      db.prepare('UPDATE local_image_devices SET runtime_state=? WHERE id=?').run(state,device.id);
      return reply({ok:true});
    }
    if (route==='POST /api/local-image/claim') {
      await readBody(req);
      return reply(transaction(() => {
        deviceFor(req);
        if (db.prepare(`SELECT t.job_id FROM local_image_tasks t JOIN media_jobs j ON j.id=t.job_id
          WHERE t.device_id=? AND j.status IN ('generating','local_claimed') AND t.lease_until>?`).get(device.id,Date.now())) return {task:null};
        const row=db.prepare(`SELECT t.job_id FROM local_image_tasks t JOIN media_jobs j ON j.id=t.job_id
          WHERE t.device_id=? AND j.user_id=? AND t.started_at=0
          AND (j.status='local_queued' OR (j.status='local_claimed' AND t.lease_until<?)) ORDER BY j.created_at,j.id LIMIT 1`).get(device.id,device.user_id,Date.now());
        if (!row) return {task:null};
        const leaseToken=secret();
        db.prepare('UPDATE local_image_tasks SET lease_hash=?,lease_until=? WHERE job_id=?').run(hash(leaseToken),Date.now()+LEASE_MS,row.job_id);
        db.prepare("UPDATE media_jobs SET status='local_claimed',updated_at=datetime('now') WHERE id=?").run(row.job_id);
        return {task:{...getMediaJob(device.user_id,row.job_id),leaseToken}};
      }));
    }
    const action=pathname.match(/^\/api\/local-image\/tasks\/([a-f0-9-]+)\/(start|heartbeat|fail|complete)$/);
    if (action && req.method==='POST') {
      const [,_id,operation]=action;
      if (operation==='complete') {
        const lease=String(req.headers['x-image-lease']||'');
        let task=leased(device,_id,lease);
        if (!task.started_at || !['generating','needs_review','success'].includes(task.status)) failure(409,'任务尚未开始或已取消');
        const bytes=await readBody(req,MAX_IMAGE,true);
        deviceFor(req);
        task=leased(device,_id,lease);
        if (bytes.length<45 || !bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || bytes.toString('ascii',12,16)!=='IHDR'
          || !bytes.subarray(-8,-4).equals(Buffer.from('IEND')) || bytes.readUInt32BE(16)<1 || bytes.readUInt32BE(20)<1
          || bytes.readUInt32BE(16)>8192 || bytes.readUInt32BE(20)>8192) failure(415,'请回传有效的 PNG 图片');
        const digest=hash(bytes);
        if (task.status==='success') {
          if (task.result_hash!==digest) failure(409,'已保存的作品与本次回传不同');
          return reply(getMediaJob(device.user_id,_id));
        }
        const assetId=randomUUID(), name=`${assetId}.png`, temp=path.join(MEDIA_DIR,`${assetId}.upload`), destination=path.join(MEDIA_DIR,name);
        await mkdir(MEDIA_DIR,{recursive:true,mode:0o700});
        try {
          await writeFile(temp,bytes,{flag:'wx',mode:0o600}); await rename(temp,destination);
          transaction(() => {
            deviceFor(req); task=leased(device,_id,lease);
            if (task.status==='success') { if(task.result_hash!==digest) failure(409,'作品已保存'); return; }
            if (!['generating','needs_review'].includes(task.status)) failure(409,'任务状态已变化');
            if(db.prepare("SELECT COALESCE(sum(a.size_bytes),0) AS n FROM media_assets a JOIN media_jobs j ON j.id=a.job_id WHERE a.user_id=? AND j.module='codex-local'").get(device.user_id).n+bytes.length>MAX_USER_IMAGES)
              failure(429,'本机作品存储已达 256 MB 上限；图片仍保留在原设备，请联系管理员');
            const job=getMediaJob(device.user_id,_id);
            db.prepare(`INSERT INTO media_assets(id,user_id,job_id,kind,origin,file_name,mime_type,size_bytes,title,source_type,source_id,prompt_id,model,prompt)
              VALUES (?,?,?,'image','generated',?,'image/png',?,?,?,?,?,?,?)`).run(assetId,device.user_id,_id,name,bytes.length,job.title,job.sourceType,job.sourceId,job.sourceType==='prompt'?job.sourceId:null,job.model,job.prompt);
            db.prepare("UPDATE media_jobs SET status='success',asset_id=?,error='',updated_at=datetime('now') WHERE id=?").run(assetId,_id);
            db.prepare('UPDATE local_image_tasks SET result_hash=? WHERE job_id=?').run(digest,_id);
          });
          const result=getMediaJob(device.user_id,_id);
          if(result.assetId!==assetId) await rm(destination,{force:true});
          return reply(result);
        } catch(error) { await rm(temp,{force:true}); await rm(destination,{force:true}); throw error; }
      }
      const input=await readBody(req);
      deviceFor(req);
      const task=leased(device,_id,input.leaseToken);
      if(operation==='start') {
        if(task.started_at || task.status!=='local_claimed' || task.lease_until<=Date.now()) failure(409,'任务已开始或租约失效，禁止重复生成');
        transaction(() => {
          db.prepare('UPDATE local_image_tasks SET started_at=?,lease_until=? WHERE job_id=?').run(Date.now(),Date.now()+LEASE_MS,_id);
          db.prepare("UPDATE media_jobs SET status='generating',updated_at=datetime('now') WHERE id=?").run(_id);
        });
      } else if(operation==='heartbeat') {
        if(!['local_claimed','generating','needs_review'].includes(task.status)) failure(409,'任务已结束');
        if(!task.started_at && task.lease_until<=Date.now()) failure(409,'租约已过期');
        db.prepare('UPDATE local_image_tasks SET lease_until=? WHERE job_id=?').run(Date.now()+LEASE_MS,_id);
      } else {
        if(['local_claimed','generating','needs_review'].includes(task.status)) db.prepare("UPDATE media_jobs SET status='needs_review',error='本机未完成生成，请在电脑检查；不会自动重试或切换付费 API',updated_at=datetime('now') WHERE id=?").run(_id);
      }
      return reply(getMediaJob(device.user_id,_id));
    }
    failure(404,'接口不存在');
  } catch(error) { return reply({error: Number(error.status) ? error.message : '本机生图服务暂不可用'},Number(error.status)||500); }
}
