import { randomUUID, createHash } from 'node:crypto';
import {CONTENT_PROMPTS,hashContent} from './content-policy.js';
import {normalizeXHandle} from './x-following.js';
import {createXProviderBudget} from './x-provider-budget.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const parse=(value,fallback={})=>{try{return JSON.parse(value);}catch{return fallback;}};
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idPattern=/^[1-9][0-9]{0,24}$/;
const handlePattern=/^[a-zA-Z0-9_]{1,15}$/;
const maxId=(a,b)=>BigInt(a||0)>BigInt(b||0)?a:b;
const https=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
// Reserve conservatively before each page. The provider bills returned items, not requests.
const PAGE_RESERVE_MICRO_USD=40000;
export const WATCH_VERSION=`x-watch-v2-${hashContent([CONTENT_PROMPTS.watch,CONTENT_PROMPTS.verify]).slice(0,12)}`;

export function normalizeWatchedPost(tweet,handle) {
  if(!tweet||!idPattern.test(tweet.id_str)||!handlePattern.test(tweet.user?.screen_name||''))fail(502,'采集结果身份字段无效');
  if(tweet.user.screen_name.toLowerCase()!==handle.toLowerCase()||tweet.user.protected)return null;
  const content=tweet.full_text||tweet.text||'';
  if(typeof content!=='string'||content.length>100000)fail(502,'采集正文无效');
  const media=(tweet.extended_entities?.media||tweet.entities?.media||[]).slice(0,16).map(m=>{
    const variants=(m.video_info?.variants||[]).filter(v=>v.content_type==='video/mp4'&&https(v.url));
    const video=variants.sort((a,b)=>(Number(a.bitrate)||0)-(Number(b.bitrate)||0))[0];
    return {type:m.type==='photo'?'photo':m.type==='video'?'video':'animated_gif',
      url:m.type==='photo'?https(m.media_url_https):https(video?.url),
      preview_image_url:https(m.media_url_https),alt_text:String(m.ext_alt_text||'').slice(0,2000)};
  }).filter(m=>m.url||m.preview_image_url);
  const time=Date.parse(tweet.tweet_created_at||tweet.created_at);
  if(!Number.isFinite(time))fail(502,'采集时间无效');
  return {externalId:tweet.id_str,author:tweet.user.screen_name,content,title:content.slice(0,160),
    url:`https://x.com/${tweet.user.screen_name}/status/${tweet.id_str}`,media,
    links:(tweet.entities?.urls||[]).map(link=>https(link.expanded_url)).filter(Boolean),
    publishedAt:new Date(time).toISOString(),publishedMs:time,
    metrics:{postCreatedAt:new Date(time).toISOString(),quotedTweet:tweet.quoted_status||null,
      replyTo:tweet.in_reply_to_status_id_str||null,retweetOf:tweet.retweeted_status?.id_str||null,
      originalAuthor:tweet.retweeted_status?.user?.screen_name||tweet.user.screen_name,
      truncated:!!tweet.truncated},raw:tweet};
}

export function createXWatch(db,{now=()=>Date.now(),fetchImpl=fetch,env=process.env,onPost=()=>{}}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS x_watch_settings(user_id INTEGER PRIMARY KEY REFERENCES users(id),daily_requests INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS x_watch_accounts(
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),handle TEXT NOT NULL,group_name TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 30,include_replies INTEGER NOT NULL DEFAULT 0,include_reposts INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,last_id TEXT NOT NULL DEFAULT '',pending TEXT NOT NULL DEFAULT '{}',
      next_at INTEGER NOT NULL DEFAULT 0,last_ok INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',failures INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,handle));
    CREATE TABLE IF NOT EXISTS x_watch_posts(
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),external_id TEXT NOT NULL,document TEXT NOT NULL,
      content_hash TEXT NOT NULL,published_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(user_id,external_id));
    CREATE TABLE IF NOT EXISTS x_watch_observations(account_id INTEGER NOT NULL REFERENCES x_watch_accounts(id),post_id INTEGER NOT NULL REFERENCES x_watch_posts(id),
      PRIMARY KEY(account_id,post_id));
    CREATE TABLE IF NOT EXISTS x_watch_revisions(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL REFERENCES x_watch_posts(id),content_hash TEXT NOT NULL,
      document TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(post_id,content_hash));
    CREATE TABLE IF NOT EXISTS x_watch_requests(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,account_id INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_analysis(post_id INTEGER PRIMARY KEY REFERENCES x_watch_posts(id),content_hash TEXT NOT NULL,version TEXT NOT NULL,
      state TEXT NOT NULL,article TEXT NOT NULL DEFAULT '{}',event_id INTEGER,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_model_calls(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,post_id INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_receipts(request_key TEXT PRIMARY KEY,response TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_analysis_leases(post_id INTEGER PRIMARY KEY,token TEXT NOT NULL,content_hash TEXT NOT NULL,until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_event_links(post_id INTEGER PRIMARY KEY,root_id INTEGER NOT NULL,root_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS x_watch_bookmarks(user_id INTEGER NOT NULL,post_id INTEGER NOT NULL,inbox_id INTEGER NOT NULL,
      PRIMARY KEY(user_id,post_id));`);
  for(const [table,column,definition] of [
    ['x_watch_settings','daily_budget_micros','INTEGER NOT NULL DEFAULT 0'],
    ['x_watch_settings','budget_revision','INTEGER NOT NULL DEFAULT 1'],
    ['x_watch_requests','cost_micros','INTEGER NOT NULL DEFAULT 40000'],
    ['x_watch_requests','cost_uncertain','INTEGER NOT NULL DEFAULT 0'],
  ])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  const providerBudget=createXProviderBudget(db,{env,now});
  const transaction=callback=>{db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const owner=userId=>{if(!db.prepare("SELECT 1 FROM users WHERE id=? AND username='zane'").get(userId))fail(403,'只有 zane 可以管理关注账号');};
  const available=()=>env.OMNIHUB_X_WATCH_ENABLED==='true'&&!!env.SOCIALDATA_API_KEY&&providerBudget.configured();
  const account=(userId,id)=>db.prepare('SELECT * FROM x_watch_accounts WHERE id=? AND user_id=?').get(id,userId);
  function addAccounts(userId,input) {
    owner(userId);
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['handles','group','intervalMinutes'].includes(k))
      ||!Array.isArray(input.handles)||!input.handles.length||input.handles.length>1000
      ||typeof input.group!=='string'||!input.group.trim()||input.group.length>60
      ||!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<15||input.intervalMinutes>1440)fail(400,'请填写账号、分组和有效的采集间隔（最多 1000 个账号）');
    // Validate the whole batch before writing; existing accounts and shared budgets stay untouched.
    const handles=[...new Set(input.handles.map(normalizeXHandle))];
    return transaction(()=>{
      let added=0;
      for(const handle of handles)added+=db.prepare(`INSERT OR IGNORE INTO x_watch_accounts(user_id,handle,group_name,interval_minutes)
        VALUES(?,?,?,?)`).run(userId,handle,input.group.trim(),input.intervalMinutes).changes;
      return {added,skipped:handles.length-added,state:status(userId)};
    });
  }
  function configure(userId,input) {
    owner(userId);
    if(!input||Object.keys(input).some(k=>!['id','revision','handle','group','intervalMinutes','includeReplies','includeReposts','enabled','dailyRequests','dailyBudgetUsd','settingsRevision'].includes(k)))fail(400,'关注配置字段无效');
    const handle=String(input.handle||'').replace(/^@/,'').toLowerCase();
    if(!handlePattern.test(handle)||typeof input.group!=='string'||!input.group.trim()||input.group.length>60)fail(400,'请填写有效账号和分组');
    if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<15||input.intervalMinutes>1440)fail(400,'采集间隔应为 15 到 1440 分钟');
    if(['enabled','includeReplies','includeReposts'].some(k=>typeof input[k]!=='boolean'))fail(400,'关注选项无效');
    if(!Number.isSafeInteger(input.dailyRequests)||input.dailyRequests<0||input.dailyRequests>500)fail(400,'每日请求上限应为 0 到 500');
    const dailyBudgetUsd=input.dailyBudgetUsd??0;
    if(typeof dailyBudgetUsd!=='number'||!Number.isFinite(dailyBudgetUsd)||dailyBudgetUsd<0||dailyBudgetUsd>20
      ||Math.abs(dailyBudgetUsd*100-Math.round(dailyBudgetUsd*100))>1e-7)fail(400,'费用预算应为 0 到 20 美元，最多两位小数');
    const budgetMicros=Math.round(dailyBudgetUsd*1000000);
    if(input.enabled&&(!available()||!input.dailyRequests||budgetMicros<PAGE_RESERVE_MICRO_USD))fail(409,'启用前请设置请求上限及至少 0.04 美元的采集预算');
    return transaction(()=>{
      const settings=db.prepare('SELECT * FROM x_watch_settings WHERE user_id=?').get(userId);
      const budgetChanged=settings&&(settings.daily_requests!==input.dailyRequests||settings.daily_budget_micros!==budgetMicros);
      if(budgetChanged&&input.settingsRevision!==settings.budget_revision)fail(409,'共享预算已改变，请重新打开账号设置后再保存');
      const old=input.id?account(userId,input.id):db.prepare('SELECT * FROM x_watch_accounts WHERE user_id=? AND handle=?').get(userId,handle);
      if((input.id&&!old)||(old&&input.revision!==old.revision))fail(409,'账号配置已改变，请刷新后再保存');
      if(old&&old.handle!==handle)fail(400,'修改账号请新建配置，原账号记录会保留');
      if(old)db.prepare(`UPDATE x_watch_accounts SET group_name=?,interval_minutes=?,include_replies=?,include_reposts=?,enabled=?,
        next_at=CASE WHEN enabled=0 AND ?=1 THEN 0 ELSE next_at END,
        revision=revision+1,lease_token=NULL,lease_until=0 WHERE id=?`).run(input.group.trim(),input.intervalMinutes,+input.includeReplies,+input.includeReposts,+input.enabled,+input.enabled,old.id);
      else db.prepare(`INSERT INTO x_watch_accounts(user_id,handle,group_name,interval_minutes,include_replies,include_reposts,enabled)
        VALUES(?,?,?,?,?,?,?)`).run(userId,handle,input.group.trim(),input.intervalMinutes,+input.includeReplies,+input.includeReposts,+input.enabled);
      db.prepare(`INSERT INTO x_watch_settings(user_id,daily_requests,daily_budget_micros) VALUES(?,?,?) ON CONFLICT(user_id)
        DO UPDATE SET daily_requests=excluded.daily_requests,daily_budget_micros=excluded.daily_budget_micros,budget_revision=budget_revision+?`).run(userId,input.dailyRequests,budgetMicros,budgetChanged?1:0);
      return status(userId);
    });
  }
  function status(userId) {
    owner(userId);
    const settings=db.prepare('SELECT * FROM x_watch_settings WHERE user_id=?').get(userId);
    const reserved=db.prepare('SELECT COALESCE(sum(cost_micros),0) n FROM x_watch_requests WHERE user_id=? AND created_at>?').get(userId,now()-86400_000).n;
    const provider=providerBudget.status();
    return {available:available(),dailyRequests:db.prepare('SELECT daily_requests FROM x_watch_settings WHERE user_id=?').get(userId)?.daily_requests||0,
      dailyBudgetUsd:(settings?.daily_budget_micros||0)/1000000,estimatedCostUsd:reserved/1000000,
      monthlyBudgetUsd:provider.limitUsd,monthlyEstimatedCostUsd:provider.spentUsd,monthlyBudgetRemainingUsd:provider.remainingUsd,
      budgetRemaining:Math.max(0,(settings?.daily_budget_micros||0)-reserved)/1000000,pageReserveUsd:PAGE_RESERVE_MICRO_USD/1000000,
      savedPosts:db.prepare('SELECT count(*) n FROM x_watch_posts WHERE user_id=?').get(userId).n,
      settingsRevision:settings?.budget_revision||0,
      costUncertain:!!db.prepare('SELECT 1 FROM x_watch_requests WHERE user_id=? AND created_at>? AND cost_uncertain=1 LIMIT 1').get(userId,now()-86400_000),
      analysisEnabled:available()&&env.OMNIHUB_X_WATCH_ANALYSIS==='true',
      modelCallsToday:db.prepare('SELECT count(*) n FROM x_watch_model_calls WHERE user_id=? AND created_at>?').get(userId,now()-86400_000).n,
      requestsToday:db.prepare('SELECT count(*) n FROM x_watch_requests WHERE user_id=? AND created_at>?').get(userId,now()-86400_000).n,
      accounts:db.prepare(`SELECT id,handle,group_name AS 'group',interval_minutes AS intervalMinutes,include_replies AS includeReplies,
        include_reposts AS includeReposts,enabled,revision,last_ok AS lastOk,next_at AS nextAt,error_code AS errorCode,pending FROM x_watch_accounts WHERE user_id=? ORDER BY id`).all(userId)
        .map(({pending,...row})=>({...row,enabled:!!row.enabled,includeReplies:!!row.includeReplies,includeReposts:!!row.includeReposts,backlog:!!parse(pending).cursor}))};
  }
  async function collect(userId) {
    owner(userId);if(!available())return {state:'disabled'};
    const claimed=transaction(()=>{
      const a=db.prepare('SELECT * FROM x_watch_accounts WHERE user_id=? AND enabled=1 AND next_at<=? AND lease_until<=? ORDER BY next_at,id LIMIT 1').get(userId,now(),now());
      if(!a)return null;
      const state=status(userId);
      if(state.costUncertain||!state.dailyRequests||state.requestsToday>=state.dailyRequests||Math.round(state.budgetRemaining*1000000)<PAGE_RESERVE_MICRO_USD
        ||!providerBudget.canReserve(PAGE_RESERVE_MICRO_USD))return {budget:true};
      const token=randomUUID();
      db.prepare('UPDATE x_watch_accounts SET lease_token=?,lease_until=? WHERE id=?').run(token,now()+120000,a.id);
      const requestId=Number(db.prepare('INSERT INTO x_watch_requests(user_id,account_id,created_at,cost_micros) VALUES(?,?,?,?)').run(userId,a.id,now(),PAGE_RESERVE_MICRO_USD).lastInsertRowid);
      const budgetKey=providerBudget.reserve({requestKey:`watch:${requestId}`,userId,service:'watch',estimatedMicros:PAGE_RESERVE_MICRO_USD});
      return {...a,token,requestId,budgetKey};
    });
    if(!claimed)return {state:'idle'};if(claimed.budget)return {state:'budget'};
    const a=claimed;
    const pending=parse(a.pending);
    const query=pending.query||`from:${a.handle}${a.last_id?` since_id:${a.last_id}`:` since:${new Date(now()-7*86400_000).toISOString().slice(0,10)}`}`;
    const url=new URL('https://api.socialdata.tools/twitter/search');
    url.searchParams.set('query',query);url.searchParams.set('type','Latest');if(pending.cursor)url.searchParams.set('cursor',pending.cursor);
    let costKnown=false;
    try {
      const response=await fetchImpl(url.href,{headers:{Authorization:`Bearer ${env.SOCIALDATA_API_KEY}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(45000)});
      if(!response.ok){costKnown=true;db.prepare('UPDATE x_watch_requests SET cost_micros=0 WHERE id=?').run(a.requestId);providerBudget.settle(a.budgetKey,0);fail(502,'采集服务返回错误');}
      let size=0;const chunks=[];
      if(!response.body)fail(502,'采集响应为空');
      for await(const chunk of response.body){size+=chunk.length;if(size>5_000_000)fail(502,'采集响应过大');chunks.push(chunk);}
      const text=Buffer.concat(chunks).toString('utf8');
      const data=JSON.parse(text);
      // Settle even if the account was paused while this paid request was in flight.
      if(Array.isArray(data.tweets)){costKnown=true;const actual=Math.max(1,data.tweets.length)*200;
        db.prepare('UPDATE x_watch_requests SET cost_micros=? WHERE id=?').run(actual,a.requestId);providerBudget.settle(a.budgetKey,actual);}
      if(!Array.isArray(data.tweets)||data.tweets.length>200||(data.next_cursor!=null&&typeof data.next_cursor!=='string'))fail(502,'采集结果格式错误');
      if(data.tweets.length&&data.next_cursor&&data.next_cursor===pending.cursor)fail(502,'采集分页未推进');
      const normalized=[];
      let scannedHighest=pending.highest||a.last_id||'0';
      for(const tweet of data.tweets) {
        if(idPattern.test(tweet?.id_str||'')&&tweet?.user?.screen_name?.toLowerCase()===a.handle)scannedHighest=maxId(scannedHighest,tweet.id_str);
        try{const post=normalizeWatchedPost(tweet,a.handle);if(post)normalized.push(post);}catch{/* A malformed item must not trap the whole cursor. */}
      }
      return transaction(()=>{
        const current=account(userId,a.id);
        if(!current?.enabled||current.revision!==a.revision||current.lease_token!==a.token) return {state:'stale'};
        let highest=scannedHighest,added=0;
        for(const post of normalized){
          highest=maxId(highest,post.externalId);
          // Excluded replies/reposts still advance the scan watermark, not the visible timeline.
          if((!a.include_replies&&post.metrics.replyTo)||(!a.include_reposts&&post.metrics.retweetOf))continue;
          const hash=fingerprint({content:post.content,media:post.media,links:post.links,quote:post.metrics.quotedTweet?.full_text||'',truncated:post.metrics.truncated});
          const old=db.prepare('SELECT id,content_hash FROM x_watch_posts WHERE user_id=? AND external_id=?').get(userId,post.externalId);
          let postId=old?.id;
          if(!old){postId=Number(db.prepare('INSERT INTO x_watch_posts(user_id,external_id,document,content_hash,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(userId,post.externalId,JSON.stringify(post),hash,post.publishedMs,now(),now()).lastInsertRowid);added++;}
          else if(old.content_hash!==hash)db.prepare('UPDATE x_watch_posts SET document=?,content_hash=?,updated_at=? WHERE id=?').run(JSON.stringify(post),hash,now(),postId);
          db.prepare('INSERT OR IGNORE INTO x_watch_revisions(post_id,content_hash,document,created_at) VALUES(?,?,?,?)').run(postId,hash,JSON.stringify(post),now());
          db.prepare('INSERT OR IGNORE INTO x_watch_observations VALUES(?,?)').run(a.id,postId);
          onPost(userId,postId,post);
        }
        const cursor=data.tweets.length?data.next_cursor||'':'';
        const backlog=cursor?JSON.stringify({query,cursor,highest}):'{}';
        db.prepare(`UPDATE x_watch_accounts SET last_id=?,pending=?,next_at=?,last_ok=?,error_code='',failures=0,lease_token=NULL,lease_until=0 WHERE id=?`)
          .run(cursor?a.last_id:highest,backlog,now()+(cursor?60000:a.interval_minutes*60000),now(),a.id);
        return {state:'ok',added,backlog:!!cursor};
      });
    } catch {
      // A successful but unreadable response may have been billed. Do not repeat it automatically.
      if(!costKnown)db.prepare('UPDATE x_watch_requests SET cost_uncertain=1 WHERE id=?').run(a.requestId);
      db.prepare(`UPDATE x_watch_accounts SET error_code='collection_failed',pending=CASE WHEN failures>=2 THEN '{}' ELSE pending END,
        failures=failures+1,next_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?`)
        .run(now()+Math.min(360,a.interval_minutes*(a.failures+1))*60000,a.id,a.token);
      return {state:'error'};
    }
  }
  function posts(userId) {
    owner(userId);
    return db.prepare(`SELECT p.*,a.article,a.state,a.event_id FROM x_watch_posts p LEFT JOIN x_watch_analysis a
      ON a.post_id=p.id AND a.content_hash=p.content_hash AND a.version=? WHERE p.user_id=? ORDER BY p.published_at DESC,p.id DESC LIMIT 300`).all(WATCH_VERSION,userId)
      .map(row=>{const post=parse(row.document);const {raw,...original}=post;
        const root=row.event_id!==row.id&&db.prepare(`SELECT 1 FROM x_watch_event_links l JOIN x_watch_posts p ON p.id=l.root_id
          JOIN x_watch_analysis a ON a.post_id=p.id AND a.content_hash=p.content_hash
          WHERE l.post_id=? AND p.user_id=? AND p.content_hash=l.root_hash AND a.event_id=p.id AND a.state='ready' AND a.version=?`).get(row.id,userId,WATCH_VERSION);
        return {...original,id:row.id,contentHash:row.content_hash,
        analysis:row.state==='ready'?parse(row.article):null,analysisState:row.state||'pending',eventId:root?row.event_id:row.id,
        groups:db.prepare('SELECT DISTINCT a.group_name FROM x_watch_observations o JOIN x_watch_accounts a ON a.id=o.account_id WHERE o.post_id=?').all(row.id).map(x=>x.group_name),
        bookmarked:!!db.prepare("SELECT 1 FROM inbox WHERE user_id=? AND source='x' AND external_id=?").get(userId,post.externalId)};});
  }
  function bookmark(userId,postId,save) {
    owner(userId);
    const row=db.prepare('SELECT * FROM x_watch_posts WHERE id=? AND user_id=?').get(postId,userId);if(!row)fail(404,'关注帖子不存在');
    return transaction(()=>{
      const post=parse(row.document),result=save({...post,source:'x'});
      db.prepare('INSERT OR IGNORE INTO x_watch_bookmarks VALUES(?,?,?)').run(userId,postId,result.id);
      return result;
    });
  }
  function pendingAnalysis(userId) {
    owner(userId);
    return transaction(()=>{
      const row=db.prepare(`SELECT p.* FROM x_watch_posts p WHERE p.user_id=? AND NOT EXISTS(SELECT 1 FROM x_watch_analysis a
        WHERE a.post_id=p.id AND a.content_hash=p.content_hash AND a.version=?) AND NOT EXISTS(SELECT 1 FROM x_watch_analysis_leases l
        WHERE l.post_id=p.id AND l.until_at>?) ORDER BY p.published_at DESC LIMIT 1`).get(userId,WATCH_VERSION,now());
      if(!row)return null;
      const analysisToken=randomUUID();
      db.prepare(`INSERT INTO x_watch_analysis_leases VALUES(?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET
        token=excluded.token,content_hash=excluded.content_hash,until_at=excluded.until_at`).run(row.id,analysisToken,row.content_hash,now()+600000);
      return {...row,analysisToken};
    });
  }
  function liveAnalysis(userId,row) {
    return !!db.prepare(`SELECT 1 FROM x_watch_analysis_leases l JOIN x_watch_posts p ON p.id=l.post_id
      WHERE p.id=? AND p.user_id=? AND p.content_hash=? AND l.token=? AND l.until_at>?`)
      .get(row.id,userId,row.content_hash,row.analysisToken,now());
  }
  function releaseAnalysis(row) {db.prepare('DELETE FROM x_watch_analysis_leases WHERE post_id=? AND token=?').run(row.id,row.analysisToken);}
  function reserveAnalysis(userId,row,limit=20) {
    owner(userId);
    return transaction(()=>{
      const used=db.prepare('SELECT count(*) n FROM x_watch_model_calls WHERE user_id=? AND created_at>?').get(userId,now()-86400_000).n;
      if(!Number.isInteger(limit)||limit<=0||used>=limit||!liveAnalysis(userId,row))return false;
      db.prepare('INSERT INTO x_watch_model_calls(user_id,post_id,created_at) VALUES(?,?,?)').run(userId,row.id,now());return true;
    });
  }
  function saveAnalysis(userId,row,article,state,eventId=row.id,eventHash='') {
    owner(userId);
    const latest=db.prepare('SELECT * FROM x_watch_posts WHERE id=? AND user_id=?').get(row.id,userId);
    if(!latest||!liveAnalysis(userId,row))return false;
    if(eventId!==row.id) {
      const root=db.prepare(`SELECT p.content_hash FROM x_watch_posts p JOIN x_watch_analysis a ON a.post_id=p.id
        WHERE p.id=? AND p.user_id=? AND a.content_hash=p.content_hash AND a.state='ready' AND a.event_id=p.id AND a.version=?`).get(eventId,userId,WATCH_VERSION);
      if(!root||(eventHash&&root.content_hash!==eventHash))eventId=row.id;
      else db.prepare('INSERT OR REPLACE INTO x_watch_event_links VALUES(?,?,?)').run(row.id,eventId,root.content_hash);
    }
    if(eventId===row.id)db.prepare('DELETE FROM x_watch_event_links WHERE post_id=?').run(row.id);
    const safeArticle=Object.fromEntries(['title','summary','claimType','evidenceQuote','topics','sameEventConfidence','eventId']
      .filter(key=>Object.hasOwn(article,key)).map(key=>[key,article[key]]));
    db.prepare(`INSERT INTO x_watch_analysis VALUES(?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET
      content_hash=excluded.content_hash,version=excluded.version,state=excluded.state,article=excluded.article,event_id=excluded.event_id,updated_at=excluded.updated_at`)
      .run(row.id,row.content_hash,WATCH_VERSION,state,JSON.stringify(safeArticle),eventId,now());
    releaseAnalysis(row);return true;
  }
  function hot(userId) {
    const groups=new Map();
    for(const post of posts(userId).filter(p=>p.analysis&&p.publishedMs<=now()&&now()-p.publishedMs<=48*3600000)){
      if(!groups.has(post.eventId))groups.set(post.eventId,[]);groups.get(post.eventId).push(post);
    }
    return [...groups.values()].map(items=>{
      const participants=new Map();for(const post of items){const author=post.metrics.originalAuthor.toLowerCase();participants.set(author,Math.max(participants.get(author)||0,post.publishedMs));}
      const heat=[...participants.values()].reduce((sum,time)=>sum+Math.pow(.5,(now()-time)/86400000),0);
      return {id:items[0].eventId,title:items[0].analysis.title,summary:items[0].analysis.summary,participants:participants.size,heat,items};
    }).filter(g=>g.participants>=2).sort((a,b)=>b.heat-a.heat).slice(0,10);
  }
  const receipt=key=>{const row=db.prepare('SELECT response FROM x_watch_receipts WHERE request_key=?').get(key);return row?parse(row.response):null;};
  const saveReceipt=(key,value)=>db.prepare('INSERT OR IGNORE INTO x_watch_receipts VALUES(?,?)').run(key,JSON.stringify(value));
  function retryAnalysis(userId,postId) {
    owner(userId);
    return db.prepare(`DELETE FROM x_watch_analysis WHERE post_id=? AND state IN ('error','review')
      AND post_id IN(SELECT id FROM x_watch_posts WHERE user_id=?)`).run(postId,userId).changes>0;
  }
  return {configure,addAccounts,status,collect,posts,bookmark,pendingAnalysis,reserveAnalysis,saveAnalysis,hot,receipt,saveReceipt,retryAnalysis,releaseAnalysis};
}
