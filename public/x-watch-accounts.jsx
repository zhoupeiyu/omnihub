function followingInputHandle(value) {
  const text=value.trim();
  const match=text.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  return (match?match[1]:text.replace(/^@/,'')).toLowerCase();
}

const X_WATCH_GROUP_PRESETS=[
  ['AI 与技术',['AI 资讯','AI 编程与 Agent','软件开发','开源项目','硬件与科技']],
  ['商业与投资',['币圈与 Web3','投资与交易','宏观经济','创业与商业','产品与设计','营销与增长']],
  ['内容与生活',['影视与短剧','图像与视频创作','写作与自媒体','知识与效率','生活与兴趣']],
];

function XWatchGroupSelect({label,ariaLabel,value,onChange,groups,disabled}) {
  const [customMode,setCustomMode]=React.useState(false);
  const customInput=React.useRef(null);
  const existing=[...new Set(groups.filter(Boolean))];
  const known=[...existing,...X_WATCH_GROUP_PRESETS.flatMap(([,names])=>names)];
  const custom=customMode||(!!value&&!known.includes(value));
  React.useEffect(()=>{if(customMode)customInput.current?.focus();},[customMode]);
  return <div className="watch-group-field">
    <label><span>{label}</span><select required aria-label={ariaLabel} value={custom?'custom':value?`group:${value}`:''} disabled={disabled}
      onChange={event=>{const choice=event.target.value;setCustomMode(choice==='custom');onChange(choice.startsWith('group:')?choice.slice(6):'');}}>
      <option value="" disabled>选择分组</option>
      {existing.length>0&&<optgroup label="已有分组">{existing.map(name=><option key={name} value={`group:${name}`}>{name}</option>)}</optgroup>}
      {X_WATCH_GROUP_PRESETS.map(([section,names])=>{
        const available=names.filter(name=>!existing.includes(name));
        return available.length>0&&<optgroup key={section} label={section}>{available.map(name=><option key={name} value={`group:${name}`}>{name}</option>)}</optgroup>;
      })}
      <option value="custom">自定义分组…</option>
    </select></label>
    {custom&&<input ref={customInput} required aria-label="自定义分组名称" maxLength={60} placeholder="输入分组名称" value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>}
  </div>;
}

function XWatchAccountsView({active=true}={}) {
  const [state,setState]=React.useState(null),[directory,setDirectory]=React.useState(null);
  const [tab,setTab]=React.useState('following'),[handle,setHandle]=React.useState('');
  const [search,setSearch]=React.useState(''),[picked,setPicked]=React.useState([]),[manual,setManual]=React.useState('');
  const [group,setGroup]=React.useState(''),[editing,setEditing]=React.useState(null);
  const [busy,setBusy]=React.useState(''),[error,setError]=React.useState(''),[notice,setNotice]=React.useState('');
  const [clock,setClock]=React.useState(Date.now());
  const [sourceEditing,setSourceEditing]=React.useState(false);
  const [moreError,setMoreError]=React.useState('');
  const pending=React.useRef(false), mounted=React.useRef(true);
  const editPanel=React.useRef(null);
  const sourceInput=React.useRef(null),sourceButton=React.useRef(null);
  const loadMoreTarget=React.useRef(null);
  async function read() {
    const [settings,cache]=await Promise.all([api('/api/x-watch'),api('/api/x-watch/following')]);
    if(!mounted.current)return;
    setState(settings);setDirectory(cache);setHandle(cache.handle);
  }
  React.useEffect(()=>{mounted.current=true;read().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[]);
  React.useEffect(()=>{
    const delay=directory?.refreshAfter-Date.now();
    if(!(delay>0))return;
    const timer=setTimeout(()=>setClock(Date.now()),Math.min(delay+50,2147483647));
    return()=>clearTimeout(timer);
  },[directory?.refreshAfter]);
  React.useEffect(()=>{if(editing)editPanel.current?.scrollIntoView({block:'nearest'});},[editing?.id]);
  React.useEffect(()=>{if(sourceEditing)sourceInput.current?.focus();},[sourceEditing]);
  async function action(name,work) {
    if(pending.current)return;
    pending.current=true;setBusy(name);setError('');setNotice('');
    try {await work();} catch(e) {if(mounted.current)setError(e.message);}
    finally {pending.current=false;if(mounted.current)setBusy('');}
  }
  function fetchFollowing(refresh=false) {
    const more=!refresh&&directory.pages>0;
    return action(more?'more':'load',async()=>{
      setMoreError('');
      try {
        const cache=await api('/api/x-watch/following',{method:'POST',body:{handle,action:refresh?'refresh':'load',generation:directory.generation,page:directory.pages}});
        if(!mounted.current)return;
        setDirectory(cache);setHandle(cache.handle);
        setSourceEditing(false);
        if(more&&cache.hasMore&&!cache.limited&&!cache.complete&&cache.generation===directory.generation&&cache.pages<=directory.pages)
          setMoreError('本次没有读到新的一页，自动加载已暂停。');
        if(cache.handle!==directory.handle)setSearch('');
        if(refresh&&cache.generation!==directory.generation)setPicked([]);
      } catch(e) {
        // A failed request may still create a cache generation. Recover it without another paid read.
        const cache=await api('/api/x-watch/following').catch(()=>null);
        if(cache&&mounted.current)setDirectory(cache);
        if(more){if(mounted.current)setMoreError(e.message);return;}
        throw e;
      }
    });
  }
  function add(event) {
    event.preventDefault();
    action('add',async()=>{
      const handles=tab==='manual'?manual.trim().split(/[\s,，;；]+/).filter(Boolean):picked;
      const result=await api('/api/x-watch/accounts/batch',{method:'POST',body:{handles,group,intervalMinutes:30}});
      if(!mounted.current)return;
      setState(result.state);
      if(tab==='manual'){setManual('');setPicked(current=>current.filter(value=>!result.state.accounts.some(a=>a.handle===value)));}
      else setPicked([]);
      setNotice(`已添加 ${result.added} 人${result.skipped?`，跳过 ${result.skipped} 个已有账号`:''}。新增账号保持暂停。`);
    });
  }
  function saveEdit(event) {
    event.preventDefault();
    action('edit',async()=>{
      let updated;
      try{updated=await api('/api/x-watch/accounts',{method:'POST',body:editing});}
      catch(e){await read().catch(()=>{});setEditing(null);throw e;}
      if(!mounted.current)return;
      setState(updated);setEditing(null);setNotice(editing.enabled?'监听已启用，服务器会在 1 分钟内开始首次采集；可到「监听动态」查看。':'已暂停采集，已保存的帖子和媒体仍保留。');
    });
  }
  const watched=new Set(state?.accounts.map(a=>a.handle)||[]);
  const users=(directory?.users||[]).filter(user=>`${user.handle} ${user.name} ${user.description}`.toLowerCase().includes(search.trim().toLowerCase()));
  const eligible=users.filter(user=>!watched.has(user.handle)&&!user.protected);
  const allPicked=eligible.length>0&&eligible.every(user=>picked.includes(user.handle));
  const count=tab==='manual'?manual.trim().split(/[\s,，;；]+/).filter(Boolean).length:picked.length;
  const changed=followingInputHandle(handle)!==directory?.handle;
  const cooldown=directory?.refreshAfter>Math.max(clock,Date.now());
  const cached=directory?.pages>0&&!changed;
  const showSourceEditor=sourceEditing||directory?.pages===0;
  const refreshRequired=cached||(changed&&!!directory?.generation);
  const canLoadMore=directory?.pages>0&&directory.available&&directory.hasMore&&!directory.complete&&!directory.limited;
  React.useEffect(()=>{
    const target=loadMoreTarget.current;
    if(!active||tab!=='following'||showSourceEditor||search.trim()||busy||moreError||!canLoadMore||!target||typeof IntersectionObserver!=='function')return;
    let disposed=false;
    const observer=new IntersectionObserver(entries=>{
      if(!disposed&&document.visibilityState!=='hidden'&&entries.some(entry=>entry.isIntersecting)&&target.getClientRects().length)
        fetchFollowing(false);
    },{rootMargin:'0px 0px 240px 0px'});
    const observe=()=>{
      observer.disconnect();
      if(document.visibilityState!=='hidden')observer.observe(target);
    };
    observe();document.addEventListener('visibilitychange',observe);
    return()=>{disposed=true;observer.disconnect();document.removeEventListener('visibilitychange',observe);};
  },[active,tab,showSourceEditor,search,busy,moreError,canLoadMore,directory]);
  function closeSourceEditor() {
    setHandle(directory.handle);setSourceEditing(false);setError('');sourceButton.current?.focus();
  }
  function changeTab(value) {
    setTab(value);setError('');setNotice('');setEditing(null);setSourceEditing(false);
    if(directory)setHandle(directory.handle);
  }
  function toggleAll() {
    const current=new Set(picked);
    for(const user of eligible)allPicked?current.delete(user.handle):current.add(user.handle);
    setPicked([...current]);
  }
  function edit(account) {
    setEditing({id:account.id,revision:account.revision,handle:account.handle,group:account.group,intervalMinutes:account.intervalMinutes,
      includeReplies:account.includeReplies,includeReposts:account.includeReposts,enabled:account.enabled,dailyRequests:state.dailyRequests,dailyBudgetUsd:state.dailyBudgetUsd||0,settingsRevision:state.settingsRevision||0});
    setError('');setNotice('');
  }
  return <section className="watch-manager" aria-label="监听账号管理">
    <header className="watch-manager-header">
      <div className="watch-manager-tabs" aria-label="账号管理视图">
        {[['following','从关注中选'],['saved',`已添加${state?` · ${state.accounts.length}`:''}`]].map(([key,label])=>
          <button key={key} type="button" aria-pressed={tab===key} disabled={!!busy} onClick={()=>changeTab(key)}>{label}</button>)}
      </div>
      <button type="button" className="btn watch-manual-action" aria-pressed={tab==='manual'} disabled={!!busy} onClick={()=>changeTab('manual')}>手动添加</button>
    </header>
    {error&&<p role="alert" className="classification-error">{error}</p>}
    {notice&&<p role="status" className="watch-manager-notice">{notice}</p>}
    {!state||!directory?<div className="watch-empty"><p role="status">{error?'页面未能读取，请重试。':'正在读取已保存的账号…'}</p>{error&&<button className="btn" onClick={()=>action('read',read)}>重新读取</button>}</div>:<>
      {tab==='following'&&<>
        <div className="watch-source-box">
          <div className="watch-source-line">
            <div className="watch-source-identity"><strong>@{directory.handle} 的关注</strong>
              {directory.pages>0&&<button ref={sourceButton} type="button" className="watch-text-button watch-secondary-action" disabled={!!busy} aria-expanded={sourceEditing} aria-controls="watch-source-editor" onClick={()=>{if(sourceEditing)closeSourceEditor();else{setHandle(directory.handle);setSourceEditing(true);setError('');}}}>更换账号</button>}
            </div>
            {directory.pages>0&&<span className="watch-source-count" role="status" title={directory.complete?'名单已完整加载':'未加载完整'}>已加载 {directory.users.length}{!directory.complete&&directory.profile?.followingCount!=null?` / ${directory.profile.followingCount}`:''} 人{!directory.complete&&directory.profile?.followingCount==null?' · 未加载完整':''}</span>}
            {!showSourceEditor&&<div className="watch-source-actions">
              <button type="button" className="btn" disabled={!!busy||!directory.available||cooldown} title={cooldown?'每 10 分钟可刷新一次':`重新拉取 @${directory.handle} 的关注名单，从第一页开始`} onClick={()=>fetchFollowing(true)}>{busy==='load'?'刷新中…':'刷新列表'}</button>
            </div>}
          </div>
          {showSourceEditor&&<form id="watch-source-editor" className="watch-source-controls" onSubmit={event=>{event.preventDefault();fetchFollowing(refreshRequired);}}>
            <label><span>名单来源</span><input ref={sourceInput} aria-label="我的 X 账号" value={handle} maxLength={300} disabled={!!busy} required placeholder="@用户名或 X 主页链接" onChange={e=>setHandle(e.target.value)}/></label>
            <button type="submit" className="btn" disabled={!!busy||!directory.available||!handle.trim()||(directory.pages>0&&!changed)||(refreshRequired&&cooldown)}>{busy==='load'?'拉取中…':directory.pages>0?'拉取并切换':'拉取关注'}</button>
            {directory.pages>0&&<button type="button" className="watch-text-button watch-secondary-action" disabled={!!busy} onClick={closeSourceEditor}>取消</button>}
            {cooldown&&refreshRequired&&<small>名单刚更新过，10 分钟后可重新同步或更换账号。</small>}
          </form>}
          <div className="watch-source-meta">
            {directory.updatedAt>0&&<time dateTime={new Date(directory.updatedAt).toISOString()} title={new Date(directory.updatedAt).toLocaleString('zh-CN')}>更新于 {new Date(directory.updatedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>}
            <span>{directory.available?'拉取约 $0.20 / 千人，仅拉取时计费。':'当前环境未配置 SocialData，可手动添加账号。'}</span>
          </div>
        </div>
        {directory.users.length>0?<div className="watch-directory-panel">
          <div className="watch-select-toolbar"><input type="search" aria-label="搜索关注账号" placeholder="搜索关注账号…" value={search} onChange={e=>setSearch(e.target.value)}/>
            <div className="watch-select-summary">{search.trim()&&<span role="status">找到 {users.length} 人</span>}<label><input type="checkbox" checked={allPicked} disabled={!!busy||!eligible.length} onChange={toggleAll}/>{search?'全选搜索结果':'全选已加载'}</label></div>
          </div>
          <ul className="watch-people-list" aria-label="关注账号">{users.map(user=>{const saved=watched.has(user.handle),disabled=saved||user.protected;
            return <li key={user.id}><label className={`watch-person${picked.includes(user.handle)?' is-picked':''}${disabled?' is-unavailable':''}`}>
              <input type="checkbox" aria-label={`选择 @${user.handle}`} checked={saved||picked.includes(user.handle)} disabled={!!busy||disabled}
                onChange={e=>setPicked(current=>e.target.checked?[...current,user.handle]:current.filter(h=>h!==user.handle))}/>
              <span className="watch-avatar"><span aria-hidden="true">{user.name.slice(0,1)}</span>{user.avatar&&<img src={user.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none';}}/>}</span>
              <span className="watch-person-name"><span title={user.name}>{user.name}</span><small title={`@${user.handle}`}>@{user.handle}</small></span>
              {user.description&&<span className="watch-person-bio" title={user.description}>{user.description}</span>}
              {(saved||user.protected)&&<span className="watch-person-label">{saved?'已添加':'非公开账号'}</span>}
            </label></li>;
          })}</ul>
          {!users.length&&<p className="watch-caption">没有匹配的账号，试试搜索用户名。</p>}
        </div>:<div className="watch-empty watch-source-empty"><p>{directory.complete?'没有返回公开关注，可以手动添加。':'拉取关注名单后，勾选要监听的账号。'}</p></div>}
        {directory.pages>0&&<div ref={loadMoreTarget} className="watch-load-more" aria-label="关注名单加载状态" aria-busy={busy==='more'}>
          {busy==='more'?<span role="status">正在加载更多账号…</span>
            :directory.complete?<span role="status">已加载全部关注</span>
            :directory.limited?<span role="status">{directory.stopReason==='repeated_cursor'?'上游分页重复，已停止；名单未完整':'已达读取上限，名单未完整'}</span>
            :!directory.hasMore?<span role="status">名单尚未完整，可稍后重新同步。</span>
            :moreError?<><span role="alert">{moreError}</span><button type="button" className="watch-text-button" disabled={!!busy||!canLoadMore||showSourceEditor} onClick={()=>fetchFollowing(false)}>重试加载</button></>
            :!directory.available?<span>当前环境无法继续拉取，可手动添加账号。</span>
            :showSourceEditor?<span>修改来源期间暂停自动加载</span>
            :search.trim()?<span>仅搜索已加载账号，清空搜索后继续自动加载。</span>
            :typeof IntersectionObserver==='function'?<span>滚动到底部自动加载</span>
            :<button type="button" className="watch-text-button" disabled={!!busy} onClick={()=>fetchFollowing(false)}>加载更多</button>}
          {directory.skipped>0&&<small>已跳过 {directory.skipped} 条无法识别的记录</small>}
        </div>}
      </>}
      {tab==='manual'&&<div className="watch-manual"><label htmlFor="watch-manual-input">X 账号或主页链接</label><p>每行一个，也支持空格或逗号分隔。</p>
        <textarea id="watch-manual-input" value={manual} disabled={!!busy} maxLength={30000} rows={6} placeholder={'例如：\n@OpenAI\nhttps://x.com/AnthropicAI'} onChange={e=>setManual(e.target.value)}/>
        <small>不调用接口验证；重复账号自动跳过。</small></div>}
      {(tab==='manual'||(tab==='following'&&count>0))&&<form className={`watch-add-bar${tab==='following'?' has-selection':' is-manual'}`} onSubmit={add}>
        {tab==='following'&&<div className="watch-selection-summary"><strong>已选 {picked.length} 人</strong><button type="button" className="watch-text-button" disabled={!!busy} onClick={()=>setPicked([])}>清空</button></div>}
        <XWatchGroupSelect label="加入分组" ariaLabel="添加到分组" value={group} onChange={setGroup} groups={state.accounts.map(a=>a.group)} disabled={!!busy}/>
        <button className="btn btn-primary" disabled={!!busy||!count||!group.trim()}>{busy==='add'?'正在添加…':`添加${count?` ${count} 个账号`:''}`}</button>
        <p>添加后默认暂停，在「已添加」中设置启用。</p>
      </form>}
      {tab==='saved'&&<>
        <div className="watch-settings-status"><span>{state.accounts.filter(a=>a.enabled).length} 个正在监听 · {state.accounts.filter(a=>!a.enabled).length} 个已暂停</span>
          {!state.available&&<span>自动采集未启用</span>}
          <p>添加不等于启用。点击账号「设置」，填写预算并勾选启用后才会抓取帖子。正文、图片和视频保存在本站服务器，仅你可见，不混入原来的收藏。</p></div>
        {!state.accounts.length&&<div className="watch-empty"><h3>还没有添加监听账号</h3><p>从关注列表中选择，或手动添加第一个账号。</p><button className="btn" onClick={()=>setTab('following')}>从我的关注选择</button></div>}
        <ul className="watch-managed-list">{state.accounts.map(account=><li key={account.id}><div><strong>@{account.handle}</strong><span>{account.group} · 每 {account.intervalMinutes} 分钟</span>
          {(account.lastOk||account.errorCode)&&<small>{account.lastOk?`最近采集 ${new Date(account.lastOk).toLocaleString('zh-CN')}`:''}{account.errorCode?' · 上次采集失败':''}</small>}</div>
          <span className={`watch-account-state${account.enabled?' is-enabled':''}`}>{!account.enabled?'已暂停':!state.available?'服务未启用':state.costUncertain?'费用待核对':account.errorCode?'采集失败':state.requestsToday>=state.dailyRequests||(state.budgetRemaining??0)<(state.pageReserveUsd??0.04)||(state.monthlyBudgetRemainingUsd??0)<(state.pageReserveUsd??0.04)?'预算暂停':account.lastOk?'正在监听':'等待首次采集'}</span><button className="btn btn-ghost" disabled={!!busy} onClick={()=>edit(account)}>设置</button></li>)}</ul>
        {editing&&<form ref={editPanel} className="watch-form watch-edit-account" onSubmit={saveEdit}><h3>@{editing.handle} 的监听设置</h3>
          <XWatchGroupSelect key={editing.id} label="分组" ariaLabel="编辑账号分组" value={editing.group} onChange={group=>setEditing({...editing,group})} groups={state.accounts.map(a=>a.group)} disabled={!!busy}/>
          <label>采集间隔（分钟）<input required type="number" min="15" max="1440" value={editing.intervalMinutes} onChange={e=>setEditing({...editing,intervalMinutes:Number(e.target.value)})}/></label>
          <label>所有账号 24 小时请求上限<input required type="number" min={editing.enabled?'1':'0'} max="500" value={editing.dailyRequests} onChange={e=>setEditing({...editing,dailyRequests:Number(e.target.value)})}/></label>
          <label>所有账号 24 小时预算（美元）<input required type="number" min={editing.enabled?'0.04':'0'} max="20" step="0.01" value={editing.dailyBudgetUsd??0} onChange={e=>setEditing({...editing,dailyBudgetUsd:Number(e.target.value)})}/><small>0 表示不授权付费采集。预算由全部监听账号共享。</small></label>
          <p className="watch-caption watch-form-note">按返回条数估算，每千条约 $0.20；每次先预留 $0.04，不足则暂停，24 小时后逐笔释放。监听帖子与手动拉取关注名单还共用 31 天 ${(state.monthlyBudgetUsd||0).toFixed(2)} 美元总上限；不含本地模型费用。首次查近 7 天，之后只查新增。</p>
          <label className="watch-check"><input type="checkbox" checked={editing.enabled} disabled={!state.available&&!editing.enabled} onChange={e=>setEditing({...editing,enabled:e.target.checked})}/>启用采集（会产生费用）</label>
          {!state.available&&<p className="watch-caption">需要先在服务器启用采集服务。</p>}
          <label className="watch-check"><input type="checkbox" checked={editing.includeReplies} onChange={e=>setEditing({...editing,includeReplies:e.target.checked})}/>包含回复</label>
          <label className="watch-check"><input type="checkbox" checked={editing.includeReposts} onChange={e=>setEditing({...editing,includeReposts:e.target.checked})}/>包含转发</label>
          <div className="watch-actions"><button className="btn btn-primary" disabled={!!busy}>保存设置</button><button type="button" className="btn btn-ghost" disabled={!!busy} onClick={()=>setEditing(null)}>取消</button></div>
        </form>}
      </>}
    </>}
  </section>;
}
