import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read = name => readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const context = vm.createContext({AbortController});
vm.runInContext(read('workspace-data.js'),context);
const requests = (section,full=false) => JSON.parse(JSON.stringify(context.workspaceDataRequests(section,full)));
test('each module loads only its collections; repository owns its single request',()=>{
  for(const full of [false,true]) {
    for(const section of ['repositories','feed','chat','tools']) assert.deepEqual(requests(section,full),[]);
    assert.deepEqual(requests('knowledgeLibrary',full),[['knowledgeLibrary','/api/knowledge-library']]);
    assert.deepEqual(requests('promptLibrary',full),[['promptLibrary','/api/prompt-library']]);
  }
  assert.deepEqual(requests('inbox'),[]);
  assert.deepEqual(requests('inbox',true),[['inbox','/api/inbox']]);
  assert.deepEqual(requests('assets'),[]); assert.deepEqual(requests('studio'),[]);
  assert.equal(requests('assets',true).length,4); assert.equal(requests('studio',true).length,2);
});
test('workspace loading is abortable, account-scoped and does not persist API data',()=>{
  const source=read('app.jsx');
  assert.doesNotMatch(source,/api\("\/api\/repositories"\)/);
  assert.match(source,/workspaceDataRequests\(section, canUseFullApp\)/);
  assert.match(read('workspace-data.js'),/entry.pending\?\.controller.abort\(\)/);
  assert.match(source,/<Workspace key=\{user \? `\$\{user.id\}:\$\{Boolean\(user.fullAccess\)\}` : "guest"\}/);
  assert.match(source,/\(\) => dataCache.dispose\(\)/);
  assert.match(source,/onRepositoriesLoaded=\{/);
  assert.match(read('api.js'),/signal: options.signal/);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
function harness(request = async () => []) {
  let clock = 1000;
  const events = [], calls = [];
  const cache = context.createWorkspaceDataCache({
    request: (...args) => { calls.push(args); return request(...args); },
    fullAccess: true, now: () => clock, ttl: 60000,
    onChange: (section, state, rows) => events.push({section, ...state, rows}),
  });
  return {cache, events, calls, advance: value => {clock += value;}};
}

test('revisiting either loaded section uses its own fresh data, including empty lists', async () => {
  const {cache, calls, events} = harness();
  await cache.load('promptLibrary');
  await cache.load('knowledgeLibrary');
  await cache.load('promptLibrary');
  await cache.load('knowledgeLibrary');
  assert.equal(calls.length, 2);
  assert.equal(events.length, 4);
  assert.ok(events.filter(e => e.status === 'success').every(e => e.hasData));
});

test('rapid switching deduplicates requests and lets the previous tab finish', async () => {
  const response = deferred();
  const {cache, calls, events} = harness(route => route.includes('prompt-library') ? response.promise : Promise.resolve([]));
  const first = cache.load('promptLibrary');
  await cache.load('knowledgeLibrary');
  assert.equal(cache.load('promptLibrary'), first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].signal.aborted, false);
  response.resolve([{id: 'prompt-1'}]);
  await first;
  assert.equal(events.at(-1).section, 'promptLibrary');
  assert.equal(events.at(-1).hasData, true);
});

test('stale refresh and refresh failure never clear successfully loaded content', async () => {
  let fail = false;
  const {cache, calls, events, advance} = harness(async () => {
    if (fail) throw new Error('offline');
    return [{id: 'saved'}];
  });
  await cache.load('promptLibrary');
  fail = true;
  advance(60001);
  await cache.load('promptLibrary');
  assert.equal(calls.length, 2);
  assert.equal(events.at(-2).status, 'refreshing');
  assert.equal(events.at(-2).hasData, true);
  assert.equal(events.at(-1).status, 'error');
  assert.equal(events.at(-1).hasData, true);
  assert.equal(events.at(-1).rows, undefined);
  fail = false;
  await cache.load('promptLibrary');
  assert.equal(events.at(-1).status, 'success');
});

test('classification invalidation retains data and rejects late pre-edit responses', async () => {
  const old = deferred();
  let attempt = 0;
  const {cache, calls, events} = harness(() => ++attempt === 2 ? old.promise : Promise.resolve([{id:`result-${attempt}`}])) ;
  await cache.load('promptLibrary');
  cache.invalidate();
  const stale = cache.load('promptLibrary');
  cache.invalidate();
  assert.equal(calls[1][1].signal.aborted, true);
  assert.equal(events.at(-1).hasData, true);
  await cache.load('promptLibrary');
  old.resolve([{id: 'wrong-old-result'}]);
  await stale;
  assert.equal(events.at(-1).rows[0][1][0].id, 'result-3');
});

test('initial failures and malformed responses remain retryable, without publishing partial collections', async () => {
  let valid = false;
  const {cache, events} = harness(async route => valid || route !== '/api/media/assets' ? [] : {error: 'not an array'});
  await cache.load('assets');
  assert.equal(events.at(-1).status, 'error');
  assert.equal(events.at(-1).hasData, false);
  assert.equal(events.some(e => e.rows), false);
  valid = true;
  await cache.load('assets');
  assert.equal(events.at(-1).rows.length, 4);
});

test('disposing the account aborts all requests and prevents late results or reuse', async () => {
  const response = deferred();
  const {cache, calls, events} = harness(() => response.promise);
  const pending = cache.load('inbox');
  cache.dispose();
  const count = events.length;
  assert.equal(calls[0][1].signal.aborted, true);
  response.resolve([{id: 'private'}]);
  await pending;
  cache.invalidate();
  await cache.load('inbox');
  assert.equal(events.length, count);
  assert.equal(calls.length, 1);
  const guestEvents = [];
  const guest = context.createWorkspaceDataCache({request: async route => {
    assert.fail(`guest must not request private originals: ${route}`);
  }, fullAccess:false, onChange: (...event) => guestEvents.push(event)});
  await guest.load('inbox');
  assert.equal(guestEvents.length, 0);
});

test('core panels retain their own queries and portals are gated by visibility', () => {
  const source = read('app.jsx');
  for (const section of ['promptLibrary', 'knowledgeLibrary', 'inbox', 'feed']) {
    assert.ok(source.includes(`name="${section}"`));
    assert.ok(source.includes(`queryFor('${section}')`));
  }
  assert.match(source,/hidden=\{!active\} inert=/);
  assert.match(source,/media => media.pause\(\)/);
  assert.match(read('refinery.jsx'),/active && selected && <PromptDetail/);
  assert.match(read('inbox.jsx'),/active && mediaPreview && ReactDOM.createPortal/);
});

test('slower hidden sections cannot overwrite a newer shared media collection', async () => {
  const oldMedia = deferred();
  let mediaReads = 0;
  const {cache, events} = harness(route => {
    if (route === '/api/media/assets') return ++mediaReads === 1 ? oldMedia.promise : Promise.resolve([{id: 'new-media'}]);
    return Promise.resolve([]);
  });
  const assets = cache.load('assets');
  await cache.load('studio');
  oldMedia.resolve([{id: 'old-media'}]);
  await assets;
  const published = Object.fromEntries(events.flatMap(event => event.rows || []));
  assert.equal(published.mediaAssets[0].id, 'new-media');
  assert.equal(events.at(-1).hasData, true);
  assert.ok(events.at(-1).rows.some(([key]) => key === 'favorites'));
});

test('manual media reads supersede older tab responses and cannot survive edits or logout', async () => {
  const oldMedia = deferred();
  const {cache, events} = harness(() => oldMedia.promise);
  const pending = cache.load('studio');
  cache.applyCollections([['mediaAssets', [{id:'new'}]]], cache.beginUpdate());
  oldMedia.resolve([{id:'old'}]);
  await pending;
  const published = Object.fromEntries(events.flatMap(event => event.rows || []));
  assert.equal(published.mediaAssets[0].id, 'new');
  const stalePoll = cache.beginUpdate();
  cache.invalidate();
  let count = events.length;
  cache.applyCollections([['mediaAssets', [{id:'before-edit'}]]], stalePoll);
  assert.equal(events.length, count);
  const beforeLogout = cache.beginUpdate();
  cache.dispose();
  cache.applyCollections([['mediaAssets', [{id:'private'}]]], beforeLogout);
  assert.equal(events.length, count);
});

test('successful collection writes invalidate before caller state updates; failed writes and reads do not', async () => {
  let ok = true;
  const events = [];
  const apiContext = vm.createContext({Event,
    fetch: async () => ({ok,status:ok?200:500,json:async()=>({id:1})}),
    window:{dispatchEvent:event=>events.push(event.type)},
  });
  vm.runInContext(read('api.js'), apiContext);
  for (const [path, method] of [['/api/inbox/1/dispatch','POST'],['/api/inbox/import/x','POST'],['/api/prompts/1','DELETE'],['/api/media/assets/1','PUT']]) {
    await apiContext.api(path,{method}).then(()=>events.push('local-update'));
  }
  assert.deepEqual(events,Array.from({length:4},()=>['omnihub:collection-updated','local-update']).flat());
  const count = events.length;
  await apiContext.api('/api/inbox');
  await apiContext.api('/api/chat',{method:'POST'});
  ok = false;
  await assert.rejects(apiContext.api('/api/inbox/1/ignore',{method:'POST'}));
  assert.equal(events.length,count);
});

test('cross-module navigation clears only the destination query', () => {
  const source = read('app.jsx');
  const setter = source.slice(source.indexOf('  const setQuery ='),source.indexOf('  const [favCategory,'));
  const queryContext = vm.createContext({
    section:'inbox',user:{id:'owner'},
    queries:{'owner:inbox':'keep-source','owner:assets':'old-target'},
  });
  vm.runInContext('function setSectionQueries(update) { queries = update(queries); }\n'+setter+'\nsetQuery("", "assets");',queryContext);
  assert.equal(queryContext.queries['owner:inbox'],'keep-source');
  assert.equal(queryContext.queries['owner:assets'],'');
  for (const section of ['assets','studio','knowledgeLibrary','repositories']) {
    assert.ok(source.includes(`setQuery("", "${section}")`));
  }
});
