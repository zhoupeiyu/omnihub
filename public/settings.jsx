function SettingsCenter({ user, canUseFullApp, initialTab = 'account', initialAiTab = 'chat', onClose, onSaved, showToast,
  theme, onThemeToggle, skin, onSkinChange, woodFishEnabled, onWoodFishToggle }) {
  const tabs = [{ id:'account', label:'账号与同步', icon:IconUser },
    ...(canUseFullApp ? [{ id:'ai', label:'AI 服务', icon:IconSparkle }, { id:'automation', label:'收藏整理', icon:IconInbox }] : []),
    { id:'devices', label:'本机设备', icon:IconSettings }, { id:'appearance', label:'外观', icon:IconPalette }];
  const firstTab = tabs.some(item => item.id === initialTab) ? initialTab : 'account';
  const [tab, setTab] = React.useState(firstTab);
  const [visited, setVisited] = React.useState(() => new Set([firstTab]));
  const navRef = React.useRef(null);
  function selectTab(id) {
    setTab(id);
    setVisited(current => new Set([...current, id]));
  }
  function moveTab(event, index) {
    let next;
    if (['ArrowDown','ArrowRight'].includes(event.key)) next = (index + 1) % tabs.length;
    else if (['ArrowUp','ArrowLeft'].includes(event.key)) next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[next].id);
    navRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
  }
  return <DetailDrawer title="设置" onClose={onClose} className="settings-center">
    <div className="settings-layout">
      <nav className="settings-nav" ref={navRef} role="tablist" aria-label="设置分类">
        {tabs.map((item,index) => <button key={item.id} id={`settings-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
          aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => selectTab(item.id)} onKeyDown={event => moveTab(event,index)}><item.icon /><span>{item.label}</span></button>)}
      </nav>
      <div className="settings-content">
        {tabs.filter(item => visited.has(item.id)).map(item => <section key={item.id} id={`settings-panel-${item.id}`} role="tabpanel"
          aria-labelledby={`settings-tab-${item.id}`} hidden={tab !== item.id} tabIndex={0}>
          {item.id === 'account' && <AccountSettings user={user} embedded onClose={onClose} />}
          {item.id === 'ai' && <AiSettingsModal embedded initialTab={initialAiTab} onClose={onClose} onSaved={onSaved} showToast={showToast} />}
          {item.id === 'automation' && <ContentPipelineStatus settingsOnly active={tab === 'automation'} />}
          {item.id === 'devices' && <div className="account-settings-body"><h2>本机设备</h2><p className="settings-description">管理用于创作的电脑。收藏整理设备与同步规则在“账号与同步”中。</p><LocalImageDevices /></div>}
          {item.id === 'appearance' && <div className="settings-appearance"><h2>外观</h2><p className="settings-description">立即应用于当前浏览器。</p>
            <div className="settings-preference"><div><strong>深色模式</strong><p>切换阅读和工作界面的明暗。</p></div><button className="settings-switch" role="switch" aria-label="深色模式" aria-checked={theme === 'dark'} onClick={onThemeToggle}><span /></button></div>
            <div className="settings-preference"><div><strong>悬浮木鱼</strong><p>在工作区显示木鱼小工具。</p></div><button className="settings-switch" role="switch" aria-label="悬浮木鱼" aria-checked={woodFishEnabled} onClick={onWoodFishToggle}><span /></button></div>
            <fieldset className="settings-skins"><legend>主题配色</legend><div>{SKIN_LIST.map(item => <button key={item.id} aria-pressed={skin === item.id} onClick={() => onSkinChange(item.id)}><span style={{background:item.dot}} />{item.name}{skin === item.id && <IconCheck />}</button>)}</div></fieldset>
          </div>}
        </section>)}
      </div>
    </div>
  </DetailDrawer>;
}
