import { randomUUID } from 'node:crypto';

// Provider identity, API protocol and account authorization are separate concepts.
// Account login is offered only after this hosted product has an approved flow.
export const AI_PROVIDERS = [
  { id:'openai', name:'GPT · OpenAI', protocol:'responses', baseUrl:'https://api.openai.com/v1', docs:'https://developers.openai.com/api/docs/quickstart', authorization:'网站套餐授权需申请接入', authorizationDocs:'https://developers.openai.com/siwc/token-sharing-open-source' },
  { id:'anthropic', name:'Claude', protocol:'anthropic', baseUrl:'https://api.anthropic.com/v1', docs:'https://platform.claude.com/docs/en/api/overview', authorization:'第三方网站账号授权需供应商批准', authorizationDocs:'https://code.claude.com/docs/en/agent-sdk/overview' },
  { id:'kimi', name:'Kimi', protocol:'chat-completions', baseUrl:'https://api.moonshot.cn/v1', docs:'https://platform.moonshot.cn/docs/guide/getting-started', authorization:'Kimi Code 登录适用于官方客户端', authorizationDocs:'https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers' },
  { id:'deepseek', name:'DeepSeek', protocol:'chat-completions', baseUrl:'https://api.deepseek.com/v1', docs:'https://api-docs.deepseek.com/', authorization:'官方接入文档提供 API Key 方式' },
  { id:'custom', name:'其他兼容服务', protocol:'chat-completions', baseUrl:'', docs:null },
];
export const aiError = (status, message, code='configuration') => Object.assign(new Error(message), {status, code});

export function normalizeAiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw aiError(400, '请填写有效的 HTTPS 接口地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw aiError(400, '接口地址必须为 HTTPS，不能包含凭证、参数或自定义端口');
  if (!url.hostname.includes('.') || /[:\[\]]/.test(url.hostname) || /^(\d+\.){3}\d+$/.test(url.hostname) || /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw aiError(400, '接口地址需要使用公网域名');
  return url.href.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '');
}

export function createAiConnectionStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_connections (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    provider TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
    model TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    test_state TEXT NOT NULL DEFAULT 'untested', test_message TEXT NOT NULL DEFAULT '',
    tested_at INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ai_connections_owner ON ai_connections(user_id);
  CREATE TABLE IF NOT EXISTS ai_routes (
    user_id INTEGER NOT NULL REFERENCES users(id), purpose TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES ai_connections(id), PRIMARY KEY(user_id,purpose)
  );`);
  // Copy the previous single connection once, retaining its credentials and chat route.
  // Never infer a curation route: that would silently start spending another credential.
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name='ai-multiple-connections-v1'").get()) {
  db.exec(`BEGIN;
    INSERT OR IGNORE INTO ai_connections(id,user_id,name,provider,protocol,base_url,api_key,model,created_at,updated_at)
    SELECT 'legacy-' || user_id,user_id,'原有文字服务','custom','chat-completions',base_url,api_key,model,0,0 FROM ai_config WHERE api_key != '';
    INSERT OR IGNORE INTO ai_routes(user_id,purpose,connection_id)
    SELECT user_id,'chat','legacy-' || user_id FROM ai_config WHERE api_key != ''
      AND EXISTS(SELECT 1 FROM ai_connections c WHERE c.id='legacy-' || ai_config.user_id);
    INSERT INTO schema_migrations(name) VALUES('ai-multiple-connections-v1');
    COMMIT;`);
  }
  const get = (userId,id) => db.prepare('SELECT * FROM ai_connections WHERE user_id=? AND id=?').get(userId,id);
  const publicConnection = row => ({ id:row.id, name:row.name, provider:row.provider, protocol:row.protocol,
    baseUrl:row.base_url, model:row.model, authType:'api-key', hasKey:Boolean(row.api_key),
    revision:row.revision, testState:row.test_state, testMessage:row.test_message,
    testedAt:row.tested_at, latencyMs:row.latency_ms });
  const routes = userId => Object.fromEntries(db.prepare('SELECT purpose,connection_id FROM ai_routes WHERE user_id=?').all(userId).map(r=>[r.purpose,r.connection_id]));
  return {
    get, publicConnection, routes,
    list(userId) { return db.prepare('SELECT * FROM ai_connections WHERE user_id=? ORDER BY created_at,id').all(userId).map(publicConnection); },
    selected(userId,purpose='chat') { return db.prepare('SELECT c.* FROM ai_connections c JOIN ai_routes r ON r.connection_id=c.id AND r.user_id=c.user_id WHERE c.user_id=? AND r.purpose=?').get(userId,purpose); },
    save(userId,input,id) {
      if (!input || typeof input!=='object' || Array.isArray(input)) throw aiError(400,'连接配置格式不正确');
      const old = id ? get(userId,id) : null;
      if (id && !old) throw aiError(404,'连接不存在');
      if (old && input.revision !== old.revision) throw aiError(409,'连接已更新，请重新打开后编辑');
      if (!old && this.list(userId).length >= 20) throw aiError(400,'最多保存 20 条 AI 连接');
      const text = (v,max) => typeof v === 'string' ? v.trim().slice(0,max) : '';
      const name = text(input.name,80), provider = text(input.provider,40), protocol = text(input.protocol,40);
      const baseUrl = normalizeAiUrl(input.baseUrl), model = text(input.model,160);
      const apiKey = text(input.apiKey,4096) || old?.api_key || '';
      if (!name || !model || !apiKey) throw aiError(400,'请填写连接名称、模型和 API Key');
      if (!AI_PROVIDERS.some(p=>p.id===provider) || !['responses','anthropic','chat-completions'].includes(protocol)) throw aiError(400,'服务商或接口协议不受支持');
      if (/[\r\n]/.test(apiKey)) throw aiError(400,'API Key 格式不正确');
      // Never send a retained key to a newly selected host or protocol.
      if (old && !text(input.apiKey,4096) && (baseUrl !== old.base_url || protocol !== old.protocol || provider !== old.provider)) throw aiError(400,'更换接口或服务商时，请重新填写 API Key');
      const now=Date.now(), key=id || randomUUID();
      const changed=!old || [provider,protocol,baseUrl,apiKey,model].some((v,i)=>v!==[old.provider,old.protocol,old.base_url,old.api_key,old.model][i]);
      if (old) db.prepare(`UPDATE ai_connections SET name=?,provider=?,protocol=?,base_url=?,api_key=?,model=?,revision=revision+1,
        test_state=?,test_message=?,tested_at=?,latency_ms=?,updated_at=? WHERE user_id=? AND id=?`).run(name,provider,protocol,baseUrl,apiKey,model,
          changed?'untested':old.test_state,changed?'':old.test_message,changed?0:old.tested_at,changed?0:old.latency_ms,now,userId,key);
      else db.prepare('INSERT INTO ai_connections(id,user_id,name,provider,protocol,base_url,api_key,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,userId,name,provider,protocol,baseUrl,apiKey,model,now,now);
      return publicConnection(get(userId,key));
    },
    recordTest(userId,id,revision,{state,message,latencyMs}) {
      const result=db.prepare('UPDATE ai_connections SET test_state=?,test_message=?,tested_at=?,latency_ms=? WHERE user_id=? AND id=? AND revision=?').run(state,message,Date.now(),latencyMs,userId,id,revision);
      if (!result.changes) throw aiError(409,'测试期间配置已改变，请重新测试');
      return publicConnection(get(userId,id));
    },
    assign(userId,purpose,id) {
      if (!['chat','curation'].includes(purpose)) throw aiError(400,'用途不正确');
      if (!id) { db.prepare('DELETE FROM ai_routes WHERE user_id=? AND purpose=?').run(userId,purpose); return; }
      const row=get(userId,id);
      if (!row) throw aiError(404,'连接不存在');
      if (row.test_state !== 'ready') throw aiError(400,'请先测试这条连接，确认文字和 JSON 输出正常');
      db.prepare('INSERT INTO ai_routes(user_id,purpose,connection_id) VALUES(?,?,?) ON CONFLICT(user_id,purpose) DO UPDATE SET connection_id=excluded.connection_id').run(userId,purpose,id);
    },
    remove(userId,id) {
      if (!get(userId,id)) throw aiError(404,'连接不存在');
      if (Object.values(routes(userId)).includes(id)) throw aiError(409,'请先解除这条连接的用途，再删除');
      db.prepare('DELETE FROM ai_connections WHERE user_id=? AND id=?').run(userId,id);
      // Prevent the one-time legacy import from resurrecting a deleted connection.
      if (id === `legacy-${userId}`) db.prepare('DELETE FROM ai_config WHERE user_id=?').run(userId);
    },
  };
}
