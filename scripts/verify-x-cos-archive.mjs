import COS from 'cos-nodejs-sdk-v5';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

try {
  const directory=process.argv[2];
  if (!path.isAbsolute(directory)) throw new Error('invalid_archive');
  const result=JSON.parse(await readFile(path.join(directory,'upload-result.json')));
  const {COS_SECRET_ID:SecretId,COS_SECRET_KEY:SecretKey,COS_BUCKET:Bucket,COS_REGION:Region}=process.env;
  if (!SecretId || !SecretKey || result.bucket!==Bucket || result.region!==Region
    || Bucket!=='omnihub-media-1319495021' || Region!=='ap-hongkong'
    || !/^x-bookmarks\/manifests\/[a-f0-9]{64}\.json$/.test(result.manifestKey)) throw new Error('invalid_configuration');
  const cos=new COS({SecretId,SecretKey,Protocol:'https:',StrictSsl:true,FollowRedirect:false,Timeout:30000});
  const local=await readFile(path.join(directory,'x-bookmarks/manifests/media-index.json'));
  const remote=await cos.getObject({Bucket,Region,Key:result.manifestKey});
  if (!local.equals(remote.Body)) throw new Error('manifest_mismatch');
  const manifest=JSON.parse(local),samples=manifest.items.filter(item=>item.state==='prepared');
  let checked=0;
  for (const i of [0,Math.floor(samples.length/2),samples.length-1]) {
    const item=samples[i];
    if (!/^x-bookmarks\/originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(item.key)) throw new Error('invalid_key');
    const object=await cos.getObject({Bucket,Region,Key:item.key});
    if (createHash('sha256').update(object.Body).digest('hex')!==item.sha256) throw new Error('sample_mismatch');
    checked++;
  }
  console.log(JSON.stringify({manifestReadback:'matched',sampleReadback:checked,sourcePosts:manifest.sourcePosts,
    preparedUrls:manifest.prepared,unavailableUrls:manifest.failed,mediaObjects:result.mediaObjects,bytes:result.bytes}));
} catch {console.error('archive_readback_failed');process.exitCode=1;}
