import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import COS from 'cos-nodejs-sdk-v5';
import { referenceDigest } from '../lib/reference-catalogue.js';
import { writeReferenceJson } from '../lib/reference-storage.js';
import { mergeReferenceCosOriginals, verifyReferenceCosOriginals } from '../lib/reference-cos-import.js';

const { values } = parseArgs({ options: { directory: { type: 'string' }, plan: { type: 'string' },
  apply: { type: 'boolean' }, 'expected-manifest': { type: 'string' } } });
if (!values.directory || !values.plan) throw new Error('directory_and_plan_required');
const directory = path.resolve(values.directory), manifestFile = path.join(directory, 'manifest.json');
const lock = path.join(directory, 'sync.lock');
let locked = false;
try {
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  locked = true;
  const raw = await readFile(manifestFile), manifestSha256 = referenceDigest(raw);
  if (values.apply && values['expected-manifest'] !== manifestSha256) throw new Error('reference_manifest_changed');
  const plan = JSON.parse(await readFile(values.plan, 'utf8'));
  if (plan.version !== 1 || plan.bucket !== process.env.COS_BUCKET || plan.region !== process.env.COS_REGION)
    throw new Error('reference_storage_target_mismatch');
  const result = mergeReferenceCosOriginals(JSON.parse(raw), plan.rows);
  const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY,
    Protocol: 'https:', StrictSsl: true, FollowRedirect: false, Timeout: 20000 });
  await verifyReferenceCosOriginals(plan.rows, Key => cos.headObject({ Bucket: plan.bucket, Region: plan.region, Key }));
  const summary = { mode: values.apply ? 'applied' : 'dry-run', manifestSha256,
    verified: result.verified, changed: result.changed, originalCount: result.originalCount, pendingOriginals: result.pendingOriginals };
  if (values.apply && result.changed) {
    const backup = path.join(directory, 'import-backups', new Date().toISOString().replaceAll(':', '-'));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(path.join(backup, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    const statusFile = path.join(directory, 'status.json'), statusRaw = await readFile(statusFile);
    await writeFile(path.join(backup, 'status.json'), statusRaw, { flag: 'wx', mode: 0o600 });
    await writeReferenceJson(manifestFile, result.manifest);
    await writeReferenceJson(statusFile, { ...JSON.parse(statusRaw), originalCount: result.originalCount,
      pendingOriginals: result.pendingOriginals, importState: result.pendingOriginals ? 'partial' : 'ready',
      originalsImportedAt: new Date().toISOString() });
    summary.backup = backup;
  }
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(JSON.stringify({ error: /^[a-z_]+$/.test(error.message) ? error.message : 'reference_import_failed' }));
  process.exitCode = 1;
} finally { if (locked) await unlink(lock); }
