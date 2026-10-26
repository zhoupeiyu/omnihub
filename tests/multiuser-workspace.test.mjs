import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');

test('catalogue scope is URL-bound and applies only to public derivative libraries', () => {
  const api = read('public/api.js');
  assert.match(api, /OMNIHUB_CATALOGUE_PATHS/);
  assert.match(api, /'\/api\/repositories', '\/api\/knowledge-library', '\/api\/prompt-library'/);
  assert.match(api, /scope=\$\{encodeURIComponent\(omnihubCatalogueScope\(\)\)\}/);
  assert.match(api, /pathname\.startsWith\('\/api\/repositories\/'\)/);
  assert.doesNotMatch(api, /'\/api\/inbox'/);
});

test('signed-in workspace exposes own inbox and connections without widening admin tools', () => {
  const app = read('public/app.jsx');
  const nav = read('public/components.jsx');
  const account = read('public/account-settings.jsx');
  assert.match(app, /const personalAccess = Boolean\(user && user\.personalAccess !== false\)/);
  assert.match(app, /<CatalogueSpaceSwitch user=\{user\}/);
  assert.match(app, /登录后查看你的收藏/);
  assert.match(nav, /hasPersonalSpace/);
  assert.match(nav, /账号与设置/);
  assert.match(nav, /const canUseFullApp = Boolean\(user && user\.fullAccess\)/);
  assert.match(account, /账号与同步/);
  assert.doesNotMatch(account, /归属 zane/);
  assert.match(account, /localCuration\.devices\.filter/);
  assert.match(account, /个人连接状态暂时无法读取/);
});

test('ordinary inbox actions do not expose publish, remote analysis, or media creation', () => {
  const app = read('public/app.jsx');
  const inbox = read('public/inbox.jsx');
  assert.match(app, /onCapture=\{personalAccess \? captureInbox : undefined\}/);
  assert.match(app, /onAnalyze=\{canUseFullApp \? analyzeInbox : undefined\}/);
  assert.match(app, /onDispatch=\{canUseFullApp \? dispatchInbox : undefined\}/);
  assert.match(app, /onCreateMedia=\{canUseFullApp \? createFromInbox : undefined\}/);
  assert.match(inbox, /!readOnly && onCreateMedia &&/);
  assert.match(inbox, /!readOnly && onAnalyze &&/);
  assert.match(inbox, /!readOnly && onDispatch &&/);
  assert.match(inbox, /!readOnly && onIgnore && \(!onDispatch \|\|/);
  assert.match(app, /method: "POST", body: \{\}/);
  assert.match(inbox, /仅自己可见/);
});

test('ignore writes an explicit JSON payload for the personal write guard', async () => {
  let request;
  const context = vm.createContext({
    Event,
    fetch: async (path, options) => {
      request = {path, options};
      return {ok:true, status:200, json:async()=>({ok:true})};
    },
    window:{dispatchEvent(){}},
  });
  vm.runInContext(read('public/api.js'), context);
  await context.api('/api/inbox/7/ignore', {method:'POST', body:{}});
  assert.equal(request.path, '/api/inbox/7/ignore');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.body, '{}');
});

test('logout and anonymous personal URLs return to public catalogue scope', () => {
  const app = read('public/app.jsx');
  assert.match(app, /!personalAccess && catalogueScope === 'mine'/);
  assert.match(app, /params\.set\('space', 'public'\)/);
  assert.match(app, /if \(!personalAccess \|\| catalogueScope === 'mine'\) return/);
  assert.match(app, /if \(params\.has\('space'\)\) return/);
  assert.match(app, /params\.set\('space', 'mine'\)/);
});
