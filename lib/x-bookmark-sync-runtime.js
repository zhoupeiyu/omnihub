import { db } from './db.js';
import { contentStore } from './content-runtime.js';
import { createXBookmarkSync, loadXBookmarkSyncConfig } from './x-bookmark-sync.js';
import { createXAccount } from './x-account.js';

const config=loadXBookmarkSyncConfig();
export const xAccount=createXAccount({db});
function owner(userId) {
  if(!Number.isSafeInteger(userId)||!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))
    throw Object.assign(new Error('账户不存在或已失效'),{status:403});
}
function collector(userId) {
  owner(userId);
  const binding=xAccount.syncConfig(userId);
  // The server caps are shared infrastructure caps, not a per-account credit
  // multiplier.  createXBookmarkSync accounts each user's reservation and the
  // aggregate reservation before every X request.
  const accountConfig=binding.enabled
    ? {...config,...binding,sharedBudget:config.budget,enabled:config.enabled}
    // Do not let the legacy server-level zane identity appear in a disconnected
    // account's status (or become a usable fallback credential/configuration).
    : {...config,enabled:false,xUserId:'',clientId:'',clientSecret:'',tokenStore:undefined,ownerUserId:userId,sharedBudget:config.budget};
  return createXBookmarkSync({db,config:accountConfig,onImported:async({userId,inboxIds})=>{
  owner(userId);
  // The durable collector marker retries this idempotent callback after a crash.
  contentStore.setLocalMode(userId);
  contentStore.allowLocalSources(userId,inboxIds);
  }});
}
export const xBookmarkSync={
  getStatus(userId) {return {...collector(userId).getStatus(userId),serverReady:config.enabled&&Object.values(config.budget).every(value=>Number.isFinite(value)&&value>0)};},
  runDue(userId) {return collector(userId).runDue(userId);},
  runNow(userId) {return collector(userId).runDue(userId);},
  wakePending(userId) {return collector(userId).wakePending(userId);},
};

export function startXBookmarkSyncWorker() {
  if(!config.enabled)return ()=>{};
  let busy=false,stopped=false;
  const tick=async()=>{
    if(busy||stopped)return;
    busy=true;
    try {
      // Only an explicit OAuth binding with sync enabled is eligible.  Merely
      // registering on OmniHub never schedules an X read or a paid request.
      const users=db.prepare(`SELECT c.user_id FROM x_account_connections c
        JOIN users u ON u.id=c.user_id
        WHERE c.sync_enabled=1 AND c.credentials<>''`).all();
      for(const user of users) {
        // One stale grant must not starve later opted-in accounts.  Each
        // collector persists only its own safe status/error state.
        try { await xBookmarkSync.runDue(user.user_id); } catch { /* continue */ }
      }
    }
    catch {/* Only safe persistent status is shown to the owner. */}
    finally {busy=false;}
  };
  // A frequent due check is not a frequent X read; next_at is persisted for 2h.
  const first=setTimeout(tick,1500),timer=setInterval(tick,60_000);
  first.unref();timer.unref();
  return ()=>{stopped=true;clearTimeout(first);clearInterval(timer);};
}
