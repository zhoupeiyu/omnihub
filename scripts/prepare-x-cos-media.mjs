import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { planXImages, prepareXImages } from '../lib/x-cos-archive.js';

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i+1] || ''; };
const dbFile = option('--db'), outDir = option('--out'), username = option('--username');
if (!path.isAbsolute(dbFile) || !path.isAbsolute(outDir) || !username) {
  throw new Error('Usage: --db <absolute sqlite path> --out <absolute directory> --username <owner> [--download]');
}
const db = new DatabaseSync(dbFile, { readOnly: true });
let plan;
try {
  const owner = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!owner) throw new Error('owner_not_found');
  const rows = db.prepare("SELECT id,external_id,visibility,status,media FROM inbox WHERE user_id=? AND source='x' ORDER BY id").all(owner.id);
  plan = planXImages(rows);
} finally { db.close(); }
if (process.argv.includes('--download')) {
  const result = await prepareXImages(plan, outDir, { onProgress: progress => console.log(JSON.stringify({ progress })) });
  console.log(JSON.stringify(result));
  if (result.failed || result.rejected) process.exitCode = 3;
} else console.log(JSON.stringify({ dryRun: true, posts: plan.sourcePosts, images: plan.items.length, rejected: plan.rejected,
  references: plan.items.reduce((n,i)=>n+i.references.length,0), output: outDir, maxStorageGiB: 8 }));
