import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(process.env.OMNIHUB_ROUTE_APP || new URL('../public/app.jsx', import.meta.url), 'utf8');
const initializer = app.match(/const \[section, setSection(?:, sectionHooks)?\] = useWorkspaceSection\((.+)\);/)[1];
const source = readFileSync(new URL('../public/repository-tab.js', import.meta.url), 'utf8');
const hook = source.slice(source.indexOf('function useWorkspaceSection'));

function openWorkspace(hash, user) {
  const location = { hash };
  const handlers = new Map();
  let state;
  const context = vm.createContext({
    user,
    window: { location, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) },
    React: {
      useRef: initial => ({ current: initial }),
      useState: initial => { state = initial(); return [state, value => { state = value; }]; },
      useEffect: fn => fn(),
    },
  });
  vm.runInContext(hook, context);
  const [initial, setSection] = vm.runInContext(`useWorkspaceSection(${initializer})`, context);
  return { initial, setSection, location, handlers, get state() { return state; } };
}

test('bare and unknown homepage routes open repositories for guests and signed-in users', () => {
  for (const user of [null, { fullAccess: false }, { fullAccess: true }]) {
    for (const hash of ['', '#', '#unknown']) {
      assert.equal(openWorkspace(hash, user).initial, 'repositories');
    }
  }
});

test('explicit module links and navigation remain intact with the repository default', () => {
  for (const user of [null, { fullAccess: true }]) {
    for (const hash of ['#feed', '#inbox', '#repositories?topic=design']) {
      const workspace = openWorkspace(hash, user);
      assert.equal(workspace.initial, hash.slice(1).split('?')[0]);
      assert.equal(workspace.location.hash, hash);
      workspace.setSection('inbox');
      assert.equal(workspace.state, 'inbox');
      assert.equal(workspace.location.hash, '#inbox');
      workspace.location.hash = '';
      workspace.handlers.get('hashchange')();
      assert.equal(workspace.state, 'repositories');
    }
  }
});
