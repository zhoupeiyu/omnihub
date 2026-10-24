import {db,findUserByName,DATA_DIR} from './db.js';
import path from 'node:path';
import {createXWatchMedia} from './x-watch-media.js';
import {createXWatch} from './x-watch.js';
import {createXFollowing} from './x-following.js';
import {createContentModel} from './content-model.js';
import {createWatchProcessor} from './x-watch-processor.js';

export const xWatchMedia=createXWatchMedia(db,{directory:path.join(DATA_DIR,'x-watch-media')});
export const xWatch=createXWatch(db,{onPost:xWatchMedia.enqueue});
export const xFollowing=createXFollowing(db);
export function startXWatchWorker() {
  // Paid collection remains gated by both service configuration and owner budgets.
  const processor=createWatchProcessor({store:xWatch,model:createContentModel()});let busy=false,stopped=false;
  async function tick(){if(busy||stopped)return;busy=true;try{
    const owner=findUserByName('zane');if(!owner)return;
    await xWatch.collect(owner.id);
    for(let i=0;i<4;i++){if((await xWatchMedia.run(owner.id)).state==='idle')break;}
    if(process.env.OMNIHUB_X_WATCH_ANALYSIS==='true')await processor.run(owner.id);
  }catch{/* Report only sanitized state through owner APIs. */}finally{busy=false;}}
  tick();const timer=setInterval(tick,60000);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
}
