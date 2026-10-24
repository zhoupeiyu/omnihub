import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/inbox.jsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function inboxLinkedSourceId'), source.indexOf('function InboxView'));
function harness(hash = '#inbox?source=42') {
  const handlers = new Map(), opened = [], handled = {current:''};
  const location = {hash};
  let cleanup, error = '';
  const runtime = vm.createContext({URLSearchParams,
    window:{location, addEventListener:(name, fn) => handlers.set(name, fn), removeEventListener:name => handlers.delete(name)},
    useInboxRef:() => handled,
    useInboxState:() => [error, value => {error = value;}],
    useInboxEffect:fn => { cleanup?.(); cleanup = fn(); },
  });
  vm.runInContext(helpers, runtime);
  return {opened, handlers, location, runtime,
    get error() {return error;},
    render(items, active = true, state = 'ready') {runtime.useInboxSourceLink(active, items, state, item => opened.push(item));},
  };
}
const item = {id:42, source:'x', content:'Saved original', media:[{url:'/saved-image.webp'}]};

test('deep links resolve the full saved item including media and work after loading', () => {
  const app = harness();
  app.render([], true, 'loading');
  assert.equal(app.opened.length, 0);
  app.render([item]);
  assert.equal(app.opened[0], item);
  assert.equal(app.error, '');
  app.render([item]);
  assert.equal(app.opened.length, 1);
});

test('hash changes and reentering the workspace open the corresponding source', () => {
  const app = harness();
  const second = {...item, id:43};
  app.render([item,second]);
  app.location.hash = '#inbox?source=43';
  app.handlers.get('hashchange')();
  assert.equal(app.opened.at(-1), second);
  app.render([item,second], false);
  assert.equal(app.handlers.size, 0);
  app.render([item,second]);
  assert.equal(app.opened.length, 3);
  app.location.hash = '#inbox';
  app.handlers.get('hashchange')();
  assert.equal(app.opened.at(-1), null);
});

test('missing, non-X or unauthorized items cannot show the wrong original', () => {
  const app = harness();
  app.render([{id:42,source:'web'}, {...item,id:99}]);
  assert.equal(app.opened.at(-1), null);
  assert.match(app.error, /无法查看/);
  app.render([item]);
  assert.equal(app.opened.at(-1), item);
  assert.equal(app.error, '');
  app.render([]);
  assert.equal(app.opened.at(-1), null);
});

test('only exact positive inbox IDs are accepted', () => {
  const {runtime} = harness();
  assert.equal(runtime.inboxLinkedSourceId('#inbox?source=42'), '42');
  for (const hash of ['#knowledgeLibrary?source=42', '#inbox?source=-1', '#inbox?source=0', '#inbox?source=42oops', '#inbox?source=%22onclick=bad']) {
    assert.equal(runtime.inboxLinkedSourceId(hash), '');
  }
});
