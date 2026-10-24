import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const app = read('app.jsx');

test('curated prompt starts a draft with the real inbox identity, not the derived ID', () => {
  const fn = app.slice(app.indexOf('  function createFromLibraryPrompt('), app.indexOf('\n  }', app.indexOf('  function createFromLibraryPrompt(')) + 4);
  let draft;
  const context = vm.createContext({ openStudio: value => { draft = value; } });
  vm.runInContext(fn, context);
  context.createFromLibraryPrompt({id:'prompt-42', sourceInboxId:42, title:'测试', text:'画猫', media:[], category:'图像生成'});
  assert.equal(draft.sourceType, 'inbox');
  assert.equal(draft.sourceId, 42);
  assert.equal(draft.prompt, '画猫');
  assert.equal(draft.targetModule, 'image');
  context.createFromLibraryPrompt({sourceInboxId:null, text:'视频', category:'视频生成'});
  assert.equal(draft.sourceType, '');
  assert.equal(draft.sourceId, null);
  assert.equal(draft.targetModule, 'seedance');
});

test('prompt detail offers media actions only for media prompts and retains copy', () => {
  const source = read('refinery.jsx');
  assert.match(source, /onCreateMedia && \['图像生成', '视频生成'\]\.includes\(item\.category\)/);
  assert.match(source, /用此提示词生图/);
  assert.match(source, /prompt-detail-actions/);
  assert.match(source, /navigationNotice/);
  assert.match(app, /onCreateMedia=\{canUseFullApp \? createFromLibraryPrompt : undefined\}/);
});

test('personal saving does not grant paid monitoring and empty inbox links to real connections', () => {
  assert.match(app, /props\.canUseMonitoring\?/);
  assert.match(app, /onSaveToInbox=\{personalAccess \? saveFeedToInbox : null\}/);
  assert.match(app, /onOpenConnections=\{\(\) => setModal\('account-settings'\)\}/);
  assert.match(read('inbox.jsx'), /连接我的 X 账号/);
});

test('monitor diagnostics are disclosed without removing the collection status', () => {
  assert.match(app, /<details className="watch-runtime-details"><summary>\{collectionMessage\}/);
  assert.match(app, /24 小时预估用量/);
  assert.match(read('index.html'), /href="\/media-studio\.css"/);
});
