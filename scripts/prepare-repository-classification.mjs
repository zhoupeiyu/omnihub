import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data/repository-classification/2026-09-28');
const db = new DatabaseSync(path.join(root, 'data/app.db'), { readOnly: true });
const rows = db.prepare(`SELECT id, user_id AS userId, repo_key AS key, description,
  repository_url AS url, topics, metadata FROM repository_assets ORDER BY repo_key`).all();
const keysetHash = createHash('sha256').update(rows.map(row => row.key).join('\n')).digest('hex');
if (keysetHash !== 'e9616ca0716836eb44545d7bc0164be3b947e95edea90dfdc176e023bd456398') throw new Error('Reviewed keyset changed; stop and re-review');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const snapshotFile = path.join(directory, 'snapshot.json');
if (!existsSync(snapshotFile)) writeFileSync(snapshotFile, JSON.stringify({ keysetHash, capturedAt: new Date().toISOString(), rows }, null, 2), {mode:0o600});
const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
if (snapshot.keysetHash !== keysetHash) throw new Error('Snapshot keyset mismatch');
const indexes = (process.argv[2] || '').split(',').filter(Boolean).map(Number);
const exec = promisify(execFile);
const sources = db.prepare(`SELECT i.title, i.content, i.url FROM repository_sources s
  JOIN inbox i ON i.id=s.inbox_id WHERE s.repository_id=? ORDER BY i.id DESC LIMIT 3`);
for (const index of indexes) {
  const row = rows[index - 1];
  if (!row) throw new Error(`Invalid index ${index}`);
  const cacheFile = path.join(directory, `readme-${index}.json`);
  let result;
  if (existsSync(cacheFile)) result = JSON.parse(readFileSync(cacheFile, 'utf8'));
  else {
    result = { index, key: row.key, checkedAt: new Date().toISOString(), sources: sources.all(row.id) };
    try {
      const { stdout } = await exec('gh', ['api', `repos/${row.key}/readme`], {timeout:25000,maxBuffer:5_000_000});
      const response = JSON.parse(stdout);
      result.url = response.html_url;
      result.readme = Buffer.from(response.content || '', 'base64').toString('utf8');
      result.status = 'found';
    } catch (error) {
      result.status = /404/.test(error.stderr || '') ? 'not_found' : 'unavailable';
    }
    writeFileSync(cacheFile, JSON.stringify(result, null, 2), {mode:0o600});
  }
  const text = (result.readme || '').replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n');
  console.log(JSON.stringify({ index, key:row.key, status:result.status, intro:text.slice(0,1500), headings:[...text.matchAll(/^#{1,3} (.+)$/gm)].slice(0,20).map(match=>match[1]), sources: !result.readme ? result.sources?.map(source=>({...source,content:source.content.slice(0,1700)})) : undefined }));
}
db.close();
