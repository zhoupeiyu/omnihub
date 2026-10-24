import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FINAL_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIN_IMAGE_BYTES = 45;
const MAX_PROMPT_BYTES = 64 * 1024;
const SAFE_ERROR_CODES = new Set([
  'configuration',
  'auth',
  'quota_unavailable',
  'unsupported_task',
  'timeout',
  'invalid_result',
  'interrupted_after_start',
  'circuit_open',
  'reconnect',
  'conflict',
  'upstream',
]);
const API_OVERRIDE_ENV = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_HOST',
  'CODEX_ACCESS_TOKEN',
];
const CONFIG_OVERRIDE_PATTERN = /^\s*(?:model_provider|openai_api_key|api_key|base_url|openai_base_url|wire_api|oss_provider)\s*=/mi;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASPECT_RATIOS = new Set(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']);

function runnerError(code, message, status) {
  const error = new Error(message);
  error.code = SAFE_ERROR_CODES.has(code) ? code : 'upstream';
  if (status !== undefined) error.status = status;
  return error;
}

export function redactLocalImageError(error) {
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : 'upstream';
}

export function defaultLocalImageConfigPath(env = process.env) {
  const codexHome = env.CODEX_HOME || (env.HOME ? resolve(env.HOME, '.codex') : '');
  if (!codexHome || !isAbsolute(codexHome)) throw runnerError('configuration', 'Default local image config path is unavailable');
  return resolve(codexHome, 'omnihub-local-image', 'config.json');
}

function assertPrivateRegularFile(fileStat, file, maxBytes = MAX_CONFIG_BYTES) {
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxBytes || (fileStat.mode & 0o077) !== 0) {
    throw runnerError('configuration', `Private local image file is unavailable: ${file}`);
  }
}

function normalizeBaseUrl(value, { allowTestHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw runnerError('configuration', 'Invalid OmniHub URL'); }
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(allowTestHttp && localhost && url.protocol === 'http:'))
  ) throw runnerError('configuration', 'OmniHub URL must be an HTTPS origin');
  return url.href.replace(/\/$/, '');
}

export async function loadLocalImageConfig(configPath, { allowTestHttp = false } = {}) {
  if (!isAbsolute(configPath)) throw runnerError('configuration', 'Local image config path must be absolute');
  let raw;
  try {
    const fileStat = await lstat(configPath);
    assertPrivateRegularFile(fileStat, configPath);
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'configuration') throw error;
    throw runnerError('configuration', 'Local image config is unreadable');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw runnerError('configuration', 'Invalid local image config');
  const baseUrl = normalizeBaseUrl(raw.baseUrl, { allowTestHttp });
  const deviceToken = typeof raw.deviceToken === 'string' ? raw.deviceToken : '';
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';
  const codexBin = typeof raw.codexBin === 'string' ? raw.codexBin : DEFAULT_CODEX_BIN;
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_MODEL;
  if (deviceToken.length < 24 || deviceToken.length > 4096 || !deviceId || deviceId.length > 256) {
    throw runnerError('configuration', 'Local image config is missing device credentials');
  }
  if (!isAbsolute(codexBin) || !model || model.length > 128) throw runnerError('configuration', 'Invalid local image runner config');
  return Object.freeze({
    baseUrl,
    deviceToken,
    deviceId,
    codexBin: resolve(codexBin),
    model,
    configPath: resolve(configPath),
    stateDir: resolve(dirname(configPath), '.omnihub-local-image'),
  });
}

async function writePrivateJson(file, value) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw runnerError('configuration', 'Local image state directory is not private');
  }
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); } finally { await handle.close(); }
  try {
    const current = await lstat(file);
    assertPrivateRegularFile(current, file, MAX_JSON_BYTES);
  } catch (error) {
    if (error.code !== 'ENOENT') { await rm(temporary, { force: true }); throw error; }
  }
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function readPrivateJson(file, { missing = null } = {}) {
  try {
    const fileStat = await lstat(file);
    assertPrivateRegularFile(fileStat, file, MAX_JSON_BYTES);
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return missing;
    if (error.code === 'configuration') throw error;
    throw runnerError('configuration', 'Local image journal is unreadable');
  }
}

function endpoint(config, pathname) {
  const url = new URL(pathname, `${config.baseUrl}/`);
  if (url.origin !== new URL(config.baseUrl).origin) throw runnerError('configuration', 'Cross-origin endpoint rejected');
  return url;
}

async function boundedResponseText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw runnerError('upstream', 'OmniHub response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw runnerError('upstream', 'OmniHub response is too large');
  return text;
}

function assertSameOriginResponse(config, response) {
  if (!response.url) return;
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { throw runnerError('upstream', 'Invalid OmniHub response URL'); }
  if (responseUrl.origin !== new URL(config.baseUrl).origin) throw runnerError('upstream', 'Cross-origin response rejected');
}

export async function requestLocalImageApi(config, pathname, {
  method = 'GET',
  json,
  raw,
  leaseToken,
  authenticated = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const url = endpoint(config, pathname);
  const headers = {};
  if (authenticated) headers.Authorization = `Bearer ${config.deviceToken}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (raw !== undefined) headers['Content-Type'] = 'image/png';
  if (leaseToken !== undefined) headers['x-image-lease'] = leaseToken;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers,
      body: json !== undefined ? JSON.stringify(json) : raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw runnerError('upstream', 'OmniHub request failed');
  }
  assertSameOriginResponse(config, response);
  if (!response.ok) {
    const code = response.status === 401 ? 'reconnect' : response.status === 409 ? 'conflict' : 'upstream';
    throw runnerError(code, 'OmniHub request failed', response.status);
  }
  if (response.status === 204) return null;
  const text = await boundedResponseText(response);
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw runnerError('upstream', 'Invalid OmniHub response'); }
}

async function preparePairingConfig(configPath) {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw runnerError('configuration', 'Pairing config directory is not private');
  }
  try {
    await lstat(configPath);
    throw runnerError('configuration', 'Local image config already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = resolve(directory, `.pair-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    // Reserve enough writable space before consuming the one-time pairing code.
    await handle.writeFile(Buffer.alloc(8 * 1024));
    await handle.sync();
  } catch {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw runnerError('configuration', 'Pairing config target is not writable');
  }
  return {
    async commit(value) {
      const encoded = Buffer.from(JSON.stringify(value));
      if (encoded.length > 8 * 1024) throw runnerError('configuration', 'Pairing config is too large');
      try {
        await handle.write(encoded, 0, encoded.length, 0);
        await handle.truncate(encoded.length);
        await handle.sync();
        await handle.close();
        handle = null;
        // Publish exclusively: concurrent pairing must not replace credentials.
        await link(temporary, configPath);
        await chmod(configPath, 0o600);
      } catch {
        throw runnerError('configuration', 'Pairing config could not be saved');
      }
    },
    async discard() {
      await handle?.close().catch(() => {});
      handle = null;
      await rm(temporary, { force: true }).catch(() => {});
    },
  };
}

export async function pairLocalImageDevice({ baseUrl, code, configPath, allowTestHttp = false, fetchImpl = globalThis.fetch }) {
  if (!isAbsolute(configPath)) throw runnerError('configuration', 'Local image config path must be absolute');
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(code.trim())) throw runnerError('configuration', 'Invalid pairing code');
  const temporaryConfig = { baseUrl: normalizeBaseUrl(baseUrl, { allowTestHttp }), deviceToken: '', deviceId: '' };
  const prepared = await preparePairingConfig(configPath);
  try {
    const result = await requestLocalImageApi(temporaryConfig, '/api/local-image/exchange', {
      method: 'POST', json: { code: code.trim() }, authenticated: false, fetchImpl,
    });
    if (!result || typeof result.deviceId !== 'string' || typeof result.deviceToken !== 'string' || result.deviceToken.length < 24) {
      throw runnerError('upstream', 'Invalid pairing response');
    }
    const stored = {
      baseUrl: temporaryConfig.baseUrl,
      deviceToken: result.deviceToken,
      deviceId: result.deviceId,
      codexBin: DEFAULT_CODEX_BIN,
      model: DEFAULT_MODEL,
    };
    await prepared.commit(stored);
    const config = await loadLocalImageConfig(configPath, { allowTestHttp });
    // The server activates routing only after this authenticated read proves
    // that the local config was durably stored.
    await requestLocalImageApi(config, '/api/local-image/status', { fetchImpl });
    return { paired: true, deviceId: result.deviceId, expiresAt: result.expiresAt || null };
  } finally {
    await prepared.discard();
  }
}

function childEnvironment(sourceEnv, deviceToken) {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'PATH', 'CODEX_HOME'];
  const result = {};
  for (const key of allowed) {
    const value = sourceEnv[key];
    if (typeof value === 'string' && value && value !== deviceToken) result[key] = value;
  }
  result.PATH ||= '/usr/bin:/bin:/usr/sbin:/sbin';
  result.LANG = 'C';
  result.LC_ALL = 'C';
  result.LC_CTYPE = 'C';
  return result;
}

async function inspectAuthOverrides(env, codexHome) {
  const envKeys = API_OVERRIDE_ENV.filter(key => typeof env[key] === 'string' && env[key].trim());
  if (envKeys.length) throw runnerError('auth', 'API or token environment override is set');
  const configFile = resolve(codexHome, 'config.toml');
  try {
    const configStat = await lstat(configFile);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > MAX_JSON_BYTES) {
      throw runnerError('auth', 'Codex config cannot be safely inspected');
    }
    const text = await readFile(configFile, 'utf8');
    if (CONFIG_OVERRIDE_PATTERN.test(text)) throw runnerError('auth', 'Codex API provider override is configured');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function runProcess(command, args, {
  input = '', cwd, env, timeoutMs = 30_000, spawnImpl = defaultSpawn,
} = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false, timedOut = false, outputTooLarge = false;
    let timer, killTimer;
    const child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      error ? rejectProcess(error) : resolveProcess(result);
    };
    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_PROCESS_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill('SIGTERM');
        return current;
      }
      return Buffer.concat([current, Buffer.from(chunk)]);
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(runnerError('timeout', 'Codex image generation timed out')); }, 5_000);
      killTimer.unref?.();
    }, timeoutMs);
    child.once('error', () => finish(runnerError('configuration', 'Codex CLI is unavailable')));
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('close', code => {
      if (outputTooLarge) finish(runnerError('invalid_result', 'Codex output exceeded the limit'));
      else if (timedOut) finish(runnerError('timeout', 'Codex image generation timed out'));
      else finish(null, { code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

async function codexHomeFromEnv(env) {
  const home = env.CODEX_HOME || (env.HOME ? resolve(env.HOME, '.codex') : '');
  if (!home || !isAbsolute(home)) throw runnerError('configuration', 'CODEX_HOME cannot be resolved');
  return resolve(home);
}

const REQUIRED_EXEC_HELP_FLAGS = [
  '--config',
  '--sandbox',
  '--cd',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--json',
  '--output-last-message',
];

function assertSupportedExecFlags(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || REQUIRED_EXEC_HELP_FLAGS.some(flag => !output.includes(flag))) {
    throw runnerError('configuration', 'Codex CLI does not support the required bounded exec flags');
  }
}

function creditStateFromRateLimits(result) {
  const snapshot = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  const credits = snapshot?.credits;
  const limited = result?.ordinaryUsageAllowed === false
    || snapshot?.spendControlReached === true
    || typeof snapshot?.rateLimitReachedType === 'string';
  const hasBalanceValue = typeof credits?.balance === 'string' && credits.balance.trim() !== '';
  const numericBalance = hasBalanceValue ? Number(credits.balance) : Number.NaN;
  const hasSpendableCredits = credits?.unlimited === true || credits?.hasCredits === true || (Number.isFinite(numericBalance) && numericBalance > 0);
  const noSpendableCredits = credits?.unlimited === false && credits?.hasCredits === false
    && (!hasBalanceValue || (Number.isFinite(numericBalance) && numericBalance <= 0));
  return {
    available: result?.ordinaryUsageAllowed === true && !limited,
    ordinaryUsageAllowed: result?.ordinaryUsageAllowed ?? null,
    creditState: hasSpendableCredits ? 'available' : noSpendableCredits ? 'none' : 'unknown',
    // A preflight snapshot is not an atomic reservation. It cannot guarantee
    // that a long image turn will not cross from included usage into credits.
    enforceableIncludedOnly: result?.ordinaryUsageAllowed === true && !limited && noSpendableCredits,
  };
}

export function readCodexRateLimits({
  codexBin,
  spawnImpl = defaultSpawn,
  env = process.env,
  deviceToken = '',
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolveLimits, rejectLimits) => {
    let settled = false, stdout = '', stderrBytes = 0;
    const cleanEnv = childEnvironment(env, deviceToken);
    const args = [
      'app-server', '--stdio',
      '-c', 'features.shell_tool=false',
      '-c', 'features.plugins=false',
      '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'web_search="disabled"',
    ];
    const child = spawnImpl(codexBin, args, { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill?.('SIGTERM');
      error ? rejectLimits(error) : resolveLimits(value);
    };
    const timer = setTimeout(() => finish(runnerError('quota_unavailable', 'Codex rate limits are unavailable')), timeoutMs);
    child.once('error', () => finish(runnerError('quota_unavailable', 'Codex app-server is unavailable')));
    child.stderr?.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) finish(runnerError('quota_unavailable', 'Codex app-server output exceeded the limit'));
    });
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_PROCESS_OUTPUT_BYTES) {
        finish(runnerError('quota_unavailable', 'Codex app-server output exceeded the limit'));
        return;
      }
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin?.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: { supportsLunaReserve: false, excludeResetCreditDetails: true } })}\n`);
          continue;
        }
        if (message.id === 2) {
          if (message.error || !message.result) finish(runnerError('quota_unavailable', 'Codex rate limits are unavailable'));
          else finish(null, creditStateFromRateLimits(message.result));
          return;
        }
      }
    });
    child.once('close', () => finish(runnerError('quota_unavailable', 'Codex app-server closed before returning rate limits')));
    child.stdin?.on('error', () => finish(runnerError('quota_unavailable', 'Codex app-server input failed')));
    child.stdin?.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'omnihub-local-image', title: 'OmniHub Local Image', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } } })}\n`);
  });
}

export async function checkLocalImageRunner(config, {
  spawnImpl = defaultSpawn,
  env = process.env,
  fetchImpl = globalThis.fetch,
  checkRemote = true,
  readRateLimitsImpl = readCodexRateLimits,
} = {}) {
  const codexHome = await codexHomeFromEnv(env);
  await inspectAuthOverrides(env, codexHome);
  try {
    const binaryStat = await lstat(config.codexBin);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error();
    await access(config.codexBin, fsConstants.X_OK);
  } catch { throw runnerError('configuration', 'Codex CLI binary is unavailable'); }
  const cleanEnv = childEnvironment(env, config.deviceToken);
  const [version, login, execHelp] = await Promise.all([
    runProcess(config.codexBin, ['--version'], { spawnImpl, env: cleanEnv, timeoutMs: 10_000 }),
    runProcess(config.codexBin, ['login', 'status'], { spawnImpl, env: cleanEnv, timeoutMs: 10_000 }),
    runProcess(config.codexBin, ['exec', '--help'], { spawnImpl, env: cleanEnv, timeoutMs: 10_000 }),
  ]);
  if (version.code !== 0) throw runnerError('configuration', 'Codex CLI version check failed');
  assertSupportedExecFlags(execHelp);
  if (login.code !== 0 || !/(?:^|\n)Logged in using ChatGPT(?:\n|$)/.test(`${login.stdout}\n${login.stderr}`)) {
    throw runnerError('auth', 'Codex must be logged in using ChatGPT');
  }
  let quotaRead;
  try {
    quotaRead = await readRateLimitsImpl({ codexBin: config.codexBin, spawnImpl, env, deviceToken: config.deviceToken });
  } catch {
    quotaRead = { available: null, ordinaryUsageAllowed: null, creditState: 'unknown', enforceableIncludedOnly: false };
  }
  let device = null;
  if (checkRemote) {
    const status = await requestLocalImageApi(config, '/api/local-image/status', { fetchImpl });
    if (!status || typeof status !== 'object') throw runnerError('upstream', 'Invalid device status');
    device = { connected: true, deviceId: status.deviceId || config.deviceId };
  }
  return {
    configured: true,
    auth: 'chatgpt',
    cliVersion: version.stdout.trim().slice(0, 128),
    model: config.model,
    device,
    quotaGuard: {
      enforceable: quotaRead.enforceableIncludedOnly === true,
      state: quotaRead.available === false ? 'limit_unavailable'
        : quotaRead.enforceableIncludedOnly ? 'included_usage_without_credits'
          : quotaRead.creditState === 'available' ? 'credits_available_requires_ack' : 'unknown_requires_ack',
      ordinaryUsageAllowed: quotaRead.ordinaryUsageAllowed,
      creditState: quotaRead.creditState,
      requiresLocalAcknowledgement: quotaRead.enforceableIncludedOnly !== true,
    },
    apiFallback: false,
  };
}

function validateTask(task) {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id || task.id.length > 256) {
    throw runnerError('unsupported_task', 'Invalid local image task');
  }
  if (typeof task.leaseToken !== 'string' || task.leaseToken.length < 16 || task.leaseToken.length > 4096) {
    throw runnerError('unsupported_task', 'Invalid local image lease');
  }
  if (typeof task.prompt !== 'string' || !task.prompt.trim() || Buffer.byteLength(task.prompt) > MAX_PROMPT_BYTES) {
    throw runnerError('unsupported_task', 'Invalid image prompt');
  }
  if (!Array.isArray(task.referenceAssetIds) || task.referenceAssetIds.length !== 0) {
    throw runnerError('unsupported_task', 'Reference images are not supported by text-to-image v1');
  }
  const aspectRatio = task.args?.aspectRatio || '1:1';
  if (!ASPECT_RATIOS.has(aspectRatio)) throw runnerError('unsupported_task', 'Unsupported image aspect ratio');
  return { id: task.id, leaseToken: task.leaseToken, prompt: task.prompt.trim(), args: { aspectRatio }, aspectRatio, referenceAssetIds: [] };
}

function imagePrompt(task) {
  const ratioInstruction = task.aspectRatio === 'auto'
    ? 'Choose the aspect ratio that best fits the image request.'
    : `Required aspect ratio: ${task.aspectRatio}.`;
  return `Create exactly one raster image using the built-in image_gen/imagegen tool.\n\nImage request:\n${task.prompt}\n\n${ratioInstruction}\n\nThis is a bounded text-to-image v1 job. Do not use reference images. Do not call shell commands, browsers, web search, MCP, plugins, subagents, SDKs, Python, or external APIs. Do not install anything or change configuration. Do not retry image generation. If the native image tool is unavailable, return NATIVE_IMAGE_TOOL_UNAVAILABLE without using any fallback. After one successful generation, return only a short status and the absolute local PNG path actually produced under CODEX_HOME/generated_images.`;
}

function withinRoot(file, root) {
  const result = relative(root, file);
  return result !== '' && result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result);
}

export async function validateGeneratedPng(file, {
  generatedRoot,
  startedAt,
  before = new Map(),
  now = Date.now(),
} = {}) {
  if (!isAbsolute(file) || !isAbsolute(generatedRoot)) throw runnerError('invalid_result', 'Generated image path must be absolute');
  let fileStat;
  try { fileStat = await lstat(file); } catch { throw runnerError('invalid_result', 'Generated image is missing'); }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < MIN_IMAGE_BYTES || fileStat.size > MAX_IMAGE_BYTES) {
    throw runnerError('invalid_result', 'Generated image is not a bounded regular PNG');
  }
  let canonicalRoot, canonicalFile;
  try { [canonicalRoot, canonicalFile] = await Promise.all([realpath(generatedRoot), realpath(file)]); }
  catch { throw runnerError('invalid_result', 'Generated image path cannot be verified'); }
  if (!withinRoot(canonicalFile, canonicalRoot)) throw runnerError('invalid_result', 'Generated image is outside CODEX_HOME');
  const previous = before.get(canonicalFile) || before.get(resolve(file));
  const changed = !previous || previous.size !== fileStat.size || previous.mtimeMs !== fileStat.mtimeMs;
  if (!changed || fileStat.mtimeMs < startedAt - 2_000 || fileStat.mtimeMs > now + 60_000) {
    throw runnerError('invalid_result', 'Generated image is stale');
  }
  const handle = await open(canonicalFile, 'r');
  let sha256;
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 24 || !header.subarray(0, 8).equals(PNG_MAGIC) || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw runnerError('invalid_result', 'Generated image has invalid PNG magic');
    }
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000) {
      throw runnerError('invalid_result', 'Generated image dimensions are unsafe');
    }
    const trailer = Buffer.alloc(12);
    const trailing = await handle.read(trailer, 0, trailer.length, fileStat.size - trailer.length);
    if (trailing.bytesRead !== trailer.length || trailer.toString('ascii', 4, 8) !== 'IEND') {
      throw runnerError('invalid_result', 'Generated image has no PNG end marker');
    }
    sha256 = createHash('sha256').update(await handle.readFile()).digest('hex');
  } finally { await handle.close(); }
  return { path: canonicalFile, size: fileStat.size, sha256 };
}

function pathsFromFinal(text) {
  return [...new Set([...text.matchAll(/`([^`\r\n]+\.png)`/gi)].map(match => match[1]))];
}

async function snapshotGeneratedSessions(root) {
  let rootStat;
  try { rootStat = await lstat(root); } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw runnerError('invalid_result', 'Generated image root is unavailable');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw runnerError('invalid_result', 'Generated image root is unsafe');
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 4096) throw runnerError('invalid_result', 'Generated image root is too large');
  return new Set(entries.map(entry => entry.name));
}

async function validateLinkedSession(file, generatedRoot, previousSessions) {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(generatedRoot), realpath(file)]);
  const segments = relative(canonicalRoot, canonicalFile).split(sep);
  if (segments.length !== 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw runnerError('invalid_result', 'Generated image is not in a bounded native session');
  }
  if (previousSessions.has(segments[0])) throw runnerError('invalid_result', 'Generated image session predates this task');
  const session = resolve(canonicalRoot, segments[0]);
  const sessionStat = await lstat(session);
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) throw runnerError('invalid_result', 'Generated image session is unsafe');
  const pngs = (await readdir(session, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.png'));
  if (pngs.length !== 1 || resolve(session, pngs[0].name) !== canonicalFile) {
    throw runnerError('invalid_result', 'Native image session did not produce exactly one PNG');
  }
}

function codexArgs(config, jobDir, finalPath) {
  return [
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json',
    '-C', jobDir, '-s', 'workspace-write',
    '-c', `model=${JSON.stringify(config.model)}`,
    '-c', 'model_reasoning_effort="low"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'features.shell_tool=false',
    '-c', 'features.image_generation=true',
    '-c', 'features.plugins=false',
    '-c', 'features.skip_host_skill_discovery=true',
    '-c', 'web_search="disabled"',
    '-o', finalPath, '-',
  ];
}

export async function runNativeImageTask(config, taskInput, {
  spawnImpl = defaultSpawn,
  env = process.env,
  now = Date.now,
  timeoutMs = 5 * 60 * 1000,
  generatedRoot: generatedRootOverride,
} = {}) {
  const task = validateTask(taskInput);
  const codexHome = await codexHomeFromEnv(env);
  await inspectAuthOverrides(env, codexHome);
  const generatedRoot = generatedRootOverride || resolve(codexHome, 'generated_images');
  const previousSessions = await snapshotGeneratedSessions(generatedRoot);
  const jobDir = resolve(config.stateDir, 'jobs', randomUUID());
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const finalPath = resolve(jobDir, 'final.txt');
  const startedAt = now();
  try {
    const result = await runProcess(config.codexBin, codexArgs(config, jobDir, finalPath), {
      input: imagePrompt(task), cwd: jobDir, env: childEnvironment(env, config.deviceToken), timeoutMs, spawnImpl,
    });
    if (result.code !== 0) throw runnerError('invalid_result', 'Codex image generation failed');
    let finalText;
    try {
      const finalStat = await lstat(finalPath);
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.size > MAX_FINAL_BYTES) throw new Error();
      finalText = await readFile(finalPath, 'utf8');
    } catch { throw runnerError('invalid_result', 'Codex did not return a bounded final result'); }
    const candidates = pathsFromFinal(finalText);
    if (candidates.length !== 1) throw runnerError('invalid_result', 'Codex did not return exactly one image path');
    if (task.prompt.includes(candidates[0])) throw runnerError('invalid_result', 'Final image path was echoed from the task prompt');
    const validated = await validateGeneratedPng(candidates[0], { generatedRoot, startedAt, now: now() });
    await validateLinkedSession(validated.path, generatedRoot, previousSessions);
    return validated;
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function withGuard(lockPath, action) {
  const guardPath = `${lockPath}.guard`;
  let guard, guardToken;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        guard = await open(guardPath, 'wx', 0o600);
        guardToken = randomUUID();
        await guard.writeFile(JSON.stringify({ pid: process.pid, token: guardToken, startedAt: Date.now() }));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const guardStat = await lstat(guardPath).catch(() => null);
        const owner = await readPrivateJson(guardPath, { missing: null }).catch(() => null);
        if (!guardStat || guardStat.isSymbolicLink() || processAlive(owner?.pid)) {
          throw runnerError('conflict', 'Local image lock transition is busy');
        }
        const deadPath = `${guardPath}.dead-${randomUUID()}`;
        try { await rename(guardPath, deadPath); } catch { continue; }
        await rm(deadPath, { force: true });
      }
    }
    if (!guard) throw runnerError('conflict', 'Local image lock transition is busy');
    return await action();
  } finally {
    await guard?.close();
    if (guard) {
      const owner = await readPrivateJson(guardPath, { missing: null }).catch(() => null);
      if (owner?.token === guardToken) await rm(guardPath, { force: true });
    }
  }
}

export async function acquireLocalImageLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  return withGuard(lockPath, async () => {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
      return { handle, token, lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingStat = await lstat(lockPath).catch(() => null);
      const owner = await readPrivateJson(lockPath, { missing: null }).catch(() => null);
      if (!existingStat || existingStat.isSymbolicLink() || processAlive(owner?.pid)) throw runnerError('conflict', 'Local image worker is already running');
      const deadPath = `${lockPath}.dead-${randomUUID()}`;
      await rename(lockPath, deadPath);
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
      await rm(deadPath, { force: true });
      return { handle, token, lockPath };
    }
  });
}

export async function releaseLocalImageLock(lock) {
  if (!lock) return;
  await lock.handle?.close();
  await withGuard(lock.lockPath, async () => {
    const owner = await readPrivateJson(lock.lockPath, { missing: null }).catch(() => null);
    if (owner?.token === lock.token) await rm(lock.lockPath, { force: true });
  });
}

function journalPaths(config) {
  return {
    journal: resolve(config.stateDir, 'journal.json'),
    image: resolve(config.stateDir, 'result.png'),
    lock: resolve(config.stateDir, 'worker.lock'),
  };
}

function hasSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function verifyJournalImageHash(journal, image) {
  if (!hasSha256(journal.imageSha256) || image.sha256 !== journal.imageSha256) {
    throw runnerError('invalid_result', 'Staged image hash does not match the durable journal');
  }
}

async function persistResultImage(source, destination, expectedSha256) {
  if (!hasSha256(expectedSha256)) throw runnerError('invalid_result', 'Generated image hash is unavailable');
  await rm(destination, { force: true });
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  const actualSha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
  if (actualSha256 !== expectedSha256) throw runnerError('invalid_result', 'Staged image copy failed integrity verification');
  return { path: destination, sha256: actualSha256 };
}

async function completePending(config, journal, paths, options) {
  const image = await validateGeneratedPng(paths.image, {
    generatedRoot: config.stateDir,
    startedAt: journal.createdAt - 2_000,
    before: new Map(),
    now: options.now(),
  });
  verifyJournalImageHash(journal, image);
  const png = await readFile(image.path);
  await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(journal.taskId)}/complete`, {
    method: 'POST', raw: png, leaseToken: journal.leaseToken, fetchImpl: options.fetchImpl,
  });
  await rm(paths.image, { force: true });
  await rm(paths.journal, { force: true });
  return { processed: 1, completed: 1, recovered: true };
}

async function failPending(config, journal, paths, options) {
  await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(journal.taskId)}/fail`, {
    method: 'POST', json: { leaseToken: journal.leaseToken, code: journal.code }, fetchImpl: options.fetchImpl,
  });
  await rm(paths.image, { force: true });
  await rm(paths.journal, { force: true });
  return { processed: 1, completed: 0, recovered: true };
}

async function blockAfterGeneration(config, journal, paths, options, code = 'invalid_result') {
  let blocked = {
    ...journal,
    state: 'blocked',
    code: ['timeout', 'invalid_result', 'auth', 'configuration', 'interrupted_after_start'].includes(code) ? code : 'invalid_result',
    serverReported: journal.serverReported === true,
  };
  await writePrivateJson(paths.journal, blocked);
  if (!blocked.serverReported) {
    try {
      await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(blocked.taskId)}/fail`, {
        method: 'POST', json: { leaseToken: blocked.leaseToken, code: blocked.code }, fetchImpl: options.fetchImpl,
      });
      blocked = { ...blocked, serverReported: true };
      await writePrivateJson(paths.journal, blocked);
    } catch {
      // Keep the circuit open. A later worker run or explicit reset can retry
      // the bounded needs-review notification without claiming another task.
    }
  }
  return { processed: 1, completed: 0, recovered: true, blocked: true };
}

async function recoverJournal(config, paths, options) {
  const journal = await readPrivateJson(paths.journal, { missing: null });
  if (!journal) return null;
  if (!journal || journal.version !== 1 || typeof journal.taskId !== 'string' || typeof journal.leaseToken !== 'string') {
    throw runnerError('configuration', 'Invalid local image journal');
  }
  if (journal.state === 'complete_pending') return completePending(config, journal, paths, options);
  if (journal.state === 'fail_pending') return failPending(config, journal, paths, options);
  if (journal.state === 'blocked') {
    if (!journal.serverReported) return blockAfterGeneration(config, journal, paths, options, journal.code);
    return { processed: 0, completed: 0, recovered: true, blocked: true };
  }
  if (journal.state === 'result_staging') {
    try {
      const image = await validateGeneratedPng(paths.image, {
        generatedRoot: config.stateDir,
        startedAt: journal.createdAt - 2_000,
        before: new Map(),
        now: options.now(),
      });
      verifyJournalImageHash(journal, image);
      const pending = { ...journal, state: 'complete_pending' };
      await writePrivateJson(paths.journal, pending);
      return completePending(config, pending, paths, options);
    } catch (error) {
      if (error.code !== 'invalid_result') throw error;
      return blockAfterGeneration(config, journal, paths, options, 'interrupted_after_start');
    }
  }
  if (journal.state === 'generating') {
    return blockAfterGeneration(config, journal, paths, options, 'interrupted_after_start');
  }
  if (['start_attempted', 'started'].includes(journal.state)) {
    const pending = { ...journal, state: 'fail_pending', code: 'interrupted_after_start' };
    await writePrivateJson(paths.journal, pending);
    return failPending(config, pending, paths, options);
  }
  if (journal.state === 'claimed') {
    await rm(paths.journal, { force: true });
    return { processed: 0, completed: 0, recovered: true };
  }
  throw runnerError('configuration', 'Unknown local image journal state');
}

async function runOneClaim(config, options) {
  const paths = journalPaths(config);
  const recovered = await recoverJournal(config, paths, options);
  if (recovered?.blocked) throw runnerError('circuit_open', 'Local image worker requires an explicit operator reset');
  if (recovered) return recovered;
  const safety = options.safety;
  if (['limit_unavailable', 'unknown_requires_ack'].includes(safety.quotaGuard.state)) {
    throw runnerError('quota_unavailable', 'Included Codex usage is unavailable or unknown');
  }
  if (safety.quotaGuard.state === 'credits_available_requires_ack' && options.acknowledgeCodexCredits !== true) {
    throw runnerError('quota_unavailable', 'A local Codex credits acknowledgement is required before claiming a task');
  }
  const claim = await requestLocalImageApi(config, '/api/local-image/claim', {
    method: 'POST', json: {}, fetchImpl: options.fetchImpl,
  });
  if (!claim?.task) return { processed: 0, completed: 0, recovered: false };
  let task;
  try { task = validateTask(claim.task); }
  catch (error) {
    if (typeof claim.task?.id === 'string' && typeof claim.task?.leaseToken === 'string') {
      await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(claim.task.id)}/fail`, {
        method: 'POST', json: { leaseToken: claim.task.leaseToken, code: 'unsupported_task' }, fetchImpl: options.fetchImpl,
      });
    }
    throw error;
  }
  const baseJournal = { version: 1, taskId: task.id, leaseToken: task.leaseToken, createdAt: options.now() };
  await writePrivateJson(paths.journal, { ...baseJournal, state: 'claimed' });
  await writePrivateJson(paths.journal, { ...baseJournal, state: 'start_attempted' });
  try {
    await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(task.id)}/start`, {
      method: 'POST', json: { leaseToken: task.leaseToken }, fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    // The request may have reached the server. Keep start_attempted so the
    // next run marks it for review instead of starting or generating again.
    throw error;
  }
  await writePrivateJson(paths.journal, { ...baseJournal, state: 'started' });
  let heartbeat;
  let heartbeatBusy = false;
  try {
    heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(task.id)}/heartbeat`, {
        method: 'POST', json: { leaseToken: task.leaseToken }, fetchImpl: options.fetchImpl,
      }).catch(() => {}).finally(() => { heartbeatBusy = false; });
    }, 30_000);
    heartbeat.unref?.();
    await writePrivateJson(paths.journal, { ...baseJournal, state: 'generating' });
    const result = await runNativeImageTask(config, task, options);
    const staging = { ...baseJournal, state: 'result_staging', imageSha256: result.sha256 };
    await writePrivateJson(paths.journal, staging);
    await persistResultImage(result.path, paths.image, result.sha256);
    const pending = { ...staging, state: 'complete_pending' };
    await writePrivateJson(paths.journal, pending);
    const summary = await completePending(config, pending, paths, options);
    return { ...summary, recovered: false };
  } catch (error) {
    const current = await readPrivateJson(paths.journal, { missing: null });
    if (current?.state === 'complete_pending') throw error;
    if (current?.state === 'result_staging') {
      try {
        const image = await validateGeneratedPng(paths.image, {
          generatedRoot: config.stateDir,
          startedAt: baseJournal.createdAt - 2_000,
          before: new Map(),
          now: options.now(),
        });
        verifyJournalImageHash(current, image);
        await writePrivateJson(paths.journal, { ...current, state: 'complete_pending' });
        throw error;
      } catch (validationError) {
        if (validationError === error) throw error;
        if (validationError.code !== 'invalid_result') throw validationError;
      }
    }
    const code = redactLocalImageError(error);
    const safeCode = ['timeout', 'invalid_result', 'auth', 'configuration'].includes(code) ? code : 'invalid_result';
    await blockAfterGeneration(config, current || baseJournal, paths, options, safeCode);
    throw error;
  } finally { clearInterval(heartbeat); }
}

function workerRuntimeState(safety, acknowledgement) {
  if (safety.quotaGuard.state === 'limit_unavailable') return 'quota_exhausted';
  if (safety.quotaGuard.state === 'unknown_requires_ack') return 'quota_unavailable';
  if (safety.quotaGuard.state === 'credits_available_requires_ack' && acknowledgement !== true) return 'credits_confirmation_required';
  return 'ready';
}

async function reportWorkerState(config, state, fetchImpl) {
  await requestLocalImageApi(config, '/api/local-image/status', {
    method: 'POST', json: { state }, fetchImpl,
  });
}

export async function resetLocalImageCircuitBreaker(config, { fetchImpl = globalThis.fetch } = {}) {
  const paths = journalPaths(config);
  let lock;
  try {
    lock = await acquireLocalImageLock(paths.lock);
    let journal = await readPrivateJson(paths.journal, { missing: null });
    if (!journal || journal.version !== 1 || journal.state !== 'blocked'
      || typeof journal.taskId !== 'string' || typeof journal.leaseToken !== 'string') {
      throw runnerError('configuration', 'No blocked local image task is available to reset');
    }
    if (!journal.serverReported) {
      await requestLocalImageApi(config, `/api/local-image/tasks/${encodeURIComponent(journal.taskId)}/fail`, {
        method: 'POST', json: { leaseToken: journal.leaseToken, code: journal.code || 'invalid_result' }, fetchImpl,
      });
      journal = { ...journal, serverReported: true };
      await writePrivateJson(paths.journal, journal);
    }
    let preservedResult = false;
    try {
      const imageStat = await lstat(paths.image);
      if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size > MAX_IMAGE_BYTES) {
        throw runnerError('configuration', 'Blocked result cannot be safely preserved');
      }
      const preserved = resolve(config.stateDir, `blocked-result-${Date.now()}-${randomUUID()}.png`);
      await rename(paths.image, preserved);
      preservedResult = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rm(paths.journal, { force: true });
    return { reset: true, preservedResult };
  } finally {
    await releaseLocalImageLock(lock);
  }
}

export async function runLocalImageWorker(config, {
  watch = false,
  pollMs = 30_000,
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawn,
  env = process.env,
  now = Date.now,
  sleepImpl = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  generatedRoot,
  acknowledgeCodexCredits = false,
  readRateLimitsImpl = readCodexRateLimits,
} = {}) {
  if (watch !== true && watch !== false) throw runnerError('configuration', 'Invalid watch mode');
  const paths = journalPaths(config);
  let lock;
  try {
    lock = await acquireLocalImageLock(paths.lock);
    do {
      const recoveryOptions = { fetchImpl, spawnImpl, env, now, generatedRoot };
      const recovered = await recoverJournal(config, paths, recoveryOptions);
      if (recovered?.blocked) {
        await reportWorkerState(config, 'worker_error', fetchImpl).catch(() => {});
        if (!watch) throw runnerError('circuit_open', 'Local image worker requires an explicit operator reset');
        await sleepImpl(pollMs);
        continue;
      }
      if (recovered && !watch) return recovered;
      let safety;
      try {
        safety = await checkLocalImageRunner(config, { spawnImpl, env, fetchImpl, readRateLimitsImpl });
        if (safety.auth !== 'chatgpt' || safety.apiFallback !== false) throw runnerError('auth', 'Unsafe Codex authentication route');
      } catch (error) {
        const state = error.code === 'auth' ? 'login_required' : 'worker_error';
        await reportWorkerState(config, state, fetchImpl).catch(() => {});
        if (!watch) throw error;
        await sleepImpl(pollMs);
        continue;
      }
      const runtimeState = workerRuntimeState(safety, acknowledgeCodexCredits);
      await reportWorkerState(config, runtimeState, fetchImpl);
      const options = { ...recoveryOptions, safety, acknowledgeCodexCredits };
      try {
        const result = await runOneClaim(config, options);
        if (!watch) return { ...result, quotaGuard: safety.quotaGuard };
      } catch (error) {
        if (runtimeState === 'ready') await reportWorkerState(config, 'worker_error', fetchImpl).catch(() => {});
        if (!watch) throw error;
      }
      await sleepImpl(pollMs);
    } while (watch);
  } finally { await releaseLocalImageLock(lock); }
}
