import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const objectPattern = /^x-bookmarks\/originals\/([a-f0-9]{2})\/([a-f0-9]{64})\.(jpg|png|webp|gif)$/;
const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

export async function loadArchiveForUpload(directory) {
  if (!path.isAbsolute(directory)) throw new Error('absolute_archive_required');
  const manifestBytes = await readFile(path.join(directory, 'x-bookmarks/manifests/media-index.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) throw new Error('invalid_manifest');
  const unique = new Map();
  for (const item of manifest.items) {
    if (item.state !== 'prepared') continue;
    const match = objectPattern.exec(item.key || '');
    if (!match || match[1] !== match[2].slice(0,2) || item.sha256 !== match[2]
      || item.contentType !== types[match[3]] || !Number.isSafeInteger(item.bytes)
      || item.bytes < 1 || item.bytes > 10 * 1024 ** 2) throw new Error('invalid_manifest_object');
    const bytes = await readFile(path.join(directory, item.key));
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('local_checksum_mismatch');
    unique.set(item.key, item);
  }
  const bytes = [...unique.values()].reduce((sum,item) => sum + item.bytes,0);
  if (bytes > 8 * 1024 ** 3) throw new Error('archive_capacity_limit');
  return { manifest, manifestBytes, objects: [...unique.values()], bytes,
    manifestKey: `x-bookmarks/manifests/${hash(manifestBytes)}.json` };
}

export async function uploadXArchive(directory, { cos, bucket, region, onProgress = () => {} }) {
  if (!path.isAbsolute(directory)) throw new Error('absolute_archive_required');
  if (bucket !== 'omnihub-media-1319495021' || region !== 'ap-hongkong') throw new Error('unexpected_cos_target');
  const lock = path.join(directory, 'upload.lock');
  await writeFile(lock, String(process.pid), { flag:'wx', mode:0o600 });
  try {
    const archive = await loadArchiveForUpload(directory);
    let uploaded=0, skipped=0, cursor=0, fatalError;
    const base = { Bucket:bucket, Region:region };
    const headersMatch = (response, bytes, sha256) => Number(response.headers?.['content-length']) === bytes
      && response.headers?.['x-cos-meta-sha256'] === sha256
      && response.headers?.['x-cos-server-side-encryption'] === 'AES256';
    async function putVerified(Key, Body, ContentType) {
      const sha256 = hash(Body);
      let found;
      try { found = await cos.headObject({...base,Key}); }
      catch (error) { if (![403,404].includes(error.statusCode)) throw new Error('cos_head_failed'); }
      if (found) {
        if (!headersMatch(found,Body.length,sha256)) throw new Error('cos_existing_object_mismatch');
        skipped++; return;
      }
      try {
        await cos.putObject({...base,Key,Body,ContentLength:Body.length,ContentType,ACL:'private',
          StorageClass:'STANDARD',ServerSideEncryption:'AES256',CacheControl:'private, max-age=86400',
          'x-cos-meta-sha256':sha256,Headers:{'x-cos-forbid-overwrite':'true'}});
      } catch { throw new Error('cos_upload_failed'); }
      let check;
      try {check=await cos.headObject({...base,Key});} catch {throw new Error('cos_verify_failed');}
      if (!headersMatch(check,Body.length,sha256)) throw new Error('cos_verify_mismatch');
      uploaded++;
    }
    await Promise.allSettled(Array.from({length:3},async()=>{
      try {
        while (!fatalError && cursor<archive.objects.length) {
          const item=archive.objects[cursor++];
          const bytes=await readFile(path.join(directory,item.key));
          if (hash(bytes)!==item.sha256 || bytes.length!==item.bytes) throw new Error('local_checksum_mismatch');
          await putVerified(item.key,bytes,item.contentType);
          if ((uploaded+skipped)%50===0) onProgress({done:uploaded+skipped,total:archive.objects.length});
        }
      } catch(error) {fatalError ||= error;}
    }));
    if (fatalError) throw fatalError;
    await putVerified(archive.manifestKey,archive.manifestBytes,'application/json');
    const result={uploadedAt:new Date().toISOString(),bucket,region,uploaded,skipped,
      mediaObjects:archive.objects.length,bytes:archive.bytes,manifestKey:archive.manifestKey};
    const temp=path.join(directory,`upload-result.${randomUUID()}.tmp`);
    await writeFile(temp,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(temp,path.join(directory,'upload-result.json'));
    return result;
  } finally {await unlink(lock);}
}
