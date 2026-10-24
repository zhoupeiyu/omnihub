// Run on the existing production host with a verified, code-only release packet.
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,renameSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const stage = process.argv[2];
if (!/^\/root\/omnihub-deploy\/performance-[a-z0-9-]+$/.test(stage || '')) throw new Error('Invalid release directory');
const root = '/root/omnihub';
const manifest = JSON.parse(readFileSync(path.join(stage,'manifest.json'),'utf8'));
if (!/^[a-f0-9]{16}$/.test(manifest.version)) throw new Error('Invalid build version');
const code = ['lib/http-response.js','lib/http-static.js','lib/api.js','server.js','public/index.html'];
const assetPrefix = `public/assets/build-${manifest.version}/`;
const assetNames = ['app.js','app.css','repository-explorer-prototype.js','repository-taxonomy.js',
  'repository-tab.html','repository-explorer-prototype.css','repository-tab.css','vendor/marked.min.js','vendor/purify.min.js'];
const expectedFiles = [...code,...assetNames.map(name=>assetPrefix+name)];
if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expectedFiles.sort())) throw new Error('Unexpected release files');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const file of expectedFiles) {
  const source = path.join(stage,'payload',file);
  if (lstatSync(source).isSymbolicLink() || hash(source)!==manifest.files[file]) throw new Error(`Invalid payload: ${file}`);
}
function verifyBaseline() {
  for (const file of code) {
    const current = path.join(root,file);
    const expected = manifest.before[file];
    if (expected === null ? existsSync(current) : !expected || !existsSync(current) || hash(current)!==expected) {
      throw new Error(`Baseline changed: ${file}`);
    }
  }
}
verifyBaseline();
if (process.argv.includes('--check')) {console.log(JSON.stringify({verified:true,files:expectedFiles.length,version:manifest.version}));process.exit(0);}
const backup = path.join(stage,'backup');
if (existsSync(backup)) throw new Error('Release was already attempted; inspect its backup before retrying');
mkdirSync(backup);
for (const file of code) {
  if (!existsSync(path.join(root,file))) continue;
  mkdirSync(path.dirname(path.join(backup,file)),{recursive:true});
  copyFileSync(path.join(root,file),path.join(backup,file));
}
function atomicCopy(source,destination) {
  mkdirSync(path.dirname(destination),{recursive:true});
  const temporary = `${destination}.release-${process.pid}`;
  copyFileSync(source,temporary);
  renameSync(temporary,destination);
}
// Upload immutable files first, while the previous site remains available.
for (const name of assetNames) {
  const file = assetPrefix+name;
  const target = path.join(root,file);
  if (existsSync(target)) {
    if (hash(target)!==manifest.files[file]) throw new Error(`Immutable asset collision: ${file}`);
  } else atomicCopy(path.join(stage,'payload',file),target);
}
const service = operation => execFileSync('systemctl',[operation,'omnihub'],{stdio:'pipe'});
let stopped = false;
try {
  verifyBaseline();
  service('stop'); stopped = true;
  verifyBaseline();
  // Index is last, so all referenced files are present before it becomes visible.
  for (const file of code) atomicCopy(path.join(stage,'payload',file),path.join(root,file));
  service('start');
  let ready = false;
  for (let attempt=0;attempt<20;attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:4320/',{signal:AbortSignal.timeout(3000)});
      if (response.ok && (await response.text()).includes(`build-${manifest.version}`)) {ready=true;break;}
    } catch {}
    await delay(250);
  }
  if (!ready) throw new Error('New site did not become healthy');
  for (const [route,count] of Object.entries(manifest.counts)) {
    if (!['/api/repositories','/api/prompt-library','/api/knowledge-library','/api/x-bookmarks?v=2'].includes(route)) throw new Error('Invalid probe route');
    const response = await fetch(`http://127.0.0.1:4320${route}`,{signal:AbortSignal.timeout(10000)});
    const rows = await response.json();
    if (!response.ok || !Array.isArray(rows) || rows.length!==count || response.headers.get('cache-control')!=='no-store') throw new Error(`Probe failed: ${route}`);
  }
  for (const file of expectedFiles) if (hash(path.join(root,file))!==manifest.files[file]) throw new Error(`Read-back mismatch: ${file}`);
  service('is-active');
  writeFileSync(path.join(stage,'result.json'),JSON.stringify({status:'deployed',version:manifest.version,counts:manifest.counts,backup},null,2));
  console.log(JSON.stringify({status:'deployed',version:manifest.version,counts:manifest.counts,backup}));
} catch (error) {
  if (stopped) {
    service('stop');
    for (const file of code) if (existsSync(path.join(backup,file))) atomicCopy(path.join(backup,file),path.join(root,file));
    // New helper and asset files remain unreferenced; no data or existing assets are removed.
    service('start');
  }
  throw error;
}
