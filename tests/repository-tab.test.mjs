import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mountRepositoryExplorer } from '../public/repository-explorer-prototype.js';
import { repositoryLocation } from '../public/repository-navigation.js';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
test('workspace routing opens a deep link and switches tabs without leaving the application', () => {
  const handlers = new Map();
  let state;
  let cleanup;
  const location = { hash: '#repositories?space=mine' };
  const context = vm.createContext({
    URLSearchParams,
    window: { location, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) },
    React: {
      useRef: initial => ({current:initial}),
      useState: initial => { state = initial(); return [state, value => { state = value; }]; },
      useEffect: fn => { cleanup = fn(); },
    },
  });
  vm.runInContext(read('repository-tab.js').slice(read('repository-tab.js').indexOf('function useWorkspaceSection')), context);
  const [initial, setSection] = context.useWorkspaceSection('feed');
  assert.equal(initial, 'repositories');
  setSection('inbox');
  assert.equal(state, 'inbox');
  assert.equal(location.hash, '#inbox?space=mine');
  location.hash = '#repositories?topic=design&use=design.portrait&space=mine';
  handlers.get('hashchange')();
  assert.equal(state, 'repositories');
  setSection('inbox');
  setSection('repositories');
  assert.equal(location.hash, '#repositories?topic=design&use=design.portrait&space=mine');
  location.hash = '#unknown';
  handlers.get('hashchange')();
  assert.equal(state, 'feed');
  cleanup();
  assert.equal(handlers.size, 0);
});

test('repository navigation is a workspace tab and old URLs return to that tab', () => {
  assert.equal(typeof mountRepositoryExplorer, 'function');
  assert.doesNotMatch(read('components.jsx'), /href: "\/repositories.html"|window.location.assign/);
  assert.match(read('app.jsx'), /<RepositoryExplorerTab key=/);
  for (const file of ['repository-explorer-prototype.html', 'repositories.html']) {
    assert.match(read(file), /window.location.replace\("\/#repositories"\)/);
  }
  assert.doesNotMatch(read('repository-tab.html'), /<aside|<iframe|class="topbar"/);
  assert.match(read('repository-explorer-prototype.js'), /lifetime.abort\(\)/);
  assert.match(read('repository-explorer-prototype.js'), /detailRequest\?\.abort\(\)/);
});

test('repository tabs stay mounted and no longer duplicate the header search', () => {
  assert.match(read('app.jsx'), /active=\{section === "repositories"\}/);
  assert.match(read('app.jsx'), /showSearch=\{!\["repositories", "knowledgeLibrary"\]\.includes\(section\) && !\(section === "feed"/);
  assert.match(read('app.jsx'), /sectionQueries\[queryKey\]/);
  assert.doesNotMatch(read('repository-explorer-prototype.js'), /showModal\(/);
  assert.match(read('repository-tab.html'), /class="repository-detail detail-drawer"/);
});

test('repository links retain the catalogue space on deep links and history navigation', () => {
  const hash = repositoryLocation({ section:'design', use:'design.portrait', form:'all', query:'portrait', sort:'default', detail:'owner/repo' }, '#repositories?space=mine');
  assert.equal(hash, '#repositories?space=mine&topic=design&use=design.portrait&q=portrait&repo=owner%2Frepo');
  assert.equal(repositoryLocation({ section:'overview', use:'all', form:'all', query:'', sort:'default', detail:'' }, '#repositories?space=public'), '#repositories?space=public&topic=overview');
});

test('repository details overlay the catalogue without resizing or scrolling the list', () => {
  const css = read('detail-drawer.css');
  const renderer = read('repository-explorer-prototype.js');
  assert.match(css, /\.detail-drawer \{[^}]*position:fixed/);
  assert.match(css, /\.detail-drawer-body \{[^}]*overscroll-behavior:contain/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css, /detail-open|container-type:/);
  assert.doesNotMatch(renderer, /detail-open/);
  const openDetail = renderer.slice(renderer.indexOf('async function openDetail('), renderer.indexOf('async function load('));
  assert.doesNotMatch(openDetail, /window\.scrollTo|scrollIntoView/);
  assert.match(openDetail, /dialog\.focus\(\{preventScroll:true\}\)/);
  assert.match(read('repository-tab.html'), /role="dialog" aria-label="仓库详情"/);
});

test('a guide loads independently of citations and a stale drawer cannot receive its result', () => {
  const renderer = read('repository-explorer-prototype.js');
  assert.match(renderer, /loadRepositoryGuide\(key, \{signal:controller\.signal\}\)/);
  assert.match(renderer, /state\.detail !== key \|\| dialog\.hidden/);
  assert.match(renderer, /void \(async \(\) =>/);
  assert.match(renderer, /\$\('detail-evidence'\)\.innerHTML = evidenceMarkup\(detail\)/);
  assert.match(renderer, /const media = activeGuide\?\.media \|\| \[\]/);
  assert.match(renderer, /activeGuide = guide/);
});

test('compact module navigation retains names and remains accessible on desktop', () => {
  const components = read('components.jsx');
  assert.match(components, /aria-label=\{m.label\} tooltip=\{m.label/);
  assert.match(components, /const hidden = mobile && collapsed/);
  assert.match(components, /inert=\{hidden \? "" : undefined\}/);
  assert.match(components, /展开模块名称/);
  assert.match(components, /className="workspace-context" hidden=\{collapsed\}/);
  assert.match(read('repository-workspace.css'), /\.workspace-navigation\.collapsed \{ opacity:1/);
});

test('the header is the single control for module labels and mobile navigation visibility', () => {
  const components = read('components.jsx');
  const app = read('app.jsx');
  const footer = components.split('<div className="sidebar-foot">')[1].split('{hasContext &&')[0];
  assert.match(components, /function Header\([^)]*moduleLabels, onToggleModuleLabels/);
  assert.match(components, /onClick=\{mobile \? onToggleSidebar : onToggleModuleLabels\}/);
  assert.match(components, /aria-label=\{navigationTitle\}/);
  assert.doesNotMatch(footer, /module-label-toggle|展开模块名称|收起模块名称/);
  assert.doesNotMatch(components, /const \[moduleLabels, setModuleLabels\] = useState/);
  assert.match(app, /const \[moduleLabels, setModuleLabels\] = useAppState\(false\)/);
  assert.match(app, /setSidebarCollapsed\(event\.matches\)/);
  assert.match(app, /if \(event\.matches\) setModuleLabels\(false\)/);
  assert.match(app, /onToggleModuleLabels=\{\(\) => setModuleLabels/);
  assert.match(app, /moduleLabels=\{moduleLabels\}/);
});

test('icon navigation has explicit hover and keyboard tooltips without a duplicate active stripe', () => {
  const components = read('components.jsx');
  const css = read('repository-workspace.css');
  assert.match(components, /function ModuleRailButton\(/);
  assert.match(components, /role="tooltip"/);
  assert.match(components, /aria-describedby=\{position \? tooltipId : undefined\}/);
  assert.match(components, /onPointerEnter=/);
  assert.match(components, /pointerType !== "touch"/);
  assert.match(components, /matches\(":focus-visible"\)/);
  assert.match(components, /event.key === "Escape"/);
  assert.match(components, /ref=\{buttonRef\}/);
  assert.match(css, /\.module-tooltip \{[\s\S]*?position:fixed/);
  assert.match(css, /\.module-rail \.module-button.active \{[^}]*color:var\(--accent\)/);
  assert.doesNotMatch(css, /\.module-nav \.module-button.active::after/);
});

test('the account avatar is the only settings trigger and anchors its menu to the icon rail', () => {
  const components = read('components.jsx');
  const footer = components.split('<div className="sidebar-foot">')[1].split('{hasContext &&')[0];
  assert.match(components, /const menuTriggerRef = React\.useRef\(null\)/);
  assert.doesNotMatch(components, /gearRef|closest\("\.sidebar"\)/);
  assert.match(components, /left: \(r\.right \+ 8\) \+ "px"/);
  assert.equal((footer.match(/buttonRef=\{menuTriggerRef\}/g) || []).length, 1);
  assert.doesNotMatch(footer, /aria-label="设置"/);
  assert.match(footer, /账号与设置：\$\{user\.username\}/);
  assert.match(footer, /aria-haspopup=\{user \? "menu" : undefined\}/);
  for (const label of ['账号与连接', 'AI 设置', '深色模式', '悬浮木鱼', '皮肤', '退出登录']) {
    assert.ok(footer.includes(label), `missing settings action: ${label}`);
  }
});

test('repository data and view assets load together before the skeleton is replaced', async () => {
  const requests = [];
  let finishModule;
  const module = new Promise(resolve => { finishModule = resolve; });
  const context = vm.createContext({ fetch: async url => {
    requests.push(url);
    return { ok: true, json: async () => [{ key: 'example/tool' }], text: async () => 'static content' };
  }});
  vm.runInContext(read('repository-tab.js'), context);
  const result = context.loadRepositoryTab(undefined, () => module);
  assert.deepEqual(requests, ['/api/repositories', '/repository-tab.html', '/repository-explorer-prototype.css', '/repository-tab.css', '/detail-drawer.css']);
  finishModule({ mountRepositoryExplorer() {} });
  assert.equal((await result).repositories.length, 1);
  assert.match(read('repository-tab.js'), /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(read('repository-tab.js'), /root.innerHTML = '<p role="status">/);
});

test('invalid repository responses fail instead of rendering a misleading empty library', async () => {
  const context = vm.createContext({ fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }) });
  vm.runInContext(read('repository-tab.js'), context);
  await assert.rejects(context.loadRepositoryTab(undefined, async () => ({})), /Invalid repository library/);
});

test('feed monitoring has a discoverable secondary navigation and reports the actual limiter', () => {
  const app = read('app.jsx');
  const components = read('components.jsx');
  const watchCss = read('x-watch.css');
  const workspaceCss = read('repository-workspace.css');
  assert.match(components, /feedNavigation, onFeedNavigate/);
  assert.match(components, /<strong>资讯与监听<\/strong>/);
  assert.match(components, /aria-label="资讯与监听"/);
  for (const label of ['AIHOT 资讯', '监听动态', '关注热点', '监听账号']) {
    assert.ok(app.includes(`title:"${label}"`), `missing feed navigation action: ${label}`);
  }
  assert.match(app, /feedNavigation=\{section === "feed" && canUseFullApp/);
  assert.match(app, /writeFeedMode\(mode\)/);
  assert.match(watchCss, /\.watch-tabs\{display:none/);
  assert.match(watchCss, /@media\(max-width:860px\)\{\.watch-tabs\{display:flex\}\}/);
  assert.match(workspaceCss, /\.feed-side-group \.watch-navigation-item:nth-child\(2\)/);
  assert.match(app, /已达到 24 小时请求上限/);
  assert.match(app, /24 小时采集费用预算不足/);
  assert.match(app, /31 天 SocialData 费用上限不足/);
  assert.match(app, /中文整理：/);
  assert.doesNotMatch(app, /budgetBlocked\?'采集预算不足/);
});
