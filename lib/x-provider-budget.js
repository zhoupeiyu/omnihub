const MONTH_MS = 31 * 24 * 60 * 60 * 1000;

const fail = (message) => Object.assign(new Error(message), {code:'budget', status:409});
const dollarsToMicros = value => {
  const text=String(value??'').trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))return 0;
  const micros=Math.round(Number(text)*1_000_000);
  return micros>0&&micros<=5_900_000?micros:0;
};

/**
 * Shared rolling cap for every SocialData call made by OmniHub.
 *
 * Callers reserve inside their own BEGIN IMMEDIATE transaction before an
 * upstream request. A readable response settles to the returned-item cost;
 * ambiguous transport or parsing failures retain the conservative reserve.
 */
export function createXProviderBudget(db,{env=process.env,now=()=>Date.now()}={}) {
  const limitMicros=dollarsToMicros(env.OMNIHUB_SOCIALDATA_MONTH_USD);
  db.exec(`CREATE TABLE IF NOT EXISTS x_provider_costs(
    request_key TEXT PRIMARY KEY,user_id INTEGER NOT NULL,service TEXT NOT NULL,requested_at INTEGER NOT NULL,
    estimated_micros INTEGER NOT NULL,final_micros INTEGER,state TEXT NOT NULL);`);

  // Keep pre-ledger requests inside the first rolling window. Following pages
  // did not record result counts, so they retain the documented maximum page
  // reserve ($0.20 for at most 1,000 returned profiles).
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x_watch_requests'").get()) {
    const columns=new Set(db.prepare('PRAGMA table_info(x_watch_requests)').all().map(column=>column.name));
    if(columns.has('cost_micros')){const uncertain=columns.has('cost_uncertain')?'COALESCE(cost_uncertain,0)':'0';db.exec(`INSERT OR IGNORE INTO x_provider_costs
      SELECT 'watch:'||id,user_id,'watch',created_at,cost_micros,
        CASE WHEN ${uncertain}=0 THEN cost_micros ELSE NULL END,
        CASE WHEN ${uncertain}=0 THEN 'final' ELSE 'uncertain' END
      FROM x_watch_requests`);}
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x_following_requests'").get()) {
    const columns=new Set(db.prepare('PRAGMA table_info(x_following_requests)').all().map(column=>column.name));
    const pending=columns.has('budget_key')?"WHERE budget_key=''":'';
    db.exec(`INSERT OR IGNORE INTO x_provider_costs
      SELECT 'following:legacy:'||id,user_id,'following',created_at,200000,NULL,'uncertain'
      FROM x_following_requests ${pending}`);
    if(columns.has('budget_key'))db.exec(`UPDATE x_following_requests SET budget_key='following:legacy:'||id WHERE budget_key=''`);
  }

  const spentMicros=()=>Number(db.prepare(`SELECT COALESCE(SUM(COALESCE(final_micros,estimated_micros)),0) AS total
    FROM x_provider_costs WHERE requested_at>=? AND state IN ('reserved','final','uncertain')`).get(now()-MONTH_MS).total||0);
  const configured=()=>limitMicros>0;
  const canReserve=estimatedMicros=>Number.isSafeInteger(estimatedMicros)&&estimatedMicros>0&&configured()
    &&spentMicros()+estimatedMicros<=limitMicros;
  function reserve({requestKey,userId,service,estimatedMicros}) {
    if(!/^[a-z]+:[a-z0-9:-]+$/.test(requestKey)||!Number.isSafeInteger(userId)||userId<=0
      ||!['watch','following-profile','following'].includes(service)
      ||!Number.isSafeInteger(estimatedMicros)||estimatedMicros<=0)throw new TypeError('SocialData 费用预留参数无效');
    if(!canReserve(estimatedMicros))throw fail('SocialData 已达到 31 天共享费用上限');
    db.prepare(`INSERT INTO x_provider_costs(request_key,user_id,service,requested_at,estimated_micros,state)
      VALUES(?,?,?,?,?,'reserved')`).run(requestKey,userId,service,now(),estimatedMicros);
    return requestKey;
  }
  function settle(requestKey,actualMicros) {
    if(!Number.isSafeInteger(actualMicros)||actualMicros<0)throw new TypeError('SocialData 实际费用无效');
    db.prepare(`UPDATE x_provider_costs SET final_micros=?,state='final'
      WHERE request_key=? AND state IN ('reserved','uncertain')`).run(actualMicros,requestKey);
  }
  function status() {
    const spent=spentMicros();
    return {configured:configured(),limitUsd:limitMicros/1_000_000,spentUsd:spent/1_000_000,
      remainingUsd:Math.max(0,limitMicros-spent)/1_000_000};
  }
  return {configured,canReserve,reserve,settle,status};
}
