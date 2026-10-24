import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const run = (command, args, env = {}) => new Promise(resolve => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('close', code => resolve({ code, output }));
});

test('launchd generator stages a fixed two-hour agent and never starts it by default', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omnihub-local-agent-'));
  try {
    const config = path.join(dir, 'config.json'); const plist = path.join(dir, 'agent.plist');
    await writeFile(config, JSON.stringify({}), { mode: 0o600 });
    const result = await run(process.execPath, ['scripts/install-local-curation-agent.mjs', '--config', config, '--out', plist]);
    assert.equal(result.code, 0); assert.match(result.output, /"started":false/);
    const rendered = await readFile(plist, 'utf8');
    assert.match(rendered, /<integer>7200<\/integer>/); assert.match(rendered, /run-local-curation\.mjs/); assert.doesNotMatch(rendered, /\/bin\/sh/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker checks the no-tools boundary before it claims a server task', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omnihub-local-worker-'));
  let claims = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${'b'.repeat(32)}`);
    if (req.url === '/api/local-curation/claim') {
      claims += 1;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ task: null }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const fakeCodex = path.join(dir, 'codex');
  await writeFile(fakeCodex, '#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==="exec"&&a[1]==="--help")process.stdout.write("Usage: codex exec\\n");else process.stdout.write("logged in\\n");\n', { mode: 0o700 });
  const outbox = path.join(dir, 'outbox.json'); const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: 'b'.repeat(32), model: 'fixture', codexPath: fakeCodex, outboxPath: outbox }), { mode: 0o600 });
  const args = ['scripts/run-local-curation.mjs', '--config', config, '--max-tasks', '1'];
  const result = await run(process.execPath, args, { NODE_ENV: 'test' }); assert.equal(result.code, 1);
  assert.equal(claims, 0, 'disabled capability must not reserve a task');
});

test('permanent outbox 4xx is isolated before capability checking', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omnihub-local-worker-')); let completions = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/local-curation/tasks/42/complete') { completions += 1; res.writeHead(422); return res.end('expired'); }
    res.writeHead(500); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const fakeCodex = path.join(dir, 'codex'); await writeFile(fakeCodex, '#!/usr/bin/env node\nprocess.stdout.write("Usage: codex exec\\n");\n', { mode: 0o700 });
  const outbox = path.join(dir, 'outbox.json'); await writeFile(outbox, JSON.stringify([{ id: '42', kind: 'complete', body: { leaseToken: 'secret', requestKey: 'request', value: {}, model: 'fixture' } }]), { mode: 0o600 });
  const config = path.join(dir, 'config.json'); await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: 'b'.repeat(32), model: 'fixture', codexPath: fakeCodex, outboxPath: outbox }), { mode: 0o600 });
  const result = await run(process.execPath, ['scripts/run-local-curation.mjs', '--config', config], { NODE_ENV: 'test' });
  assert.equal(result.code, 1); assert.equal(completions, 1); assert.deepEqual(JSON.parse(await readFile(outbox, 'utf8')), []);
});

test('worker redacts malformed configuration and local connection failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omnihub-local-worker-'));
  try {
    const badConfig = path.join(dir, 'bad-config.json');
    await writeFile(badConfig, '{"deviceToken":"private-device-token"', { mode: 0o600 });
    const malformed = await run(process.execPath, ['scripts/run-local-curation.mjs', '--config', badConfig], { NODE_ENV: 'test' });
    assert.equal(malformed.code, 1);
    assert.deepEqual(JSON.parse(malformed.output.trim()), { ok: false, code: 'configuration' });
    assert.doesNotMatch(malformed.output, /private-device-token|SyntaxError/);

    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const fakeCodex = path.join(dir, 'codex');
    await writeFile(fakeCodex, '#!/usr/bin/env node\nprocess.stdout.write("Usage: codex exec\\n");\n', { mode: 0o700 });
    const outbox = path.join(dir, 'outbox.json');
    await writeFile(outbox, JSON.stringify([{ id: '1', kind: 'complete', body: { leaseToken: 'private-lease-token', requestKey: 'request', value: {}, model: 'fixture' } }]), { mode: 0o600 });
    const config = path.join(dir, 'connection-config.json');
    await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, deviceToken: 'private-device-token'.padEnd(32, 'x'), model: 'fixture', codexPath: fakeCodex, outboxPath: outbox }), { mode: 0o600 });
    const unavailable = await run(process.execPath, ['scripts/run-local-curation.mjs', '--config', config], { NODE_ENV: 'test' });
    assert.equal(unavailable.code, 1);
    assert.deepEqual(JSON.parse(unavailable.output.trim()), { ok: false, code: 'upstream' });
    assert.doesNotMatch(unavailable.output, /private-(?:device|lease)-token|127\.0\.0\.1|Error:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
