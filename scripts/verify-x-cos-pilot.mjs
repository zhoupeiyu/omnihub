import COS from 'cos-nodejs-sdk-v5';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadArchiveForUpload } from '../lib/x-cos-upload.js';

let phase='preflight';
try {
  const directory=process.argv[2];
  const archive=await loadArchiveForUpload(directory);
  const {COS_SECRET_ID:SecretId,COS_SECRET_KEY:SecretKey,COS_BUCKET:Bucket,COS_REGION:Region}=process.env;
  if (!SecretId || !SecretKey || Bucket!=='omnihub-media-1319495021' || Region!=='ap-hongkong') throw new Error('invalid_configuration');
  const cos=new COS({SecretId,SecretKey,Protocol:'https:',StrictSsl:true,FollowRedirect:false,Timeout:30000,UploadCheckContentMd5:true});
  const item=archive.objects[0], Key=item.key, Body=await readFile(`${directory}/${Key}`);
  const base={Bucket,Region,Key};
  phase='head';
  let existing;
  try {existing=await cos.headObject(base);} catch(e) {if (![403,404].includes(e.statusCode)) throw e;}
  if (!existing) {
    phase='put';
    await cos.putObject({...base,Body,ContentLength:Body.length,ContentType:item.contentType,ACL:'private',
      StorageClass:'STANDARD',ServerSideEncryption:'AES256','x-cos-meta-sha256':item.sha256,
      CacheControl:'private, max-age=86400',Headers:{'x-cos-forbid-overwrite':'true'}});
  }
  phase='readback';
  const head=await cos.headObject(base), read=await cos.getObject(base);
  const checksum=createHash('sha256').update(read.Body).digest('hex')===item.sha256;
  const metadata=head.headers['x-cos-meta-sha256']===item.sha256;
  const size=Number(head.headers['content-length'])===item.bytes;
  const encrypted=head.headers['x-cos-server-side-encryption']==='AES256';
  phase='anonymous';
  const anonymous=await fetch(`https://${Bucket}.cos.${Region}.myqcloud.com/${Key}`,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(15000)});
  const privateObject=anonymous.status===403;
  phase='scope';
  let outsidePrefixDenied=false,listDenied=false;
  try {await cos.headObject({Bucket,Region,Key:'outside-prefix-permission-check'});} catch(e) {outsidePrefixDenied=e.statusCode===403;}
  try {await cos.getBucket({Bucket,Region,MaxKeys:1});} catch(e) {listDenied=e.statusCode===403;}
  const result={checksum,metadata,size,encrypted,privateObject,outsidePrefixDenied,listDenied};
  if (Object.values(result).some(v=>v!==true)) throw new Error('verification_failed');
  await writeFile(`${directory}/pilot-result.json`,JSON.stringify({verifiedAt:new Date().toISOString(),key:Key,...result},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({pilot:'passed',...result}));
} catch(error) {
  console.error(JSON.stringify({pilot:'failed',phase,statusCode:Number(error.statusCode)||null,code:/^[A-Za-z_]{1,60}$/.test(error.code||'')?error.code:'redacted'}));
  process.exitCode=1;
}
