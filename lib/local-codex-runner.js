import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_CONFIG_BYTES = 64 * 1024;
const SAFE_ERROR_CODES = new Set(['configuration', 'tool_isolation_unavailable', 'timeout', 'invalid_result', 'upstream']);
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

function safeError(code, message) {
  const error = new Error(message);
  error.code = SAFE_ERROR_CODES.has(code) ? code : 'upstream';
  return error;
}

function assertPrivateMode(stat, file) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES || (stat.mode & 0o077) !== 0) {
    throw safeError('configuration', `本机整理配置不可用：${file}`);
  }
}

export async function loadLocalCurationConfig(configPath, { allowTestHttp = false } = {}) {
  if (!isAbsolute(configPath)) throw safeError('configuration', '本机整理配置必须使用绝对路径');
  let raw;
  try {
    const stat = await lstat(configPath);
    assertPrivateMode(stat, configPath);
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'configuration') throw error;
    throw safeError('configuration', '本机整理配置不可读取');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw safeError('configuration', '本机整理配置格式错误');
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
  const deviceToken = typeof raw.deviceToken === 'string' ? raw.deviceToken : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const transport = raw.transport === undefined ? 'codex' : raw.transport;
  const codexPath = typeof raw.codexPath === 'string' ? raw.codexPath : '/opt/homebrew/bin/codex';
  if (!deviceToken || deviceToken.length < 24 || !model || !isAbsolute(codexPath) || !['codex', 'claude-api'].includes(transport)) throw safeError('configuration', '本机整理配置缺少必要字段');
  let url;
  try { url = new URL(baseUrl); } catch { throw safeError('configuration', '网站地址无效'); }
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(allowTestHttp && localhost && url.protocol === 'http:'))) {
    throw safeError('configuration', '网站地址必须为 HTTPS 根地址');
  }
  const outboxPath = raw.outboxPath === undefined ? resolve(dirname(configPath), 'omnihub-local-curation-outbox.json') : raw.outboxPath;
  if (typeof outboxPath !== 'string' || !isAbsolute(outboxPath)) throw safeError('configuration', '本机整理暂存路径必须使用绝对路径');
  return Object.freeze({ baseUrl: url.href.replace(/\/$/, ''), deviceToken, model, transport, codexPath, configPath: resolve(configPath), outboxPath: resolve(outboxPath) });
}

function runProcess(command, args, { input = '', timeoutMs = 30_000, spawnImpl = defaultSpawn } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    let stdout = '', stderr = '', settled = false, timedOut = false, outputTooLarge = false;
    let timer, killTimer;
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const finish = (error, result) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killTimer); error ? rejectProcess(error) : resolveProcess(result); } };
    const exceed = () => { if (outputTooLarge) return; outputTooLarge = true; child.kill('SIGTERM'); killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(safeError('invalid_result', '本机 Codex 输出过大')); }, 5_000); };
    timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(safeError('timeout', '本机 Codex 执行超时')); }, 5_000); }, timeoutMs);
    child.once('error', () => finish(safeError('configuration', '本机 Codex 不可用')));
    child.stdout?.on('data', chunk => { if (Buffer.byteLength(stdout) + chunk.length > MAX_PROCESS_OUTPUT_BYTES) exceed(); else stdout += chunk; });
    child.stderr?.on('data', chunk => { if (Buffer.byteLength(stderr) + chunk.length > MAX_PROCESS_OUTPUT_BYTES) exceed(); else stderr += chunk; });
    child.once('close', code => finish(outputTooLarge ? safeError('invalid_result', '本机 Codex 输出过大') : timedOut ? safeError('timeout', '本机 Codex 执行超时') : null, { code, stdout, stderr }));
    child.stdin?.end(input);
  });
}

export async function inspectCodexSafety({ codexPath, spawnImpl = defaultSpawn } = {}) {
  const result = await runProcess(codexPath, ['exec', '--help'], { spawnImpl, timeoutMs: 10_000 });
  // Current official CLI exposes sandbox modes only. Those restrict effects,
  // but do not provide a documented all-tools-off boundary for untrusted text.
  return { available: result.code === 0, supportsNoTools: false };
}

export async function checkLocalCodex(config, { spawnImpl = defaultSpawn } = {}) {
  const [safety, login] = await Promise.all([
    inspectCodexSafety({ codexPath: config.codexPath, spawnImpl }),
    runProcess(config.codexPath, ['login', 'status'], { spawnImpl, timeoutMs: 10_000 }),
  ]);
  return { configured: true, loggedIn: login.code === 0, toolIsolation: safety.supportsNoTools ? 'available' : 'unavailable' };
}

export async function runLocalCodexTask(config, task, { spawnImpl = defaultSpawn } = {}) {
  if (!task || task.model !== config.model) throw safeError('invalid_result', '整理任务模型不匹配');
  const safety = await inspectCodexSafety({ codexPath: config.codexPath, spawnImpl });
  if (!safety.available) throw safeError('configuration', '本机 Codex 不可用');
  if (!safety.supportsNoTools) throw safeError('tool_isolation_unavailable', '当前 Codex CLI 无法可靠禁用工具，本机整理已安全停止');
  // Kept as a single fail-closed boundary so a future supported transport can
  // be wired here after it proves no filesystem, shell, network, MCP or plugin
  // tools are available. Do not substitute a prompt-only guard.
  void config; void task;
  throw safeError('tool_isolation_unavailable', '当前 Codex CLI 无法可靠禁用工具，本机整理已安全停止');
}

export function redactLocalCurationError(error) {
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : 'upstream';
}

async function lockOwner(lockPath) {
  try { return JSON.parse(await readFile(lockPath, 'utf8')); } catch { return null; }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function withLockGuard(lockPath, action) {
  const guardPath = `${lockPath}.guard`;
  let guard;
  try {
    guard = await open(guardPath, 'wx', 0o600);
    await guard.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
    return await action();
  } catch (error) {
    if (error.code === 'EEXIST') throw safeError('upstream', '本机整理锁正在变更，请稍后重试');
    throw error;
  } finally {
    await guard?.close();
    // A guard is removed only by the instance that successfully created it.
    // A crash leaves it for explicit operator recovery instead of racing a
    // potentially live owner.
    if (guard) await rm(guardPath, { force: true });
  }
}
export async function acquireLocalCurationLock(lockPath, { now = Date.now(), staleMs = 3 * 60 * 60 * 1000 } = {}) {
  return withLockGuard(lockPath, async () => {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: now }));
      return { handle, token, lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(lockPath).catch(() => null);
      const owner = await lockOwner(lockPath);
      if (!stat || stat.isSymbolicLink() || processAlive(owner?.pid) || now - stat.mtimeMs <= staleMs) throw safeError('upstream', '本机整理任务已在运行');
      await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: now }));
      return { handle, token, lockPath };
    }
  });
}

export async function releaseLocalCurationLock(lock) {
  if (!lock) return;
  await lock.handle?.close();
  await withLockGuard(lock.lockPath, async () => {
    const owner = await lockOwner(lock.lockPath);
    if (owner?.token === lock.token) await rm(lock.lockPath, { force: true });
  });
}
