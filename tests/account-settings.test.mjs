import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('account connections keep X, local curation, and ChatGPT independently readable', () => {
  const source = read('public/account-settings.jsx');
  assert.match(source, /const \[xAccount, setXAccount\]/);
  assert.match(source, /const \[connections, setConnections\]/);
  assert.match(source, /void loadX\(controller\.signal\); void loadConnections\(controller\.signal\)/);
  assert.doesNotMatch(source, /Promise\.all\(/);
  assert.match(source, /重试 X 连接/);
  assert.match(source, /重试个人连接/);
  assert.match(source, /account-x-section/);
  assert.match(source, /local-curation-section/);
  assert.match(source, /chatgpt-section/);
  assert.doesNotMatch(source, /<h2[^>]*>账号与连接/);
  assert.match(source, /xAccount\.connected \? <div className="connection-subsection"/);
  assert.match(source, /连接后可设置每 2 小时同步，已有收藏保留。/);
  assert.match(source, /原始收藏、未发布媒体与草稿/);
});

test('local curation uses the existing owner-only endpoints without retaining the device secret', () => {
  const source = read('public/account-settings.jsx');
  assert.match(source, /api\('\/api\/local-curation\/settings', \{ method: 'POST', body: \{ enabled, model \} \}\)/);
  assert.match(source, /api\('\/api\/local-curation\/devices', \{ method: 'POST', body: \{ label \} \}\)/);
  assert.match(source, /api\(`\/api\/local-curation\/devices\/\$\{encodeURIComponent\(id\)\}\/revoke`, \{ method: 'POST', body: \{\} \}\)/);
  assert.match(source, /downloadDeviceConfig\(pair, savedModel\)/);
  assert.match(source, /transport: 'claude-api'/);
  assert.match(source, /model !== savedModel/);
  assert.match(source, /localModel\.trim\(\) === savedLocalModel/);
  assert.match(source, /URL\.revokeObjectURL\(url\), 1_500/);
  assert.doesNotMatch(source, /(?:window\.)?localStorage\s*[.(]/);
  assert.match(source, /never rendered, stored in the URL, localStorage, or component state/);
  assert.match(source, /网页不会自动安装或启动它/);
  assert.match(source, /本机运行，并调用这台电脑已有的 Claude API/);
  assert.match(source, /API 密钥不上传网站，也不使用 ChatGPT 网页额度/);
  assert.match(source, /模型名必须与本机 Claude API 配置一致/);
  assert.match(source, /placeholder="例如 claude-opus-5-5"/);
});

test('account connection styles retain the shared drawer shell and provide compact device rows', () => {
  const css = read('public/detail-drawer.css');
  assert.match(css, /\.detail-drawer \{[^}]*width:min\(680px,100vw\)/);
  assert.match(css, /\.connection-section \{/);
  assert.match(css, /\.device-row \{/);
  assert.match(css, /\.local-curation-help/);
});
