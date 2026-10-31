const REFERENCE_LABELS = { face: '人物', costume: '服装', pose: '姿势' };

function AiArtCover({ active }) {
  const [images, setImages] = React.useState([]);
  React.useEffect(() => {
    if (!active || images.length) return;
    const controller = new AbortController();
    Promise.all(Object.keys(REFERENCE_LABELS).map(kind => api(`/api/reference-library?kind=${kind}`, { signal: controller.signal })))
      .then(libraries => { if (!controller.signal.aborted) setImages(libraries.map(library => library.items[0]?.thumbnailUrl).filter(Boolean)); })
      .catch(() => {});
    return () => controller.abort();
  }, [active, images.length]);
  return <span className="ai-art-cover" aria-hidden="true">{images.map((src, index) => <img key={src} src={src} alt="" className={`ai-art-cover-${index}`} />)}</span>;
}

function AiArtWorkspace({ active, hash, showToast, onCreate }) {
  return <section className="ai-art-workspace" aria-labelledby="ai-art-title">
    <a className="ai-art-back" href="#tools?space=mine">全部工具</a>
    <header className="ai-art-heading">
      <h1 id="ai-art-title">AI 作图</h1>
      <nav aria-label="AI 作图相关页面">
        <a className="btn btn-ghost" href="#works?space=mine">我的作品</a>
        <a className="btn" href="#studio?space=mine">创作台</a>
      </nav>
    </header>
    <ReferenceLibraryTool active={active} visible hash={hash} showToast={showToast} onCreate={onCreate} />
  </section>;
}

function ReferenceLibraryTool({ active, visible, hash, showToast, onCreate }) {
  const params = workspaceHashParams(hash), kind = params.get('kind') || 'face';
  const query = params.get('q') || '', collection = params.get('collection') || '', category = params.get('category') || '', hair = params.get('hair') || '';
  const selectedId = params.get('reference') || '';
  const [search, setSearch] = React.useState(query), [data, setData] = React.useState(null), [status, setStatus] = React.useState(null);
  const [detail, setDetail] = React.useState(null), [error, setError] = React.useState(''), [detailError, setDetailError] = React.useState('');
  const [loading, setLoading] = React.useState(false), [creating, setCreating] = React.useState(false), [revision, setRevision] = React.useState(0);
  const dialog = React.useRef(null);
  const navigate = updates => {
    const next = new URLSearchParams(workspaceHashParams(window.location.hash));
    next.delete('tab'); next.set('space', 'mine');
    for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
    window.location.hash = `#ai-art?${next}`;
  };
  React.useEffect(() => setSearch(query), [query]);
  React.useEffect(() => {
    if (!active || search === query) return;
    const timer = setTimeout(() => navigate({ q: search, page: '', reference: '' }), 300);
    return () => clearTimeout(timer);
  }, [search, query, active]);
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), q = new URLSearchParams();
    for (const key of ['kind','collection','q','category','hair','page','sort','originals']) if (params.get(key)) q.set(key, params.get(key));
    setLoading(true); setError('');
    api(`/api/reference-library?${q}`, { signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    api('/api/reference-library/status', { signal: controller.signal }).then(setStatus).catch(() => {});
    return () => controller.abort();
  }, [active, kind, collection, query, category, hair, params.get('page'), params.get('sort'), params.get('originals'), revision]);
  React.useEffect(() => {
    if (!active || !selectedId) { setDetail(null); dialog.current?.close(); return; }
    const controller = new AbortController(); setDetail(null); setDetailError('');
    dialog.current?.showModal();
    api(`/api/reference-library/items/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(setDetail)
      .catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [active, selectedId]);
  const close = () => navigate({ reference: '' });
  async function create() {
    if (!detail || creating || !onCreate) return;
    setCreating(true);
    try {
      const response = await fetch(detail.imageUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('参考图读取失败，请重试。');
      const blob = await response.blob(), extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
      const asset = await uploadMediaFile(new File([blob], `${detail.stem}.${extension}`, { type: blob.type }), { title: detail.title });
      dialog.current?.close();
      close();
      await onCreate(asset, detail);
    } catch (e) { showToast?.(e.message); }
    finally { setCreating(false); }
  }
  async function copyPrompt() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(`请以我提供的${REFERENCE_LABELS[detail.kind]}参考图为依据。${detail.title}。${detail.tags.slice(0, 8).join('、')}。保留参考中的关键特征，并按我的场景要求创作。`);
      showToast?.('参考说明已复制，请与图片一起使用');
    } catch { showToast?.('无法访问剪贴板，请下载图片后使用'); }
  }
  if (!visible) return null;
  return <section className="reference-library" aria-label="作图参考库">
    <div className="reference-toolbar">
      <div className="reference-kinds" aria-label="参考图类型">{Object.entries(REFERENCE_LABELS).map(([id, label]) => <button key={id} type="button" className={kind === id ? 'active' : ''} aria-pressed={kind === id}
        onClick={() => { setSearch(''); navigate({ kind: id, q: '', category: '', hair: '', page: '', reference: '' }); }}>{label}<span>{data?.counts?.[id]?.toLocaleString() || '—'}</span></button>)}</div>
      <label className="reference-search"><IconSearch /><input aria-label="搜索参考图" type="search" placeholder="搜索名称、标签或编号" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    <div className="reference-filters">
      <select className="reference-collection" aria-label="素材集" value={collection} onChange={e => { setSearch(''); navigate({ collection: e.target.value, q: '', category: '', hair: '', page: '', reference: '' }); }}><option value="">全部素材集</option>{(data?.collections || []).map(item => <option key={item.id} value={item.id}>{item.name}（{item.count.toLocaleString()}）</option>)}</select>
      <select aria-label="素材分类" value={category} onChange={e => navigate({ category: e.target.value, page: '' })}><option value="">全部分类</option>{(data?.categories || []).map(value => <option key={value}>{value}</option>)}</select>
      {kind === 'face' && <select aria-label="头发长度" value={hair} onChange={e => navigate({ hair: e.target.value, page: '' })}><option value="">全部发长</option>{(data?.hairs || []).map(value => <option key={value}>{value}</option>)}</select>}
      <select aria-label="排序方式" value={params.get('sort') || ''} onChange={e => navigate({ sort: e.target.value, page: '' })}><option value="">默认排序</option><option value="newest">最近加入</option></select>
      <label className="reference-original-filter"><input type="checkbox" checked={params.get('originals') === '1'} onChange={e => navigate({ originals: e.target.checked ? '1' : '', page: '' })} />原图已导入</label>
      <span className="reference-private">仅自己可见</span>
    </div>
    <div className="reference-summary" aria-live="polite"><span>{loading ? '正在读取…' : `${(data?.total || 0).toLocaleString()} 张参考图`}</span><button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>刷新</button>
      <details><summary>{status?.state === 'syncing' ? '正在同步' : ['failed', 'partial'].includes(status?.state) ? '同步待重试' : '同步状态'}</summary><div className="reference-sync-info"><p>每天自动检查新增素材，已有图片保留。</p><p>最近一次新增 {status?.added || 0} 张，更新 {status?.changed || 0} 张。</p><p>已导入 {status?.originalCount || 0} 张原图；{status?.pendingOriginals || 0} 张等待原图。</p>{status?.checkedAt && <p>最近检查：{new Date(status.checkedAt).toLocaleString('zh-CN')}</p>}{status?.nextCheckAt && <p>下次检查：{new Date(status.nextCheckAt).toLocaleString('zh-CN')}</p>}{status?.error && <p role="status">上次同步未完成，已保存的素材仍可用。</p>}</div></details>
    </div>
    {error && <div className="reference-empty" role="alert">{error}<button className="btn" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!error && !loading && !data?.items.length && <div className="reference-empty"><strong>{data?.counts?.[kind] ? '没有匹配的参考图' : '素材正在准备'}</strong><p>{data?.counts?.[kind] ? '换个关键词，或清除分类筛选。' : '导入完成后，图片会显示在这里。'}</p></div>}
    {!error && <div className="reference-grid" aria-busy={loading}>{data?.items.map(item => <button type="button" className="reference-card" key={item.id} onClick={() => navigate({ reference: item.id })}>
      <div className="reference-image"><img loading="lazy" decoding="async" src={item.thumbnailUrl} alt={item.title} /><span className={item.originalReady ? 'ready' : ''}>{item.originalReady ? '原图' : '预览'}</span></div>
      <div className="reference-caption"><strong>{item.title}</strong><span>{item.angle || item.hair || item.category}<small>{item.stem}</small></span></div>
    </button>)}</div>}
    {data?.pages > 1 && <nav className="reference-pagination" aria-label="参考图库分页"><button className="btn" disabled={data.page === 1 || loading} onClick={() => navigate({ page: String(data.page - 1) })}>上一页</button><span>{data.page} / {data.pages}</span><button className="btn" disabled={data.page === data.pages || loading} onClick={() => navigate({ page: String(data.page + 1) })}>下一页</button></nav>}
    <dialog className="reference-dialog" ref={dialog} aria-label="参考图详情" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <button className="reference-close btn" aria-label="关闭参考图" onClick={close}><IconX /></button>
      {detail ? <div className="reference-detail"><div className="reference-detail-image"><img src={detail.imageUrl} alt={detail.title} /></div><div className="reference-inspector"><span className="reference-detail-kind">{REFERENCE_LABELS[detail.kind]}参考 · {detail.category}</span><h2>{detail.title}</h2><p className="reference-detail-id">{detail.collectionName}<br />{detail.stem}</p><div className="reference-tags">{detail.tags.slice(0, 12).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
        {detail.variants.length > 1 && <div className="reference-angles" aria-label="姿势角度">{detail.variants.map(item => <button key={item.id} className={item.id === detail.id ? 'active' : ''} onClick={() => navigate({ reference: item.id })}>{item.angle}</button>)}</div>}
        <p className="reference-quality">{detail.originalReady ? '已保存原图，可直接用于创作。' : '当前为预览图。原图导入后会自动替换，无需重新选择。'}</p>
        <div className="reference-detail-actions"><a className="btn btn-primary" href={`${detail.imageUrl}?download=1`} download>{detail.originalReady ? '下载原图' : '下载预览图'}</a><button className="btn" onClick={create} disabled={creating || !onCreate}>{creating ? '正在准备…' : '用于创作'}</button><button className="btn btn-ghost" onClick={copyPrompt}>复制参考说明</button></div>
        <a className="reference-source" href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">查看素材来源</a></div></div> : <p className="reference-empty">{detailError || '正在读取参考图…'}</p>}
    </dialog>
  </section>;
}
