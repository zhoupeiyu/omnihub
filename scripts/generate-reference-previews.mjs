import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';import {spawn} from 'node:child_process';
import {createReferenceStorage} from '../lib/reference-storage.js';
const directory=path.resolve(process.argv[2]||'data/reference-library');
const limit=Number(process.argv[3]||0),profile='webp-800-q84-v1';
const storage=createReferenceStorage({directory});
const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json')));
const file=path.join(directory,'previews.json');let previews={version:1,profile,items:{}};
try{previews=JSON.parse(await readFile(file))}catch(e){if(e.code!=='ENOENT')throw e}
if(previews.profile!==profile)throw Error('preview_profile_mismatch');
const rows=manifest.items.filter(i=>i.original);let cursor=0,done=0,failed=0;
const py=`import sys,io,json
from PIL import Image,ImageOps
im=ImageOps.exif_transpose(Image.open(io.BytesIO(sys.stdin.buffer.read())))
im.thumbnail((800,800),Image.Resampling.LANCZOS)
if im.mode not in ('RGB','RGBA'): im=im.convert('RGB')
im.save(sys.stdout.buffer,format='WEBP',quality=84,method=4)
`;
function resize(bytes){return new Promise((resolve,reject)=>{const p=spawn('python3',['-c',py]);let chunks=[];p.stdout.on('data',b=>chunks.push(b));p.stderr.resume();p.on('error',reject);p.on('close',code=>code?reject(Error('resize_failed')):resolve(Buffer.concat(chunks)));p.stdin.on('error',reject);p.stdin.end(bytes)})}
let writing=Promise.resolve();function save(){const body=JSON.stringify(previews);writing=writing.then(async()=>{await writeFile(file+'.next',body,{mode:0o600});await rename(file+'.next',file)});return writing}
await Promise.all(Array.from({length:4},async()=>{while(cursor<rows.length&&(!limit||cursor<limit)){const item=rows[cursor++];if(previews.items[item.id]?.originalSha256===item.original.sha256){done++;continue}try{const bytes=await storage.read(item.original),small=await resize(bytes),object=await storage.put(small,{cache:true});if(!(await storage.read(object)).equals(small))throw Error('verification_failed');previews.items[item.id]={originalSha256:item.original.sha256,object};done++;if(limit||done%100===0){await save();console.log(JSON.stringify({done,total:rows.length,failed,last:item.id,originalBytes:bytes.length,previewBytes:small.length}))}}catch(e){failed++;console.log(JSON.stringify({id:item.id,error:e.message}))}}}));await save();console.log(JSON.stringify({done,failed,total:rows.length,bytes:Object.values(previews.items).reduce((n,i)=>n+i.object.bytes,0)}));if(failed)process.exitCode=1;
