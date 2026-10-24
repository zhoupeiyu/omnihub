#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { isAbsolute } from 'node:path';
import {
  checkLocalImageRunner,
  defaultLocalImageConfigPath,
  loadLocalImageConfig,
  pairLocalImageDevice,
  redactLocalImageError,
  resetLocalImageCircuitBreaker,
  runLocalImageWorker,
} from '../lib/local-image-runner.js';

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

let configPath = valueAfter('--config');
try { configPath ||= defaultLocalImageConfigPath(); }
catch {
  console.error(JSON.stringify({ ok: false, code: 'configuration' }));
  process.exit(2);
}
const baseUrl = valueAfter('--base-url');
const pair = process.argv.includes('--pair');
const check = process.argv.includes('--check');
const watch = process.argv.includes('--watch');
const resetBlocked = process.argv.includes('--reset-blocked');
const acknowledgeCodexCredits = process.argv.includes('--acknowledge-codex-credits');
const allowed = new Set(['--config', '--base-url', '--pair', '--check', '--watch', '--reset-blocked', '--acknowledge-codex-credits']);
const invalid = process.argv.slice(2).some((value, index, all) => value.startsWith('--') && !allowed.has(value)
  || (!value.startsWith('--') && (index === 0 || !['--config', '--base-url'].includes(all[index - 1]))));

if (!isAbsolute(configPath) || invalid
  || (pair && (!baseUrl || check || watch || resetBlocked || acknowledgeCodexCredits))
  || (!pair && baseUrl)
  || (check && (watch || resetBlocked || acknowledgeCodexCredits))
  || (resetBlocked && (watch || acknowledgeCodexCredits))) {
  console.error(JSON.stringify({ ok: false, code: 'usage', usage: 'node scripts/run-local-image.mjs [--config /absolute/private.json] [--pair --base-url https://host | --check | --watch | --reset-blocked] [--acknowledge-codex-credits]' }));
  process.exit(2);
}

async function readPairingCode() {
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  try { return (await readline.question(process.stdin.isTTY ? 'Pairing code: ' : '')).trim(); }
  finally { readline.close(); }
}

async function main() {
  const allowTestHttp = process.env.NODE_ENV === 'test';
  if (pair) {
    const result = await pairLocalImageDevice({ baseUrl, code: await readPairingCode(), configPath, allowTestHttp });
    console.log(JSON.stringify({ ok: true, paired: result.paired, deviceId: result.deviceId, expiresAt: result.expiresAt }));
    return;
  }
  const config = await loadLocalImageConfig(configPath, { allowTestHttp });
  if (resetBlocked) {
    const result = await resetLocalImageCircuitBreaker(config);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (check) {
    const status = await checkLocalImageRunner(config);
    console.log(JSON.stringify({ ok: true, ...status }));
    return;
  }
  const result = await runLocalImageWorker(config, { watch, acknowledgeCodexCredits });
  console.log(JSON.stringify({ ok: true, ...result }));
}

await main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: redactLocalImageError(error) }));
  process.exitCode = 1;
});
