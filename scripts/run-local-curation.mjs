#!/usr/bin/env node
import { dirname, isAbsolute, resolve } from 'node:path';
import { lstat, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { acquireLocalCurationLock, checkLocalCodex, loadLocalCurationConfig, redactLocalCurationError, releaseLocalCurationLock, runLocalCodexTask } from '../lib/local-codex-runner.js';
import { checkClaudeApiTransport, createClaudeApiTransport } from '../lib/local-text-model.js';

const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || ''; };
const configPath = arg('--config');
const checkOnly = process.argv.includes('--check');
const explicitMax = arg('--max-tasks');
const maxTasks = explicitMax ? Number(explicitMax) : 10;
if (!isAbsolute(configPath) || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 10) {
  console.error('Usage: node scripts/run-local-curation.mjs --config /absolute/private-config.json [--check] [--max-tasks 1..10]'); process.exit(2);
}

async function main() {
const config = await loadLocalCurationConfig(configPath, { allowTestHttp: process.env.NODE_ENV === 'test' });
const claudeTransport = config.transport === 'claude-api' ? createClaudeApiTransport() : null;
const transportStatus = () => config.transport === 'claude-api'
  ? checkClaudeApiTransport(config)
  : checkLocalCodex(config);
const transportReady = status => config.transport === 'claude-api'
  ? status.configured && status.model === config.model
  : status.loggedIn && status.toolIsolation === 'available';
const runTask = task => config.transport === 'claude-api' ? claudeTransport.run(config, task) : runLocalCodexTask(config, task);
const endpoint = path => new URL(path, `${config.baseUrl}/`).href;
const fetchApi = async (path, { method = 'GET', body } = {}) => {
  let response;
  try { response = await fetch(endpoint(path), { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${config.deviceToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('本机整理无法连接网站'), { code: 'upstream' }); }
  if (!response.ok) throw Object.assign(new Error('本机整理网站请求失败'), { code: response.status === 401 ? 'reconnect' : response.status === 409 ? 'conflict' : 'upstream', status: response.status });
  try { return await response.json(); } catch { throw Object.assign(new Error('本机整理网站响应错误'), { code: 'upstream' }); }
};
const outboxPath = config.outboxPath;
const privateRegularFile = async file => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Object.assign(new Error('本机整理暂存不可读取'), { code: 'configuration' });
  return stat;
};
const readOutbox = async () => {
  try { const stat = await privateRegularFile(outboxPath); if (stat.size > 512 * 1024) throw new Error(); const entries = JSON.parse(await readFile(outboxPath, 'utf8')); return Array.isArray(entries) ? entries : []; } catch (error) { if (error.code === 'ENOENT') return []; if (error.code === 'configuration') throw error; throw Object.assign(new Error('本机整理暂存不可读取'), { code: 'configuration' }); }
};
const writeOutbox = async entries => {
  await privateRegularFile(outboxPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const temporary = resolve(dirname(outboxPath), `.omnihub-local-curation-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(entries)); } finally { await handle.close(); }
  await rename(temporary, outboxPath);
};
const submit = async record => fetchApi(`/api/local-curation/tasks/${encodeURIComponent(record.id)}/${record.kind}`, { method: 'POST', body: record.body });
const drainOutbox = async () => {
  const entries = await readOutbox(); const remaining = []; let dropped = 0; let reconnect = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try { await submit(entry); }
    catch (error) {
      // A completed/changed/expired lease cannot be recovered locally. Do not
      // let it block later records, and never print the record or its token.
      if (error.code === 'conflict' || (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status))) { dropped += 1; continue; }
      remaining.push(entry);
      if (error.code === 'reconnect') { reconnect = true; remaining.push(...entries.slice(index + 1)); break; }
    }
  }
  if (remaining.length !== entries.length || entries.length) await writeOutbox(remaining);
  return { remaining: remaining.length, dropped, reconnect };
};

if (checkOnly) {
  try {
    const status = await transportStatus();
    console.log(JSON.stringify({ transport: config.transport, configured: status.configured, model: status.model || config.model, provider: status.provider || null, toolIsolation: status.toolIsolation || null }));
    process.exitCode = transportReady(status) ? 0 : 1;
  } catch { console.log(JSON.stringify({ transport: config.transport, configured: false })); process.exitCode = 1; }
} else {
  const lockPath = resolve(dirname(config.configPath), '.omnihub-local-curation.lock');
  let lock;
  try {
    lock = await acquireLocalCurationLock(lockPath);
    // Delivery is safe even when the current Codex lacks a no-tools boundary.
    // Always settle old idempotent results before deciding whether to claim.
    const pending = await drainOutbox();
    if (pending.remaining) throw Object.assign(new Error('本机整理回传仍在重试'), { code: 'upstream' });
    // This check happens before a claim so a missing no-tools boundary cannot
    // reserve a server task or consume its retry budget.
    const safety = await transportStatus();
    if (!transportReady(safety)) throw Object.assign(new Error('本机整理传输未就绪'), { code: 'tool_isolation_unavailable' });
    let completed = 0;
    while (completed < maxTasks) {
      const claim = await fetchApi('/api/local-curation/claim', { method: 'POST', body: {} });
      if (!claim.task) break;
      const task = claim.task;
      const requestKey = task.requestKey;
      const heartbeat = setInterval(() => { fetchApi(`/api/local-curation/tasks/${encodeURIComponent(task.id)}/heartbeat`, { method: 'POST', body: { leaseToken: task.leaseToken, requestKey } }).catch(() => {}); }, 30_000);
      try {
        const result = await runTask(task);
        const record = { id: task.id, kind: 'complete', body: { leaseToken: task.leaseToken, requestKey, value: result.value, model: result.model } };
        try { await submit(record); } catch { const entries = await readOutbox(); entries.push(record); await writeOutbox(entries); break; }
      } catch (error) {
        const record = { id: task.id, kind: 'fail', body: { leaseToken: task.leaseToken, requestKey, code: redactLocalCurationError(error) } };
        try { await submit(record); } catch { const entries = await readOutbox(); entries.push(record); await writeOutbox(entries); break; }
      } finally { clearInterval(heartbeat); }
      completed += 1;
    }
    console.log(JSON.stringify({ processed: completed }));
  } finally { if (lock) await releaseLocalCurationLock(lock); }
}
}

await main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: redactLocalCurationError(error) }));
  process.exitCode = 1;
});
