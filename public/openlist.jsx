function OpenListSettings({ active = true }) {
  const [connection,setConnection] = React.useState(null);
  const [baseUrl,setBaseUrl] = React.useState('');
  const [token,setToken] = React.useState('');
  const [root,setRoot] = React.useState('/');
  const [picker,setPicker] = React.useState(null);
  const [courses,setCourses] = React.useState(null);
  const [quark,setQuark] = React.useState(null);
  const [playing,setPlaying] = React.useState(null);
  const [error,setError] = React.useState('');
  const [notice,setNotice] = React.useState('');
  const [busy,setBusy] = React.useState(false);
  const [configState,setConfigState] = React.useState('loading');
  const video = React.useRef(null);
  const loadConnection = React.useCallback(async signal => {
    setConfigState('loading'); setError('');
    try {
      const c = await api('/api/openlist',{signal});
      if (signal?.aborted) return;
      setConnection(c); setBaseUrl(c.baseUrl || ''); setRoot(c.root || '/'); setConfigState('ready');
    } catch(e) {
      if (!signal?.aborted) { setConfigState('failed'); setError(e.message || '绑定信息读取失败，请重试。'); }
    }
  },[]);
  React.useEffect(() => {
    if (!active) { video.current?.pause(); return; }
    const abort = new AbortController();
    void loadConnection(abort.signal);
    return () => abort.abort();
  },[active,loadConnection]);
  async function action(fn) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch(e) { setError(e.message || '连接失败，请重试'); } finally { setBusy(false); } }
  const browse = (path='/',page=1) => action(async () => {
    setPicker(await api('/api/openlist/browse',{method:'POST',body:{baseUrl,token,path,page}}));
    setNotice('连接成功，请选择课程目录');
  });
  const loadCourses = (path,page=1) => action(async () => {
    const query = new URLSearchParams({page:String(page),...(path ? {path} : {})});
    setCourses(await api('/api/openlist/courses?'+query));
  });
  const parent = path => path.slice(0,path.lastIndexOf('/')) || '/';
  function pager(list,load) { return list && list.total > 100 && <div className="openlist-actions"><button className="btn" disabled={busy || list.page <= 1} onClick={() => load(list.path,list.page-1)}>上一页</button><span>第 {list.page} 页</span><button className="btn" disabled={busy || list.page*100 >= list.total} onClick={() => load(list.path,list.page+1)}>下一页</button></div>; }
  return <section className="connection-section sync-module openlist-settings" aria-label="OpenList 网盘课程">
    <div className="sync-module-title"><h3>网盘课程</h3><span className="sync-status" data-tone={configState === 'ready' && connection?.connected ? 'success':'neutral'}>{configState === 'loading' ? '正在读取绑定信息' : configState === 'failed' ? '绑定信息读取失败' : connection?.connected ? '已绑定 OpenList':'未绑定'}</span></div>
    <p className="sync-meta">连接已挂载夸克的 OpenList，选择课程目录后直接播放。本站不保存视频文件。</p>
    {configState === 'loading' && <div className="openlist-config-pending" role="status" aria-busy="true" aria-label="正在读取 OpenList 绑定信息"><div className="openlist-fields" aria-hidden="true"><span className="sk-line"/><span className="sk-line"/></div><span className="sk-line" aria-hidden="true"/></div>}
    {configState === 'failed' && <div className="openlist-config-failed" role="alert"><p className="connection-error">{error}</p><button type="button" className="btn" onClick={()=>void loadConnection()}>重新读取绑定信息</button></div>}
    {configState === 'ready' && <>
    <div className="openlist-fields">
      <label>OpenList 服务地址<input aria-label="OpenList 服务地址" type="url" value={baseUrl} placeholder="https://你的 OpenList 地址" onChange={e => {setBaseUrl(e.target.value);setPicker(null);}} autoComplete="off" /></label>
      <label>OpenList 访问令牌<input aria-label="OpenList 访问令牌" type="password" value={token} placeholder={connection?.hasToken ? '已保存；留空保留现有令牌':'填写 OpenList token'} onChange={e => {setToken(e.target.value);setPicker(null);}} autoComplete="new-password" /></label>
    </div>
    <div className="openlist-actions"><button className="btn" disabled={busy || !baseUrl} onClick={() => browse('/')}>{busy ? '处理中…':'测试连接并选择目录'}</button><span className="sync-meta">凭证仅在服务器加密保存。</span></div>
    {picker && <div className="openlist-directory" aria-label="选择课程目录">
      <div className="openlist-actions"><strong>{picker.path}</strong><button className="btn" disabled={busy || picker.path === '/'} onClick={() => browse(parent(picker.path))}>上一级</button><button className="btn" disabled={busy} onClick={() => {setRoot(picker.path);setPicker(null);setNotice('目录已选择，请保存绑定');}}>选择此目录</button></div>
      {picker.items.filter(i=>i.isDir).map(i=><button className="openlist-row" key={i.path} disabled={busy} onClick={()=>browse(i.path)}><span>{i.name}</span><span aria-hidden="true">›</span></button>)}
      {!picker.items.some(i=>i.isDir) && <p className="sync-meta">此页没有子目录，可以选择当前目录。</p>}{pager(picker,browse)}
    </div>}
    <p className="openlist-root">课程目录：<strong>{root}</strong></p>
    <div className="openlist-actions"><button className="btn btn-primary" disabled={busy || !baseUrl} onClick={()=>action(async()=>{const c=await api('/api/openlist',{method:'PUT',body:{baseUrl,token,root}});setConnection(c);setToken('');setCourses(null);setPlaying(null);setNotice('绑定已保存');})}>保存绑定</button>
      {connection?.connected && <><button className="btn" disabled={busy} onClick={()=>loadCourses()}>打开课程目录</button><button className="btn btn-ghost" disabled={busy} onClick={()=>action(async()=>{setConnection(await api('/api/openlist',{method:'DELETE',body:{}}));setToken('');setCourses(null);setPlaying(null);setNotice('已解除绑定，网盘文件保留');})}>解除绑定</button></>}
    </div>
    {connection?.connected && <div className="openlist-quark">
      <div className="openlist-actions"><strong>夸克授权</strong><button className="btn" disabled={busy} onClick={()=>action(async()=>setQuark(await api('/api/openlist/quark')))}>检查授权</button><button className="btn" disabled={busy} onClick={()=>action(async()=>{setQuark(await api('/api/openlist/quark/connect',{method:'POST',body:{}}));setNotice('请使用夸克 App 扫码并确认授权');})}>重新扫码授权</button></div>
      {quark && <p className="sync-meta">{quark.ready ? '夸克挂载已就绪，可打开课程目录。':'夸克尚未就绪，请扫码授权后验证。'}</p>}
      {quark?.qr && <div><img className="openlist-qr" src={quark.qr} alt="夸克网盘授权二维码" /><button className="btn" disabled={busy} onClick={()=>action(async()=>{const q=await api('/api/openlist/quark/confirm',{method:'POST',body:{}});setQuark(q);if(q.ready)setNotice('授权成功，请选择课程目录');})}>已扫码，验证授权</button></div>}
    </div>}
    {error && <p className="connection-error" role="alert">{error}</p>}{notice && <p className="sync-meta" role="status">{notice}</p>}
    {courses && <div className="openlist-course-browser" aria-label="网盘课程目录">
      <div className="openlist-actions"><strong>{courses.path}</strong><button className="btn" disabled={busy || courses.path === connection.root} onClick={()=>loadCourses(parent(courses.path))}>返回上级目录</button></div>
      {!courses.items.length && <p className="sync-meta">此目录为空。</p>}
      {courses.items.map(i=><button className="openlist-row" key={i.path} disabled={busy || (!i.isDir && !i.video)} aria-pressed={!i.isDir ? playing?.path===i.path:undefined} onClick={()=>i.isDir ? loadCourses(i.path) : (setPlaying(i),setError(''))}><span>{i.name}</span><span>{i.isDir ? '进入':i.video ? '播放':'文件'}</span></button>)}
      {pager(courses,loadCourses)}
    </div>}
    {playing && <div className="openlist-player"><h4>{playing.name}</h4><video ref={video} key={playing.path} controls autoPlay playsInline preload="metadata" src={'/api/openlist/video?'+new URLSearchParams({path:playing.path})} onError={()=>setError('视频未能播放，请检查 OpenList 授权、源文件格式或网络；本站不会下载视频作为替代。')} /></div>}
    </>}
  </section>;
}
