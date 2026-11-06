import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CEPHALON_SCHEDULER_ORIGIN = 'https://prod.unicorn.org.cn';
export const CEPHALON_SCHEDULER_BASE = `${CEPHALON_SCHEDULER_ORIGIN}/cephalon`;
export const CEPHALON_CONSOLE_ORIGIN = 'https://cephalon.cloud';
const CEPHALON_MODELS_PATH = '/user-center/v1/model/models';
const CEPHALON_CONNECTION_TIMEOUT_MS = 10_000;
const CEPHALON_CONNECTION_RESPONSE_MAX_BYTES = 1024 * 1024;

const MISSION_TYPES = new Set([
  'comfyui_advance_time', 'comfyui_compat_time', 'comfyui_time',
  'comfyui_advance_video_new_time', 'sd_webui_forge', 'sd_time',
  'sd_branch_time', 'sd_branch_base_time', 'fooocus', 'invokeai',
  'index_tts_time', 'f5_tts', 'chat_tts', 'heygem',
]);
const GPU_TYPES = new Set(['RTX4090', 'RTX4090D']);

export const cephalonError = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const hmacValue = (value, length, label) => {
  const normalized = text(value, length + 1).toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(normalized)) throw cephalonError(400, `${label}格式不正确`);
  return normalized;
};

export function validateCephalonCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw cephalonError(400, '端脑云凭证格式不正确');
  return {
    key: hmacValue(input.key, 32, '平台密钥'),
    secret: hmacValue(input.secret, 64, '平台密钥'),
    serviceKey: text(input.serviceKey, 4096),
  };
}

// Go encoding/json sorts map keys and HTML-escapes these code points. Keep this
// explicit because JSON.stringify does neither reliably enough for an HMAC byte
// contract. Undefined object properties mirror JSON.stringify and are omitted.
function goString(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => ({ '<':'\\u003c', '>':'\\u003e', '&':'\\u0026', '\u2028':'\\u2028', '\u2029':'\\u2029' }[char]));
}
function canonical(value, stack = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return goString(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) return 'null'; return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => item === undefined || typeof item === 'function' || typeof item === 'symbol' ? 'null' : canonical(item, stack)).join(',')}]`;
  if (!value || typeof value !== 'object') return undefined;
  if (stack.has(value)) throw cephalonError(400, '请求参数不能循环引用');
  stack.add(value);
  const entries = Object.keys(value).sort().flatMap(key => {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return [];
    return [`${goString(key)}:${canonical(item, stack)}`];
  });
  stack.delete(value);
  return `{${entries.join(',')}}`;
}

export function canonicalCephalonJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cephalonError(400, '请求参数必须是对象');
  return canonical(value);
}

export function signCephalonRequest(requestUri, secret, body) {
  if (typeof requestUri !== 'string' || !requestUri.startsWith('/') || requestUri.includes('://') || /[\r\n]/.test(requestUri)) throw cephalonError(400, '请求路径不正确');
  const normalizedSecret = hmacValue(secret, 64, '平台密钥');
  const json = body && typeof body === 'object' && !Array.isArray(body) ? canonicalCephalonJson(body) : '';
  const payload = goString(requestUri + (json === '{}' ? '' : json));
  return createHmac('sha256', normalizedSecret).update(payload, 'utf8').digest('hex');
}

async function readCephalonConnectionPayload(response) {
  const contentLength=Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > CEPHALON_CONNECTION_RESPONSE_MAX_BYTES)) throw new Error('response too large');
  const reader=response.body?.getReader?.();
  if (!reader) throw new Error('response body unavailable');
  const chunks=[];
  let size=0;
  try {
    while (true) {
      const { done, value }=await reader.read();
      if (done) break;
      const chunk=value instanceof Uint8Array ? value : new Uint8Array(value);
      size+=chunk.byteLength;
      if (size > CEPHALON_CONNECTION_RESPONSE_MAX_BYTES) throw new Error('response too large');
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function normalizeCephalonMission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw cephalonError(400, '端脑云任务参数不正确');
  const type = text(input.type, 80);
  const gpuVersion = text(input.gpuVersion || input.gpu_version, 32).toUpperCase();
  const gpuNum = Number(input.gpuNum ?? input.gpu_num);
  const batchSize = Number(input.batchSize ?? input.batch_size ?? 1);
  if (!MISSION_TYPES.has(type)) throw cephalonError(400, '该端脑云应用类型暂未开放');
  if (!GPU_TYPES.has(gpuVersion)) throw cephalonError(400, '显卡型号仅支持 RTX4090 或 RTX4090D');
  if (!Number.isInteger(gpuNum) || gpuNum < 1 || gpuNum > 8) throw cephalonError(400, '显卡数量需为 1 至 8');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 8) throw cephalonError(400, '任务数量需为 1 至 8');
  return { type, gpu_version:gpuVersion, gpu_num:gpuNum, batch_size:batchSize };
}

export function createCephalonClient({ fetchImpl = globalThis.fetch, connectionTimeoutMs = CEPHALON_CONNECTION_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');
  if (!Number.isInteger(connectionTimeoutMs) || connectionTimeoutMs < 1 || connectionTimeoutMs > 60_000) throw new TypeError('connectionTimeoutMs 必须介于 1 和 60000 之间');
  async function connectionTest(credentials) {
    const serviceKey=text(credentials?.serviceKey,4096);
    if (!serviceKey) return { connected:false, reason:'service_key_required' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), connectionTimeoutMs);
    try {
      const response = await fetchImpl(`${CEPHALON_CONSOLE_ORIGIN}${CEPHALON_MODELS_PATH}`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${serviceKey}`,
        },
      });
      if (!response || !response.ok) {
        return { connected:false, reason:response?.status === 401 || response?.status === 403 ? 'authentication_rejected' : 'service_unavailable' };
      }
      let payload;
      try {
        payload = await readCephalonConnectionPayload(response);
      } catch {
        return { connected:false, reason:controller.signal.aborted ? 'service_unavailable' : 'invalid_response' };
      }
      return payload && typeof payload === 'object' && !Array.isArray(payload) && payload.object === 'list' && Array.isArray(payload.data)
        ? { connected:true, models:payload.data.length }
        : { connected:false, reason:'invalid_response' };
    } catch {
      return { connected:false, reason:'service_unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    prepareMission(input, credentials) {
      const mission = normalizeCephalonMission(input);
      const auth = validateCephalonCredentials(credentials);
      const requestUri = '/cephalon/user-center/v1/user/missions/batch';
      return {
        url: `${CEPHALON_SCHEDULER_ORIGIN}${requestUri}`,
        requestUri,
        body: mission,
        headers: { 'Hmac-Key':auth.key, Hmac:signCephalonRequest(requestUri, auth.secret, mission) },
      };
    },
    dryRunProbe(credentials) {
      const auth = validateCephalonCredentials(credentials);
      return {
        configured: true,
        hasServiceKey: Boolean(auth.serviceKey),
        readyForPaidMission: false,
        reason: auth.serviceKey
          ? '已保存凭证；尚未启用真实创建，需先配置费用上限和已验证的工作流接口'
          : '调度文档的查询接口要求 Bearer Token，但未说明获取方式；无法进行联网校验',
      };
    },
    connectionTest,
  };
}

export function createCephalonStore({ db, directory }) {
  if (!db || !directory) throw new TypeError('db 和 directory 为必填项');
  db.exec(`CREATE TABLE IF NOT EXISTS cephalon_connections (
    user_id INTEGER PRIMARY KEY, credentials TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  let key;
  const keyFileError = () => cephalonError(500, '端脑云凭证加密配置异常');
  function readPrivateKeyFile(file) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw keyFileError();
    return readFileSync(file);
  }
  function encryptionKey() {
    if (key) return key;
    mkdirSync(directory, { recursive:true, mode:0o700 });
    const file = path.join(directory, 'cephalon.key');
    try { key = readPrivateKeyFile(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { writeFileSync(file, randomBytes(32), { mode:0o600, flag:'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      key = readPrivateKeyFile(file);
    }
    if (key.length !== 32) throw cephalonError(500, '端脑云凭证加密配置异常');
    return key;
  }
  const aad = userId => Buffer.from(String(userId), 'utf8');
  const seal = (userId, value) => { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm', encryptionKey(), iv); cipher.setAAD(aad(userId)); return Buffer.concat([iv,cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64'); };
  const unseal = (userId, value) => {
    try {
      const bytes=Buffer.from(value,'base64'); if(bytes.length < 29) throw cephalonError(500,'端脑云凭证无法读取'); const cipher=createDecipheriv('aes-256-gcm',encryptionKey(),bytes.subarray(0,12)); cipher.setAAD(aad(userId)); cipher.setAuthTag(bytes.subarray(-16)); return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('utf8'));
    } catch (error) { if (error?.status) throw error; throw cephalonError(500,'端脑云凭证无法读取'); }
  };
  const row = userId => db.prepare('SELECT credentials,updated_at FROM cephalon_connections WHERE user_id=?').get(userId);
  return {
    status(userId) { const saved=row(userId); return { configured:Boolean(saved), hasPlatformKey:Boolean(saved), hasServiceKey:Boolean(saved && unseal(userId, saved.credentials).serviceKey), updatedAt:saved?.updated_at || 0, liveGenerationEnabled:false }; },
    save(userId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw cephalonError(400,'端脑云凭证格式不正确');
      const previous=row(userId) ? unseal(userId, row(userId).credentials) : null;
      const suppliedKey=typeof input.key === 'string' && input.key.trim();
      const suppliedSecret=typeof input.secret === 'string' && input.secret.trim();
      if (Boolean(suppliedKey) !== Boolean(suppliedSecret)) throw cephalonError(400,'请同时填写平台密钥和平台密钥值');
      const credentials=validateCephalonCredentials({
        key:suppliedKey || previous?.key,
        secret:suppliedSecret || previous?.secret,
        serviceKey:input.clearServiceKey ? '' : (typeof input.serviceKey === 'string' && input.serviceKey.trim() ? input.serviceKey : previous?.serviceKey),
      });
      db.prepare('INSERT INTO cephalon_connections(user_id,credentials,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET credentials=excluded.credentials,updated_at=excluded.updated_at').run(userId,seal(userId, credentials),Date.now()); return this.status(userId);
    },
    credentials(userId) { const saved=row(userId); if(!saved) throw cephalonError(409,'请先配置端脑云平台密钥'); return validateCephalonCredentials(unseal(userId, saved.credentials)); },
    disconnect(userId) { db.prepare('DELETE FROM cephalon_connections WHERE user_id=?').run(userId); return this.status(userId); },
  };
}
