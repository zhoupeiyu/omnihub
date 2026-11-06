import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

const read=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');

test('administrator access editor uses revisioned, native checkbox grants',()=>{
  const source=read('public/user-access.jsx');
  assert.doesNotThrow(()=>transformSync(source,{loader:'jsx',target:'es2020'}));
  assert.match(source,/request\('\/api\/admin\/users'\)/);
  assert.match(source,/\/api\/admin\/users\/'.*'\/access/);
  assert.match(source,/revision:draft\.revision/);
  assert.match(source,/type="checkbox"/);
  assert.match(source,/搜索注册用户/);
  assert.match(source,/总管理员 · 全部网盘分类与工具/);
  assert.match(source,/权限已保存，对方刷新后生效/);
  assert.match(source,/确定放弃并切换用户吗？/);
  assert.match(source,/确定放弃并刷新用户列表吗？/);
});

test('settings exposes user access only to an administrator and recognizes its route',()=>{
  const settings=read('public/settings.jsx'), workspace=read('public/workspace-data.js');
  assert.match(settings,/id:'users', label:'用户与权限'/);
  assert.match(settings,/item\.id !== 'users' \|\| isAdmin/);
  assert.match(settings,/routed\.category === 'users' && !isAdmin/);
  assert.match(settings,/<UserAccessSettings active=\{tab === 'users'\}/);
  assert.match(workspace,/SETTINGS_CATEGORIES = \['sync', 'ai', 'devices', 'users', 'appearance'\]/);
});

test('shared drive and tools are individually gated without granting full administration',()=>{
  const app=read('public/app.jsx'), drive=read('public/drive-library.jsx'), tools=read('public/video-tools.jsx');
  assert.match(app,/user\?\.driveAccess/);
  assert.match(app,/driveReadOnly=\{!canUseFullApp\}/);
  assert.match(drive,/!readOnly&&<details className="drive-manage">/);
  assert.match(tools,/toolAccess\.has\('media'\)/);
  assert.match(tools,/toolAccess\.has\('markdown'\)/);
  assert.match(tools,/toolAccess\.has\('pdf'\)/);
  assert.match(tools,/route === 'ai-art'.*ToolAccessDenied/);
  assert.match(tools,/function ToolAccessDenied/);
});
