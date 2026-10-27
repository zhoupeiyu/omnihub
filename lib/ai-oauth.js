import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { aiError } from './ai-connections.js';
import { fetchAiEndpoint } from './ai-provider.js';

export const AI_OAUTH_CALLBACK='/api/ai/oauth/openai/callback';
const ISSUER='https://auth.openai.com', RESOURCE='https://api.openai.com/v1';
const SCOPES=['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const fail=(code,message,status=409)=>aiError(status,message,code);

// This is the registered hosted-client flow. Never reuse another application's
// client ID or substitute the loopback-only dynamic_agent_client registration.
export function createAiOAuth({db,connections,env=process.env,fetchImpl=fetchAiEndpoint,now=Date.now}) {
  const clientId=env.OMNIHUB_OPENAI_CLIENT_ID||'';
  const redirectUri=env.OMNIHUB_OPENAI_REDIRECT_URI||'';
  const method=env.OMNIHUB_OPENAI_TOKEN_AUTH_METHOD||'';
  const secret=env.OMNIHUB_OPENAI_CLIENT_SECRET||'';
  const key=/^[a-f0-9]{64}$/i.test(env.OMNIHUB_AI_OAUTH_KEY||'')?Buffer.from(env.OMNIHUB_AI_OAUTH_KEY,'hex'):null;
  const appKey=digest(JSON.stringify([clientId,redirectUri,method,secret]));
  let callback;
  try {const url=new URL(redirectUri);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname===AI_OAUTH_CALLBACK)callback=url;}catch{}
  const ready=()=>Boolean(/^oaiapp_[\w-]+$/.test(clientId)&&callback&&key&&['none','client_secret_basic'].includes(method)&&
    (method!=='client_secret_basic'||secret)&&env.OMNIHUB_OPENAI_PLAN_USAGE_APPROVED==='true');
  function status() {
    return {available:ready(),label:'使用 ChatGPT 授权登录',
      message:ready()?'前往 ChatGPT 授权，完成后返回此页面。':'网站尚未开通 ChatGPT 授权接入，可先使用 API Key。',
      docs:'https://developers.openai.com/siwc/request-client-id'};
  }
  function requireReady(){if(!ready())throw fail('oauth_unavailable','网站尚未开通 ChatGPT 授权接入，可先使用 API Key。');}
  function seal(value,context) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));
    const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  }
  function unseal(value,context) {
    try {const p=JSON.parse(value),cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(p.iv,'base64'));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(p.tag,'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(p.data,'base64')),cipher.final()]).toString());
    }catch{throw fail('reconnect_required','授权凭证不可用，请重新授权');}
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ai_oauth_transactions (
    state_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,session_hash TEXT NOT NULL,
    connection_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,
    nonce TEXT NOT NULL,verifier TEXT NOT NULL,app_key TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_oauth_attempts (user_id INTEGER PRIMARY KEY,state_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_oauth_grants (
    connection_id TEXT PRIMARY KEY REFERENCES ai_connections(id) ON DELETE CASCADE,user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,credentials TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
    app_key TEXT NOT NULL,needs_reauth INTEGER NOT NULL DEFAULT 0,refresh_lease TEXT NOT NULL DEFAULT '',refresh_until INTEGER NOT NULL DEFAULT 0);`);
  const grant=(userId,id)=>db.prepare('SELECT * FROM ai_oauth_grants WHERE user_id=? AND connection_id=?').get(userId,id);
  const context=g=>`${g.app_key}:${g.user_id}:${g.connection_id}`;
  function liveSession(user) {
    if(!user?.token||!db.prepare('SELECT 1 FROM sessions WHERE user_id=? AND token=?').get(user.id,user.token))throw fail('session_required','请重新登录网站',401);
  }
  async function json(url,options={}) {
    let response;
    try {
      response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20_000)});
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw fail('oauth_upstream','官方授权请求失败，请稍后重新授权',502);}
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>128*1024)throw Error('large');chunks.push(Buffer.from(chunk));}
      return JSON.parse(Buffer.concat(chunks).toString());
    }catch(error){if(error?.code==='oauth_upstream')throw error;throw fail('oauth_upstream','官方授权请求失败，请稍后重新授权',502);}
  }
  let discoveryCache,jwksCache;
  async function discovery() {
    if(discoveryCache&&discoveryCache.until>now())return discoveryCache.value;
    const d=await json(ISSUER+'/.well-known/openid-configuration');
    if(d.issuer!==ISSUER||d.authorization_endpoint!==ISSUER+'/api/accounts/authorize'||d.token_endpoint!==ISSUER+'/api/accounts/oauth/token'||d.jwks_uri!==ISSUER+'/.well-known/jwks.json')throw fail('oauth_discovery','官方授权配置与预期不符',502);
    discoveryCache={value:d,until:now()+3600_000};return d;
  }
  async function keys(force=false) {
    if(!force&&jwksCache&&jwksCache.until>now())return jwksCache.value;
    const d=await discovery(),j=await json(d.jwks_uri);
    if(!Array.isArray(j.keys)||j.keys.length>30)throw fail('invalid_identity','无法校验授权账号',502);
    jwksCache={value:j.keys,until:now()+300_000};return j.keys;
  }
  async function identity(token,nonce,expectedSubject) {
    try {
      if(typeof token!=='string'||token.length>32768)throw 0;
      const parts=token.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw 0;
      const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()),p=JSON.parse(Buffer.from(parts[1],'base64url').toString());
      // Deliberately support only the issuer's RS256 ID-token contract. No JWT
      // algorithm negotiation or token-supplied key URLs are accepted.
      if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit||header.jku||header.jwk||header.x5u)throw 0;
      let matches=(await keys()).filter(k=>k.kid===header.kid);
      if(!matches.length)matches=(await keys(true)).filter(k=>k.kid===header.kid);
      if(matches.length!==1)throw 0;
      const jwk=matches[0];if(jwk.kty!=='RSA'||jwk.alg&&jwk.alg!=='RS256'||jwk.use&&jwk.use!=='sig')throw 0;
      const publicKey=createPublicKey({key:jwk,format:'jwk'});
      if(publicKey.asymmetricKeyDetails.modulusLength<2048||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')))throw 0;
      const seconds=now()/1000,aud=Array.isArray(p.aud)?p.aud:[p.aud];
      if(p.iss!==ISSUER||!aud.includes(clientId)||aud.length>1&&p.azp!==clientId||p.azp&&p.azp!==clientId||
        !Number.isFinite(p.exp)||p.exp<=seconds-5||!Number.isFinite(p.iat)||p.iat>seconds+5||p.exp<=p.iat||
        p.nbf!==undefined&&(!Number.isFinite(p.nbf)||p.nbf>seconds+5)||typeof p.sub!=='string'||!p.sub||p.sub.length>512||
        nonce&&p.nonce!==nonce||expectedSubject&&p.sub!==expectedSubject)throw 0;
      return p;
    }catch{throw fail('invalid_identity','无法校验授权账号，请重新授权',400);}
  }
  async function exchange(parameters) {
    const d=await discovery(),headers={'content-type':'application/x-www-form-urlencoded','accept':'application/json'};
    if(method==='client_secret_basic'){
      const encode=v=>new URLSearchParams({v}).toString().slice(2);
      headers.authorization='Basic '+Buffer.from(encode(clientId)+':'+encode(secret)).toString('base64');
    }
    return json(d.token_endpoint,{method:'POST',headers,body:new URLSearchParams({...parameters,client_id:clientId,resource:RESOURCE}).toString()});
  }
  function credentials(tokens,previous) {
    const scope=typeof tokens.scope==='string'?tokens.scope:previous?.scope;
    const scopes=new Set(String(scope||'').split(' '));
    if(!SCOPES.every(s=>scopes.has(s)))throw fail('scope_missing','未获得 ChatGPT 套餐调用权限，请重新授权',400);
    if(tokens.token_type?.toLowerCase()!=='bearer'||typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>32768||
      typeof tokens.refresh_token!=='string'||!tokens.refresh_token||tokens.refresh_token.length>32768||/[\r\n]/.test(tokens.access_token)||
      !Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>86400)throw fail('invalid_grant','授权凭证不完整，请重新授权',400);
    const earliest=Number(tokens.earliest_refresh_at||0)*1000;
    if(!Number.isFinite(earliest)||earliest>now()+tokens.expires_in*1000)throw fail('invalid_grant','授权有效期不正确，请重新授权',400);
    return {accessToken:tokens.access_token,refreshToken:tokens.refresh_token,scope,expiresAt:now()+tokens.expires_in*1000,earliestRefreshAt:earliest};
  }
  async function start(user,input={}) {
    requireReady();liveSession(user);
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail('invalid_input','授权参数无效',400);
    if(input.connectionId&&(typeof input.connectionId!=='string'||input.connectionId.length>80))throw fail('invalid_input','授权连接无效',400);
    const old=input.connectionId?connections.get(user.id,input.connectionId):null;
    if(input.connectionId&&(!old||old.auth_type!=='oauth'))throw fail('connection_missing','授权连接不存在',404);
    if(old&&input.revision!==old.revision)throw fail('connection_changed','连接已更新，请重新打开后授权');
    if(!old&&connections.list(user.id).length>=20)throw fail('connection_limit','最多保存 20 条 AI 连接',400);
    const name=typeof input.name==='string'?input.name.trim().slice(0,80):'';
    const d=await discovery();liveSession(user);
    const state=random(),stateHash=digest(state),verifier=random(),nonce=random();
    db.prepare('DELETE FROM ai_oauth_transactions WHERE user_id=? OR expires_at<=?').run(user.id,now());
    db.prepare('INSERT INTO ai_oauth_transactions VALUES(?,?,?,?,?,?,?,?,?,?)').run(stateHash,user.id,digest(user.token),old?.id||'',old?.revision||0,name||old?.name||'我的 ChatGPT',nonce,seal(verifier,stateHash),appKey,now()+600_000);
    db.prepare('INSERT INTO ai_oauth_attempts VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET state_hash=excluded.state_hash').run(user.id,stateHash);
    const params=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:SCOPES.join(' '),resource:RESOURCE,state,nonce,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    return {authorizationUrl:d.authorization_endpoint+'?'+params};
  }
  async function finish(user,params) {
    requireReady();liveSession(user);
    const state=params.get('state')||'',hash=digest(state);
    const pending=db.prepare('SELECT * FROM ai_oauth_transactions WHERE state_hash=?').get(hash);
    if(!/^[\w-]{43}$/.test(state)||params.getAll('state').length!==1||!pending||pending.user_id!==user.id||pending.session_hash!==digest(user.token)||pending.app_key!==appKey||pending.expires_at<=now())
      throw fail('invalid_state','授权已过期或不是在当前登录会话发起的',400);
    if(!db.prepare('DELETE FROM ai_oauth_transactions WHERE state_hash=?').run(hash).changes)throw fail('invalid_state','授权已使用，请重新发起',400);
    if(params.has('error'))throw fail('authorization_cancelled','已取消 ChatGPT 授权',400);
    const code=params.get('code');if(!code||code.length>4096||params.getAll('code').length!==1)throw fail('invalid_code','授权码无效',400);
    function assertCurrent() {
      liveSession(user);
      if(db.prepare('SELECT state_hash FROM ai_oauth_attempts WHERE user_id=?').get(user.id)?.state_hash!==hash)throw fail('connection_changed','已发起新的授权，请完成最新的登录');
      const old=pending.connection_id?connections.get(user.id,pending.connection_id):null;
      if(pending.connection_id&&(!old||old.revision!==pending.revision))throw fail('connection_changed','连接已改变，请重新授权');
      if(!old&&connections.list(user.id).length>=20)throw fail('connection_limit','最多保存 20 条 AI 连接',400);
      return old;
    }
    assertCurrent();
    const token=await exchange({grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:unseal(pending.verifier,hash)});
    const previous=pending.connection_id?grant(user.id,pending.connection_id):null;
    const profile=await identity(token.id_token,pending.nonce,previous?.subject);
    const creds=credentials(token),old=assertCurrent(),id=old?.id||randomUUID();
    const label=profile.email_verified===true&&typeof profile.email==='string'?profile.email.slice(0,160):'ChatGPT 账号';
    const encrypted=seal(creds,context({app_key:appKey,user_id:user.id,connection_id:id}));
    db.exec('BEGIN IMMEDIATE');
    try {
      if(old)db.prepare("UPDATE ai_connections SET account_label=?,revision=revision+1,test_state='untested',test_message='',tested_at=0,latency_ms=0,updated_at=? WHERE user_id=? AND id=?").run(label,now(),user.id,id);
      else db.prepare(`INSERT INTO ai_connections(id,user_id,name,provider,protocol,base_url,api_key,model,created_at,updated_at,auth_type,account_label) VALUES(?,?,?,'openai','responses',?,'','',?,?,'oauth',?)`).run(id,user.id,pending.name,RESOURCE,now(),now(),label);
      db.prepare(`INSERT INTO ai_oauth_grants(connection_id,user_id,subject,credentials,app_key) VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET credentials=excluded.credentials,app_key=excluded.app_key,version=version+1,needs_reauth=0,refresh_lease='',refresh_until=0`).run(id,user.id,profile.sub,encrypted,appKey);
      db.prepare('DELETE FROM ai_oauth_attempts WHERE user_id=? AND state_hash=?').run(user.id,hash);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return connections.publicConnection(connections.get(user.id,id));
  }
  const refreshes=new Map();
  async function accessToken(connection) {
    requireReady();
    const g=grant(connection.user_id,connection.id);
    if(!g||g.app_key!==appKey||g.needs_reauth)throw fail('reconnect_required','ChatGPT 授权已失效，请重新授权');
    const saved=unseal(g.credentials,context(g));
    if(saved.expiresAt>now()+60_000||now()<saved.earliestRefreshAt&&saved.expiresAt>now())return saved.accessToken;
    if(refreshes.has(g.connection_id))return refreshes.get(g.connection_id);
    const lease=random();
    // A crashed or concurrent process must not replay a rotating refresh token.
    const lock=db.prepare("UPDATE ai_oauth_grants SET refresh_lease=?,refresh_until=? WHERE connection_id=? AND user_id=? AND version=? AND refresh_lease='' AND needs_reauth=0").run(lease,now()+60_000,g.connection_id,g.user_id,g.version);
    if(!lock.changes)throw fail('refresh_pending','授权正在更新；若持续失败，请重新授权');
    const task=(async()=>{
      try {
        const token=await exchange({grant_type:'refresh_token',refresh_token:saved.refreshToken});
        if(token.id_token)await identity(token.id_token,null,g.subject);
        const next=credentials(token,saved);
        if(!db.prepare("UPDATE ai_oauth_grants SET credentials=?,version=version+1,refresh_lease='',refresh_until=0 WHERE user_id=? AND connection_id=? AND version=? AND refresh_lease=?").run(seal(next,context(g)),g.user_id,g.connection_id,g.version,lease).changes)throw fail('connection_changed','授权连接已改变，请重试');
        return next.accessToken;
      }catch{
        const changed=db.prepare("UPDATE ai_oauth_grants SET needs_reauth=1,refresh_lease='',refresh_until=0 WHERE user_id=? AND connection_id=? AND version=? AND refresh_lease=?").run(g.user_id,g.connection_id,g.version,lease).changes;
        if(changed)db.prepare("UPDATE ai_connections SET test_state='failed',test_message='ChatGPT 授权已失效，请重新授权' WHERE user_id=? AND id=?").run(g.user_id,g.connection_id);
        throw fail('reconnect_required','ChatGPT 授权更新失败，请重新授权');
      }finally{refreshes.delete(g.connection_id);}
    })();refreshes.set(g.connection_id,task);return task;
  }
  return {status,start,finish,accessToken};
}
