import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, stat, rename, unlink, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

const script = `import sys
from PIL import Image,ImageOps
Image.MAX_IMAGE_PIXELS=32000000
with Image.open(sys.argv[1]) as source:
 im=ImageOps.exif_transpose(source)
 im.thumbnail((800,800),Image.Resampling.LANCZOS)
 if im.mode not in ('RGB','RGBA'): im=im.convert('RGB')
 im.save(sys.argv[2],format='WEBP',quality=84,method=4)
`;
export function createMediaPreviewer(directory, { maxBytes = 128 * 1024 ** 2 } = {}) {
  const folder = path.join(directory, 'previews'), pending = new Map();
  let queue = Promise.resolve();
  async function preview(file, identity = null) {
    const info = await stat(file);
    const hash = createHash('sha256').update(JSON.stringify([identity || [file,info.size,info.mtimeMs,info.ctimeMs],'800-q84-v1'])).digest('hex');
    const destination = path.join(folder, hash + '.webp');
    try { if ((await stat(destination)).size > 0) { const now = new Date(); await utimes(destination,now,now); return destination; } } catch { /* Generate once below. */ }
    if (pending.has(hash)) return pending.get(hash);
    const task = queue.then(async () => {
      await mkdir(folder,{recursive:true,mode:0o700});
      const temp = path.join(folder,hash+'.'+randomUUID()+'.tmp');
      try {
        await new Promise((resolve,reject) => {
          const child = spawn('python3',['-c',script,file,temp],{stdio:'ignore',timeout:20000});
          child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('preview_failed')));
        });
        const size=(await stat(temp)).size; if(size>maxBytes)throw new Error('preview_too_large');
        const files=[];
        for(const name of await readdir(folder)) if(/^[a-f0-9]{64}\.webp$/.test(name)) {
          const p=path.join(folder,name),s=await stat(p);files.push({p,size:s.size,time:s.mtimeMs});
        }
        let total=files.reduce((n,x)=>n+x.size,0);
        for(const item of files.sort((a,b)=>a.time-b.time)){if(total+size<=maxBytes)break;await unlink(item.p);total-=item.size;}
        await rename(temp,destination);return destination;
      } finally {await unlink(temp).catch(()=>{});}
    });
    pending.set(hash,task);queue=task.catch(()=>{});
    try{return await task;}finally{pending.delete(hash);}
  }
  async function fromBytes(bytes) {
    const identity=createHash('sha256').update(bytes).digest('hex');
    const hash=createHash('sha256').update(JSON.stringify([identity,'800-q84-v1'])).digest('hex');
    const existing=path.join(folder,hash+'.webp');
    try {if((await stat(existing)).size>0){const now=new Date();await utimes(existing,now,now);return existing;}} catch {}
    await mkdir(folder,{recursive:true,mode:0o700});
    const temp=path.join(folder,randomUUID()+'.source');
    try {await writeFile(temp,bytes,{flag:'wx',mode:0o600});return await preview(temp,identity);}
    finally {await unlink(temp).catch(()=>{});}
  }
  async function find(identity) {
    const hash=createHash('sha256').update(JSON.stringify([identity,'800-q84-v1'])).digest('hex');
    const file=path.join(folder,hash+'.webp');
    try {if((await stat(file)).size>0){const now=new Date();await utimes(file,now,now);return file;}} catch {}
    return null;
  }
  return {preview,fromBytes,find};
}
