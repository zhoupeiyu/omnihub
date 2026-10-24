import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';

const live = '/root/omnihub';
const release = '/root/omnihub-deploy/repository-tab-20260928';
const manifest = JSON.parse(readFileSync(path.join(release, 'manifest.json'), 'utf8'));
const allowed = new Set(['public/app.jsx', 'public/components.jsx', 'public/index.html', 'public/repository-tab.js', 'public/repository-tab.html', 'public/repository-tab.css', 'public/repository-explorer-prototype.js', 'public/repository-explorer-prototype.html', 'public/repositories.html']);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (process.argv.length > 3 || !['--check', '--apply'].includes(process.argv[2] || '--check')) throw new Error('Use --check or --apply');
if (manifest.files.length !== allowed.size || new Set(manifest.files.map(item => item.path)).size !== allowed.size) throw new Error('Unexpected manifest');
for (const item of manifest.files) {
  if (!allowed.has(item.path) || hash(path.join(release, 'candidate', item.path)) !== item.sha256) throw new Error('Candidate file mismatch');
  const target = path.join(live, item.path);
  if (item.before === null ? existsSync(target) : !existsSync(target) || hash(target) !== item.before) throw new Error(`Live file changed: ${item.path}`);
}
if (process.argv[2] !== '--apply') { console.log(JSON.stringify({checked: manifest.files.length, databaseChanges: false})); process.exit(0); }
const backup = path.join(release, 'backup');
if (existsSync(backup)) throw new Error('Existing backup; reconcile before retrying');
mkdirSync(backup, { mode: 0o700 });
const installed = [];
try {
  for (const item of manifest.files) if (item.before !== null) {
    const destination = path.join(backup, item.path);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(path.join(live, item.path), destination); chmodSync(destination, 0o600);
  }
  // Publish the entry HTML last, after all of its new module dependencies exist.
  const ordered = [...manifest.files].sort((a, b) => Number(a.path === 'public/index.html') - Number(b.path === 'public/index.html'));
  for (const item of ordered) {
    const target = path.join(live, item.path);
    const temporary = target + '.repository-tab-release';
    if (existsSync(temporary)) throw new Error('Stale activation file');
    copyFileSync(path.join(release, 'candidate', item.path), temporary); chmodSync(temporary, 0o644);
    renameSync(temporary, target); installed.push(item);
    if (hash(target) !== item.sha256) throw new Error('Activated file mismatch');
  }
  const result = { deployedAt: new Date().toISOString(), files: manifest.files, databaseChanges: false, serviceRestarted: false, backup };
  writeFileSync(path.join(release, 'deployed.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ deployed: true, files: installed.length, databaseChanges: false, serviceRestarted: false, backup }));
} catch (error) {
  for (const item of installed.reverse()) {
    const target = path.join(live, item.path);
    if (item.before !== null) { copyFileSync(path.join(backup, item.path), target); chmodSync(target, 0o644); }
    else { const saved = path.join(backup, 'new-files', item.path); mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 }); renameSync(target, saved); }
  }
  throw error;
}
