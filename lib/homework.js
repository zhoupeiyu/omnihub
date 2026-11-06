import { aiError } from './ai-connections.js';

export function validateHomeworkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 || Buffer.byteLength(JSON.stringify(messages)) > 4 * 1024 * 1024) throw aiError(400,'作业内容过大，请将附件控制在 3 MB 内');
  let textBytes=0, files=0;
  for (const m of messages) {
    if (!m || !['system','user','assistant'].includes(m.role)) throw aiError(400,'作业消息格式不正确');
    if (typeof m.content==='string') {textBytes+=Buffer.byteLength(m.content);continue;}
    if (m.role!=='user' || !Array.isArray(m.content) || !m.content.length) throw aiError(400,'附件只能作为题目输入');
    for (const part of m.content) {
      if (part?.type==='text' && typeof part.text==='string') {textBytes+=Buffer.byteLength(part.text);continue;}
      if (!part || !['image','pdf'].includes(part.type) || typeof part.data!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) || part.data.length%4 || !['image/png','image/jpeg','image/webp','application/pdf'].includes(part.mimeType) || (part.type==='pdf')!==(part.mimeType==='application/pdf')) throw aiError(400,'附件格式不支持，请上传 PNG、JPEG、WebP 或 PDF');
      if (++files>4) throw aiError(400,'每次最多提交 4 个附件');
    }
  }
  if (textBytes>256*1024) throw aiError(400,'题目文字过长');
}

export function mapHomeworkMessages(messages, protocol) {
  validateHomeworkMessages(messages);
  return messages.map(m=>typeof m.content==='string'?m:{...m,content:m.content.map(p=>{
    if(p.type==='text')return {type:protocol==='responses'?'input_text':'text',text:p.text};
    const url=`data:${p.mimeType};base64,${p.data}`;
    if(protocol==='responses')return p.type==='pdf'?{type:'input_file',filename:'homework.pdf',file_data:url}:{type:'input_image',image_url:url};
    if(protocol==='anthropic')return {type:p.type==='pdf'?'document':'image',source:{type:'base64',media_type:p.mimeType,data:p.data}};
    if(p.type==='pdf')throw aiError(400,'当前连接协议不支持 PDF，请在工作台选择 Responses 或 Anthropic 连接，或将题页转为图片');
    return {type:'image_url',image_url:{url}};
  })});
}
