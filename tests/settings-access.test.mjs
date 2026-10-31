import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const context = vm.createContext({URLSearchParams});
vm.runInContext(read('workspace-data.js'), context);
const routes = read('repository-tab.js');
vm.runInContext(routes.slice(routes.indexOf('function workspaceHashName'), routes.indexOf('// Central mapping')), context);

test('guest settings always resolve to local appearance, including private deep links', () => {
  for (const hash of ['#settings', '#settings?category=appearance', '#settings?category=sync', '#settings?category=ai&aiTab=media', '#settings?category=devices', '#settings?category=automation', '#settings?category=unknown']) {
    const route = context.settingsRouteFor(hash, false);
    assert.equal(route.category, 'appearance', hash);
    assert.equal(route.aiTab, 'chat', hash);
  }
});

test('signed-in settings keep their existing categories and AI subtab', () => {
  for (const category of ['sync', 'ai', 'devices', 'appearance']) {
    assert.equal(context.settingsRouteFor(`#settings?category=${category}`, true).category, category);
  }
  assert.equal(context.settingsRouteFor('#settings?category=ai&aiTab=media', true).aiTab, 'media');
  assert.equal(context.settingsRouteFor('#settings', true).category, 'sync');
});

test('canonical guest settings URL drops account callback parameters', () => {
  const hash = '#settings?space=public&category=ai&aiTab=media&result=connected';
  const route = context.settingsRouteFor(hash, false);
  assert.equal(context.settingsHashFor(hash, route.category), '#settings?space=public&category=appearance');
});
