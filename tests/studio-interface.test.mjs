import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { normalizeGeneration } from '../lib/media-provider.js';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const mediaCode = transformSync(read('media.jsx'), { loader: 'jsx', jsx: 'transform' }).code;
const selectCode = transformSync(read('reference-library.jsx').split('// Match the preview surface')[0], { loader: 'jsx', jsx: 'transform' }).code;
const draftCode = read('studio-draft.js');

function render({ draft = {}, assets = [], jobs = [], view = 'input', allowExternal = true } = {}) {
  const data = new Map();
  const Icon = () => React.createElement('svg', { 'aria-hidden': true });
  const context = vm.createContext({
    React: { ...React, useLayoutEffect: React.useEffect }, URLSearchParams, location: { hash: `#studio?view=${view}` },
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
    IconSettings: Icon, IconPalette: Icon, IconPlus: Icon, IconX: Icon, IconRefresh: Icon,
  });
  vm.runInContext(draftCode + '\n' + selectCode + '\n' + mediaCode, context);
  vm.runInContext('writeStudioDraft', context)(1, { prompt: 'A quiet forest', ...draft });
  return renderToStaticMarkup(React.createElement(vm.runInContext('MediaStudioView', context), {
    userId: 1, assets, jobs, allowExternal, canCollect: true,
    onAssetsChanged() {}, onJobsChanged() {}, onOpenSettings() {}, onShowAsset() {}, showToast() {},
  }));
}

function renderPicker({ assets, references = [], capabilities, search = '', disabled = false }) {
  const context = vm.createContext({
    React: { ...React, useLayoutEffect: React.useEffect },
    DetailDrawer: ({ title, actions, children, className, id }) => React.createElement('aside', { role: 'dialog', 'aria-label': title, className, id }, actions, children),
  });
  vm.runInContext(selectCode + '\n' + mediaCode, context);
  return renderToStaticMarkup(React.createElement(vm.runInContext('StudioReferencePicker', context), {
    assets, references, capabilities, search, disabled, onSearch() {}, onToggle() {}, onClose() {},
  }));
}

test('reference picking uses a drawer without navigation away from the current draft', () => {
  const html = renderPicker({ assets: [{ id: 'a', kind: 'image', title: 'Forest' }], capabilities: { kinds: ['image'], maxRefs: 8 } });
  assert.match(html, /role="dialog" aria-label="选择参考素材"/);
  assert.match(html, /studio-reference-drawer/);
  assert.match(html, /搜索参考素材/);
  assert.match(html, /选择参考 Forest/);
  assert.doesNotMatch(html, /打开素材库|href="#|studio-picker-footer/);
});

test('picker respects mode limits and still lets selected references be removed', () => {
  const images = ['a', 'b', 'c'].map(id => ({ id, kind: 'image', title: id }));
  const html = renderPicker({ assets: [...images, { id: 'v', kind: 'video', title: 'Unsupported video' }], references: images.slice(0, 2), capabilities: { kinds: ['image'], maxRefs: 2 } });
  assert.match(html, /aria-label="选择参考 a"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /aria-label="选择参考 a"[^>]*disabled/);
  assert.match(html, /aria-label="选择参考 c"[^>]*disabled=""/);
  assert.doesNotMatch(html, /Unsupported video/);
});

test('picker enforces media-kind limits independently and explains an empty search', () => {
  const assets = [{ id: 'a', kind: 'image', title: 'Portrait' }, { id: 'b', kind: 'image', title: 'Forest' }, { id: 'v', kind: 'video', title: 'Clip' }];
  const capabilities = { kinds: ['image', 'video'], maxRefs: 3, maxByKind: { image: 1, video: 1 } };
  const html = renderPicker({ assets, references: assets.slice(0, 1), capabilities });
  assert.match(html, /aria-label="选择参考 Forest"[^>]*disabled=""/);
  assert.doesNotMatch(html, /aria-label="选择参考 Clip"[^>]*disabled/);
  assert.match(renderPicker({ assets, capabilities, search: 'no match' }), /没有找到匹配的素材/);
});

test('picker groups mixed assets by media kind rather than repeating type labels on cards', () => {
  const assets = [{ id: 'v', kind: 'video', title: 'Clip' }, { id: 'a', kind: 'audio', title: 'Sound' }, { id: 'i', kind: 'image', title: 'Portrait' }];
  const html = renderPicker({ assets, capabilities: { kinds: ['image', 'video', 'audio'], maxRefs: 8 } });
  assert.ok(html.indexOf('aria-label="图片素材"') < html.indexOf('aria-label="视频素材"'));
  assert.ok(html.indexOf('aria-label="视频素材"') < html.indexOf('aria-label="音频素材"'));
  assert.equal((html.match(/class="studio-material-group is-/g) || []).length, 3);
  assert.doesNotMatch(html, /studio-material-card-footer|aria-label="素材类型"/);
  const searched = renderPicker({ assets, capabilities: { kinds: ['image', 'video', 'audio'], maxRefs: 8 }, search: 'Portrait' });
  assert.match(searched, /aria-label="图片素材"/);
  assert.doesNotMatch(searched, /aria-label="视频素材"|aria-label="音频素材"/);
});

test('drawer selection stays locked while generation or an upload is in progress', () => {
  const asset = { id: 'a', kind: 'image', title: 'Forest' };
  const html = renderPicker({ assets: [asset], references: [asset], capabilities: { kinds: ['image'], maxRefs: 8 }, disabled: true });
  assert.match(html, /aria-label="选择参考 Forest"[^>]*disabled=""/);
  assert.match(html, /aria-label="预览素材 Forest"/);
});

test('the actual prompt is editable before service settings and auxiliary templates stay collapsed', () => {
  const html = render();
  assert.match(html, /<label for="studio-prompt">画面描述<\/label>/);
  assert.ok(html.indexOf('<textarea id="studio-prompt"') < html.indexOf('生成服务'));
  assert.match(html, /A quiet forest/);
  assert.match(html, /<details[^>]*><summary>角色、风格与更多设置/);
  assert.doesNotMatch(html, /<details[^>]*open=""[^>]*><summary>角色、风格与更多设置/);
});

test('an unconfigured API keeps the draft editable without offering a paid submit button', () => {
  const html = render({ draft: { module: 'image', generationRoute: 'api' } });
  assert.match(html, /配置媒体服务/);
  assert.match(html, /尚未配置可用的媒体服务/);
  assert.doesNotMatch(html, /<button[^>]*>生成(?:图片|视频|\s*\d+ 张图片)<\/button>/);
  assert.doesNotMatch(html, /studio-consent/);
});

test('image model settings do not expose video duration and resolution', () => {
  const html = render({ draft: { module: 'image', generationRoute: 'api', model: 'gpt-image-2' } });
  assert.match(html, />画面比例</);
  assert.match(html, /生成数量/);
  assert.doesNotMatch(html, /时长（秒）|>分辨率<|>清晰度</);
});

test('local generation shows the fixed engine without inventing a selectable image model', () => {
  const html = render({ draft: { generationRoute: 'local', model: 'gpt-image-2' } });
  assert.match(html, /aria-label="生图模型"[^>]*readOnly=""[^>]*value="Codex 原生生图"/i);
  assert.match(html, /未回传具体型号/);
  assert.match(html, /aria-label="执行设备"[^>]*disabled=""/);
  assert.match(html, /未连接设备/);
  assert.doesNotMatch(html, /<option value="gpt-image-2">/);
});

test('API image generation offers every supported image model separately from local devices', () => {
  const html = render({ draft: { generationRoute: 'api' } });
  for (const model of ['nano-banana-pro', 'gpt-image-2', 'seedream-5.0-pro', 'gpt-image-2-flare']) assert.ok(html.includes(`value="${model}"`));
  assert.doesNotMatch(html, /aria-label="执行设备"|未回传具体型号/);
});

test('video providers expose only their supported mode and resolution controls', () => {
  const happyHorse = render({ draft: { module: 'hh1', generationRoute: 'api', mode: 'text' } });
  assert.match(happyHorse, /镜头描述/);
  assert.match(happyHorse, /文生视频/);
  assert.match(happyHorse, /时长（秒）/);
  assert.doesNotMatch(happyHorse, /首帧／首尾帧|>分辨率<|生成数量/);
  const wan = render({ draft: { module: 'wan3', generationRoute: 'api' } });
  assert.match(wan, /1080p/);
  assert.match(wan, /首帧／首尾帧/);
});

test('reference previews cannot masquerade as successful generated results', () => {
  const image = { id: 'ref-1', title: 'Input reference', kind: 'image', origin: 'reference' };
  const html = render({ assets: [image], draft: { referenceIds: ['ref-1'] } });
  assert.match(html, />参考预览</);
  assert.match(html, />图片参考</);
  assert.match(html, /从草稿移除/);
  assert.doesNotMatch(html, /基于此结果继续|复用提示词/);
  const resultView = render({ assets: [image], draft: { referenceIds: ['ref-1'] }, view: 'result' });
  assert.doesNotMatch(resultView, /图片参考|Input reference/);
  assert.match(resultView, /还没有已保存的结果/);
});

test('record and result routes contain their own content without remounting a hidden generator', () => {
  const jobs = render({ view: 'jobs' });
  assert.match(jobs, /最近任务/);
  assert.doesNotMatch(jobs, /<textarea|生成结果会显示在这里/);
  const result = render({ view: 'result' });
  assert.match(result, /生成结果/);
  assert.doesNotMatch(result, /<textarea|最近任务/);
});

test('restricted accounts do not gain a video or API selector from the redesign', () => {
  const html = render({ allowExternal: false });
  assert.match(html, /<button[^>]*disabled=""[^>]*>视频<\/button>/);
  assert.doesNotMatch(html, /<option value="api">|<label>视频服务/);
});

// Check UI boundaries against the actual provider validator, not another copy of the limits.
test('visible duration and first/last-frame limits agree with the provider contract', () => {
  const context = vm.createContext({ React });
  vm.runInContext(mediaCode, context);
  const capabilities = vm.runInContext('mediaStudioCapabilities', context);
  for (const [module, model, mode] of [['seedance', 'seedance2.0', 'text_video'], ['seedance', 'seedance2.5', 'text_video'], ['wan3', 'wan3.0-video', 'text_video'], ['hh1', 'hh1', 'text']]) {
    const limits = capabilities(module, model, mode);
    const input = { module, model, mode, prompt: 'A quiet forest', aspectRatio: '16:9', resolution: '720p' };
    for (const duration of [limits.durationMin, limits.durationMax]) assert.doesNotThrow(() => normalizeGeneration({ ...input, duration }, []));
    for (const duration of [limits.durationMin - 1, limits.durationMax + 1]) assert.throws(() => normalizeGeneration({ ...input, duration }, []));
  }
  const refs = [{ id: 'first', kind: 'image', url: 'https://example.com/first.png' }, { id: 'last', kind: 'image', url: 'https://example.com/last.png' }];
  const input = { module: 'seedance', model: 'seedance2.0', mode: 'first_last_frame', prompt: 'A quiet forest', aspectRatio: '16:9', duration: 5, resolution: '720p' };
  assert.equal(capabilities(input.module, input.model, input.mode).maxRefs, refs.length);
  const issue = vm.runInContext('mediaStudioReferenceIssue', context);
  assert.match(issue([], capabilities(input.module, input.model, input.mode)), /首帧/);
  assert.equal(issue(refs, capabilities(input.module, input.model, input.mode)), '');
  assert.doesNotThrow(() => normalizeGeneration(input, refs));
  assert.throws(() => normalizeGeneration(input, [...refs, { ...refs[0], id: 'third' }]));
});
