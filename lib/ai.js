import { aiProvider, selectedAiConnection, withAiSlot } from './ai-service.js';

export async function chatWithAi(userId,messages) {
  return withAiSlot(userId,()=>aiProvider.complete(selectedAiConnection(userId),messages));
}
export async function streamChatToClient(userId,messages,res) {
  return withAiSlot(userId,async()=>{
    const c=selectedAiConnection(userId);
    const iterator=aiProvider.stream(c,messages)[Symbol.asyncIterator]();
    let first;
    try {first=await iterator.next();} catch(error) {await iterator.return?.();throw error;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive'});
    res.write(`data: ${JSON.stringify({model:c.model})}\n\n`);
    try {
      for(let item=first;!item.done;item=await iterator.next()) {
        if(res.destroyed)break;
        if(item.value.delta)res.write(`data: ${JSON.stringify({delta:item.value.delta})}\n\n`);
        if(item.value.done)res.write('data: [DONE]\n\n');
      }
    } catch(error) {if(!res.destroyed)res.write(`data: ${JSON.stringify({error:error.status?error.message:'AI 服务传输中断，请重试'})}\n\n`);}
    finally{await iterator.return?.();res.end();}
  });
}
