export function createLocalCurationHandler({queue,pipeline,sync,requireOwner,send}) {
  async function body(req) {
    if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json')throw {status:415,message:'请使用 JSON'};
    let size=0;const chunks=[];
    for await(const chunk of req) {
      size+=chunk.length;if(size>256*1024)throw {status:413,message:'整理结果过大'};
      chunks.push(chunk);
    }
    try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
    catch {throw {status:400,message:'无效的 JSON'};}
  }
  return async(req,res,pathname)=>{
    if(!pathname.startsWith('/api/local-curation/'))return false;
    const reply=value=>send(res,200,value,{'Cache-Control':'no-store'});
    try {
      if(pathname==='/api/local-curation/settings') {
        const user=requireOwner(req,req.method!=='GET');
        if(req.method==='GET')return reply({...queue.status(user.id),sync:sync.getStatus(user.id)});
        if(req.method==='POST')return reply(queue.configure(user.id,await body(req)));
      }
      if(pathname==='/api/local-curation/devices'&&req.method==='POST') {
        const user=requireOwner(req,true),data=await body(req);
        return reply(queue.issueDevice(user.id,data.label));
      }
      const revoke=pathname.match(/^\/api\/local-curation\/devices\/([a-f0-9-]+)\/revoke$/);
      if(revoke&&req.method==='POST') {
        const user=requireOwner(req,true);await body(req);queue.revoke(user.id,revoke[1]);return reply({ok:true});
      }
      // Never accept session cookies for the worker or device tokens elsewhere.
      const device=queue.authenticate(String(req.headers.authorization||'').replace(/^Bearer /,''));
      if(pathname==='/api/local-curation/status'&&req.method==='GET')return reply({...queue.status(device.userId),sync:sync.getStatus(device.userId)});
      if(pathname==='/api/local-curation/claim'&&req.method==='POST') {
        await body(req);
        if(!queue.isEnabled(device.userId))return reply({task:null,waitingFor:'local_curation_disabled'});
        await sync.wakePending(device.userId);
        const syncState=sync.getStatus(device.userId);
        if(syncState.running)return reply({task:null,waitingFor:'bookmark_sync'});
        await pipeline.run(device.userId);
        return reply({task:queue.claim(device),sync:syncState});
      }
      const action=pathname.match(/^\/api\/local-curation\/tasks\/([a-f0-9-]+)\/(complete|fail|heartbeat)$/);
      if(action&&req.method==='POST') {
        const result=queue[action[2]](device,action[1],await body(req));
        if(action[2]==='complete')await pipeline.run(device.userId);
        return reply(result);
      }
      return send(res,404,{error:'接口不存在'},{'Cache-Control':'no-store'});
    } catch(error) {
      const status=Number(error.status)||500;
      return send(res,status,{error:status===500?'本地整理暂时不可用':error.message||'请求无效',code:error.code||'request_failed'},{'Cache-Control':'no-store'});
    }
  };
}
