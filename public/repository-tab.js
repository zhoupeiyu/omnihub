const repositoryLoadingStyles = `
.repository-loading{padding:6px 0 20px;min-height:640px;animation:repository-loading-enter .2s cubic-bezier(.2,0,0,1)}
.repository-loading-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.repository-loading-heading{display:flex;justify-content:space-between;gap:24px;margin-bottom:24px}
.repository-loading-heading>div:first-child{flex:1;min-width:0}
.repository-loading .sk-line{animation:none;max-width:100%;background-color:var(--bg-sunken)}
.repository-loading-heading .sk-line:first-child,.repository-loading-grid>div:nth-child(3n+1) .sk-line:first-child{animation:skShimmer 1.8s ease-in-out infinite}
.repository-loading-title{width:310px;height:30px!important;margin-bottom:13px}
.repository-loading-description{width:365px;height:12px}
.repository-loading-total{width:42px;height:30px!important}
.repository-loading-tabs{display:flex;gap:9px;margin-bottom:18px}
.repository-loading-tabs .sk-line{width:105px;height:32px}
.repository-loading-search{height:49px;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:18px 16px;margin-bottom:28px}
.repository-loading-search .sk-line{width:270px;height:11px}
.repository-loading-label{width:155px;height:13px!important;margin-bottom:15px}
.repository-loading-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}
.repository-loading-tile{min-height:78px;border:1px solid var(--border);border-radius:11px;padding:18px 17px;background:var(--surface)}
.repository-loading-tile .sk-line:first-child{width:52%;height:12px;margin-bottom:12px}
.repository-loading-tile .sk-line:last-child{width:76%;height:10px}
.repository-loading-note{margin:20px 0 0;color:var(--text-3);font-size:12px}
.repository-load-error{padding:30px 0;color:var(--text-2);font-size:13px}
.repository-load-error p{margin:0 0 12px}
@keyframes repository-loading-enter{from{opacity:.5;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:1660px){.repository-loading-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
@media(max-width:1000px){.repository-loading-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.repository-loading{min-height:580px}.repository-loading-title{width:230px;height:26px!important}.repository-loading-total{display:none}.repository-loading-tile{padding:15px 12px}.repository-loading-description{width:90%}}
@media(prefers-reduced-motion:reduce){.repository-loading,.repository-loading .sk-line{animation:none!important}}
`;

function RepositoryLoading() {
  const element = React.createElement;
  const line = (name = '', key) => element('div', { className: `sk-line ${name}`, key });
  return element('div', { className: 'repository-loading', role: 'status', 'aria-label': '正在加载仓库库' },
    element('span', { className: 'repository-loading-sr' }, '正在加载仓库库'),
    element('div', { 'aria-hidden': true },
      element('div', { className: 'repository-loading-heading' },
        element('div', null, line('repository-loading-title'), line('repository-loading-description')), line('repository-loading-total')),
      element('div', { className: 'repository-loading-tabs' }, line('', 'topics'), line('', 'all')),
      element('div', { className: 'repository-loading-search' }, line()),
      line('repository-loading-label'),
      element('div', { className: 'repository-loading-grid' }, Array.from({ length: 10 }, (_, key) =>
        element('div', { className: 'repository-loading-tile', key }, line(), line())))),
    element('p', { className: 'repository-loading-note', 'aria-hidden': true }, '正在读取已整理的仓库…'));
}

async function loadRepositoryTab(signal, loadModule = () => import('/repository-explorer-prototype.js?v=navigation-20260928')) {
  const read = async (url, json = false) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Repository resource unavailable');
    return json ? response.json() : response.text();
  };
  // Start the data request immediately, not after template/module downloads.
  const scopedCataloguePath = typeof window !== 'undefined' && window.omnihubScopedCataloguePath;
  const data = read(typeof scopedCataloguePath === 'function' ? scopedCataloguePath('/api/repositories') : '/api/repositories', true);
  const [repositories, module, template, baseStyles, tabStyles, drawerStyles] = await Promise.all([
    data, loadModule(), read('/repository-tab.html'),
    read('/repository-explorer-prototype.css'), read('/repository-tab.css'), read('/detail-drawer.css'),
  ]);
  if (!Array.isArray(repositories)) throw new Error('Invalid repository library');
  return { repositories, module, template, styles: `${baseStyles}\n${drawerStyles}\n${tabStyles}` };
}

// Keep catalogue styles isolated while rendering inside the existing workspace tab.
function loadClassificationTaxonomy() { return import('/repository-taxonomy.js'); }

function RepositoryExplorerTab({ query = "", onQueryChange, userKey = "guest", active = true, onCorrectClassification, onRepositoriesLoaded }) {
  const hostRef = React.useRef(null);
  const viewRef = React.useRef(null);
  const current = React.useRef({ query, onQueryChange, active });
  current.current = { query, onQueryChange, active, onCorrectClassification, onRepositoriesLoaded };
  const [retry, setRetry] = React.useState(0);
  const [error, setError] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [visited, setVisited] = React.useState(active);
  const [preview, setPreview] = React.useState(null);
  React.useEffect(() => { if (active) setVisited(true); }, [active]);

  React.useEffect(() => {
    if (!visited) return;
    const controller = new AbortController();
    const host = hostRef.current;
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.replaceChildren();
    let disposed = false;
    setError(false);
    setLoading(true);
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Repository loading timed out'));
        controller.abort();
      }, 45000);
    });
    Promise.race([loadRepositoryTab(controller.signal), deadline]).then(({ module, template, styles, repositories }) => {
      if (disposed || controller.signal.aborted) return;
      current.current.onRepositoriesLoaded?.(repositories);
      const content = document.createElement('template');
      content.innerHTML = template;
      content.content.querySelectorAll('link[rel="stylesheet"]').forEach(link => link.remove());
      const style = document.createElement('style');
      style.textContent = styles;
      root.replaceChildren(style, content.content);
      viewRef.current = module.mountRepositoryExplorer(root, {
        query: current.current.query,
        onQueryChange: (value) => current.current.onQueryChange?.(value),
        active: current.current.active,
        onCorrectClassification: current.current.onCorrectClassification ? key => current.current.onCorrectClassification?.({repositoryKey:key}) : null,
        onPreviewMedia: setPreview,
        repositories,
      });
      setLoading(false);
    }).catch((failure) => {
      if (!disposed) {
        controller.abort();
        console.error("Repository tab failed to load", failure);
        root.replaceChildren();
        setError(true);
        setLoading(false);
      }
    }).finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
      viewRef.current?.destroy();
      viewRef.current = null;
      root.replaceChildren();
    };
  }, [userKey, retry, visited]);

  React.useEffect(() => { if (active && !loading) viewRef.current?.setQuery(query); }, [query, active, loading]);
  React.useLayoutEffect(() => { viewRef.current?.setActive(active); }, [active, loading]);
  return React.createElement("section", { "aria-label": "仓库库", hidden:!active, 'aria-busy': loading, style: { minWidth: 0 } },
    React.createElement('style', null, repositoryLoadingStyles),
    loading && React.createElement(RepositoryLoading),
    React.createElement("div", { ref: hostRef, style: { display: loading || error ? "none" : "block", minWidth: 0 } }),
    error && React.createElement("div", { role: "alert", className: 'repository-load-error' },
      React.createElement("p", null, "仓库暂时没有加载成功，请检查网络后重试。"),
      React.createElement("button", { className: "btn", onClick: () => setRetry(value => value + 1) }, "重新加载")),
    active && preview && React.createElement(PromptMediaViewer, {
      ...preview,
      onSelect: index => setPreview(value => value ? {...value,index} : null),
      onClose: () => setPreview(null),
    }));
}

// ---- Workspace routing ------------------------------------------------------
// Everything below is self-contained (no URLSearchParams/history requirement)
// so it can be exercised in a plain VM context.
function useWorkspaceSection(fallback) {
  const sections = ["repositories", "knowledgeLibrary", "promptLibrary", "inbox", "feed", "resources", "works",
    "studio", "chat", "tools", "topics", "settings"];
  const parseParams = query => String(query || '').split('&').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    const decode = value => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };
    return index < 0 ? [decode(part), ''] : [decode(part.slice(0, index)), decode(part.slice(index + 1))];
  });
  const formatParams = pairs => pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  // Resolves a hash to its module plus a compatible replacement URL for legacy links.
  const resolve = hash => {
    const [name, query = ''] = String(hash || '').replace(/^#/, '').split('?');
    // 生活指南 keeps its own deep links but lives under the 专题 module.
    if (name === 'life-guide') return { section: 'topics', redirect: '' };
    if (name === 'assets') {
      // 全部资产 was split: generated results → 作品, hand-added records → 收藏.
      const params = parseParams(query);
      const tab = (params.find(([key]) => key === 'tab') || [])[1];
      const target = tab === 'works' ? 'works' : 'resources';
      const kept = params.filter(([key]) => target === 'resources' || key !== 'tab');
      return { section: target, redirect: `#${target}${kept.length ? `?${formatParams(kept)}` : ''}` };
    }
    return { section: sections.includes(name) ? name : fallback, redirect: '' };
  };
  const remembered = React.useRef({});
  const lastHash = React.useRef(window.location.hash);
  const bypass = React.useRef('');
  // Workspace-owned hooks: canLeave(from, to) → false cancels; onModuleChange
  // runs after history (back/forward/link) moves to another module.
  const controls = React.useRef({ canLeave: null, onModuleChange: null });
  const readSection = (hash = window.location.hash) => resolve(hash).section;
  const replaceHash = hash => { if (window.history?.replaceState) window.history.replaceState(null, '', hash); };
  const [section, setValue] = React.useState(() => {
    const { section: initial, redirect } = resolve(window.location.hash);
    if (redirect) { replaceHash(redirect); lastHash.current = redirect; }
    return initial;
  });
  // Ask the workspace and the shared drawer guard (window.OmniNavigationGuard)
  // before leaving a module. A guard may answer synchronously or with a promise.
  const confirmLeave = (from, to, proceed, cancel) => {
    if (from === to) return proceed();
    if (controls.current.canLeave && controls.current.canLeave(from, to) === false) return cancel();
    let result = true;
    try { result = window.OmniNavigationGuard?.allow ? window.OmniNavigationGuard.allow() : true; } catch { result = true; }
    if (result && typeof result.then === 'function') {
      cancel();
      result.then(ok => { if (ok !== false) proceed(true); }, () => {});
      return;
    }
    return result === false ? cancel() : proceed();
  };
  React.useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      const next = resolve(hash);
      const from = readSection(lastHash.current);
      const accept = () => {
        let target = hash;
        if (next.redirect) { replaceHash(next.redirect); target = next.redirect; }
        remembered.current[next.section] = target;
        lastHash.current = target;
        if (from !== next.section) controls.current.onModuleChange?.(next.section, from);
        setValue(next.section);
      };
      if (bypass.current && bypass.current === hash) { bypass.current = ''; return accept(); }
      confirmLeave(from, next.section, delayed => {
        if (!delayed) return accept();
        // An async guard approved after the route was restored: re-apply it once.
        bypass.current = hash;
        window.location.hash = hash;
      }, () => {
        // Cancelled: restore the previous URL without emitting another hashchange.
        if (window.history?.pushState) window.history.pushState(null, '', lastHash.current);
        if (typeof CustomEvent === 'function') window.dispatchEvent?.(new CustomEvent('omnihub:route-restored'));
      });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [fallback]);
  // options.params sets query params; options.base ignores the remembered filters;
  // options.force skips leave guards (only after the user's own save completed).
  const setSection = (value, options = {}) => {
    const from = readSection();
    remembered.current[from] = window.location.hash;
    let hash = options.base || options.params ? `#${value}` : (remembered.current[value] || `#${value}`);
    const [target, query = ''] = hash.split('?');
    const targetParams = parseParams(query);
    const has = key => targetParams.some(([name]) => name === key);
    for (const [key, item] of Object.entries(options.params || {})) if (item) targetParams.push([key, String(item)]);
    const inherited = (parseParams(window.location.hash.split('?')[1]).find(([key]) => key === 'space') || [])[1];
    // A section change keeps the current personal/public boundary. Repository
    // filters may change, but the account scope must never silently disappear.
    if (['mine', 'public'].includes(inherited) && !has('space')) targetParams.push(['space', inherited]);
    if (targetParams.length !== parseParams(query).length) hash = `${target}?${formatParams(targetParams)}`;
    (options.force ? (_from, _to, proceed) => proceed() : confirmLeave)(from, value, () => {
      lastHash.current = hash;
      remembered.current[value] = hash;
      setValue(value);
      // Same accepted-change hook as history navigation (closes the old modal).
      if (from !== value) controls.current.onModuleChange?.(value, from);
      if (window.location.hash !== hash) window.location.hash = hash;
    }, () => {});
  };
  return [section, setSection, controls.current];
}

// ---- Settings and 专题 routes ----------------------------------------------
// Pure helpers shared by SettingsCenter, the topics catalogue and Workspace.
function workspaceHashName(hash) { return String(hash || '').replace(/^#/, '').split('?')[0]; }
function workspaceHashParams(hash) { return new URLSearchParams(String(hash || '').split('?')[1] || ''); }
// #settings?category=sync|ai|devices|appearance; legacy drawer tab names still work.
function settingsRouteFor(hash, canUseFullApp) {
  const params = workspaceHashParams(hash);
  let category = settingsCategoryFor(params.get('category') || '') || 'sync';
  if (category === 'ai' && !canUseFullApp) category = 'sync';
  return { category, aiTab: params.get('aiTab') || 'chat' };
}
// Canonical settings URL; drops the one-shot OAuth `result` and keeps `space`.
function settingsHashFor(hash, category) {
  const current = workspaceHashParams(hash);
  const params = workspaceHashName(hash) === 'settings' ? current : new URLSearchParams();
  if (workspaceHashName(hash) !== 'settings' && current.get('space')) params.set('space', current.get('space'));
  const target = settingsCategoryFor(category) || 'sync';
  params.delete('result');
  if (target !== 'ai') params.delete('aiTab');
  params.set('category', target);
  return `#settings?${params}`;
}
// Central mapping for the legacy setModal('ai-settings' | 'account-settings' |
// {type:'settings',tab,aiTab}) calls; anything else is an ordinary modal.
function settingsTargetForModal(value) {
  if (value === 'ai-settings' || value === 'account-settings') return { category: settingsCategoryFor(value), aiTab: '' };
  if (value && typeof value === 'object' && value.type === 'settings') {
    const category = settingsCategoryFor(value.tab || '') || 'sync';
    return { category, aiTab: category === 'ai' ? value.aiTab || '' : '' };
  }
  return null;
}
// 专题 registry: real topics only. Each keeps its own deep-link hash.
const TOPIC_REGISTRY = Object.freeze([
  Object.freeze({ id: 'life-guide', title: '生活指南', hash: '#life-guide', description: '按章节、证据等级与金钱、时间、毅力投入筛选生活建议。' }),
]);
function topicHref(topic, currentHash) {
  const space = workspaceHashParams(currentHash).get('space');
  return topic.hash + (space === 'mine' || space === 'public' ? `?space=${space}` : '');
}
