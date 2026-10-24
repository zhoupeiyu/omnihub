import COS from 'cos-nodejs-sdk-v5';
import { loadArchiveForUpload, uploadXArchive } from '../lib/x-cos-upload.js';

const i=process.argv.indexOf('--archive');
const directory=i>=0 ? process.argv[i+1] : '';
try {
  if (!process.argv.includes('--upload')) {
    const archive=await loadArchiveForUpload(directory);
    console.log(JSON.stringify({dryRun:true,objects:archive.objects.length,bytes:archive.bytes,manifestKey:archive.manifestKey}));
  } else {
    const {COS_SECRET_ID:SecretId,COS_SECRET_KEY:SecretKey,COS_BUCKET:bucket,COS_REGION:region}=process.env;
    if (!SecretId || !SecretKey) throw new Error('cos_credentials_missing');
    const cos=new COS({SecretId,SecretKey,Protocol:'https:',StrictSsl:true,FollowRedirect:false,
      Timeout:30000,UploadCheckContentMd5:true,KeepAlive:true});
    const result=await uploadXArchive(directory,{cos,bucket,region,onProgress:p=>console.log(JSON.stringify({progress:p}))});
    console.log(JSON.stringify(result));
  }
} catch (error) {
  const safe=/^(absolute_archive_required|invalid_manifest|invalid_manifest_object|local_checksum_mismatch|archive_capacity_limit|unexpected_cos_target|cos_credentials_missing|cos_head_failed|cos_existing_object_mismatch|cos_upload_failed|cos_verify_failed|cos_verify_mismatch)$/;
  console.error(JSON.stringify({error:safe.test(error.message)?error.message:'archive_upload_failed'}));
  process.exitCode=1;
}
