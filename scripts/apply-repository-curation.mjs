import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { applyRepositoryCurationImport, prepareRepositoryCurationImport, repositoryCurationSummary } from '../lib/repository-curation-import.js';

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? '' : args[index + 1] || '';
}

function absolute(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

const args = process.argv.slice(2);
const accepted = new Set(['--database','--packet','--apply','--backup-dir']);
for (const arg of args) if (arg.startsWith('--') && !accepted.has(arg)) throw new Error(`Unknown option: ${arg}`);
const databasePath = absolute(option(args,'--database'),'--database');
const packetPath = absolute(option(args,'--packet'),'--packet');
const apply = args.includes('--apply');
const backupDir = option(args,'--backup-dir');
if (apply) absolute(backupDir,'--backup-dir');

const packet = JSON.parse(readFileSync(packetPath,'utf8'));
const db = new DatabaseSync(databasePath,{readOnly:!apply});
db.exec('PRAGMA busy_timeout=5000');
try {
  const plan = prepareRepositoryCurationImport(db,packet);
  if (!apply) {
    console.log(JSON.stringify({mode:'dry-run',...repositoryCurationSummary(plan)},null,2));
  } else {
    mkdirSync(backupDir,{recursive:true,mode:0o700});
    const backupPath = path.join(backupDir,`before-repository-curation-${Date.now()}.db`);
    await backup(db,backupPath);
    chmodSync(backupPath,0o600);
    const result = applyRepositoryCurationImport(db,plan);
    console.log(JSON.stringify({mode:'applied',backupPath,...result},null,2));
  }
} finally {
  db.close();
}
