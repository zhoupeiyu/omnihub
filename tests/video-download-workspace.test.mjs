import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../public/video-tools.jsx', import.meta.url), 'utf8');
const media = readFileSync(new URL('../public/media-processing.jsx', import.meta.url), 'utf8').split('function useMediaJobs')[0];
const compiled = (await transform(source, { loader: 'jsx' })).code;

function renderDownload(text) {
  const requests = [], errors = [], selectedMedia = [];
  const hash = `#media-tools?${new URLSearchParams({ tab: 'download', text })}`;
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: { location: { hash } },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: initial => ({ current: initial }), useEffect: () => {},
    },
    workspaceHashName: value => value.split('?')[0].replace(/^#/, ''),
    workspaceHashParams: value => new URLSearchParams(value.split('?')[1]),
    api: async (path, options) => {
      requests.push({ path, body: options.body });
      return path.endsWith('/batch') ? { jobs: [{ id: 'batch-result' }] } : { id: 'single-result' };
    },
  });
  for (const name of new Set(source.match(/\bIcon\w+/g))) context[name] = () => null;
  vm.runInContext(media, context);
  vm.runInContext(compiled, context);
  context.useToolData = () => ({ jobs: [], status: { scope: 'public', available: true }, update: () => {}, setError: error => errors.push(error), error: '', loading: false, refresh: async () => {} });
  context.useMediaJobs = () => ({ jobs: [], status: { scope: 'public', available: true }, update: job => selectedMedia.push(job.id) });
  const tree = context.ToolShell({ tool: { id: 'video-download', icon: () => null }, active: true, hash, space: 'public' });
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'form') return node;
    for (const child of (Array.isArray(node) ? node : node.props?.children || [])) {
      const result = find(child);
      if (result) return result;
    }
    return null;
  };
  return { requests, errors, selectedMedia, submit: () => find(tree).props.onSubmit({ preventDefault() {} }) };
}

test('one share link uses the single parser and preserves the share text', async () => {
  const text = '分享文案 https://v.douyin.com/abc/。';
  const screen = renderDownload(text);
  await screen.submit();
  assert.equal(screen.requests.length, 1);
  assert.equal(screen.requests[0].path, '/api/tools/video/jobs');
  assert.equal(screen.requests[0].body.text, text);
});

test('one expanded-platform link uses the media engine', async () => {
  const screen = renderDownload('分享 https://x.com/example/status/123');
  await screen.submit();
  assert.equal(screen.requests.length, 1);
  assert.equal(screen.requests[0].path, '/api/tools/media/jobs');
  assert.deepEqual(screen.selectedMedia, ['single-result']);
});

test('multiple links in share text use exactly one batch request', async () => {
  const text = '第一条 https://v.douyin.com/abc/\n第二条 https://www.bilibili.com/video/BV123';
  const screen = renderDownload(text);
  await screen.submit();
  assert.equal(screen.requests.length, 1);
  assert.equal(screen.requests[0].path, '/api/tools/video/batch');
  assert.equal(screen.requests[0].body.text, text);
});

test('mixed unsupported batch links do not create a partial single job', async () => {
  const screen = renderDownload('https://v.douyin.com/abc/\n分享：https://x.com/example/status/123');
  await screen.submit();
  assert.equal(screen.requests.length, 0);
  assert.match(screen.errors.at(-1), /暂不支持批量/);
});

test('over-limit batches are rejected before making a request', async () => {
  const screen = renderDownload(Array.from({ length: 21 }, (_, index) => `https://v.douyin.com/${index}/`).join('\n'));
  await screen.submit();
  assert.equal(screen.requests.length, 0);
  assert.match(screen.errors.at(-1), /最多解析 20 条/);
});

test('empty input does not create a task', async () => {
  const screen = renderDownload('  ');
  await screen.submit();
  assert.equal(screen.requests.length, 0);
});

test('downloads without a media preview keep their file download link', async () => {
  const mediaSource = readFileSync(new URL('../public/media-processing.jsx', import.meta.url), 'utf8').split('function MediaProcessingTool')[0];
  const context = vm.createContext({ URLSearchParams,
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: value => [value, () => {}] },
    IconCopy: () => null, IconDownload: () => null, videoFileSize: () => '1 KB',
  });
  vm.runInContext((await transform(mediaSource, { loader: 'jsx' })).code, context);
  const tree = context.MediaProcessingResult({ job: { id: 'text-result', engine: 'media', state: 'saved', operation: 'download', files: [{ name: 'captions.vtt', type: 'text/vtt', bytes: 100 }] }, downloadWorkspace: true });
  const links = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'a') links.push(node.props.href);
    for (const child of (Array.isArray(node) ? node : node.props?.children || [])) visit(child);
  };
  visit(tree);
  assert.ok(links.includes('/api/tools/media/jobs/text-result/files/captions.vtt'));
});

function renderWorkspace(tab = 'library') {
  const effects = [], refs = [], listeners = new Map();
  const hash = `#media-tools?tab=${tab}&space=mine`;
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { hash }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: initial => [initial, () => {}],
      useRef: initial => { const ref = { current: initial }; refs.push(ref); return ref; },
      useEffect: callback => effects.push(callback),
    },
    workspaceHashName: value => value.split('?')[0].replace(/^#/, ''),
    workspaceHashParams: value => new URLSearchParams(value.split('?')[1]),
  });
  for (const name of [...new Set(source.match(/\bIcon\w+/g)), 'MediaProcessingTool', 'MediaTextWorkspace', 'MediaCollectionWorkspace', 'MediaDiscoveryTool']) context[name] = () => null;
  vm.runInContext(compiled, context);
  const tree = context.VideoToolsWorkspace({ active: true, userKey: 'test' });
  const nodes = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.props) nodes.push(value);
    for (const child of (Array.isArray(value) ? value : value.props?.children || [])) visit(child);
  };
  visit(tree);
  return { context, effects, refs, listeners, tabs: nodes.filter(node => node.props.role === 'tab'), list: nodes.find(node => node.props.role === 'tablist') };
}

test('workspace arrow navigation wraps, preserves private scope and has one tab stop', () => {
  const screen = renderWorkspace();
  assert.equal(screen.tabs.filter(tab => tab.props.tabIndex === 0).length, 1);
  let focused = -1, prevented = false;
  const controls = screen.tabs.map((_, index) => ({ focus: () => { focused = index; } }));
  screen.refs[0].current = { querySelectorAll: () => controls };
  screen.list.props.onKeyDown({ key: 'ArrowRight', target: controls.at(-1), preventDefault: () => { prevented = true; } });
  assert.equal(focused, 0);
  assert.equal(prevented, true);
  assert.equal(screen.context.window.location.hash, '#media-tools?tab=download&space=mine');
  screen.list.props.onKeyDown({ key: 'End', target: controls[0], preventDefault() {} });
  assert.equal(focused, controls.length - 1);
  assert.equal(screen.context.window.location.hash, '#media-tools?tab=library&space=mine');
});

test('active tab is revealed on entry and after narrowing the viewport', () => {
  const screen = renderWorkspace();
  let width = 900;
  const list = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: width }), querySelector: () => ({ getBoundingClientRect: () => ({ left: 660 - list.scrollLeft, right: 740 - list.scrollLeft }) }) };
  screen.refs[0].current = list;
  const cleanup = screen.effects[0]();
  assert.equal(list.scrollLeft, 0);
  width = 350;
  screen.listeners.get('resize')();
  assert.equal(list.scrollLeft, 398);
  cleanup();
  assert.equal(screen.listeners.has('resize'), false);
});
