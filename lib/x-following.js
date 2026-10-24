import { randomUUID } from 'node:crypto';
import { createXProviderBudget } from './x-provider-budget.js';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const reserved = new Set(['home','explore','search','notifications','messages','settings','i','intent','share','compose']);
const MAX_PAGES = 20, MAX_USERS = 5000, DAILY_REQUESTS = 40, REFRESH_DELAY = 600000;
const PROFILE_RESERVE_MICROS=200, FOLLOWING_PAGE_RESERVE_MICROS=200000;

export function normalizeXHandle(value) {
  if (typeof value !== 'string' || value.length > 300) fail(400, '请输入有效的 X 用户名或个人主页链接');
  let handle = value.trim();
  if (/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\//i.test(handle)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(handle) ? handle : `https://${handle}`); } catch { fail(400, 'X 主页链接无效'); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port
      || !/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)
      || !/^\/[a-zA-Z0-9_]{1,15}\/?$/.test(url.pathname)) fail(400, '请使用个人主页链接，不要填写帖子链接');
    handle = url.pathname.split('/')[1];
  }
  handle = handle.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle) || reserved.has(handle)) fail(400, '请输入有效的 X 用户名或个人主页链接');
  return handle;
}

function profileFrom(data) {
  if (!data || typeof data.id_str !== 'string' || !/^[1-9][0-9]{0,24}$/.test(data.id_str)
    || typeof data.screen_name !== 'string' || !/^[a-zA-Z0-9_]{1,15}$/.test(data.screen_name)) fail(502, '关注列表返回的账号格式不正确');
  let avatar = '';
  try {
    const url = new URL(data.profile_image_url_https);
    if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password) avatar = url.href;
  } catch { /* An avatar is optional. */ }
  return {id:data.id_str, handle:data.screen_name.toLowerCase(), name:String(data.name || data.screen_name).slice(0,160),
    description:String(data.description || '').slice(0,2000), avatar, protected:!!data.protected,
    followingCount:Number.isSafeInteger(data.friends_count) && data.friends_count >= 0 ? data.friends_count : null};
}

export function createXFollowing(db, {now=()=>Date.now(), fetchImpl=fetch, env=process.env}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS x_following_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), handle TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '{}',
    users TEXT NOT NULL DEFAULT '[]', next_cursor TEXT NOT NULL DEFAULT '', cursors TEXT NOT NULL DEFAULT '[]',
    pages INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL,
    stopped_reason TEXT NOT NULL DEFAULT '', skipped INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS x_following_requests (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
  const columns=new Set(db.prepare('PRAGMA table_info(x_following_cache)').all().map(column=>column.name));
  if(!columns.has('stopped_reason'))db.exec("ALTER TABLE x_following_cache ADD COLUMN stopped_reason TEXT NOT NULL DEFAULT ''");
  if(!columns.has('skipped'))db.exec('ALTER TABLE x_following_cache ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(x_following_requests)').all().some(column=>column.name==='budget_key'))
    db.exec("ALTER TABLE x_following_requests ADD COLUMN budget_key TEXT NOT NULL DEFAULT ''");
  const providerBudget=createXProviderBudget(db,{env,now});
  const owner = userId => { if (!db.prepare("SELECT 1 FROM users WHERE id=? AND username='zane'").get(userId)) fail(403, '只有 zane 可以读取关注名单'); };
  const cached = userId => db.prepare('SELECT * FROM x_following_cache WHERE user_id=?').get(userId);
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result=callback(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  function status(userId) {
    owner(userId);
    const row=cached(userId), users=JSON.parse(row?.users || '[]');
    const requestsToday=db.prepare('SELECT count(*) n FROM x_following_requests WHERE user_id=? AND created_at>?').get(userId,now()-86400000).n;
    const provider=providerBudget.status();
    return {available:!!env.SOCIALDATA_API_KEY&&provider.configured, handle:row?.handle || env.OMNIHUB_X_SOURCE_HANDLE || 'zane9588',
      profile:row ? JSON.parse(row.profile) : null, users, generation:row?.generation || '', pages:row?.pages || 0,
      complete:!!row?.complete, hasMore:!!row?.next_cursor, limited:!!row?.stopped_reason || (!row?.complete && (row?.pages>=MAX_PAGES || users.length>=MAX_USERS)),
      stopReason:row?.stopped_reason || '', skipped:row?.skipped || 0,
      updatedAt:row?.updated_at || 0, refreshAfter:row?.started_at ? row.started_at+REFRESH_DELAY : 0,
      loading:!!row?.lease_token && row.lease_until>now(), requestsToday, dailyRequestLimit:DAILY_REQUESTS,
      monthlyBudgetUsd:provider.limitUsd,monthlyEstimatedCostUsd:provider.spentUsd,monthlyBudgetRemainingUsd:provider.remainingUsd};
  }
  async function provider(path,budgetKey) {
    let response;
    try {
      response=await fetchImpl(`https://api.socialdata.tools${path}`, {headers:{Authorization:`Bearer ${env.SOCIALDATA_API_KEY}`,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.timeout(30000)});
    } catch { fail(502, '读取 X 服务超时或网络异常，已缓存的名单仍然保留，请稍后再试'); }
    if (!response.ok) {
      providerBudget.settle(budgetKey,0);
      const messages={401:'SocialData 凭证未通过验证，请检查服务器配置',402:'SocialData 余额不足，请在服务商后台检查余额',
        403:'SocialData 暂时无法读取此账号',404:'没有找到该 X 账号',429:'SocialData 请求过于频繁，请稍后再试'};
      fail(response.status===429?429:502, messages[response.status] || 'SocialData 暂时读取失败，已缓存的名单仍然保留');
    }
    try {
      const text=await response.text();
      if (text.length>5000000) fail(502, '关注列表响应过大');
      return JSON.parse(text);
    } catch { fail(502, '关注列表响应格式不正确'); }
  }
  async function load(userId, input) {
    owner(userId);
    if (!input || Array.isArray(input) || Object.keys(input).some(key=>!['handle','action','generation','page'].includes(key))
      || !['load','refresh'].includes(input.action) || typeof input.generation!=='string' || input.generation.length>80
      || !Number.isInteger(input.page) || input.page<0) fail(400, '关注名单请求参数无效');
    const handle=normalizeXHandle(input.handle);
    if (!env.SOCIALDATA_API_KEY||!providerBudget.configured()) fail(409, '服务器尚未配置 SocialData 或共享费用上限，仍可手动添加账号');
    const claim=transaction(()=>{
      const row=cached(userId);
      if ((row?.generation || '')!==input.generation || (row?.pages || 0)!==input.page) return null;
      if (row?.lease_token && row.lease_until>now()) fail(409, '正在拉取名单，请稍后查看缓存');
      const refresh=input.action==='refresh';
      if (row && row.handle!==handle && !refresh) fail(409, '账号已更换，请重新拉取关注名单');
      if (refresh && row?.started_at && now()<row.started_at+REFRESH_DELAY) fail(429, '名单刚刚拉取过，10 分钟后可重新拉取；现在可继续使用缓存');
      if (!refresh && row && (row.complete || row.stopped_reason || row.pages>=MAX_PAGES || JSON.parse(row.users).length>=MAX_USERS)) return null;
      const needsProfile=refresh || !JSON.parse(row?.profile || '{}').id;
      const needed=needsProfile?2:1;
      if (status(userId).requestsToday+needed>DAILY_REQUESTS) fail(429, '已达到关注名单每日读取上限，请明天再试；手动添加不受影响');
      const reserveTotal=needsProfile?PROFILE_RESERVE_MICROS:FOLLOWING_PAGE_RESERVE_MICROS;
      if(!providerBudget.canReserve(reserveTotal))fail(409,'SocialData 已达到 31 天共享费用上限，已保留现有关注名单');
      let profileBudgetKey='';
      if(needsProfile){const id=Number(db.prepare('INSERT INTO x_following_requests(user_id,created_at) VALUES(?,?)').run(userId,now()).lastInsertRowid);
        profileBudgetKey=`following:profile:${id}`;db.prepare('UPDATE x_following_requests SET budget_key=? WHERE id=?').run(profileBudgetKey,id);
        providerBudget.reserve({requestKey:profileBudgetKey,userId,service:'following-profile',estimatedMicros:PROFILE_RESERVE_MICROS});}
      let pageBudgetKey='';
      if(!needsProfile){const pageRequestId=Number(db.prepare('INSERT INTO x_following_requests(user_id,created_at) VALUES(?,?)').run(userId,now()).lastInsertRowid);
        pageBudgetKey=`following:page:${pageRequestId}`;db.prepare('UPDATE x_following_requests SET budget_key=? WHERE id=?').run(pageBudgetKey,pageRequestId);
        providerBudget.reserve({requestKey:pageBudgetKey,userId,service:'following',estimatedMicros:FOLLOWING_PAGE_RESERVE_MICROS});}
      const token=randomUUID();
      if (!row) db.prepare('INSERT INTO x_following_cache(user_id,handle,generation) VALUES(?,?,?)').run(userId,handle,randomUUID());
      db.prepare('UPDATE x_following_cache SET lease_token=?,lease_until=? WHERE user_id=?').run(token,now()+120000,userId);
      return {row,token,refresh,needsProfile,profileBudgetKey,pageBudgetKey};
    });
    if (!claim) return status(userId);
    try {
      const {row,token,refresh,needsProfile,profileBudgetKey}=claim;
      let pageBudgetKey=claim.pageBudgetKey;
      let profile;
      if(needsProfile){const profileData=await provider(`/twitter/user/${encodeURIComponent(handle)}`,profileBudgetKey);providerBudget.settle(profileBudgetKey,PROFILE_RESERVE_MICROS);profile=profileFrom(profileData);}
      else profile=JSON.parse(row.profile);
      if (profile.handle!==handle) fail(502, '服务返回的账号与请求不一致');
      if (profile.protected) fail(409, '此账号的关注名单非公开，无法拉取；可以手动添加公开账号');
      if(!pageBudgetKey)pageBudgetKey=transaction(()=>{
        const current=cached(userId);
        if(current?.lease_token!==token)fail(409,'关注名单读取状态已改变，请重新操作');
        if(!providerBudget.canReserve(FOLLOWING_PAGE_RESERVE_MICROS))fail(409,'SocialData 已达到 31 天共享费用上限，已保留现有关注名单');
        const pageRequestId=Number(db.prepare('INSERT INTO x_following_requests(user_id,created_at) VALUES(?,?)').run(userId,now()).lastInsertRowid);
        const key=`following:page:${pageRequestId}`;db.prepare('UPDATE x_following_requests SET budget_key=? WHERE id=?').run(key,pageRequestId);
        providerBudget.reserve({requestKey:key,userId,service:'following',estimatedMicros:FOLLOWING_PAGE_RESERVE_MICROS});return key;
      });
      const cursor=refresh?'':row?.next_cursor || '';
      const data=await provider(`/twitter/user/${profile.id}/following${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`,pageBudgetKey);
      if(Array.isArray(data?.users))providerBudget.settle(pageBudgetKey,Math.max(1,data.users.length)*200);
      if (!Array.isArray(data?.users) || data.users.length>1000 || (data.next_cursor!=null && typeof data.next_cursor!=='string')
        || (data.next_cursor?.length || 0)>2000) fail(502, '关注列表格式不正确');
      let next=data.next_cursor==='0'?'':data.next_cursor || '';
      const cursors=refresh?[]:JSON.parse(row?.cursors || '[]');
      let stopped=next && (next===cursor || cursors.includes(next))?'repeated_cursor':'';
      if(stopped)next='';
      const users=new Map((refresh?[]:JSON.parse(row?.users || '[]')).map(user=>[user.id,user]));
      let skipped=refresh?0:row?.skipped || 0;
      for (const value of data.users) {
        try { const user=profileFrom(value); users.set(user.id,user); }
        catch { skipped++; }
      }
      const list=[...users.values()];
      const pages=refresh?1:(row?.pages || 0)+1;
      if(list.length>MAX_USERS || (list.length===MAX_USERS&&next))stopped='user_limit';
      if(pages>=MAX_PAGES&&next&&!stopped)stopped='page_limit';
      const current=cached(userId);
      if (current?.lease_token!==token) return status(userId);
      db.prepare(`UPDATE x_following_cache SET handle=?,profile=?,users=?,next_cursor=?,cursors=?,pages=?,complete=?,
        generation=?,updated_at=?,started_at=?,stopped_reason=?,skipped=?,lease_token=NULL,lease_until=0 WHERE user_id=? AND lease_token=?`)
        .run(handle,JSON.stringify(profile),JSON.stringify(list.slice(0,MAX_USERS)),next,JSON.stringify([...cursors,cursor]),
          pages,+(!next&&!stopped),refresh?randomUUID():current.generation,now(),refresh||!row?.started_at?now():row.started_at,stopped,skipped,userId,token);
      return status(userId);
    } finally {
      db.prepare('UPDATE x_following_cache SET lease_token=NULL,lease_until=0 WHERE user_id=? AND lease_token=?').run(userId,claim.token);
    }
  }
  return {status,load};
}
