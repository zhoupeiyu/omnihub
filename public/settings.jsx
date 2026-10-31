// Full-page settings rendered inside the workspace <main>. The category lives
// in the URL (#settings?category=sync|ai|devices|appearance), so it survives
// refresh, deep links and Back/Forward. Leaving the page through the sidebar
// or browser history is owned by the Workspace router, which asks for confirmation
// while onDirtyChange(true) is in effect.
function SettingsCenter({ user, canUseFullApp, onClose, onSaved, onDirtyChange, showToast,
  theme, onThemeToggle, skin, onSkinChange, woodFishEnabled, onWoodFishToggle }) {
  const personalAccess = Boolean(user && user.personalAccess !== false);
  const tabs = [{ id:'sync', label:'数据同步', icon:IconUser },
    { id:'ai', label:'AI 服务', icon:IconSparkle },
    { id:'devices', label:'执行设备', icon:IconSettings }, { id:'appearance', label:'外观', icon:IconPalette }]
    .filter(item => personalAccess || item.id === 'appearance');
  const readRoute = () => settingsRouteFor(window.location.hash, personalAccess);
  const [route, setRoute] = React.useState(readRoute);
  const tab = route.category;
  const [visited, setVisited] = React.useState(() => new Set([tab]));
  const [dirty, setDirty] = React.useState(false);
  const dirtyParts = React.useRef({});
  const dirtyCallback = React.useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const navRef = React.useRef(null);

  // Category changes arrive as same-module hash changes (click, Back, Forward).
  React.useEffect(() => {
    const sync = () => {
      if (workspaceHashName(window.location.hash) !== 'settings') return;
      const next = settingsRouteFor(window.location.hash, personalAccess);
      // Guest links can change without changing the active appearance tab.
      if (!personalAccess && window.history?.replaceState) {
        const canonical = settingsHashFor(window.location.hash, next.category);
        if (canonical !== window.location.hash) window.history.replaceState(null, '', canonical);
      }
      setRoute(current => current.category === next.category && current.aiTab === next.aiTab ? current : next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('omnihub:route-restored', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('omnihub:route-restored', sync);
    };
  }, [personalAccess]);
  React.useEffect(() => { setVisited(current => current.has(tab) ? current : new Set([...current, tab])); }, [tab]);
  // Canonical URL: legacy/unknown/forbidden categories are rewritten in place and
  // the one-shot OAuth `result` (already read by AccountSettings) is dropped.
  React.useEffect(() => {
    const hash = window.location.hash;
    if (workspaceHashName(hash) !== 'settings') return;
    const canonical = settingsHashFor(hash, tab);
    if (canonical !== hash && window.history?.replaceState) window.history.replaceState(null, '', canonical);
  }, [tab]);

  const markDirty = React.useCallback((key, value) => {
    dirtyParts.current = { ...dirtyParts.current, [key]: Boolean(value) };
    const next = Object.values(dirtyParts.current).some(Boolean);
    setDirty(next);
    dirtyCallback.current?.(next);
  }, []);
  const onAiDirtyChange = React.useCallback(value => markDirty('ai', value), [markDirty]);
  React.useEffect(() => () => dirtyCallback.current?.(false), []);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function selectTab(id) {
    if (id === tab) return;
    // Pushes a history entry so Back returns to the previous category.
    window.location.hash = settingsHashFor(window.location.hash, id);
  }
  // Manual activation: arrows move focus, Enter/Space (click) selects.
  function moveFocus(event, index) {
    let next;
    if (['ArrowDown','ArrowRight'].includes(event.key)) next = (index + 1) % tabs.length;
    else if (['ArrowUp','ArrowLeft'].includes(event.key)) next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    navRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
  }

  return <section className="settings-page" aria-label="设置">
    <div className="settings-layout">
      <nav className="settings-nav" ref={navRef} role="tablist" aria-label="设置分类" aria-orientation="vertical">
        {tabs.map((item,index) => <button key={item.id} type="button" id={`settings-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
          aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => selectTab(item.id)} onKeyDown={event => moveFocus(event,index)}><item.icon aria-hidden="true" /><span>{item.label}</span></button>)}
      </nav>
      <div className="settings-content">
        {dirty && <p className="settings-dirty" role="status">有未保存的修改</p>}
        {tabs.filter(item => visited.has(item.id)).map(item => <section key={item.id} id={`settings-panel-${item.id}`} role="tabpanel"
          aria-labelledby={`settings-tab-${item.id}`} hidden={tab !== item.id} tabIndex={0}>
          {item.id === 'sync' && <div className="settings-sync">
            <div className="account-settings-body sync-modules">
              <AccountSettings active={tab === 'sync'} />
              {canUseFullApp && <ContentPipelineStatus settingsOnly active={tab === 'sync'} onOpenDevices={() => selectTab('devices')} />}
            </div>
          </div>}
          {item.id === 'ai' && <AiSettingsModal embedded initialTab={route.aiTab}
            onClose={onClose} onDirtyChange={onAiDirtyChange} onSaved={onSaved} showToast={showToast} canUseMedia={canUseFullApp} />}
          {item.id === 'devices' && <div className="account-settings-body sync-modules"><LocalCurationSettings /><LocalImageDevices /></div>}
          {item.id === 'appearance' && <div className="settings-appearance">
            <section className="settings-skins" aria-labelledby="settings-theme-title">
              <div className="settings-theme-heading"><h2 id="settings-theme-title">主题配色</h2>
                <label className="settings-theme-mode"><span>深色模式</span><button type="button" className="settings-switch" role="switch" aria-label="深色模式" aria-checked={theme === 'dark'} onClick={onThemeToggle}><span /></button></label>
              </div>
              <div className="settings-theme-grid">{SKIN_LIST.map(item => <button type="button" className="settings-theme-card" key={item.id}
                aria-label={item.name} aria-pressed={skin === item.id} onClick={() => onSkinChange(item.id)}>
                <span className="settings-palette" data-skin={item.id} data-theme={theme} aria-hidden="true">
                  <span className="settings-palette-accent" /><span className="settings-palette-background" /><span className="settings-palette-surface" />
                </span>
                <span className="settings-theme-label"><strong>{item.name}</strong><span className="settings-theme-check" aria-hidden="true">{skin === item.id && <IconCheck />}</span></span>
              </button>)}</div>
            </section>
            <div className="settings-preferences">
              <div className="settings-preference"><strong>悬浮木鱼</strong><div className="settings-preference-control"><p id="settings-woodfish-description">在工作区显示木鱼小工具。</p><button type="button" className="settings-switch" role="switch" aria-label="悬浮木鱼" aria-describedby="settings-woodfish-description" aria-checked={woodFishEnabled} onClick={onWoodFishToggle}><span /></button></div></div>
            </div>
          </div>}
        </section>)}
      </div>
    </div>
  </section>;
}
