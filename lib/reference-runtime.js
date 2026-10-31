import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function startReferenceSync({ directory, enabled = process.env.OMNIHUB_REFERENCE_SYNC === 'true' }) {
  if (!enabled) return () => {};
  let stopped = false, child = null, checking = false;
  const script = fileURLToPath(new URL('../scripts/sync-reference-library.mjs', import.meta.url));
  async function tick() {
    if (stopped || child || checking) return;
    checking = true;
    try {
      let status = {};
      try { status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')); } catch { /* First run. */ }
      if (Number.isFinite(Date.parse(status.nextCheckAt)) && Date.parse(status.nextCheckAt) > Date.now()) return;
      child = spawn(process.execPath, [script, '--directory', directory], { stdio: 'ignore', env: process.env });
      child.once('error', () => { child = null; });
      child.once('exit', () => { child = null; });
    } finally { checking = false; }
  }
  const initial = setTimeout(() => void tick(), 45000), interval = setInterval(() => void tick(), 60000);
  initial.unref(); interval.unref();
  return () => { stopped = true; clearTimeout(initial); clearInterval(interval); };
}
