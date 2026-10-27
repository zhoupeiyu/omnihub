import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createAiConnectionStore} from '../lib/ai-connections.js';
import {createAiOAuth,AI_OAUTH_CALLBACK} from '../lib/ai-oauth.js';
import {createAiProvider} from '../lib/ai-provider.js';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
const issuer='https://auth.openai.com',resource='https://api.openai.com/v1';
const discovery={issuer,authorization_endpoint:issuer+'/api/accounts/authorize',token_endpoint:issuer+'/api/accounts/oauth/token',jwks_uri:issuer+'/.well-known/jwks.json'};
const env={OMNIHUB_OPENAI_CLIENT_ID:'oaiapp_fixture',OMNIHUB_OPENAI_REDIRECT_URI:'https://omnihub.example'+AI_OAUTH_CALLBACK,
  OMNIHUB_OPENAI_TOKEN_AUTH_METHOD:'none',OMNIHUB_OPENAI_PLAN_USAGE_APPROVED:'true',OMNIHUB_AI_OAUTH_KEY:'ab'.repeat(32)};
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const user={id:1,token:'session-alice'},bob={id:2,token:'session-bob'};
function fixture(t,config=env) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1),(2);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER); INSERT INTO sessions VALUES('session-alice',1),('session-bob',2);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);CREATE TABLE ai_config(user_id INTEGER PRIMARY KEY,base_url TEXT,api_key TEXT,model TEXT);`);
  const connections=createAiConnectionStore(db),state={time:1793060000000,nonce:'',claims:{},tokens:{},calls:[],beforeToken:null,header:{},key:pair.privateKey};
  function jwt(){const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key',...state.header})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iss:issuer,aud:env.OMNIHUB_OPENAI_CLIENT_ID,sub:'openai-alice',iat:state.time/1000,exp:state.time/1000+3600,nonce:state.nonce,email:'alice@example.com',email_verified:true,...state.claims})).toString('base64url');
    return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),state.key).toString('base64url');}
  const fetchImpl=async(url,options={})=>{
    state.calls.push({url,options});
    if(url.endsWith('openid-configuration'))return Response.json(discovery);
    if(url===discovery.jwks_uri)return Response.json({keys:[jwk]});
    if(url===discovery.token_endpoint){if(state.beforeToken)await state.beforeToken(options);return Response.json({id_token:jwt(),access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600,scope:scopes,token_type:'Bearer',...state.tokens});}
    throw Error('Unexpected URL');
  };
  const oauth=createAiOAuth({db,connections,env:config,fetchImpl,now:()=>state.time});
  async function start(input={}){const result=await oauth.start(user,input),url=new URL(result.authorizationUrl);state.nonce=url.searchParams.get('nonce');return url;}
  const params=url=>new URLSearchParams({state:url.searchParams.get('state'),code:'fixture-code'});
  async function connect(){const url=await start();return oauth.finish(user,params(url));}
  return {db,connections,oauth,state,start,params,connect};
}
test('unregistered hosted clients fail closed without creating transactions',async t=>{
  for(const config of [{},{...env,OMNIHUB_OPENAI_PLAN_USAGE_APPROVED:'false'},{...env,OMNIHUB_OPENAI_CLIENT_ID:'dynamic_agent_client'},
    {...env,OMNIHUB_OPENAI_REDIRECT_URI:'http://localhost'+AI_OAUTH_CALLBACK},{...env,OMNIHUB_OPENAI_TOKEN_AUTH_METHOD:'client_secret_basic'}]){
    const f=fixture(t,config);assert.equal(f.oauth.status().available,false);await assert.rejects(f.start(),{code:'oauth_unavailable'});assert.equal(f.state.calls.length,0);
  }
});
test('PKCE login stores only encrypted credentials and binds the result to its initiating user',async t=>{
  const f=fixture(t),url=await f.start({name:'个人 ChatGPT'}),params=f.params(url);
  assert.equal(url.origin,issuer);assert.equal(url.searchParams.get('client_id'),'oaiapp_fixture');assert.equal(url.searchParams.get('resource'),resource);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),scopes);
  await assert.rejects(f.oauth.finish(bob,params),{code:'invalid_state'});
  const row=await f.oauth.finish(user,params);assert.equal(row.authType,'oauth');assert.equal(row.hasKey,false);assert.equal(row.model,'');assert.equal(row.testState,'untested');assert.equal(row.accountLabel,'alice@example.com');
  assert.equal(f.connections.list(2).length,0);assert.equal(f.connections.get(1,row.id).api_key,'');
  const exchange=f.state.calls.find(c=>c.url===discovery.token_endpoint),body=new URLSearchParams(exchange.options.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(body.get('redirect_uri'),env.OMNIHUB_OPENAI_REDIRECT_URI);assert.equal(body.get('resource'),resource);
  const raw=f.db.prepare('SELECT * FROM ai_oauth_grants').get();assert.ok(!JSON.stringify(raw).includes('secret-access'));assert.ok(!JSON.stringify(raw).includes('secret-refresh'));
  assert.equal(await f.oauth.accessToken(f.connections.get(1,row.id)),'secret-access');
  await assert.rejects(f.oauth.finish(user,params),{code:'invalid_state'});
  assert.throws(()=>f.connections.assign(1,'chat',row.id));
});
test('denial, expiry, replaced attempt, duplicate state, and a changed login session do not exchange codes',async t=>{
  for(const kind of ['denied','expired','replaced','duplicate','session']){
    const f=fixture(t),url=await f.start(),p=f.params(url);
    if(kind==='denied')p.set('error','access_denied');
    if(kind==='expired')f.state.time+=601000;
    if(kind==='replaced')await f.start();
    if(kind==='duplicate')p.append('state',p.get('state'));
    if(kind==='session')f.db.prepare('DELETE FROM sessions WHERE token=?').run(user.token);
    await assert.rejects(f.oauth.finish(user,p));assert.equal(f.state.calls.filter(c=>c.url===discovery.token_endpoint).length,0);assert.equal(f.connections.list(1).length,0);
  }
});
test('ID tokens require a verified signature, issuer, audience, nonce, subject and valid timestamps',async t=>{
  for(const claims of [{iss:'https://attacker.example'},{aud:'another-client'},{nonce:'wrong'},{sub:''},{exp:0},{iat:9999999999},{nbf:9999999999},{aud:['oaiapp_fixture','another-client']}]){
    const f=fixture(t);f.state.claims=claims;await assert.rejects(f.connect(),{code:'invalid_identity'});assert.equal(f.connections.list(1).length,0);
  }
  for(const header of [{alg:'none'},{kid:'missing'},{jku:'https://attacker.example/keys'},{crit:['unexpected']}]){
    const f=fixture(t);f.state.header=header;await assert.rejects(f.connect(),{code:'invalid_identity'});
  }
  const f=fixture(t);f.state.key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;await assert.rejects(f.connect(),{code:'invalid_identity'});
});
test('identity alone, incomplete token sets, and user logout during exchange never establish a connection',async t=>{
  for(const tokens of [{scope:'openid profile email'},{refresh_token:''},{token_type:'MAC'},{expires_in:-1}]){
    const f=fixture(t);f.state.tokens=tokens;await assert.rejects(f.connect());assert.equal(f.connections.list(1).length,0);
  }
  const f=fixture(t);f.state.beforeToken=()=>f.db.prepare('DELETE FROM sessions WHERE token=?').run(user.token);
  await assert.rejects(f.connect(),{code:'session_required'});assert.equal(f.connections.list(1).length,0);
});
test('confidential clients send their secret only in the Basic header',async t=>{
  const f=fixture(t,{...env,OMNIHUB_OPENAI_TOKEN_AUTH_METHOD:'client_secret_basic',OMNIHUB_OPENAI_CLIENT_SECRET:'private:secret+'});
  await f.connect();const call=f.state.calls.find(c=>c.url===discovery.token_endpoint);
  assert.equal(Buffer.from(call.options.headers.authorization.slice(6),'base64').toString(),'oaiapp_fixture:private%3Asecret%2B');
  assert.ok(!call.options.body.includes('client_secret'));assert.ok(!call.url.includes('private'));
});
test('refresh rotates atomically, is serialized, and does not re-test the chosen model',async t=>{
  const f=fixture(t),row=await f.connect(),connection=f.connections.get(1,row.id);f.state.time+=3600_000;
  f.state.tokens={access_token:'access-rotated',refresh_token:'refresh-rotated',scope:undefined};
  let release;f.state.beforeToken=()=>new Promise(r=>{release=r;});
  const a=f.oauth.accessToken(connection),b=f.oauth.accessToken(connection);
  await new Promise(r=>setImmediate(r));release();assert.deepEqual(await Promise.all([a,b]),['access-rotated','access-rotated']);
  assert.equal(f.state.calls.filter(c=>c.url===discovery.token_endpoint).length,2);
  assert.equal(await f.oauth.accessToken(connection),'access-rotated');
  const body=new URLSearchParams(f.state.calls.filter(c=>c.url===discovery.token_endpoint).at(-1).options.body);
  assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'secret-refresh');assert.equal(body.has('scope'),false);
});
test('failed or ambiguous refresh is not retried with the same rotating credential',async t=>{
  const f=fixture(t),row=await f.connect(),connection=f.connections.get(1,row.id);f.state.time+=3600_000;
  f.state.beforeToken=()=>{throw Error('must not expose secret-refresh');};
  await assert.rejects(f.oauth.accessToken(connection),{code:'reconnect_required'});
  const count=f.state.calls.length;await assert.rejects(f.oauth.accessToken(connection),{code:'reconnect_required'});assert.equal(f.state.calls.length,count);
  assert.equal(f.connections.get(1,row.id).test_state,'failed');
});
test('deletion and reauthorization races cannot resurrect a connection or switch its identity',async t=>{
  const f=fixture(t),row=await f.connect();
  let url=await f.start({connectionId:row.id,revision:row.revision});f.state.claims={sub:'another-account'};
  await assert.rejects(f.oauth.finish(user,f.params(url)),{code:'invalid_identity'});
  f.state.claims={};url=await f.start({connectionId:row.id,revision:row.revision});
  f.state.beforeToken=()=>f.connections.remove(1,row.id);
  await assert.rejects(f.oauth.finish(user,f.params(url)),{code:'connection_changed'});
  assert.equal(f.connections.list(1).length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_oauth_grants').get().n,0);
});
test('OAuth connections accept model edits but cannot be forged or sent to another endpoint',async t=>{
  const f=fixture(t),row=await f.connect();
  const next=f.connections.save(1,{...row,model:'model-fixture',apiKey:''},row.id);assert.equal(next.model,'model-fixture');
  for(const patch of [{baseUrl:'https://attacker.example'},{protocol:'chat-completions'},{apiKey:'secret'},{authType:'api-key'}])assert.throws(()=>f.connections.save(1,{...next,...patch},row.id));
  assert.throws(()=>f.connections.save(2,{...row,model:'x'}),{status:400});
});
test('Responses subscription requests omit unsupported parameters and keep tokens out of bodies',async()=>{
  let seen,lookups=0;
  const provider=createAiProvider({oauthToken:async()=>{lookups++;return 'private-access';},fetchImpl:async(url,options)=>{seen={url,options};return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{}}\n\n');}});
  const c={auth_type:'oauth',provider:'openai',protocol:'responses',base_url:resource,model:'fixture'};
  assert.equal((await provider.complete(c,[{role:'user',content:'hello'}])).reply,'ok');
  const body=JSON.parse(seen.options.body);assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.max_output_tokens,undefined);assert.equal(seen.options.headers.authorization,'Bearer private-access');assert.ok(!seen.options.body.includes('private-access'));
  await assert.rejects(provider.complete({...c,base_url:'https://attacker.example'},[{role:'user',content:'hello'}]));assert.equal(lookups,1);
});
