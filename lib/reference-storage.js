import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { referenceDigest, referenceImageType, referenceObject, validReferenceObject } from './reference-catalogue.js';

export async function writeReferenceJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

export function createReferenceStorage({ directory, env = process.env, cos: providedCos } = {}) {
  if (!path.isAbsolute(directory || '')) throw new Error('absolute_reference_directory_required');
  let client = providedCos;
  const bucket = env.COS_BUCKET, region = env.COS_REGION;
  const remote = Boolean(providedCos || (bucket && region && env.COS_SECRET_ID && env.COS_SECRET_KEY));
  async function cos() {
    if (!remote) throw new Error('reference_storage_not_configured');
    if (!client) {
      const { default: COS } = await import('cos-nodejs-sdk-v5');
      client = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY,
        Protocol: 'https:', StrictSsl: true, FollowRedirect: false, Timeout: 20000 });
    }
    return client;
  }
  async function read(object) {
    if (!validReferenceObject(object)) throw new Error('invalid_reference_object');
    let bytes;
    try {
      const file = path.join(directory, object.key);
      if ((await stat(file)).size === object.bytes) bytes = await readFile(file);
    } catch { /* Locally retained thumbnails are optional; originals remain in COS. */ }
    if (!bytes || referenceDigest(bytes) !== object.sha256) {
      try {
        const response = await (await cos()).getObject({ Bucket: bucket, Region: region, Key: object.key, Range: `bytes=0-${object.bytes}` });
        bytes = Buffer.isBuffer(response.Body) ? response.Body : Buffer.from(response.Body);
      } catch { throw new Error('reference_image_unavailable'); }
    }
    if (bytes.length !== object.bytes || referenceDigest(bytes) !== object.sha256) throw new Error('reference_integrity_failed');
    return bytes;
  }
  async function put(bytes, { cache = false } = {}) {
    const object = referenceObject(bytes);
    if (remote) {
      const connection = await cos(), params = { Bucket: bucket, Region: region, Key: object.key };
      const matches = response => Number(response?.headers?.['content-length']) === object.bytes
        && response.headers['x-cos-meta-sha256'] === object.sha256;
      let existing;
      try { existing = await connection.headObject(params); }
      catch (error) { if (error.statusCode !== 404) throw new Error('reference_storage_head_failed'); }
      if (existing && !matches(existing)) throw new Error('reference_storage_conflict');
      if (!existing) {
        try {
          await connection.putObject({ ...params, Body: bytes, ContentLength: bytes.length, ContentType: object.contentType,
            ACL: 'private', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store',
            'x-cos-meta-sha256': object.sha256, Headers: { 'x-cos-forbid-overwrite': 'true' } });
          if (!matches(await connection.headObject(params))) throw new Error('verify_failed');
        } catch { throw new Error('reference_storage_write_failed'); }
      }
    }
    if (cache || !remote) {
      const file = path.join(directory, object.key);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return object;
  }
  async function findOriginal(kind, stem) {
    if (!remote) return null;
    const folders = { face: 'AI 作图脸库', pose: 'AI 作图姿势库', costume: 'AI 服装库' };
    if (!Object.hasOwn(folders, kind) || !/^[A-Za-z0-9_-]{1,100}$/.test(stem)) throw new Error('invalid_reference_id');
    const key = `ai-reference/图片/${folders[kind]}/${stem}.png`;
    const connection = await cos(), params = { Bucket: bucket, Region: region, Key: key };
    let head;
    try { head = await connection.headObject(params); }
    catch (error) { if (error.statusCode === 404) return null; throw new Error('reference_storage_read_failed'); }
    const size = Number(head.headers?.['content-length']);
    if (!Number.isSafeInteger(size) || size < 12 || size > 32 * 1024 ** 2) throw new Error('invalid_reference_image');
    let result;
    try { result = await connection.getObject({ ...params, Range: `bytes=0-${size - 1}`, IfMatch: head.headers.etag }); }
    catch { throw new Error('reference_storage_read_failed'); }
    const bytes = Buffer.isBuffer(result.Body) ? result.Body : Buffer.from(result.Body);
    if (bytes.length !== size || referenceImageType(bytes).extension !== 'png') throw new Error('invalid_reference_image');
    return { key, bytes: size, sha256: referenceDigest(bytes), contentType: 'image/png',
      etag: String(head.headers.etag || '').replaceAll('"', '').toLowerCase() };
  }
  return { read, put, findOriginal, remote };
}
