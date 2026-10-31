import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';
const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const video = read('video-tools.jsx'), reference = read('reference-library.jsx');
const compiled = (await transform(reference + '\n' + video, { loader: 'jsx' })).code;
function screen(hash = '#tools?space=mine') {
  const effects = [], location = { hash };
  const context = vm.createContext({ URLSearchParams, window: { location },
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: current => ({ current }), useEffect: callback => effects.push(callback) },
    workspaceHashName: value => value.replace(/^#/, '').split('?')[0],
    workspaceHashParams: value => new URLSearchParams(value.split('?')[1]),
  });
  for (const name of new Set((video + reference).match(/\bIcon\w+/g))) context[name] = () => null;
  for (const name of ['MediaProcessingTool', 'MediaTextWorkspace', 'MediaCollectionWorkspace', 'MediaDiscoveryTool']) context[name] = () => null;
  vm.runInContext(compiled, context);
  return { context, location, effects };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(Array.isArray(tree) ? tree : tree.props?.children || []).flatMap(nodes)];
}
test('AI art is an owner-only sibling tool and unauthorized deep links never mount references', () => {
  const { context } = screen('#ai-art?space=mine');
  const links = access => nodes(context.ToolCatalog({ space: 'mine', active: true, referenceAccess: access })).filter(n => n.type === 'a').map(n => n.props.href);
  assert.deepEqual(links(false), ['#media-tools?tab=download&space=mine']);
  assert.deepEqual(links(true), ['#media-tools?tab=download&space=mine', '#ai-art?space=mine']);
  assert.equal(context.VideoToolsWorkspace({ active: true, referenceAccess: false }).type, context.ToolCatalog);
  assert.equal(context.VideoToolsWorkspace({ active: true, referenceAccess: true }).type, context.AiArtWorkspace);
});
test('media tools retain the platform library and no longer contain the AI reference tab', () => {
  const { context } = screen('#media-tools?tab=library&space=mine');
  const tree = context.VideoToolsWorkspace({ active: true, referenceAccess: true });
  const tabs = nodes(tree).filter(n => n.props?.role === 'tab');
  assert.equal(tabs.length, 8);
  assert.equal(tabs.find(n => n.props['aria-selected']).props['data-tool-tab'], 'library');
  assert.equal(nodes(tree).some(n => n.type === context.ReferenceLibraryTool), false);
});
test('collection changes stay in AI art and clear incompatible filters', () => {
  const { context, location } = screen('#ai-art?space=mine&kind=face&collection=one&category=old&hair=long&page=2&q=old&reference=face%3Af001');
  const tree = context.ReferenceLibraryTool({ active: true, visible: true, hash: location.hash });
  const select = nodes(tree).find(n => n.type === 'select' && n.props['aria-label'] === '素材集');
  select.props.onChange({ target: { value: 'two' } });
  const params = new URLSearchParams(location.hash.split('?')[1]);
  assert.ok(location.hash.startsWith('#ai-art?'));
  assert.equal(params.get('collection'), 'two'); assert.equal(params.get('kind'), 'face');
  for (const key of ['category','hair','page','q','reference','tab']) assert.equal(params.has(key), false, key);
  const workspace = nodes(context.AiArtWorkspace({ active: true, hash: location.hash }));
  assert.ok(workspace.some(n => n.props?.href === '#works?space=mine'));
  assert.ok(workspace.some(n => n.props?.href === '#studio?space=mine'));
});
test('legacy reference links redirect without losing filters on initial load and history changes', () => {
  const handlers = new Map(), events = [], location = { hash: '#media-tools?tab=references&kind=pose&reference=pose%3Ap1&space=public' };
  let state;
  const context = vm.createContext({ URLSearchParams, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { location, history: { replaceState: (_a, _b, hash) => { location.hash = hash; } },
      addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), dispatchEvent: event => events.push(event.type) },
    React: { useRef: current => ({ current }), useState: initial => { state = initial(); return [state, value => { state = value; }]; }, useEffect: fn => fn() } });
  const source = read('repository-tab.js'); vm.runInContext(source.slice(source.indexOf('function useWorkspaceSection')), context);
  const [initial] = context.useWorkspaceSection('feed'); assert.equal(initial, 'tools');
  assert.equal(location.hash, '#ai-art?space=mine&kind=pose&reference=pose%3Ap1');
  location.hash = '#video-tools?tab=references&collection=gia-ai-reference&q=white'; handlers.get('hashchange')();
  assert.equal(state, 'tools'); assert.equal(location.hash, '#ai-art?space=mine&collection=gia-ai-reference&q=white');
  assert.ok(events.includes('omnihub:route-restored'));
  location.hash = '#media-tools?tab=library&space=mine'; handlers.get('hashchange')();
  assert.equal(location.hash, '#media-tools?tab=library&space=mine'); assert.equal(state, 'tools');
});
