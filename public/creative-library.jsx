(function(){
  const { useState, useEffect, useRef, useCallback } = React;
  const LIB_BASE = '/api/creative-library';
  const QUEUE_PATH = '/api/omniget/queue';
  const Omniget = (typeof OmnigetWorkspace !== 'undefined') ? OmnigetWorkspace : null;
  const TYPE_LABELS = { image: '图片', video: '视频', audio: '音频' };
  const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,audio/wav,audio/mpeg';
  const MIME_FORMATS = { 'image/jpeg': 'JPG', 'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/x-wav': 'WAV', 'audio/wave': 'WAV' };
  const STORAGE_LABELS = { stored: '服务器，已云备份', local: '服务器', failed: '服务器，云备份未完成', pending: '服务器，云备份等待中' };
  // Dimensions and durations read from the real files, keyed by file URL so remounts do not re-probe.
  const mediaFacts = new Map();

  function sizeLabel(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1).replace(/\.0$/, '') + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }
  function durationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.max(1, Math.round(seconds));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = String(total % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  const orientationLabel = (w, h) => !w || !h ? '' : w > h ? '横版' : w < h ? '竖版' : '方形';
  const dimensionLabel = facts => facts.width && facts.height ? facts.width + '×' + facts.height : '';
  function formatLabel(item) {
    const mime = item.mimeType || item.contentType || '';
    if (MIME_FORMATS[mime]) return MIME_FORMATS[mime];
    if (/^(image|video|audio)\/[a-z0-9]+$/i.test(mime)) return mime.split('/')[1].toUpperCase();
    for (const name of [item.fileUrl, item.title]) {
      const ext = String(name || '').split(/[?#]/)[0].split('/').pop().match(/\.([a-z0-9]{2,5})$/i);
      if (ext) return ext[1].toUpperCase();
    }
    return '';
  }
  function specParts(item, facts, detailed) {
    if (item.kind === 'image') return [dimensionLabel(facts)].filter(Boolean);
    if (item.kind === 'video') return [durationLabel(facts.duration), detailed && dimensionLabel(facts), orientationLabel(facts.width, facts.height)].filter(Boolean);
    if (item.kind === 'audio') return [durationLabel(facts.duration)].filter(Boolean);
    return [];
  }
  function sourceLabel(item) {
    if (item.sourceUrl) {
      try { return new URL(item.sourceUrl).hostname.replace(/^www\./, ''); } catch {}
    }
    return '本地上传';
  }

  const PlayGlyph = () => <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 1.6v8.8L10.2 6z" fill="currentColor" /></svg>;
  const PauseGlyph = () => <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor" /></svg>;

  function useNearViewport(ref) {
    const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
    useEffect(() => {
      if (near || !ref.current) return;
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) setNear(true);
      }, { rootMargin: '400px 0px' });
      observer.observe(ref.current);
      return () => observer.disconnect();
    }, [near]);
    return near;
  }

  function Fallback({ item, failed, onRetry }) {
    return <div className="cl-fallback">
      <strong>{formatLabel(item) || TYPE_LABELS[item.kind] || '文件'}</strong>
      <span>{failed ? '无法解码预览' : '暂无预览'}</span>
      {failed && onRetry && <button className="cl-btn" onClick={onRetry}>重新预览</button>}
    </div>;
  }

  function MediaFrame({ item, facts, onFacts, playing, onToggleAudio, children }) {
    const ref = useRef(null);
    const near = useNearViewport(ref);
    const probeAudio = item.kind === 'audio' && near && !facts.duration && !facts.error && Boolean(item.fileUrl);

    // Audio cards read only the metadata header for duration; playback loads on click.
    useEffect(() => {
      if (!probeAudio) return;
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => onFacts({ duration: probe.duration });
      probe.onerror = () => onFacts({ error: true });
      probe.src = item.fileUrl;
      return () => { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute('src'); probe.load(); };
    }, [probeAudio, item.fileUrl]);

    let media;
    if (facts.error || !item.fileUrl) media = <Fallback item={item} failed={facts.error} onRetry={() => onFacts({ error: false })} />;
    else if (item.kind === 'image') media = <img src={item.fileUrl} alt="" loading="lazy" decoding="async"
      onLoad={event => onFacts({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => onFacts({ error: true })} />;
    else if (item.kind === 'video') media = near ? <video src={item.fileUrl + '#t=0.1'} poster={item.thumbnailUrl || undefined}
      preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
      onLoadedMetadata={event => { const v = event.currentTarget; onFacts({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }}
      onError={() => onFacts({ error: true })} /> : null;
    else if (item.kind === 'audio') media = <div className="cl-audio-face">
      <button className={'cl-audio-play' + (playing ? ' is-playing' : '')} aria-label={(playing ? '暂停 ' : '播放 ') + (item.title || '音频')} onClick={onToggleAudio}>
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <span>{formatLabel(item) || '音频'}</span>
    </div>;
    else media = <Fallback item={item} />;
    return <div ref={ref} className="cl-frame">{media}{children}</div>;
  }

  function CreativeLibraryWorkspace({ userId, onUse, onAssetsChanged, showToast, canCollect = true, assets = [] }) {
    const [tab, setTab] = useState('library');
    const [items, setItems] = useState([]);
    const [collections, setCollections] = useState([]);
    const [limits, setLimits] = useState(null);
    const [usage, setUsage] = useState(null);
    const [collectionFilter, setCollectionFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [favOnly, setFavOnly] = useState(false);
    const [selected, setSelected] = useState(new Set());
    const [adoptSelected, setAdoptSelected] = useState(new Set());
    const [panel, setPanel] = useState(null);
    const [newCollectionName, setNewCollectionName] = useState('');
    const [queueRecords, setQueueRecords] = useState(null);
    const [queueError, setQueueError] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [creatingCollection, setCreatingCollection] = useState(false);
    const [loading, setLoading] = useState(true);
    const [playingId, setPlayingId] = useState(null);
    const [, setFactsVersion] = useState(0);
    const alive = useRef(false);
    const requestId = useRef(0);
    const writing = useRef(false);
    const panelRef = useRef(null);
    const uploadRef = useRef(null);
    const player = useRef(null);
    const allowPanelClose = useCallback(() => {
      const form = panelRef.current;
      const name = form?.querySelector('input[name="title"]');
      const collect = form?.querySelector('.cl-collect');
      const hasInput = collect && [...collect.querySelectorAll('input[type="url"], textarea')].some(input => input.value.trim());
      const dirty = Boolean(name && name.value !== name.defaultValue || hasInput);
      return window.OmniNavigationGuard ? window.OmniNavigationGuard.confirmDiscard(dirty) : !dirty || window.confirm('尚有未保存的内容，确定关闭？');
    }, []);
    const closePanel = useCallback(() => { if (allowPanelClose()) setPanel(null); }, [allowPanelClose]);

    useEffect(() => {
      if (!panel) return;
      const previouslyFocused = document.activeElement;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const dialog = panelRef.current;
      const controls = () => [...dialog.querySelectorAll('button, input, select, textarea, a[href], audio[controls], video[controls], [tabindex="0"]')]
        .filter(element => !element.disabled && element.getClientRects().length > 0);
      controls()[0]?.focus();
      const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
        if (event.key !== 'Tab') return;
        const elements = controls();
        const first = elements[0], last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); return; }
        if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', onKey);
      const unregister = window.OmniNavigationGuard?.register(allowPanelClose);
      const beforeUnload = event => {
        const name = dialog.querySelector('input[name="title"]');
        const collect = dialog.querySelector('.cl-collect');
        const hasInput = collect && [...collect.querySelectorAll('input[type="url"], textarea')].some(input => input.value.trim());
        if (name && name.value !== name.defaultValue || hasInput) { event.preventDefault(); event.returnValue = ''; }
      };
      window.addEventListener('beforeunload', beforeUnload);
      return () => {
        unregister?.();
        window.removeEventListener('beforeunload', beforeUnload);
        document.removeEventListener('keydown', onKey);
        document.body.style.overflow = previousOverflow;
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      };
    }, [Boolean(panel)]);

    const targetCollectionId = () => (collectionFilter === 'all' || collectionFilter === 'none') ? null : collectionFilter;

    const load = useCallback(async () => {
      const ticket = ++requestId.current;
      try {
        const data = await api(LIB_BASE);
        if (!alive.current || ticket !== requestId.current) return;
        setItems(data.items);
        setCollections(data.collections);
        setLimits(data.limits);
        setUsage(data.usage);
        setLoading(false);
      } catch (reason) {
        if (alive.current && ticket === requestId.current) { setError(reason.message); setLoading(false); }
      }
    }, []);

    useEffect(() => {
      alive.current = true;
      load();
      return () => { alive.current = false; requestId.current += 1; };
    }, [userId, load]);

    useEffect(() => {
      if (tab !== 'records' || !canCollect) return;
      let active = true;
      const refresh = async () => {
        try {
          const data = await api(QUEUE_PATH);
          if (active) { setQueueRecords(data.jobs || []); setQueueError(''); }
        } catch (reason) {
          if (active) setQueueError(reason.message);
        }
      };
      refresh();
      const timer = setInterval(refresh, 2500);
      return () => { active = false; clearInterval(timer); };
    }, [tab, canCollect]);

    useEffect(() => () => {
      const audio = player.current;
      if (!audio) return;
      audio.onplay = audio.onpause = audio.onended = audio.onerror = audio.onloadedmetadata = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }, []);

    async function mutate(action, after) {
      if (writing.current) return false;
      writing.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await action();
        if (!alive.current) return false;
        after?.(result);
        await load();
        return true;
      } catch (reason) {
        if (alive.current) setError(reason.message);
        return false;
      } finally {
        writing.current = false;
        if (alive.current) setBusy(false);
      }
    }

    const recordFacts = useCallback((url, patch) => {
      const previous = mediaFacts.get(url) || {};
      const next = { ...previous };
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        const valid = key === 'error' ? typeof value === 'boolean' : Number.isFinite(value) && value > 0;
        if (valid && previous[key] !== value) { next[key] = value; changed = true; }
      }
      if (!changed) return;
      mediaFacts.set(url, next);
      if (alive.current) setFactsVersion(version => version + 1);
    }, []);

    // One shared player for grid cards: nothing loads until the user presses play.
    function toggleAudio(item) {
      const key = String(item.id);
      let audio = player.current;
      if (!audio) {
        audio = player.current = new Audio();
        audio.preload = 'none';
        audio.onplay = () => setPlayingId(audio.dataset.id);
        audio.onpause = audio.onended = () => setPlayingId(null);
      }
      if (audio.dataset.id === key && !audio.paused) { audio.pause(); return; }
      if (audio.dataset.id !== key || audio.error) {
        audio.pause();
        audio.dataset.id = key;
        audio.onloadedmetadata = () => recordFacts(item.fileUrl, { duration: audio.duration });
        audio.onerror = () => { setPlayingId(null); recordFacts(item.fileUrl, { error: true }); };
        audio.src = item.fileUrl;
      }
      audio.play().catch(() => {});
    }
    const stopAudio = () => player.current?.pause();
    useEffect(() => {
      player.current?.pause();
    }, [tab, collectionFilter, typeFilter, favOnly, search, panel?.type]);
    const openDetail = id => { stopAudio(); setPanel({ type: 'detail', id }); };
    const openCollect = () => { stopAudio(); setPanel({ type: 'collect' }); };

    const filtered = items.filter((it) => {
      if (collectionFilter === 'none' && it.collectionId) return false;
      if (collectionFilter !== 'all' && collectionFilter !== 'none' && it.collectionId !== collectionFilter) return false;
      if (typeFilter !== 'all' && it.kind !== typeFilter) return false;
      if (favOnly && !it.favorite) return false;
      if (search && !(it.title || '').toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });

    function toggleSelect(id) {
      setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    function toggleAdopt(id) {
      setAdoptSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }

    function patchItem(id, patch) {
      return mutate(() => api(LIB_BASE + '/items/' + encodeURIComponent(id), { method: 'PATCH', body: patch }));
    }

    function handleUpload(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const params = new URLSearchParams({ title: file.name });
      const cid = targetCollectionId();
      if (cid) params.set('collectionId', cid);
      return mutate(async () => {
        const response = await fetch(LIB_BASE + '/uploads?' + params, { method: 'POST', body: file, credentials: 'same-origin' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '上传失败');
        return data;
      }, () => showToast?.('已保存到素材库'));
    }

    function handleAdopt() {
      const assetIds = Array.from(adoptSelected);
      if (!assetIds.length) return;
      return mutate(() => api(LIB_BASE + '/items', { method: 'POST', body: { assetIds, collectionId: targetCollectionId() } }), () => {
        setAdoptSelected(new Set());
        showToast?.('已加入素材库');
      });
    }

    function handleImport(sourceType, sourceId) {
      return mutate(() => api(LIB_BASE + '/imports', { method: 'POST', body: { sourceType, sourceId, collectionId: targetCollectionId() } }),
        () => showToast?.('已保存到素材库'));
    }

    function handleCreateCollection() {
      const name = newCollectionName.trim();
      if (!name) return;
      return mutate(() => api(LIB_BASE + '/collections', { method: 'POST', body: { name } }), (result) => {
        setNewCollectionName('');
        setCreatingCollection(false);
        pickScope(result.id);
      });
    }

    async function sendToDraft(chosen, newDraft, clearSelection) {
      if (!chosen.length || writing.current) return;
      setError('');
      writing.current = true;
      setBusy(true);
      try {
        await onAssetsChanged?.();
        if (!alive.current) return;
        const result = await onUse(chosen, { newDraft });
        if (clearSelection && result !== false) setSelected(new Set());
      } catch (reason) {
        if (alive.current) setError(reason.message);
      } finally {
        writing.current = false;
        if (alive.current) setBusy(false);
      }
    }

    const view = tab === 'records' && canCollect ? 'records' : 'library';
    const scope = view === 'records' ? 'records' : favOnly ? 'favorite' : collectionFilter;
    const title = { records: '收集记录', favorite: '收藏', none: '未整理' }[scope]
      || collections.find(collection => collection.id === collectionFilter)?.name || '素材';
    const scopes = [
      ['all', '全部素材', items.length],
      ['favorite', '收藏', items.filter(item => item.favorite).length],
      ['none', '未整理', items.filter(item => !item.collectionId).length],
      ...(canCollect ? [['records', '收集记录', null]] : []),
    ];
    const chooseCollection = id => { setCollectionFilter(id); setFavOnly(false); setTab('library'); };
    function pickScope(key) {
      if (key === 'records') setTab('records');
      else if (key === 'favorite') { setFavOnly(true); setCollectionFilter('all'); setTab('library'); }
      else chooseCollection(key);
      setPanel(current => current?.type === 'collections' ? null : current);
    }

    const detailItem = panel?.type === 'detail' ? items.find(item => item.id === panel.id) : null;
    const detailFacts = detailItem ? mediaFacts.get(detailItem.fileUrl) || {} : {};
    const onDetailFacts = patch => recordFacts(detailItem.fileUrl, patch);
    const panelTitle = { collect: '收集链接', detail: '素材详情', collections: '集合' }[panel?.type];
    const unadopted = assets.filter(asset => !items.some(item => item.id === asset.id));

    const uploadButton = <button className="cl-btn" disabled={busy} onClick={() => uploadRef.current?.click()}>
      <IconUpload aria-hidden="true" />上传
    </button>;
    const collectButton = canCollect && Omniget && <button className="cl-btn cl-primary" onClick={openCollect}>
      <IconPlus aria-hidden="true" />收集链接
    </button>;

    const renderNav = () => <React.Fragment>
      <nav className="cl-nav" aria-label="素材范围">
        {scopes.map(([key, label, count]) => <button key={key} aria-current={scope === key ? 'page' : undefined} onClick={() => pickScope(key)}>
          <span className="cl-nav-name">{label}</span>{count != null && <span className="cl-nav-count">{count}</span>}
        </button>)}
      </nav>
      <div className="cl-nav-label">
        <span>集合</span>
        <button className="cl-icon-btn" aria-label="新建集合" aria-expanded={creatingCollection} onClick={() => setCreatingCollection(value => !value)}><IconPlus aria-hidden="true" /></button>
      </div>
      {creatingCollection && <form className="cl-new" onSubmit={event => { event.preventDefault(); handleCreateCollection(); }}>
        <input className="cl-input" aria-label="集合名称" placeholder="集合名称" value={newCollectionName} onChange={event => setNewCollectionName(event.target.value)} maxLength={120} autoFocus />
        <button className="cl-btn" disabled={busy || !newCollectionName.trim()}>创建</button>
      </form>}
      <nav className="cl-nav" aria-label="我的集合">
        {collections.map(collection => <button key={collection.id} title={collection.name}
          aria-current={scope === collection.id ? 'page' : undefined} onClick={() => pickScope(collection.id)}>
          <span className="cl-nav-name">{collection.name}</span>
          <span className="cl-nav-count">{items.filter(item => item.collectionId === collection.id).length}</span>
        </button>)}
        {!collections.length && <p className="cl-nav-empty">按主题整理参考素材</p>}
      </nav>
    </React.Fragment>;

    const renderDetailMedia = item => {
      if (detailFacts.error || !item.fileUrl) return <Fallback item={item} failed={detailFacts.error} onRetry={() => onDetailFacts({ error: false })} />;
      if (item.kind === 'image') return <img src={item.fileUrl} alt={item.title || ''}
        onLoad={event => onDetailFacts({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => onDetailFacts({ error: true })} />;
      if (item.kind === 'video') return <video src={item.fileUrl + '#t=0.1'} poster={item.thumbnailUrl || undefined} controls playsInline preload="metadata"
        onLoadedMetadata={event => { const v = event.currentTarget; onDetailFacts({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }}
        onError={() => onDetailFacts({ error: true })} />;
      if (item.kind === 'audio') return <div className="cl-detail-audio">
        <strong>{item.title || '未命名音频'}</strong>
        <span>{[formatLabel(item), durationLabel(detailFacts.duration), sizeLabel(item.sizeBytes)].filter(Boolean).join(' · ')}</span>
        <audio src={item.fileUrl} controls preload="metadata"
          onLoadedMetadata={event => onDetailFacts({ duration: event.currentTarget.duration })}
          onError={() => onDetailFacts({ error: true })} />
      </div>;
      return <Fallback item={item} />;
    };

    const detailRows = detailItem ? [
      ['类型', [TYPE_LABELS[detailItem.kind] || '文件', formatLabel(detailItem)].filter(Boolean).join(' · ')],
      ['规格', specParts(detailItem, detailFacts, true).join(' · ')],
      ['大小', sizeLabel(detailItem.sizeBytes)],
      ['来源', sourceLabel(detailItem)],
      ['保存位置', STORAGE_LABELS[detailItem.storageState] || STORAGE_LABELS.pending],
    ].filter(([, value]) => value) : [];

    return (
      <section className="cl-root" aria-label="素材工作区">
        <header className="cl-head">
          <h1 className="cl-title" title={title}><PhraseText>{title}</PhraseText></h1>
          <div className="cl-head-actions">
            <button className="cl-btn cl-scope-btn" aria-haspopup="dialog" onClick={() => setPanel({ type: 'collections' })}>集合</button>
            {uploadButton}{collectButton}
          </div>
          <input ref={uploadRef} type="file" aria-label="上传文件" hidden accept={ACCEPT} disabled={busy} onChange={handleUpload} />
        </header>
        <div className="cl-layout">
          <aside className="cl-sidebar" aria-label="素材分类">
            {renderNav()}
            {limits && usage && <div className="cl-quota">
              <div><span>存储</span><span>{sizeLabel(usage.bytes)} / {sizeLabel(limits.maxStorageBytes)}</span></div>
              <progress max={limits.maxStorageBytes} value={usage.bytes} aria-label="素材容量使用情况" />
            </div>}
          </aside>
          <div className="cl-main">
            {error && !panel && <div className="cl-error" role="alert"><span>{error}</span><button className="cl-btn" onClick={() => { setError(''); load(); }}>重试</button></div>}
            {view === 'library' && <React.Fragment>
              <div className="cl-toolbar">
                <label className="cl-search"><IconSearch aria-hidden="true" />
                  <input className="cl-input" type="search" aria-label="搜索素材" placeholder="搜索素材名称" value={search} onChange={event => setSearch(event.target.value)} />
                </label>
                <div className="cl-toolbar-end">
                  <select className="cl-input cl-type" aria-label="素材类型" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}>
                    <option value="all">全部类型</option>
                    {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <span className="cl-count" aria-live="polite">{loading ? '' : filtered.length + ' 项'}</span>
                </div>
              </div>
              {loading ? <div className="cl-empty" role="status">正在加载素材…</div> : <div className="cl-grid">
                {!filtered.length && <div className="cl-empty">
                  <IconInbox aria-hidden="true" /><h3>{search || items.length ? '没有找到符合条件的素材' : '从第一份参考素材开始'}</h3>
                  <p>{search || items.length ? '试试其他关键词或切换筛选条件。' : '上传图片、视频或音频，也可以从公开链接收集。'}</p>
                  {search || items.length
                    ? <button className="cl-btn" onClick={() => { setSearch(''); setTypeFilter('all'); chooseCollection('all'); }}>清除筛选</button>
                    : <button className="cl-btn" disabled={busy} onClick={() => uploadRef.current?.click()}>上传文件</button>}
                </div>}
                {filtered.map(item => {
                  const facts = mediaFacts.get(item.fileUrl) || {};
                  const name = item.title || '未命名素材';
                  const isSelected = selected.has(item.id);
                  const duration = durationLabel(facts.duration);
                  const meta = [TYPE_LABELS[item.kind] || formatLabel(item) || '文件', ...specParts(item, facts), sizeLabel(item.sizeBytes)].filter(Boolean).join(' · ');
                  return <article key={item.id} className={'cl-card' + (isSelected ? ' is-selected' : '')}>
                    <MediaFrame item={item} facts={facts} onFacts={patch => recordFacts(item.fileUrl, patch)}
                      playing={playingId === String(item.id)} onToggleAudio={() => toggleAudio(item)}>
                      {!facts.error && <button className="cl-open" tabIndex={-1} aria-hidden="true" onClick={() => openDetail(item.id)} />}
                      {item.kind === 'video' && !facts.error && <span className="cl-duration" data-glass="dense" aria-hidden="true"><PlayGlyph />{duration}</span>}
                      <label className="cl-check" data-glass="dense"><input type="checkbox" aria-label={'选择 ' + name} checked={isSelected} onChange={() => toggleSelect(item.id)} /></label>
                    </MediaFrame>
                    <div className="cl-copy">
                      <div className="cl-copy-row">
                        <button className="cl-name" title={name} onClick={() => openDetail(item.id)}>{name}</button>
                        <button className="cl-fav" aria-label={(item.favorite ? '取消收藏 ' : '收藏 ') + name} aria-pressed={Boolean(item.favorite)}
                          disabled={busy} onClick={() => patchItem(item.id, { favorite: !item.favorite })}>{item.favorite ? '★' : '☆'}</button>
                      </div>
                      <p className="cl-meta">{meta}
                        {['pending', 'failed'].includes(item.storageState) && <span className="cl-warn"> · {item.storageState === 'pending' ? '云备份等待中' : '云备份未完成'}</span>}
                      </p>
                    </div>
                  </article>;
                })}
              </div>}
              {unadopted.length > 0 && <details className="cl-adopt">
                <summary>从已有作品选择</summary>
                <div className="cl-adopt-list">{unadopted.map(asset =>
                  <label key={asset.id}><input type="checkbox" checked={adoptSelected.has(asset.id)} onChange={() => toggleAdopt(asset.id)} />
                    <span className="cl-adopt-name">{asset.title || '未命名作品'}</span><span>{TYPE_LABELS[asset.kind]}</span></label>)}</div>
                <button className="cl-btn" disabled={busy || !adoptSelected.size} onClick={handleAdopt}>加入素材库</button>
              </details>}
              {selected.size > 0 && <div className="cl-actionbar" role="region" aria-label="已选素材操作">
                <span>已选 <strong>{selected.size}</strong> 项</span>
                <button className="cl-btn cl-ghost" onClick={() => setSelected(new Set())}>取消选择</button>
                <button className="cl-btn" disabled={busy} onClick={() => sendToDraft(items.filter(item => selected.has(item.id)), true, true)}>用于新草稿</button>
                <button className="cl-btn cl-strong" disabled={busy} onClick={() => sendToDraft(items.filter(item => selected.has(item.id)), false, true)}>加入当前草稿</button>
              </div>}
            </React.Fragment>}
            {view === 'records' && <div className="cl-records">
              {queueError && <p className="cl-error" role="alert">{queueError}</p>}
              <p className="cl-note">下载文件默认保留 1 小时，保存后可在素材库中查看。</p>
              {!queueRecords && !queueError && <p className="cl-note" role="status">正在加载收集记录…</p>}
              {(queueRecords || []).map(record => <article key={record.id} className="cl-record">
                <div className="cl-record-copy">
                  <strong>{omnigetQueueLabel(record)}</strong>
                  <p>{record.state === 'ready' && record.metadata?.expiresAt ? '临时文件，有效至 ' + new Date(record.metadata.expiresAt).toLocaleString() : record.error || '公开链接收集'}</p>
                </div>
                <span className={'cl-record-status is-' + record.state}>{omnigetQueueStatus(record.state)}</span>
                {record.state === 'ready' && record.metadata?.expiresAt > Date.now() && <button className="cl-btn" disabled={busy} onClick={() => handleImport('queue', record.id)}>保存到素材库</button>}
              </article>)}
              {queueRecords && !queueRecords.length && !queueError && <div className="cl-empty">
                <IconDownload aria-hidden="true" /><h3>还没有收集记录</h3><p>通过公开链接收集素材，处理进度会显示在这里。</p>
                {Omniget && <button className="cl-btn" onClick={openCollect}>收集链接</button>}
              </div>}
            </div>}
          </div>
        </div>
        {panel && <div className="cl-panel" data-type={panel.type} onClick={closePanel}>
          <div ref={panelRef} tabIndex={-1} className="cl-sheet" role="dialog" aria-modal="true" aria-label={panelTitle} onClick={event => event.stopPropagation()}>
            <header className="cl-sheet-head">
              <button className="cl-btn cl-ghost cl-back" onClick={closePanel}>‹ 返回</button>
              <h2>{panelTitle}</h2>
              <button className="cl-btn cl-ghost cl-close" aria-label="关闭" onClick={closePanel}><IconX aria-hidden="true" /></button>
            </header>
            {error && <p className="cl-error" role="alert">{error}</p>}
            {panel.type === 'collections' && <div className="cl-sheet-body">{renderNav()}</div>}
            {panel.type === 'collect' && Omniget && <div className="cl-sheet-body cl-collect">
              <p className="cl-note">保存到 {collections.find(collection => collection.id === targetCollectionId())?.name || '未整理'}</p>
              <Omniget active visible onSave={(type, id) => handleImport(type, id)} />
            </div>}
            {panel.type === 'detail' && !detailItem && <p className="cl-sheet-body cl-note">这份素材已不存在。</p>}
            {detailItem && <React.Fragment>
              <div className={'cl-detail-media is-' + detailItem.kind}>{renderDetailMedia(detailItem)}</div>
              <div className="cl-detail">
                <form onSubmit={event => { event.preventDefault(); patchItem(detailItem.id, { title: new FormData(event.currentTarget).get('title') }); }}>
                  <label>素材名称<input key={detailItem.id} className="cl-input" name="title" aria-label="素材名称" defaultValue={detailItem.title} required maxLength={160} /></label>
                  <button className="cl-btn" disabled={busy}>保存名称</button>
                </form>
                <label>所属集合<select className="cl-input" value={detailItem.collectionId || ''} disabled={busy} onChange={event => patchItem(detailItem.id, { collectionId: event.target.value || null })}>
                  <option value="">未整理</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                </select></label>
                <dl>{detailRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                <div className="cl-detail-actions">
                  <button className="cl-btn" aria-pressed={Boolean(detailItem.favorite)} disabled={busy} onClick={() => patchItem(detailItem.id, { favorite: !detailItem.favorite })}>{detailItem.favorite ? '★ 取消收藏' : '☆ 收藏'}</button>
                  <a className="cl-btn" href={detailItem.fileUrl} download><IconDownload aria-hidden="true" />下载</a>
                  {detailItem.sourceUrl && <a className="cl-btn" href={detailItem.sourceUrl} target="_blank" rel="noreferrer">查看来源</a>}
                  <button className="cl-btn cl-strong cl-detail-use" disabled={busy} onClick={() => sendToDraft([detailItem], false, false)}>加入当前草稿</button>
                </div>
              </div>
            </React.Fragment>}
          </div>
        </div>}
      </section>
    );
  }

  if (typeof window !== 'undefined') window.CreativeLibraryWorkspace = CreativeLibraryWorkspace;
  if (typeof module !== 'undefined' && module.exports) module.exports = CreativeLibraryWorkspace;
})();
