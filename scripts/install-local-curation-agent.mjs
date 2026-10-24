#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || ''; };
const configPath = arg('--config');
const outputPath = arg('--out') || resolve(dirname(configPath || '/tmp/placeholder'), 'com.omnihub.local-curation.plist');
if (!isAbsolute(configPath) || !isAbsolute(outputPath)) { console.error('Usage: node scripts/install-local-curation-agent.mjs --config /absolute/private-config.json [--out /absolute/file.plist] [--install]'); process.exit(2); }
const scriptPath = fileURLToPath(new URL('./run-local-curation.mjs', import.meta.url));
const xml = value => String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.omnihub.local-curation</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(scriptPath)}</string><string>--config</string><string>${xml(resolve(configPath))}</string></array><key>StartInterval</key><integer>7200</integer><key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string></dict></plist>\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, plist, { mode: 0o600 });
if (process.argv.includes('--install')) {
  const destination = resolve(homedir(), 'Library/LaunchAgents/org.omnihub.local-curation.plist');
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(outputPath, destination);
  console.log(JSON.stringify({ staged: outputPath, installed: destination, started: false, note: '本脚本未执行 launchctl；下次登录时 launchd 可能加载并开始按间隔运行。' }));
} else console.log(JSON.stringify({ staged: outputPath, installed: false, started: false }));
