import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireLocalImageLock,
  defaultLocalImageConfigPath,
  loadLocalImageConfig,
  pairLocalImageDevice,
  readCodexRateLimits,
  requestLocalImageApi,
  releaseLocalImageLock,
  resetLocalImageCircuitBreaker,
  runLocalImageWorker,
  runNativeImageTask,
  validateGeneratedPng,
} from '../lib/local-image-runner.js';

const BINARY = process.execPath;
const EXEC_HELP = '--config --sandbox --cd --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --json --output-last-message\n';

function preflightResult(call) {
  if (call.args[0] === '--version') return { stdout: 'codex-cli fixture\n' };
  if (call.args[0] === 'login') return { stdout: 'Logged in using ChatGPT\n' };
  if (call.args[0] === 'exec' && call.args[1] === '--help') return { stdout: EXEC_HELP };
  return null;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function privateConfig(directory, values = {}) {
  const file = path.join(directory, 'config.json');
  await writeFile(file, JSON.stringify({
    baseUrl: 'http://127.0.0.1:4320',
    deviceToken: 'device-secret-token-'.padEnd(32, 'x'),
    deviceId: 'fixture-device',
    codexBin: BINARY,
    model: 'gpt-5.6-sol',
    ...values,
  }), { mode: 0o600 });
  return loadLocalImageConfig(file, { allowTestHttp: true });
}

function response(body, { status = 200, url = 'http://127.0.0.1:4320/api/local-image/status', headers = {} } = {}) {
  return new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function fakeSpawn(handler, calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    const input = [];
    child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
    child.stdin.on('finish', async () => {
      try {
        calls.push({ command, args, options, input: Buffer.concat(input).toString('utf8') });
        const result = await handler({ command, args, options, input: Buffer.concat(input).toString('utf8') });
        if (result?.stdout) child.stdout.write(result.stdout);
        if (result?.stderr) child.stderr.write(result.stderr);
        child.stdout.end(); child.stderr.end(); child.emit('close', result?.code ?? 0);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
}

function png(width = 2, height = 2) {
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8AARMAgYKSAAAMAAgEAff9ZSQAAAABJRU5ErkJggg==', 'base64');
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function makePng(file, data = png()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, data, { mode: 0o600 });
  return file;
}

test('config is private and HTTPS-only outside localhost tests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify({ baseUrl: 'http://example.com', deviceToken: 'x'.repeat(32), deviceId: 'd' }), { mode: 0o600 });
    await assert.rejects(loadLocalImageConfig(file), error => error.code === 'configuration');
    await chmod(file, 0o644);
    await assert.rejects(loadLocalImageConfig(file, { allowTestHttp: true }), error => error.code === 'configuration');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('default config uses a dedicated private-directory target', () => {
  assert.equal(defaultLocalImageConfigPath({ HOME: '/fixture-home' }), '/fixture-home/.codex/omnihub-local-image/config.json');
});

test('pairing prepares a private target before exchange, persists, then activates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  const configPath = path.join(directory, 'private', 'config.json');
  const calls = [];
  try {
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      const privateStat = await lstat(path.dirname(configPath));
      assert.equal(privateStat.mode & 0o077, 0);
      if (String(url).endsWith('/exchange')) {
        await assert.rejects(lstat(configPath), error => error.code === 'ENOENT');
        return response({ deviceId: 'paired-device', deviceToken: 'paired-device-token-'.padEnd(32, 'x') }, { url: String(url) });
      }
      if (String(url).endsWith('/status')) {
        const saved = await loadLocalImageConfig(configPath, { allowTestHttp: true });
        assert.equal(saved.deviceId, 'paired-device');
        assert.equal(options.headers.Authorization, `Bearer ${saved.deviceToken}`);
        return response({ deviceId: saved.deviceId }, { url: String(url) });
      }
      throw new Error('unexpected request');
    };
    const paired = await pairLocalImageDevice({ baseUrl: 'http://127.0.0.1:4320', code: 'ABCD-1234', configPath, allowTestHttp: true, fetchImpl });
    assert.equal(paired.paired, true);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/local-image/exchange', '/api/local-image/status']);
    assert.equal((await lstat(configPath)).mode & 0o077, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pairing never consumes a code when a local config already exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, '{}', { mode: 0o600 });
    let fetched = false;
    await assert.rejects(pairLocalImageDevice({
      baseUrl: 'http://127.0.0.1:4320', code: 'ABCD-1234', configPath, allowTestHttp: true,
      fetchImpl: async () => { fetched = true; throw new Error(); },
    }), error => error.code === 'configuration');
    assert.equal(fetched, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent pairing cannot replace a successfully saved device config', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'omnihub-image-'));
  const configPath=path.join(directory,'config.json');
  let exchanges=0,activations=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const fetchImpl=async(url,options)=>{
    if(String(url).endsWith('/exchange')){
      const id=String(++exchanges);if(exchanges===2)release();await barrier;
      return response({deviceId:id,deviceToken:id.repeat(32)},{url:String(url)});
    }
    activations++;
    const saved=await loadLocalImageConfig(configPath,{allowTestHttp:true});
    assert.equal(options.headers.Authorization,`Bearer ${saved.deviceToken}`);
    return response({deviceId:saved.deviceId},{url:String(url)});
  };
  try{
    const results=await Promise.allSettled([1,2].map(()=>pairLocalImageDevice({baseUrl:'http://127.0.0.1:4320',code:'ABCD-1234',configPath,allowTestHttp:true,fetchImpl})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(activations,1);
    const saved=await loadLocalImageConfig(configPath,{allowTestHttp:true});
    assert.equal(saved.deviceId,results.find(r=>r.status==='fulfilled').value.deviceId);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('redirects never forward the device token to another origin', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return response('', { status: 302, headers: { location: 'https://attacker.example/steal' } });
    };
    await assert.rejects(requestLocalImageApi(config, '/api/local-image/status', { fetchImpl }), error => error.code === 'upstream');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(new URL(calls[0].url).origin, 'http://127.0.0.1:4320');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker lock recovers a guard and lock left by a dead process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  const lockPath = path.join(directory, 'worker.lock');
  try {
    await writeFile(`${lockPath}.guard`, JSON.stringify({ pid: 999_999_999, token: 'dead' }), { mode: 0o600 });
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead' }), { mode: 0o600 });
    const lock = await acquireLocalImageLock(lockPath);
    await releaseLocalImageLock(lock);
    await assert.rejects(lstat(lockPath), error => error.code === 'ENOENT');
    await assert.rejects(lstat(`${lockPath}.guard`), error => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('generated PNG validation rejects symlink, stale, and out-of-root files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  const root = path.join(directory, 'generated_images');
  try {
    const good = await makePng(path.join(root, 'job', 'good.png'));
    const outside = await makePng(path.join(directory, 'outside.png'));
    const link = path.join(root, 'job', 'link.png'); await symlink(outside, link);
    const startedAt = Date.now();
    await assert.rejects(validateGeneratedPng(link, { generatedRoot: root, startedAt, now: Date.now() }), error => error.code === 'invalid_result');
    await assert.rejects(validateGeneratedPng(outside, { generatedRoot: root, startedAt, now: Date.now() }), error => error.code === 'invalid_result');
    await utimes(good, new Date(0), new Date(0));
    await assert.rejects(validateGeneratedPng(good, { generatedRoot: root, startedAt, now: Date.now() }), error => error.code === 'invalid_result');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native runner disables fallback tools and strips API and device credentials from child env', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const generatedRoot = path.join(directory, 'codex', 'generated_images'); const calls = [];
    const generated = path.join(generatedRoot, 'task', 'image.png');
    const spawnImpl = fakeSpawn(async call => {
      const version = call.args[0] === '--version';
      const login = call.args[0] === 'login';
      if (version) return { stdout: 'codex-cli fixture\n' };
      if (login) return { stdout: 'Logged in using ChatGPT\n' };
      await makePng(generated);
      const outputIndex = call.args.indexOf('-o');
      await writeFile(call.args[outputIndex + 1], `ok \`${generated}\`\n`, { mode: 0o600 });
      return { stdout: '{"type":"turn.completed"}\n' };
    }, calls);
    const result = await runNativeImageTask(config, {
      id: 'job-1', leaseToken: 'l'.repeat(24), prompt: 'A blue mug', args: { aspectRatio: '1:1' }, referenceAssetIds: [],
    }, { spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, generatedRoot });
    assert.equal(result.path, await realpath(generated));
    const execution = calls.find(call => call.args[0] === 'exec');
    assert.ok(execution.args.includes('features.shell_tool=false'));
    assert.ok(execution.args.includes('features.plugins=false'));
    assert.ok(execution.args.includes('web_search="disabled"'));
    assert.equal(execution.options.env.OPENAI_API_KEY, undefined);
    assert.equal(execution.options.env.CODEX_API_KEY, undefined);
    assert.ok(!Object.values(execution.options.env).includes(config.deviceToken));
    assert.equal(execution.options.env.LANG, 'C');
    assert.equal(execution.options.env.LC_ALL, 'C');
    assert.match(execution.input, /Do not retry image generation/);
    assert.match(execution.input, /Do not.*external APIs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native result selection ignores fresh PNGs from other concurrent sessions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const generatedRoot = path.join(directory, 'codex', 'generated_images');
    await makePng(path.join(generatedRoot, 'old-session', 'old.png'));
    const ours = path.join(generatedRoot, 'our-session', 'image.png');
    const spawnImpl = fakeSpawn(async call => {
      await makePng(ours);
      await makePng(path.join(generatedRoot, 'other-session', 'other.png'));
      const outputIndex = call.args.indexOf('-o');
      await writeFile(call.args[outputIndex + 1], `\`${ours}\`\n`, { mode: 0o600 });
      return { stdout: '{"type":"turn.completed"}\n' };
    });
    const result = await runNativeImageTask(config, {
      id: 'job-concurrent', leaseToken: 'l'.repeat(24), prompt: 'A blue mug', args: { aspectRatio: '21:9' }, referenceAssetIds: [],
    }, { spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, generatedRoot });
    assert.equal(result.path, await realpath(ours));
    assert.equal(result.sha256, sha256(png()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native result rejects a PNG path echoed from the task prompt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const generatedRoot = path.join(directory, 'generated_images');
    const fakePath = path.join(generatedRoot, 'fake-session', 'fake.png');
    const spawnImpl = fakeSpawn(async call => {
      await makePng(fakePath);
      const outputIndex = call.args.indexOf('-o');
      await writeFile(call.args[outputIndex + 1], `\`${fakePath}\`\n`, { mode: 0o600 });
      return {};
    });
    await assert.rejects(runNativeImageTask(config, {
      id: 'job-echo', leaseToken: 'l'.repeat(24), prompt: `repeat ${fakePath}`, args: { aspectRatio: 'auto' }, referenceAssetIds: [],
    }, { spawnImpl, env: { HOME: directory }, generatedRoot }), error => error.code === 'invalid_result');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('API environment override fails closed before spawning native generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const calls = [];
    await assert.rejects(runNativeImageTask(config, {
      id: 'job-1', leaseToken: 'l'.repeat(24), prompt: 'test', args: { aspectRatio: '1:1' }, referenceAssetIds: [],
    }, { spawnImpl: fakeSpawn(async () => ({}), calls), env: { HOME: directory, OPENAI_API_KEY: 'must-not-run' }, generatedRoot: path.join(directory, 'generated_images') }), error => error.code === 'auth');
    assert.equal(calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('app-server quota preflight reads only the sanitized usage decision', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    let pending = '';
    child.stdin.on('data', chunk => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        if (message.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'fixture' } })}\n`);
        if (message.id === 2) child.stdout.write(`${JSON.stringify({ id: 2, result: {
          ordinaryUsageAllowed: true,
          rateLimits: { credits: { hasCredits: true, unlimited: false, balance: 'private-balance' }, spendControlReached: false, rateLimitReachedType: null },
          rateLimitsByLimitId: null,
        } })}\n`);
      }
    });
    return child;
  };
  const result = await readCodexRateLimits({ codexBin: BINARY, spawnImpl, env: { HOME: '/tmp', OPENAI_API_KEY: 'not-forwarded' }, deviceToken: 'not-forwarded-either' });
  assert.deepEqual(result, { available: true, ordinaryUsageAllowed: true, creditState: 'available', enforceableIncludedOnly: false });
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.ok(!Object.values(calls[0].options.env).includes('not-forwarded-either'));
});

test('one acknowledged run claims, starts, generates, and uploads exactly one raw PNG', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const generatedRoot = path.join(directory, 'codex', 'generated_images');
    const generated = path.join(generatedRoot, 'task', 'image.png'); const apiCalls = []; const spawnCalls = [];
    const fetchImpl = async (url, options) => {
      apiCalls.push({ url: String(url), options });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      if (String(url).endsWith('/claim')) return response({ task: { id: 'job-1', leaseToken: 'l'.repeat(24), prompt: 'A blue mug', args: { aspectRatio: '1:1' }, referenceAssetIds: [] } });
      if (String(url).endsWith('/start')) return response({ ok: true });
      if (String(url).endsWith('/complete')) return response({ job: { id: 'job-1' } });
      throw new Error(`unexpected ${url}`);
    };
    const spawnImpl = fakeSpawn(async call => {
      const preflight = preflightResult(call); if (preflight) return preflight;
      await makePng(generated);
      const outputIndex = call.args.indexOf('-o'); await writeFile(call.args[outputIndex + 1], `\`${generated}\`\n`, { mode: 0o600 });
      return { stdout: '{"type":"turn.completed"}\n' };
    }, spawnCalls);
    const result = await runLocalImageWorker(config, {
      fetchImpl, spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, generatedRoot,
      acknowledgeCodexCredits: true,
      readRateLimitsImpl: async () => ({ available: true, ordinaryUsageAllowed: true, creditState: 'available', enforceableIncludedOnly: false }),
    });
    assert.equal(result.completed, 1);
    assert.equal(spawnCalls.filter(call => call.args[0] === 'exec' && call.args[1] !== '--help').length, 1);
    assert.equal(apiCalls.filter(call => call.url.endsWith('/claim')).length, 1);
    assert.equal(apiCalls.filter(call => call.url.endsWith('/start')).length, 1);
    const runtime = apiCalls.find(call => call.url.endsWith('/status') && call.options.method === 'POST');
    assert.deepEqual(JSON.parse(runtime.options.body), { state: 'ready' });
    const upload = apiCalls.find(call => call.url.endsWith('/complete'));
    assert.ok(Buffer.isBuffer(upload.options.body));
    assert.equal(upload.options.headers['Content-Type'], 'image/png');
    assert.equal(upload.options.headers['x-image-lease'], 'l'.repeat(24));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restart uploads a pending PNG without starting or generating the task again', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const image = path.join(config.stateDir, 'result.png'); await makePng(image);
    const journal = path.join(config.stateDir, 'journal.json');
    await writeFile(journal, JSON.stringify({ version: 1, state: 'complete_pending', taskId: 'job-1', leaseToken: 'l'.repeat(24), imageSha256: sha256(png()), createdAt: Date.now() }), { mode: 0o600 });
    const apiCalls = []; const spawnCalls = [];
    const fetchImpl = async (url, options) => {
      apiCalls.push({ url: String(url), options });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      if (String(url).endsWith('/complete')) return response({ job: { id: 'job-1' } });
      throw new Error('unexpected request');
    };
    const spawnImpl = fakeSpawn(async call => preflightResult(call) || {}, spawnCalls);
    const result = await runLocalImageWorker(config, { fetchImpl, spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, readRateLimitsImpl: async () => { throw new Error('quota read unavailable'); } });
    assert.equal(result.completed, 1);
    assert.equal(apiCalls.filter(call => call.url.endsWith('/complete')).length, 1);
    assert.equal(apiCalls.some(call => call.url.endsWith('/start') || call.url.endsWith('/claim')), false);
    assert.equal(spawnCalls.some(call => call.args[0] === 'exec' && call.args[1] !== '--help'), false);
    await assert.rejects(lstat(journal), error => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restart after an ambiguous start reports needs-review without duplicate start or generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config.stateDir, 'journal.json'), JSON.stringify({
      version: 1, state: 'start_attempted', taskId: 'job-2', leaseToken: 'z'.repeat(24), createdAt: Date.now(),
    }), { mode: 0o600 });
    const apiCalls = []; const spawnCalls = [];
    const fetchImpl = async (url, options) => {
      apiCalls.push({ url: String(url), options });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      if (String(url).endsWith('/fail')) return response({ ok: true });
      throw new Error('unexpected request');
    };
    const spawnImpl = fakeSpawn(async call => preflightResult(call) || {}, spawnCalls);
    const result = await runLocalImageWorker(config, { fetchImpl, spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, readRateLimitsImpl: async () => ({ available: true, ordinaryUsageAllowed: true, creditState: 'none', enforceableIncludedOnly: true }) });
    assert.equal(result.recovered, true);
    assert.equal(apiCalls.filter(call => call.url.endsWith('/fail')).length, 1);
    assert.equal(apiCalls.some(call => call.url.endsWith('/start') || call.url.endsWith('/claim')), false);
    assert.equal(spawnCalls.some(call => call.args[0] === 'exec' && call.args[1] !== '--help'), false);
    const body = JSON.parse(apiCalls.find(call => call.url.endsWith('/fail')).options.body);
    assert.deepEqual(body, { leaseToken: 'z'.repeat(24), code: 'interrupted_after_start' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown quota state blocks before claim even with a credits acknowledgement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const apiCalls = []; const spawnCalls = [];
    const fetchImpl = async (url) => { apiCalls.push(String(url)); return response({ deviceId: 'fixture-device' }); };
    const spawnImpl = fakeSpawn(async call => preflightResult(call) || {}, spawnCalls);
    await assert.rejects(runLocalImageWorker(config, {
      fetchImpl, spawnImpl, env: { HOME: directory, PATH: process.env.PATH },
      acknowledgeCodexCredits: true,
      readRateLimitsImpl: async () => { throw new Error('not exposed'); },
    }), error => error.code === 'quota_unavailable');
    assert.equal(apiCalls.some(url => url.endsWith('/claim')), false);
    assert.ok(apiCalls.filter(url => url.endsWith('/status')).length >= 2);
    assert.equal(spawnCalls.some(call => call.args[0] === 'exec' && call.args[1] !== '--help'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed completion upload preserves the complete outbox and never sends fail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const generatedRoot = path.join(directory, 'codex', 'generated_images');
    const generated = path.join(generatedRoot, 'task', 'image.png'); const apiCalls = [];
    const fetchImpl = async (url, options) => {
      apiCalls.push({ url: String(url), options });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      if (String(url).endsWith('/claim')) return response({ task: { id: 'job-3', leaseToken: 'm'.repeat(24), prompt: 'A blue mug', args: { aspectRatio: 'auto' }, referenceAssetIds: [] } });
      if (String(url).endsWith('/start')) return response({ ok: true });
      if (String(url).endsWith('/complete')) return response({ error: 'revoked' }, { status: 401 });
      if (String(url).endsWith('/fail')) throw new Error('fail must not be sent after a valid image exists');
      throw new Error(`unexpected ${url}`);
    };
    const spawnImpl = fakeSpawn(async call => {
      const preflight = preflightResult(call); if (preflight) return preflight;
      await makePng(generated);
      const outputIndex = call.args.indexOf('-o'); await writeFile(call.args[outputIndex + 1], `\`${generated}\`\n`, { mode: 0o600 });
      return { stdout: '{"type":"turn.completed"}\n' };
    });
    await assert.rejects(runLocalImageWorker(config, {
      fetchImpl, spawnImpl, env: { HOME: directory, PATH: process.env.PATH }, generatedRoot,
      acknowledgeCodexCredits: true,
      readRateLimitsImpl: async () => ({ available: true, ordinaryUsageAllowed: true, creditState: 'available', enforceableIncludedOnly: false }),
    }), error => error.code === 'reconnect');
    assert.equal(apiCalls.some(call => call.url.endsWith('/fail')), false);
    const journal = JSON.parse(await readFile(path.join(config.stateDir, 'journal.json'), 'utf8'));
    assert.equal(journal.state, 'complete_pending');
    assert.ok((await lstat(path.join(config.stateDir, 'result.png'))).isFile());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('post-generation parse failure opens a durable circuit and watch never claims another task', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); const apiCalls = []; const spawnCalls = [];
    const task = { id: 'job-blocked', leaseToken: 'b'.repeat(24), prompt: 'A blue mug', args: { aspectRatio: 'auto' }, referenceAssetIds: [] };
    const fetchImpl = async (url, options) => {
      apiCalls.push({ url: String(url), options });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      if (String(url).endsWith('/claim')) return response({ task });
      if (String(url).endsWith('/start') || String(url).endsWith('/fail')) return response({ ok: true });
      throw new Error(`unexpected ${url}`);
    };
    const spawnImpl = fakeSpawn(async call => {
      const preflight = preflightResult(call); if (preflight) return preflight;
      const outputIndex = call.args.indexOf('-o');
      await writeFile(call.args[outputIndex + 1], 'no native image path\n', { mode: 0o600 });
      return { stdout: '{"type":"turn.completed"}\n' };
    }, spawnCalls);
    let sleeps = 0;
    await assert.rejects(runLocalImageWorker(config, {
      watch: true, pollMs: 1, fetchImpl, spawnImpl, env: { HOME: directory }, acknowledgeCodexCredits: true,
      readRateLimitsImpl: async () => ({ available: true, ordinaryUsageAllowed: true, creditState: 'available', enforceableIncludedOnly: false }),
      sleepImpl: async () => { sleeps += 1; if (sleeps > 1) throw new Error('stop-watch'); },
    }), /stop-watch/);
    assert.equal(apiCalls.filter(call => call.url.endsWith('/claim')).length, 1);
    assert.equal(spawnCalls.filter(call => call.args[0] === 'exec' && call.args[1] !== '--help').length, 1);
    const journalPath = path.join(config.stateDir, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.state, 'blocked');
    assert.equal(journal.serverReported, true);
    const reset = await resetLocalImageCircuitBreaker(config, { fetchImpl });
    assert.deepEqual(reset, { reset: true, preservedResult: false });
    await assert.rejects(lstat(journalPath), error => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery hash mismatch keeps the staged PNG and opens the circuit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnihub-image-'));
  try {
    const config = await privateConfig(directory); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const imagePath = path.join(config.stateDir, 'result.png'); await makePng(imagePath);
    const journalPath = path.join(config.stateDir, 'journal.json');
    await writeFile(journalPath, JSON.stringify({
      version: 1, state: 'result_staging', taskId: 'job-hash', leaseToken: 'h'.repeat(24), imageSha256: '0'.repeat(64), createdAt: Date.now(),
    }), { mode: 0o600 });
    const apiCalls = [];
    const fetchImpl = async (url) => {
      apiCalls.push(String(url));
      if (String(url).endsWith('/fail')) return response({ ok: true });
      if (String(url).endsWith('/status')) return response({ deviceId: 'fixture-device' });
      throw new Error(`unexpected ${url}`);
    };
    await assert.rejects(runLocalImageWorker(config, { fetchImpl, env: { HOME: directory } }), error => error.code === 'circuit_open');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.state, 'blocked');
    assert.ok((await lstat(imagePath)).isFile());
    assert.equal(apiCalls.some(url => url.endsWith('/complete') || url.endsWith('/claim')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
