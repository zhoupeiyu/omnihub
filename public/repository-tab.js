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

function useWorkspaceSection(fallback) {
  const sections = ["repositories", "knowledgeLibrary", "promptLibrary", "inbox", "feed", "assets", "studio", "chat", "tools"];
  const remembered = React.useRef({});
  const readSection = () => {
    const value = window.location.hash.slice(1).split('?')[0];
    return sections.includes(value) ? value : fallback;
  };
  const [section, setValue] = React.useState(readSection);
  React.useEffect(() => {
    const onHashChange = () => { const value = readSection(); remembered.current[value] = window.location.hash; setValue(value); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [fallback]);
  const setSection = (value) => {
    remembered.current[readSection()] = window.location.hash;
    setValue(value);
    let hash = remembered.current[value] || `#${value}`;
    const inherited = new URLSearchParams(window.location.hash.split('?')[1] || '').get('space');
    const [target, query = ''] = hash.split('?');
    const targetParams = new URLSearchParams(query);
    // A section change keeps the current personal/public boundary. Repository
    // filters may change, but the account scope must never silently disappear.
    if (['mine', 'public'].includes(inherited) && !targetParams.has('space')) targetParams.set('space', inherited);
    hash = `${target}${targetParams.size ? `?${targetParams}` : ''}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  };
  return [section, setSection];
}
