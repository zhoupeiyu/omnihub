import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const compiled = (await transform(read('reference-library.jsx'), { loader: 'jsx' })).code;
const memoryStorage = () => { const data = new Map(); return { data, getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)) }; };
const face = { kind: 'face', id: 'face:f001', title: '短发人物', stem: 'f001', thumbnailUrl: '/api/reference-library/items/face%3Af001/thumbnail', originalReady: true };
const face2 = { ...face, id: 'face:f002', title: '长发人物', stem: 'f002' };
const costume = { kind: 'costume', id: 'costume:c001', title: '风衣', stem: 'c001', thumbnailUrl: '/api/reference-library/items/costume%3Ac001/thumbnail', originalReady: false };
const pose = { kind: 'pose', id: 'pose:p001', title: '回头', stem: 'p001', thumbnailUrl: '/api/reference-library/items/pose%3Ap001/thumbnail', originalReady: true };

function setup(extra = {}) {
  const location = { hash: '#ai-art?space=mine&kind=pose' };
  const context = vm.createContext({ URLSearchParams, Blob, File, window: { location },
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: current => ({ current }), useEffect: () => {} },
    workspaceHashParams: value => new URLSearchParams(value.split('?')[1]), IconSearch: () => null, IconX: () => null, ...extra });
  vm.runInContext(compiled, context);
  return { context, location };
}
// Walks elements and their children; nested child arrays are flattened and text
// (strings and numbers) is kept as leaves so `text` sees what would render.
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (tree == null || typeof tree === 'boolean') return [];
  if (typeof tree !== 'object') return [tree];
  const children = tree.props?.children;
  return [tree, ...(children == null ? [] : [].concat(children)).flatMap(nodes)];
}
const text = node => nodes(node).filter(item => typeof item === 'string' || typeof item === 'number').join('');

test('any subset of roles is kept in face, costume, pose order with matching prompt roles', () => {
  const { context: c } = setup();
  let composition = c.setReferenceSelection({}, pose);
  composition = c.setReferenceSelection(composition, face);
  assert.deepEqual([...c.orderedReferenceSelections(composition)].map(item => item.kind), ['face', 'pose']);
  const prompt = c.buildReferenceCompositionPrompt(composition);
  assert.match(prompt, /2 张参考图/);
  assert.match(prompt, /图1是人物参考：[^\n]*（短发人物）/);
  assert.match(prompt, /图2是姿势参考：[^\n]*（回头）/);
  assert.doesNotMatch(prompt, /服装|图3/);

  const all = c.setReferenceSelection(composition, costume);
  const full = c.buildReferenceCompositionPrompt(all);
  assert.ok(full.indexOf('图1是人物') < full.indexOf('图2是服装') && full.indexOf('图2是服装') < full.indexOf('图3是姿势'));

  const single = c.buildReferenceCompositionPrompt(c.setReferenceSelection({}, costume));
  assert.match(single, /参考图是服装参考/);
  assert.doesNotMatch(single, /图1/);
  assert.equal(c.buildReferenceCompositionPrompt({}), '');
  // Item lists (as returned by the library at send time) are ordered and de-duplicated by role.
  const fromItems = c.buildReferenceCompositionPrompt([pose, face2, face, costume]);
  assert.match(fromItems, /图1是人物参考：[^\n]*（长发人物）/);
  assert.equal((fromItems.match(/人物参考/g) || []).length, 1);
});

test('selecting a second image of a role replaces it, and removal only affects that role', () => {
  const { context: c } = setup();
  let composition = c.setReferenceSelection(c.setReferenceSelection({}, face), costume);
  composition = c.setReferenceSelection(composition, face2);
  assert.equal(composition.face.id, 'face:f002');
  assert.equal(c.orderedReferenceSelections(composition).length, 2);
  composition = c.removeReferenceSelection(composition, 'face');
  assert.equal(composition.face, undefined);
  assert.equal(composition.costume.id, 'costume:c001');
  assert.deepEqual({ ...c.setReferenceSelection(composition, { kind: 'scene', id: 'x' }) }, { ...composition });
});

test('selections persist per account, survive reloads, and reject unsafe stored values', () => {
  const storage = memoryStorage();
  const { context: c } = setup();
  assert.equal(c.writeReferenceComposition(8, c.setReferenceSelection({}, face), storage), true);
  assert.equal(c.readReferenceComposition(8, storage).face.id, 'face:f001');
  assert.deepEqual({ ...c.readReferenceComposition(9, storage) }, {});
  assert.equal(c.writeReferenceComposition(null, { face }, storage), false);
  assert.equal(c.writeReferenceComposition('8x', { face }, storage), false);
  assert.ok([...storage.data.keys()].every(key => key === 'omnihub:reference-composition:v1:8'));

  const { context: reloaded } = setup();
  assert.equal(reloaded.readReferenceComposition(8, storage).face.title, '短发人物');

  storage.setItem('omnihub:reference-composition:v1:10', JSON.stringify({ version: 1, selections: {
    face: { ...pose }, costume: { ...costume, thumbnailUrl: '//evil.example/x.png' }, pose: { ...pose, thumbnailUrl: 'https://evil.example/x.png' } } }));
  const cleaned = reloaded.readReferenceComposition(10, storage);
  assert.equal(cleaned.face, undefined);
  assert.equal(cleaned.costume.thumbnailUrl, '');
  assert.equal(cleaned.pose.thumbnailUrl, '');
  storage.setItem('omnihub:reference-composition:v1:11', 'not json');
  assert.deepEqual({ ...reloaded.readReferenceComposition(11, storage) }, {});

  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } };
  assert.equal(reloaded.writeReferenceComposition(12, { pose }, blocked), false);
  assert.equal(reloaded.readReferenceComposition(12, blocked).pose.id, 'pose:p001');
});

test('composer labels roles, keeps select and preview separate, and needs a selection to send', () => {
  const { context: c } = setup();
  const empty = c.ReferenceComposer({ composition: {}, kind: 'pose', canSend: true, onShow() {}, onBrowse() {}, onRemove() {}, onClear() {}, onSend() {} });
  const send = nodes(empty).find(node => node.props?.className?.includes('reference-send'));
  assert.equal(send.props.disabled, true);
  assert.match(text(empty), /人物[\s\S]*服装[\s\S]*姿势/);
  const filled = c.ReferenceComposer({ composition: { face, costume }, kind: 'pose', canSend: true, onShow() {}, onBrowse() {}, onRemove() {}, onClear() {}, onSend() {} });
  const buttons = nodes(filled).filter(node => node.type === 'button').map(node => node.props['aria-label'] || text(node));
  assert.ok(buttons.includes('查看人物参考：短发人物'));
  assert.ok(buttons.includes('移除服装参考：风衣'));
  assert.ok(buttons.includes('更换人物参考'));
  assert.equal(nodes(filled).find(node => node.props?.className?.includes('reference-send')).props.disabled, false);
  assert.match(text(filled), /1 张还没有原图/);
});

test('sending uploads every selected original in role order and hands one ordered set to the studio', async () => {
  const uploads = [], created = [], fetched = [];
  const items = Object.fromEntries([face, costume, pose].map(item => [item.id,
    { ...item, imageUrl: `/api/reference-library/items/${encodeURIComponent(item.id)}/image`, tags: [], variants: [] }]));
  const { context: c } = setup({
    api: async url => items[decodeURIComponent(url.split('/items/')[1])],
    fetch: async url => { fetched.push(url); return { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }; },
    uploadMediaFile: async (file, options) => { uploads.push([file.name, options.title]); return { id: `asset-${uploads.length}` }; },
  });
  c.writeReferenceComposition(8, c.setReferenceSelection(c.setReferenceSelection(c.setReferenceSelection({}, pose), costume), face));
  const tree = c.ReferenceLibraryTool({ active: true, visible: true, hash: '#ai-art?space=mine&kind=pose', userId: 8,
    onCreate: async (asset, detail) => { created.push([asset, detail]); } });
  const composer = nodes(tree).find(node => node.type === c.ReferenceComposer);
  await composer.props.onSend();
  assert.deepEqual(uploads.map(([name]) => name), ['f001.png', 'c001.png', 'p001.png']);
  assert.equal(created.length, 1);
  const [asset, detail] = created[0];
  assert.equal(asset.id, 'asset-1');
  assert.deepEqual([...detail.referenceAssetIds], ['asset-1', 'asset-2', 'asset-3']);
  assert.deepEqual([...detail.references.map(item => item.kind)], ['face', 'costume', 'pose']);
  assert.match(detail.prompt, /图1是人物参考[\s\S]*图2是服装参考[\s\S]*图3是姿势参考/);
  assert.equal(detail.title, '组合参考：人物、服装、姿势');
  assert.ok(!Object.keys(detail).some(key => /accept|consent|cost/i.test(key)));
  // A second send in the same session reuses the already saved originals.
  await composer.props.onSend();
  assert.equal(uploads.length, 3);
  assert.equal(fetched.length, 3);

  // Another account starts from its own empty composition.
  const otherAccount = c.ReferenceLibraryTool({ active: true, visible: true, hash: '#ai-art?space=mine&kind=pose', userId: 9 });
  const empty = nodes(otherAccount).find(node => node.type === c.ReferenceComposer);
  assert.deepEqual({ ...empty.props.composition }, {});

  // Card actions: a clearly labelled select button and a separate preview button.
  const { context: g } = setup({ api: async () => ({}) });
  const gallery = g.ReferenceLibraryTool({ active: true, visible: true, hash: '#ai-art?space=mine&kind=face', userId: 8 });
  const skeleton = nodes(gallery).find(node => node.props?.className === 'reference-grid reference-skeleton-grid');
  assert.equal(skeleton?.props['aria-busy'], 'true', 'the pending request renders its loading state');
  assert.equal(nodes(gallery).some(node => node.type === 'ul' && node.props.className === 'reference-grid'), false, 'cards are rendered only after the request returns');
});

test('preview dialog stays a native modal dialog with keyboard escape handling', () => {
  const { context: c, location } = setup();
  const tree = c.ReferenceLibraryTool({ active: true, visible: true, hash: '#ai-art?space=mine&kind=face&reference=face%3Af001', userId: 8 });
  const dialog = nodes(tree).find(node => node.type === 'dialog');
  assert.equal(dialog.props.className, 'reference-dialog');
  let prevented = false;
  dialog.props.onCancel({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(new URLSearchParams(location.hash.split('?')[1]).has('reference'), false);
  const css = read('reference-library.css');
  assert.match(css, /\.reference-dialog\{[^}]*inset:0;margin:auto;/);
  assert.match(css, /\.reference-dialog\{[^}]*max-height:calc\(100dvh - 48px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

 test('pose angles keep front first and unknown angles last without mutating input', () => {
  const { context: c } = setup();
  const variants = [{ angle: '新机位' }, { angle: '侧面' }, { angle: '正面' }];
  assert.deepEqual([...c.groupVariants({ variants })].map(v => v.angle), ['正面', '侧面', '新机位']);
  assert.equal(variants[0].angle, '新机位');
  assert.notEqual(c.groupKeyOf({ collectionId: 'a::b', groupId: 'c' }), c.groupKeyOf({ collectionId: 'a', groupId: 'b::c' }));
  assert.equal(c.pickRandomCombo({ face: [{ kind: 'pose' }] }).face, undefined);
});

 test('random reference preserves the selected series and angle scope', async () => {
  let requested;
  const { context, location } = setup({ api: async url => { requested = url; return { items: [] }; } });
  location.hash = '#ai-art?kind=pose&series=女性结构姿势补齐&angle=侧面&style=line-art';
  const tree = context.ReferenceLibraryTool({ active: true, visible: true, hash: location.hash });
  await nodes(tree).find(n => n.props?.className === 'reference-shuffle').props.onClick();
  const query = new URL(requested, 'https://example.test').searchParams;
  assert.equal(query.get('series'), '女性结构姿势补齐');
  assert.equal(query.get('angle'), '侧面');
  assert.equal(query.get('style'), 'line-art');
  assert.equal(query.get('group'), 'pose');
  assert.equal(query.get('sort'), 'random');
 });
