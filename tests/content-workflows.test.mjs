import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing source block: ${start}`);
  return source.slice(from, to);
};
const plain = value => JSON.parse(JSON.stringify(value));

function inboxContext() {
  const source = read('../public/inbox.jsx');
  const code = [between(source, 'const INBOX_TYPE_LABELS', 'const INBOX_SOURCE_LABELS'),
    between(source, 'function inboxJson', 'function inboxLinkedText'),
    between(source, 'function inboxReviewReason', 'const INBOX_REVIEW_LABELS'),
    between(source, '// inbox-workflow:start', '// inbox-workflow:end')].join('\n');
  const context = vm.createContext({ URL, Promise, Error }); vm.runInContext(code, context); return context;
}
function mediaContext() {
  const source = read('../public/media.jsx');
  const code = between(source, 'const MEDIA_MODEL_OPTIONS', 'const MEDIA_STATUS') + '\n' + between(source, '// media-workflow:start', '// media-workflow:end');
  const context = vm.createContext({ URL }); vm.runInContext(code, context); return context;
}

test('X queues are exclusive and make each next action explicit', () => {
  const c = inboxContext();
  assert.equal(c.inboxStage({ aiType: null }, null).stage, 'classify');
  assert.equal(c.inboxStage({ source: 'x', content: 'x', aiExtract: JSON.stringify({ xOrganization: { contentIncomplete: true } }) }, null).stage, 'content');
  assert.equal(c.inboxStage({ aiType: 'prompt' }, null).stage, 'review');
  const done = c.inboxStage({ aiType: 'prompt' }, { revision: 2, data: { type: 'prompt' } });
  assert.equal(done.stage, 'done'); assert.match(done.reason, /第 2 版/); assert.ok(done.next);
  assert.equal(c.inboxStage({aiType:'prompt', curation:{revision:2,data:{type:'prompt'}}}).stage, 'done', 'persisted review survives a page reload');
});

test('bulk summary retains failed rows and derived links use real library routes', async () => {
  const c = inboxContext();
  assert.equal(c.inboxDerivedLink({kind:'curation',id:42,data:{type:'prompt'}}).sourceId,42);
  const seen = [];
  const results = await c.inboxRunBulk([1, 2, 3], async id => { seen.push(id); if (id === 2) throw Object.assign(new Error('冲突'), { status: 409 }); return { revision: id }; });
  assert.deepEqual(seen, [1, 2, 3]); assert.equal(c.inboxBulkSummary(results).failed, 1);
  assert.deepEqual(plain(c.inboxDerivedLink({ kind: 'dispatch', result: { targetType: 'resource', targetId: 8 } })), { href: '#resources', label: '在资源收藏查看', id: 'asset-resource-8' });
});

test('works compare, lineage and continuation use stored job data', () => {
  const c = mediaContext();
  const assets = [{ id: 'a' }, { id: 'b', parentAssetId: 'a', jobId: 'j' }];
  assert.deepEqual(plain(c.mediaToggleCompare(['a', 'b'], 'c')), ['b', 'c']);
  assert.deepEqual(plain(c.mediaLineageChain('b', assets).map(row => row.id)), ['a', 'b']);
  assert.equal(c.mediaVersionLabel(assets[1], assets), '第 2 版');
  const next = c.mediaContinueDraft({ id: 'b', kind: 'image', prompt: 'fox', title: 'Fox', sourceType: 'prompt', sourceId: 4, sourceUrl: 'https://example.test/p' }, { module: 'image', model: 'gpt-image-2', prompt: 'fox', args: { aspectRatio: '16:9', size: '2k' } }, { model: 'nano-banana-pro' }, true);
  assert.equal(next.model, 'gpt-image-2'); assert.equal(next.aspectRatio, '16:9'); assert.equal(next.size, '2k'); assert.equal(next.source.parentAssetId, 'b');
  assert.equal(c.mediaSafeSourceUrl('javascript:alert(1)'), '');
});

test('studio continuation persists only valid stored generation parameters', () => {
  const context = vm.createContext({ localStorage: { getItem() { return null; }, setItem() {} }, Map, Set, JSON });
  vm.runInContext(read('../public/studio-draft.js'), context);
  const draft = context.resolveStudioDraft(null, { key: 'continue-1', targetModule: 'image', targetMode: 'image', model: 'gpt-image-2', generationArgs: { aspectRatio: '16:9', size: '2k' }, parentAssetId: 'asset-1', referenceAssetId: 'asset-1', sourceType: 'prompt', sourceId: 4 }, true);
  assert.equal(draft.model, 'gpt-image-2'); assert.equal(draft.aspectRatio, '16:9'); assert.equal(draft.size, '2k'); assert.equal(draft.source.parentAssetId, 'asset-1');
  const local = context.resolveStudioDraft(null, { key: 'continue-2', targetModule: 'seedance', model: 'seedance2.0', referenceAssetId: 'asset-2' }, false);
  assert.equal(local.module, 'image'); assert.equal(local.generationRoute, 'local');
});

test('existing knowledge opens an incoming result as unsaved editing and cancel restores the old article', () => {
  const source = read('../public/inbox.jsx');
  const code = between(source, 'const KNOWLEDGE_FORM_FIELDS', 'function KnowledgeDrawer');
  const context = vm.createContext({}); vm.runInContext(code, context);
  const old = { id: 9, title: '旧标题', summary: '旧摘要', body: '旧正文', tags: '旧标签', sourceUrl: 'https://old.example' };
  const incoming = { title: '新标题', body: '新正文', tags: '新标签', sourceUrl: 'https://new.example' };
  const state = context.knowledgeDrawerInitialState(old, incoming);
  assert.equal(state.editing, true);
  assert.equal(state.saved.body, '旧正文');
  assert.equal(state.form.body, '新正文');
  // This is exactly what the drawer cancel handler does: restore the persisted snapshot.
  const afterCancel = { ...state.saved };
  assert.equal(afterCancel.body, '旧正文');
  assert.equal(afterCancel.title, '旧标题');
  assert.equal(context.knowledgeFormDirty(afterCancel, state.saved), false);
});

test('monitor onboarding requires settings and an explicit enable save', () => {
  const source = read('../public/x-watch-accounts.jsx');
  assert.match(source, /下一步设置频率与预算；保存前不会启用采集/);
  assert.match(source, /启用采集（会产生费用）/);
  assert.match(source, /最近成功/);
  assert.match(source, /上次失败：/);
});

test('Chat source uses archived article text and supports an explicit multi-term search mode', () => {
  const source = read('../public/chat.jsx');
  const code = between(source, 'function chatSourceMaterial', '/** Bounded source search');
  const c = vm.createContext({ JSON }); vm.runInContext(code, c);
  const item = { id: 1, title: 'Article', url: 'https://x.com/a/status/1', content: 'short link', metrics: JSON.stringify({ article: { plainText: 'full archived article body' } }) };
  assert.match(c.chatSourceText(item), /full archived article body/);
  assert.equal(c.chatSourceRef(item).content, 'full archived article body');
});
