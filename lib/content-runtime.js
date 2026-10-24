import { db, findUserByName } from './db.js';
import { createContentStore } from './content-store.js';
import { createContentPipeline } from './content-pipeline.js';
import { createContentModel, contentModelStatus } from './content-model.js';
import { CONTENT_POLICY } from './content-policy.js';
import { createLocalModelQueue } from './local-model-queue.js';

export const contentStore=createContentStore(db);
const limit=(name,fallback)=>Number.isInteger(Number(process.env[name]))&&Number(process.env[name])>0?Number(process.env[name]):fallback;
const budget={
  daily:limit('OMNIHUB_CONTENT_DAILY_CALLS',CONTENT_POLICY.defaultDailyCalls),
  hourly:limit('OMNIHUB_CONTENT_HOURLY_CALLS',CONTENT_POLICY.defaultHourlyCalls),
};
export const localCuration=createLocalModelQueue({db,store:contentStore,budget});
const remoteModel=createContentModel();
// Only the original administrator may use the server's shared model credentials.
const usesLocal=userId=>contentStore.localMode(userId)||findUserByName('zane')?.id!==userId;
const selected=context=>usesLocal(context.userId)?localCuration.model:remoteModel;
export const contentPipeline=createContentPipeline({store:contentStore,budget,model:{
  deferred:context=>usesLocal(context.userId),
  identity:(stage,context)=>selected(context).identity(stage,context),
  call:(stage,input,context)=>selected(context).call(stage,input,context),
}});
export function pipelineStatus(userId) {return {...contentStore.status(userId),model:usesLocal(userId)
  ? {configured:localCuration.isEnabled(userId),provider:'local',model:localCuration.status(userId).model||null}
  : contentModelStatus(),
  limits:{dailyCalls:limit('OMNIHUB_CONTENT_DAILY_CALLS',CONTENT_POLICY.defaultDailyCalls),hourlyCalls:limit('OMNIHUB_CONTENT_HOURLY_CALLS',CONTENT_POLICY.defaultHourlyCalls)}};}

export function startContentWorker() {
  if(process.env.OMNIHUB_CONTENT_WORKER==='false')return ()=>{};
  let busy=false,stopped=false;
  async function tick(){
    if(busy||stopped)return;busy=true;
    try {
      const user=findUserByName('zane');if(!user)return;
      // Local mode is driven only by authenticated device claims/completions.
      if(contentStore.enabled(user.id)&&!contentStore.localMode(user.id))await contentPipeline.run(user.id);
    }catch{/* Safe persistent job errors are available through owner status. */}
    finally{busy=false;}
  }
  const first=setTimeout(tick,1000);first.unref();
  const timer=setInterval(tick,15_000);timer.unref();
  return ()=>{stopped=true;clearTimeout(first);clearInterval(timer);};
}
