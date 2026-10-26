// Regression coverage for the editor guard, prompt drawer, AI refinery workbench and scoped knowledge search.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Code between `// <name>` and `// </name>` marker comments. */
function block(source, name) {
  const start = source.indexOf(`// <${name}>`);
  const end = source.indexOf(`// </${name}>`);
  assert.ok(start >= 0 && end > start, `missing marker block ${name}`);
  return source.slice(start, end);
}

function evaluate(code, names, context = {}) {
  const sandbox = vm.createContext({ ...context });
  return vm.runInContext(`${code}\n;({${names.join(',')}})`, sandbox);
}

/** Compile (never run) an ES module body so syntax errors fail without spawning a process. */
function assertModuleSyntax(source, label) {
  const body = source
    .replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?/gm, '')
    .replace(/^import\s*["'][^"']+["'];?/gm, '')
    .replace(/^export\s*\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\bimport\.meta\b/g, '({})');
  assert.doesNotThrow(() => new vm.Script(`(async function () {\n${body}\n})`, { filename: label }), label);
}

const chatSource = read('public/chat.jsx');
const promptsSource = read('public/prompts.jsx');
const refinerySource = read('public/refinery.jsx');
const drawerSource = read('public/detail-drawer.jsx');
const apiSource = read('lib/api.js');

/* ---------- navigation guard ---------- */
function loadGuard() {
  const confirms = [];
  const window = { confirm: (text) => { confirms.push(text); return false; } };
  const context = vm.createContext({ window, document: {}, console: { error() {} } });
  vm.runInContext(read('public/detail-drawer.js'), context);
  return { guard: window.OmniNavigationGuard, confirms };
}

test('navigation guard: register/allow/unregister, newest first, fails closed', () => {
  const { guard, confirms } = loadGuard();
  assert.equal(guard.allow('route'), true, 'no editors means navigation is allowed');
  const calls = [];
  const offClean = guard.register((reason) => { calls.push(['clean', reason]); return true; });
  let dirty = true;
  const offDirty = guard.register((reason) => { calls.push(['dirty', reason]); return !dirty; });
  assert.equal(guard.size(), 2);
  assert.equal(guard.allow('route'), false);
  assert.deepEqual(calls, [['dirty', 'route']], 'newest check answers first and a refusal stops the chain');
  dirty = false;
  calls.length = 0;
  assert.equal(guard.allow('beforeunload'), true);
  assert.deepEqual(calls.map(([name]) => name), ['dirty', 'clean']);
  offDirty(); offDirty();
  assert.equal(guard.size(), 1, 'unregister is idempotent');
  const offThrow = guard.register(() => { throw new Error('broken editor'); });
  assert.equal(guard.allow('route'), false, 'a throwing check keeps the person on the page');
  offThrow(); offClean();
  assert.equal(guard.size(), 0);
  assert.equal(guard.confirmDiscard(false), true, 'clean editors never prompt');
  assert.equal(confirms.length, 0);
  assert.equal(guard.confirmDiscard(true, '放弃吗？', () => true), true);
  assert.equal(guard.confirmDiscard(true, '放弃吗？', () => false), false);
  assert.equal(guard.confirmDiscard(true), false, 'default ask uses window.confirm');
  assert.equal(confirms[0], guard.DISCARD_MESSAGE);
});

test('DetailDrawer guards every close path and registers its own dirty check', () => {
  assert.match(drawerSource, /dirty\s*=\s*false/);
  assert.match(drawerSource, /OmniNavigationGuard/);
  assert.match(drawerSource, /\.register\(/);
  assert.match(drawerSource, /beforeunload/);
  assert.match(drawerSource, /detail-drawer-backdrop.*onClick=\{requestClose\}/s);
  assert.match(drawerSource, /OmniDetailDrawer\.mount\(panel\.current, requestClose/);
});

/* ---------- prompt drawer ---------- */
test('prompt drawer cancel restores the saved record and dirty tracks real edits', () => {
  const { promptDrawerBaseline, promptDrawerInitialForm, promptFormDirty, promptDrawerCancel } = evaluate(
    block(promptsSource, 'prompt-drawer-state'), ['promptDrawerBaseline', 'promptDrawerInitialForm', 'promptFormDirty', 'promptDrawerCancel']);
  const saved = promptDrawerBaseline({ id: 7, title: '已保存标题', text: '原始提示词', tags: 'portrait', note: null }, null, '写作');
  assert.equal(saved.note, '');
  assert.equal(saved.category, '写作');
  const draft = { ...saved, title: '取消掉的草稿', text: '不应被使用' };
  assert.equal(promptFormDirty({ ...saved }, saved), false);
  assert.equal(promptFormDirty(draft, saved), true);
  assert.equal(promptFormDirty({ ...saved, text: saved.text.replace(/\n/g, '\r\n') }, saved), false);
  const cancelEdit = promptDrawerCancel('edit', saved);
  assert.equal(cancelEdit.close, false);
  assert.equal(cancelEdit.mode, 'view');
  assert.equal(cancelEdit.form.title, '已保存标题');
  assert.notEqual(cancelEdit.form, saved, 'restored form is a fresh copy');
  assert.equal(promptDrawerCancel('create', saved).close, true);
  const actual = promptDrawerBaseline({ id: 7, title: '旧标题', text: '旧正文', category: '学习' },
    { title: 'AI 提炼结果', text: '编辑后的正文', category: '写作' }, '学习');
  const update = promptDrawerInitialForm(actual, { title: 'AI 提炼结果', text: '编辑后的正文', category: '写作' }, true);
  assert.equal(actual.text, '旧正文', 'the view baseline remains the actual saved prompt');
  assert.equal(update.text, '编辑后的正文', 'the edit form receives the refinery update draft');
  assert.equal(promptDrawerCancel('edit', actual).form.text, '旧正文', 'cancel restores view/copy to the actual saved text');
  // View, copy and use read the saved record, never the draft.
  assert.match(promptsSource, /onCopy\(saved\.text\)/);
  assert.match(promptsSource, /onTryRun\(saved\)/);
  assert.match(promptsSource, /onCreateMedia\(saved\)/);
  assert.doesNotMatch(promptsSource, /onCopy\(form\.text\)|onTryRun\(form\)|onCreateMedia\(form\)/);
  assert.match(promptsSource, /dirty=\{dirty\}/);
});

test('resource editor protects a changed draft on every close path', () => {
  const components = read('public/components.jsx');
  const start = components.indexOf('function AddFavModalV2');
  const end = components.indexOf('/** 信息流卡片', start);
  const editor = components.slice(start, end);
  assert.match(editor, /OmniNavigationGuard\?\.register\?\.\(confirmDiscard\)/);
  assert.match(editor, /beforeunload/);
  assert.match(editor, /event\.key === 'Escape'/);
  assert.match(editor, /onClick=\{requestClose\}/);
  assert.match(editor, /资料编辑还有未保存的修改/);
});

/* ---------- AI refinery: context, retry, stream ---------- */
const chat = evaluate(block(chatSource, 'chat-workbench-logic'), [
  'chatOutboundMessages', 'chatSendPlan', 'createChatStreamParser', 'chatSourceSearch',
  'chatSourceBindingState', 'chatSourceText', 'chatRequestContent', 'chatSaveSnapshot', 'chatHasUnsavedWork', 'chatRequestSnapshot', 'chatRecentSources', 'chatPushRecent', 'CHAT_STREAM_EOF_ERROR',
]);

test('failed turns stay visible but never leave in outbound context', () => {
  const messages = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答', complete: true },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '半截回复', complete: false, error: '回复未完成：断开' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(chat.chatOutboundMessages(messages))), [
    { role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' },
  ]);
});

test('retry replaces the failed turn instead of duplicating the question', () => {
  const messages = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答', complete: true },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '半截', complete: false, error: '回复未完成：断开' },
  ];
  const retry = chat.chatSendPlan(messages, '  第二问 ');
  assert.equal(retry.retry, true);
  assert.equal(retry.base.length, 3);
  assert.equal(retry.base.filter((m) => m.content === '第二问').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(retry.outbound)).map((m) => m.content), ['第一问', '第一答', '第二问']);
  // A dangling question (request failed before any reply) is retried in place too.
  const dangling = chat.chatSendPlan([{ role: 'user', content: '只问一次' }], '只问一次');
  assert.equal(dangling.retry, true);
  assert.equal(dangling.base.length, 1);
  // An edited, different question is a new turn; the failed pair stays out of context.
  const edited = chat.chatSendPlan(messages, '换个问法');
  assert.equal(edited.retry, false);
  assert.equal(edited.base.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(edited.outbound)).map((m) => m.content), ['第一问', '第一答', '换个问法']);
  // A completed answer is never replaced, even when the same question is asked again.
  const done = [{ role: 'user', content: '再问' }, { role: 'assistant', content: '答', complete: true }];
  assert.equal(chat.chatSendPlan(done, '再问').base.length, 3);
});

test('stream parser treats premature EOF as an error and keeps partial text', () => {
  const deltas = [];
  const parser = chat.createChatStreamParser({ onDelta: (text) => deltas.push(text) });
  parser.push('data: {"model":"m"}\n\ndata: {"delta":"你"}\n\nda');
  parser.push('ta: {"delta":"好"}\n\n');
  assert.deepEqual(deltas, ['你', '你好']);
  assert.throws(() => parser.end(), (error) => error.message === chat.CHAT_STREAM_EOF_ERROR);
  assert.equal(parser.text, '你好');

  const complete = chat.createChatStreamParser();
  complete.push('data: {"delta":"完整"}\n\ndata: [DONE]');
  assert.equal(complete.end(), '完整', 'trailing event without blank line is still processed');

  const errored = chat.createChatStreamParser();
  assert.throws(() => errored.push('data: {"error":"额度不足"}\n\n'), /额度不足/);
  const garbled = chat.createChatStreamParser();
  assert.throws(() => garbled.push('data: {not json\n\n'), /无法解析/);
  const blank = chat.createChatStreamParser();
  blank.push('data: {"delta":"   "}\n\ndata: [DONE]\n\n');
  assert.throws(() => blank.end(), /空回复/);
  const silent = chat.createChatStreamParser();
  assert.throws(() => silent.end(), /没有返回内容/);
});

test('ChatView guards overlapping sends and stale stream updates', () => {
  assert.match(chatSource, /busyRef\.current\) return/);
  assert.match(chatSource, /runRef\.current === runId && !controller\.signal\.aborted/);
  assert.match(chatSource, /chatSendPlan\(messagesRef\.current/);
  assert.match(chatSource, /body: JSON\.stringify\(\{ messages: outbound \}\)/);
  assert.doesNotMatch(chatSource, /<select[^>]*value=\{selectedSource/, 'no 2000-option native select');
  assert.match(chatSource, /function ChatView\(\{[\s\S]*onSaveResult, active = false \}\)/);
  assert.match(chatSource, /onSaveResult\(\{[\s\S]*content: draft,[\s\S]*originalContent: result\.content,[\s\S]*saveSnapshot:[\s\S]*existingAsset:/);
  assert.match(chatSource, /\{ id: "result", label: "结果" \}/, 'mobile navigation can return to the generated result');
  assert.match(chatSource, /OmniNavigationGuard\?\.register\?\.\(confirmLeave\)/, 'uncommitted refinery work participates in the shared navigation guard');
  assert.match(chatSource, /if \(!plan\.retry && chatSourceBindingState\(binding, originalText\) === "stale"\)/);
});

test('refinery dirty guard clears after a matching save but keeps original and edited results', () => {
  const saved = chat.chatSaveSnapshot('成品', { id: 3, url: 'https://example.test/3' }, { category: '', tags: [] });
  const result = { role: 'assistant', content: '成品', complete: true, source: { id: 3, url: 'https://example.test/3' }, savedSnapshots: { knowledge: saved } };
  assert.equal(chat.chatHasUnsavedWork('', '', [result], {}, {}), false, 'a saved unchanged result is safe to leave');
  assert.equal(chat.chatHasUnsavedWork('尚未发送原文', '', [result], {}, {}), true);
  assert.equal(chat.chatHasUnsavedWork('', '', [result], { 0: '编辑后' }, {}), true);
});

test('retry keeps a null source and empty original instead of borrowing the newly selected source', () => {
  const plan = { retry: true, base: [{ role: 'user', content: '重试', source: null, originalText: '', requestContent: '重试' }] };
  const snapshot = chat.chatRequestSnapshot(plan, { source: { id: 9, title: '新来源' } }, '新的原文', '重试');
  assert.equal(snapshot.source, null);
  assert.equal(snapshot.originalText, '');
  assert.equal(snapshot.requestContent, '重试');
  const fresh = chat.chatRequestSnapshot({ retry: false, base: [] }, { source: { id: 9 } }, '当前原文', '整理');
  assert.equal(fresh.source.id, 9);
  assert.equal(fresh.originalText, '当前原文');
});

/* ---------- AI refinery: sources ---------- */
test('source search is bounded and covers title, author and content', () => {
  const sources = Array.from({ length: 2058 }, (_, index) => ({
    id: index + 1, title: `收藏 ${index + 1}`, author: index % 2 ? '@alice' : '@bob', content: index === 2000 ? '镜头语言 深度解析' : '普通内容',
  }));
  const all = chat.chatSourceSearch(sources, '收藏');
  assert.equal(all.total, 2058);
  assert.equal(all.matches.length, 8);
  assert.equal(chat.chatSourceSearch(sources, '').matches.length, 0, 'nothing is listed before typing');
  assert.equal(chat.chatSourceSearch(sources, '@alice').total, 1029);
  const body = chat.chatSourceSearch(sources, '镜头语言');
  assert.equal(body.total, 1);
  assert.equal(body.matches[0].id, 2001);
  assert.equal(chat.chatSourceSearch(sources, '收藏 @bob 镜头').total, 1, 'title, author and body terms combine');
  assert.equal(chat.chatSourceSearch(sources, '收藏 @alice 镜头').total, 0, 'every term must match');
  const recent = chat.chatPushRecent(chat.chatPushRecent(['3', '2'], 2), 9);
  assert.deepEqual(JSON.parse(JSON.stringify(recent)), ['9', '2', '3']);
  assert.deepEqual(JSON.parse(JSON.stringify(chat.chatRecentSources(recent, sources).map((s) => s.id))), [9, 2, 3]);
});

test('source detaches or needs confirmation when the input is substantially replaced', () => {
  const source = { id: 5, title: '运镜技巧合集', content: '推拉摇移跟，镜头运动要服务于叙事，先确定主体再设计轨迹。', url: 'https://example.com/a' };
  const insertedText = chat.chatSourceText(source);
  const binding = { source, insertedText, sent: false, confirmedInput: '' };
  assert.equal(chat.chatSourceBindingState(null, '任意内容'), 'none');
  assert.equal(chat.chatSourceBindingState(binding, ''), 'empty');
  assert.equal(chat.chatSourceBindingState(binding, insertedText), 'bound');
  assert.equal(chat.chatSourceBindingState(binding, `请提炼成提示词资产：\n\n${insertedText}`), 'bound');
  const replaced = '这是一段完全不同的新闻稿，讲的是季度财报和渠道销售数据，与原来的收藏没有关系。';
  assert.equal(chat.chatSourceBindingState(binding, replaced), 'stale');
  assert.equal(chat.chatSourceBindingState({ ...binding, confirmedInput: replaced }, replaced), 'bound', 'explicit confirmation keeps it');
  const sent = { ...binding, sent: true };
  assert.equal(chat.chatSourceBindingState(sent, '再精简一点，保留三个要点'), 'stale', 'a changed original needs an explicit decision even when short');
  assert.equal(chat.chatSourceBindingState(sent, replaced.repeat(6)), 'stale', 'a large unrelated paste is new material');
  assert.equal(chat.chatRequestContent('原文内容', '压缩为三点'), '原文：\n原文内容\n\n整理要求：\n压缩为三点');
  assert.deepEqual(JSON.parse(JSON.stringify(chat.chatSaveSnapshot('已编辑', { id: 8, url: 'https://x.test/8' }, { category: '写作', tags: ['镜头', '人物'] }))),
    { content: '已编辑', source: { id: 8, url: 'https://x.test/8' }, classification: { category: '写作', tags: '镜头,人物' } });
  assert.match(chatSource, /chatSourceBindingState\(binding, originalText\) === "stale"/);
  assert.match(chatSource, /保持关联/);
  assert.match(chatSource, /解除关联/);
});

/* ---------- AI settings ---------- */
test('AI settings describe website-service storage and report dirty state', () => {
  const settings = chatSource.slice(chatSource.indexOf('function AiSettingsModal'), chatSource.indexOf('const CHAT_CAPTURE_TEMPLATES'));
  for (const misleading of ['电脑上', '本机数据库', '保存在本机', '本地 Key', '本地凭据']) {
    assert.equal(settings.includes(misleading), false, misleading);
  }
  assert.match(settings, /本网站服务的数据库/);
  assert.match(settings, /onDirtyChange/);
  assert.match(settings, /留空沿用已保存的 Key/);
  assert.match(settings, /type="password"/);
});

test('embedded AI settings leave through the workspace dirty guard', () => {
  const center = read('public/settings.jsx');
  const workspace = read('public/app.jsx');
  assert.match(center, /<AiSettingsModal embedded initialTab=\{route\.aiTab\}\s*onClose=\{onClose\}/);
  assert.doesNotMatch(center, /markDirty\('ai', false\); onClose\(\)/);
  assert.match(workspace, /from === 'settings' && settingsDirty\.current/);
});

test('personal library views keep hand-created prompt and knowledge entry points', () => {
  const app = read('public/app.jsx');
  const knowledge = refinerySource.slice(refinerySource.indexOf('function KnowledgeLibraryView'), refinerySource.indexOf('function PromptExampleImage'));
  const prompts = refinerySource.slice(refinerySource.indexOf('function PromptLibraryView'));
  assert.match(knowledge, /onAdd && <button className="btn btn-primary knowledge-add"/);
  assert.match(prompts, /onAdd && <button className="btn btn-primary"/);
  assert.match(app, /onAdd=\{personalCatalogue && canUseFullApp \? \(\) => setModal\(\{type:'knowledge',item:null\}\)/);
  assert.match(app, /onAdd=\{personalCatalogue && canUseFullApp \? \(\) => setModal\(\{type:'drawer',prompt:null,mode:'create'\}\)/);
});

/* ---------- knowledge search + tags ---------- */
const refineryLogic = evaluate(
  refinerySource.slice(refinerySource.indexOf('function knowledgePlainText'), refinerySource.indexOf('function KnowledgeHighlight'))
    + block(refinerySource, 'knowledge-visible-match') + block(refinerySource, 'prompt-tag-label'),
  ['knowledgeVisibleMatch', 'knowledgeSearchPath', 'promptTagLabel', 'promptDisplayTags'],
  { AbortController, PROMPT_TAG_LABELS: { portrait: '人像', full_prompt: '完整提示词' } });

test('knowledge list merges local matches with scoped server body hits', () => {
  const item = { id: 12, title: '视频提示词', summary: '整理镜头结构', tags: [] };
  assert.equal(refineryLogic.knowledgeVisibleMatch(item, null, '', null).snippet, '整理镜头结构');
  assert.match(refineryLogic.knowledgeVisibleMatch(item, null, '镜头', null).snippet, /镜头/);
  assert.equal(refineryLogic.knowledgeVisibleMatch(item, null, '深层关键词', null), null);
  const hits = new Map([['12', '…正文里的深层关键词…']]);
  assert.equal(refineryLogic.knowledgeVisibleMatch(item, null, '深层关键词', hits).snippet, '…正文里的深层关键词…');
  assert.equal(refineryLogic.knowledgeSearchPath(' a&b '), '/api/knowledge-library/search?q=a%26b');
  assert.throws(() => refineryLogic.knowledgeSearchPath('a'.repeat(121)), /120/);
  const view = refinerySource.slice(refinerySource.indexOf('function KnowledgeLibraryView'), refinerySource.indexOf('function PromptExampleImage'));
  assert.doesNotMatch(view, /Math\.min\(3,\s*items\.length\)/, 'no per-article detail scan');
  assert.match(view, /api\(knowledgeSearchPath\(needle\), \{signal:controller\.signal\}\)/);
  assert.match(view, /controller\.abort\(\)/);
  assert.match(view, /queryTooLong/);
  assert.match(view, /搜索词不能超过 120 个字符/);
  assert.equal((view.match(/store\.load\(/g) || []).length, 1, 'detail cache loads only the selected article');
});

test('internal prompt tags become user-facing Chinese with a friendly fallback', () => {
  const { promptTagLabel, promptDisplayTags } = refineryLogic;
  assert.equal(promptTagLabel('portrait'), '人像');
  assert.equal(promptTagLabel('full_prompt'), '完整提示词');
  assert.equal(promptTagLabel('camera_motion'), '镜头运动');
  assert.equal(promptTagLabel('productDesign'), '产品设计');
  assert.equal(promptTagLabel('agent_or_software'), 'agent or software'.replace('agent', '智能体'));
  assert.equal(promptTagLabel('foo_bar'), 'foo bar');
  assert.equal(promptTagLabel('运镜'), '运镜');
  assert.equal(promptTagLabel('Midjourney'), 'Midjourney');
  assert.equal(promptTagLabel(''), '');
  assert.deepEqual(JSON.parse(JSON.stringify(promptDisplayTags(['portrait', '人像', '', 'camera_motion']))), ['人像', '镜头运动']);
  assert.match(promptsSource, /promptTagLabel/);
});

/* ---------- server route ---------- */
test('lib/api.js compiles and the search route reuses list guards and bulk body queries', () => {
  assertModuleSyntax(apiSource, 'lib/api.js');
  const route = apiSource.slice(apiSource.indexOf('if (route === "GET /api/knowledge-library/search")'));
  assert.match(route, /ownerContext\(req\)/);
  assert.match(route, /hasPersonalLibraryAccess\(req, owner, privateAccess\)/);
  const helper = apiSource.slice(apiSource.indexOf('function searchKnowledgeLibrary'));
  assert.match(helper, /libraryCuration\.methods\(ownerId, \{ publicOnly \}\)/);
  assert.match(helper, /contentStore\.knowledge\(ownerId, \{ publicOnly \}\)/);
  assert.match(helper, /sourceArticles\.list\(ownerId, \{ privateAccess,/);
  assert.match(helper, /listKnowledgeArticles\(ownerId, \{ publicOnly \}\)/);
  assert.match(helper, /includeManual \? manualAll : \[\]/);
  assert.match(apiSource, /json_each/);
  assert.doesNotMatch(helper, /getKnowledgeArticle\(/, 'no per-article detail reads');
  // The search path must not be swallowed by the detail route.
  const detail = /^\/api\/knowledge-library\/(\d+|archive-\d+|method-\d+|manual-knowledge-\d+|pipeline-(?:source-)?\d+)$/;
  assert.equal(detail.test('/api/knowledge-library/search'), false);
});

/* ---------- JSX syntax (best effort: only when a transformer is installed) ---------- */
test('changed JSX files compile', async (t) => {
  let transform = null;
  try {
    const esbuild = await import('esbuild');
    transform = (code) => esbuild.transformSync(code, { loader: 'jsx' });
  } catch {
    try {
      const babel = await import('@babel/standalone');
      transform = (code) => (babel.default || babel).transform(code, { presets: ['react'] });
    } catch { /* no transformer */ }
  }
  if (!transform) { t.skip('esbuild/@babel/standalone not installed in this snapshot'); return; }
  for (const file of ['public/chat.jsx', 'public/prompts.jsx', 'public/refinery.jsx', 'public/detail-drawer.jsx']) {
    assert.doesNotThrow(() => transform(read(file)), file);
  }
});

/* ---------- live privacy check (needs the full app and child processes) ---------- */
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('guest search returns public body hits only, never private sources', async (t) => {
  if (!fs.existsSync(path.join(root, 'server.js'))) { t.skip('server.js is not part of this snapshot'); return; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnihub-search-'));
  const setup = `
    import { db } from "./lib/db.js";
    import { hashPassword } from "./lib/auth.js";
    import { upsertKnowledgeArticle } from "./lib/knowledge-store.js";
    const credential = hashPassword('test-password');
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'zane', ?, ?)").run(credential.hash, credential.salt);
    const insert = db.prepare(\`INSERT INTO inbox (id, user_id, source, external_id, title, url, author, content, visibility)
      VALUES (?, 1, 'x', ?, ?, ?, ?, ?, ?)\`);
    insert.run(1, '101', '公开收藏', 'https://x.com/a/status/101', '@a', '公开来源正文', 'public');
    insert.run(2, '202', '私密收藏', 'https://x.com/b/status/202', '@b', '私密来源正文', 'private');
    const check = { verdict: { value: 'supported', answer: { confidence: .9 } }, needsReview: false };
    upsertKnowledgeArticle(1, { subjectId: 'public-subject', markdown: '# 公开知识\\\\n\\\\n正文结论。[S:101]\\\\n\\\\n## 细节\\\\n\\\\n这里藏着公开深层词汇。\\\\n',
      tags: ['测试'], claims: [{ id: 'c1', text: '正文结论', sourceIds: ['101'], check }] });
    upsertKnowledgeArticle(1, { subjectId: 'private-subject', markdown: '# 私密知识\\\\n\\\\n敏感结论。[S:202]\\\\n\\\\n## 细节\\\\n\\\\n这里藏着私密深层词汇。\\\\n',
      claims: [{ id: 'c2', text: '敏感结论', sourceIds: ['202'], check }] });
    db.close();
  `;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', setup], { cwd: root, env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: 'utf8' });
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    t.skip(`database setup unavailable here: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), OMNIHUB_DATA_DIR: dataDir,
      OMNIHUB_CONTENT_WORKER: 'false', OMNIHUB_X_BOOKMARK_SYNC: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  child.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { if ((await request('/')).ok) { ready = true; break; } } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, serverError);
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zane', password: 'test-password' }) });
    assert.equal(login.status, 200, serverError);
    const ownerCookie = login.headers.get('set-cookie').split(';')[0];
    const manual = await request('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ title: '仅本人手工笔记', body: '只在 mine 可见的手工命中词', tags: '私密' }) });
    assert.equal(manual.status, 200, serverError);
    const list = await (await request('/api/knowledge-library?scope=public')).json();
    assert.equal(list.length, 1);
    const hit = await request(`/api/knowledge-library/search?scope=public&q=${encodeURIComponent('公开深层词汇')}`);
    assert.equal(hit.status, 200, serverError);
    const found = await hit.json();
    assert.deepEqual(found.results.map((row) => String(row.id)), [String(list[0].id)]);
    assert.match(found.results[0].snippet, /公开深层词汇/);
    assert.equal('body' in found.results[0], false, 'no full text in search results');
    const hidden = await (await request(`/api/knowledge-library/search?scope=public&q=${encodeURIComponent('私密深层词汇')}`)).json();
    assert.equal(hidden.total, 0);
    assert.equal(JSON.stringify(hidden).includes('敏感结论'), false);
    const sensitive = await (await request(`/api/knowledge-library/search?scope=public&q=${encodeURIComponent('敏感')}`)).json();
    assert.equal(sensitive.total, 0, 'private articles never match');
    assert.equal((await request('/api/knowledge-library/search?scope=public&q=')).status, 400);
    assert.equal((await request(`/api/knowledge-library/search?scope=public&q=${'a'.repeat(121)}`)).status, 400, 'oversized query is rejected, never silently prefix-matched');
    const ownerMine = await (await request(`/api/knowledge-library/search?scope=mine&q=${encodeURIComponent('手工命中词')}`, { headers: { Cookie: ownerCookie } })).json();
    assert.equal(ownerMine.total, 1, 'owner mine scope includes manual assets');
    assert.match(ownerMine.results[0].snippet, /手工命中词/);
    const otherLogin = await request('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: 'test-password' }) });
    const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
    const otherMine = await (await request(`/api/knowledge-library/search?scope=mine&q=${encodeURIComponent('手工命中词')}`, { headers: { Cookie: otherCookie } })).json();
    assert.equal(otherMine.total, 0, 'another signed-in account cannot search the owner manual asset');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
