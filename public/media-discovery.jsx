const DISCOVERY_MODES = Object.freeze([
  { id: 'search-posts', label: '搜索作品', platforms: ['tiktok', 'bilibili'], needsText: true, hint: '输入关键词，查看平台公开作品。' },
  { id: 'search-users', label: '搜索作者', platforms: ['tiktok', 'bilibili'], needsText: true, hint: '输入关键词，查找公开作者。' },
  { id: 'trending', label: '热榜', platforms: ['douyin', 'bilibili'], needsText: false, hint: '查看平台当前热门搜索。' },
  { id: 'comments', label: '评论', platforms: ['douyin', 'tiktok', 'bilibili'], needsText: true, hint: '粘贴一条作品链接，读取公开评论。' },
  { id: 'music', label: '音乐', platforms: ['douyin', 'tiktok'], needsText: true, hint: '粘贴音乐页链接或填写音乐 ID。' },
  { id: 'hashtag', label: '话题', platforms: ['douyin', 'tiktok'], needsText: true, hint: '粘贴话题链接；TikTok 也支持话题名称。' },
  { id: 'live', label: '直播间', platforms: ['douyin', 'tiktok', 'bilibili'], needsText: true, hint: '粘贴直播间链接，只查询状态，不进行录制。' },
]);
const DISCOVERY_PLATFORM_NAMES = Object.freeze({ douyin: '抖音', tiktok: 'TikTok', bilibili: '哔哩哔哩' });
const discoveryMode = (id) => DISCOVERY_MODES.find(item => item.id === id) || DISCOVERY_MODES[0];
const discoveryFormMode = (operation) => ({ replies: 'comments', 'music-posts': 'music', 'hashtag-posts': 'hashtag' }[operation] || operation);
const safeDiscoveryHref = (value) => {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    const privateIpv4 = /^(?:0|10|127)\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\./.test(host);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIpv4 || host === '::1') return '';
    return url.href;
  } catch { return ''; }
};
const discoveryText = (item) => String(item?.text || item?.title || '').trim();

function useDiscoveryJobs(active) {
  const [status, setStatus] = React.useState({ available: false, scope: '' });
  const [jobs, setJobs] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const epoch = React.useRef(0);
  const refresh = React.useCallback(async (signal) => {
    const requestEpoch = epoch.current;
    const [nextStatus, result] = await Promise.all([
      videoToolApi('/api/tools/video/status', { signal }),
      videoToolApi('/api/tools/video/jobs?kind=discovery', { signal }),
    ]);
    if (signal?.aborted || requestEpoch !== epoch.current) return result;
    setStatus({ ...nextStatus, scope: result.scope || nextStatus.scope });
    setJobs(result.jobs || []); setError('');
    return result;
  }, []);
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    epoch.current += 1; const requestEpoch = epoch.current;
    setLoading(true);
    refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted && requestEpoch === epoch.current) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted && requestEpoch === epoch.current) setLoading(false);
    });
    return () => { controller.abort(); epoch.current += 1; };
  }, [active, refresh]);
  React.useEffect(() => {
    if (!active || !jobs.some(job => videoBusy(job))) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }), 2500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, jobs, refresh]);
  const update = React.useCallback((job) => setJobs(current => [job, ...current.filter(item => item.id !== job.id)].sort((a, b) => b.created - a.created)), []);
  return { status, jobs, loading, error, setError, refresh, update };
}

function DiscoveryItem({ item, job, onDownload, onSearchPosts, onReplies, onRelated }) {
  const href = safeDiscoveryHref(item.url);
  const title = discoveryText(item) || '未命名内容';
  const positive = (value) => value != null && Number(value) > 0 ? Number(value) : null;
  const metrics = job.operation === 'trending'
    ? [positive(item.rank) ? `第 ${positive(item.rank)} 名` : '', positive(item.hotValue) ? `热度 ${positive(item.hotValue)}` : ''].filter(Boolean)
    : ['music', 'hashtag', 'music-posts', 'hashtag-posts'].includes(job.operation)
    ? [positive(item.count) ? `${positive(item.count)} 条作品` : '', positive(item.likes) ? `赞 ${positive(item.likes)}` : ''].filter(Boolean)
    : [positive(item.likes) ? `赞 ${positive(item.likes)}` : '', positive(item.replies) ? `回复 ${positive(item.replies)}` : ''].filter(Boolean);
  return <article className="discovery-item">
    {item.cover && safeDiscoveryHref(item.cover) && <img className="discovery-cover" src={safeDiscoveryHref(item.cover)} alt="" loading="lazy" />}
    <div className="discovery-item-body">
      <strong>{title}</strong>
      {item.author && <span className="discovery-author">{item.author}</span>}
      {item.text && item.title && <p>{item.text}</p>}
      {metrics.length > 0 && <small>{metrics.join(' · ')}</small>}
      <div className="discovery-item-actions">
        {href && <a href={href} target="_blank" rel="noreferrer">打开来源</a>}
        {['search-posts', 'music-posts', 'hashtag-posts'].includes(job.operation) && href && <button type="button" onClick={() => onDownload(href)}>下载解析</button>}
        {job.operation === 'trending' && job.platform === 'bilibili' && title && <button type="button" onClick={() => onSearchPosts(title, job.platform)}>搜索相关作品</button>}
        {job.operation === 'search-users' && href && <button type="button" onClick={() => onDownload(href, 'collections')}>查看作者</button>}
        {job.operation === 'comments' && item.id && <button type="button" onClick={() => onReplies(item.id)}>查看回复</button>}
        {['music', 'hashtag'].includes(job.operation) && item.resourceId && (job.operation !== 'hashtag' || job.platform === 'tiktok') && <button type="button" onClick={() => onRelated(item.resourceId)}>查看相关作品</button>}
      </div>
    </div>
  </article>;
}

function DiscoveryDetail({ detail, platform, onRelated, showToast }) {
  if (!detail) return null;
  const copy = async (value) => { try { await navigator.clipboard.writeText(value); showToast?.('已复制地址'); } catch { showToast?.('复制失败'); } };
  return <article className="discovery-detail">
    <div><span className="discovery-kicker">查询结果</span><h2>{discoveryText(detail) || '已读取内容'}</h2></div>
    {detail.author && <p>{detail.author}</p>}
    {detail.isLive != null && <p className={detail.isLive ? 'is-live' : ''}>{detail.isLive ? `直播中${detail.viewerCount ? ` · ${detail.viewerCount} 人` : ''}` : '当前未开播'}</p>}
    {safeDiscoveryHref(detail.url) && <a className="btn btn-ghost" href={safeDiscoveryHref(detail.url)} target="_blank" rel="noreferrer">打开来源</a>}
    {detail.musicId && <button type="button" className="btn btn-ghost" onClick={() => onRelated('music-posts', detail.musicId)}>查看同款音乐作品</button>}
    {detail.hashtagId && platform === 'tiktok' && <button type="button" className="btn btn-ghost" onClick={() => onRelated('hashtag-posts', detail.hashtagId)}>查看话题作品</button>}
    {Array.isArray(detail.streams) && detail.streams.length > 0 && <div className="discovery-streams"><strong>播放地址</strong>{detail.streams.map((stream, index) => <button type="button" key={`${stream.url}:${index}`} onClick={() => copy(stream.url)}>{stream.protocol || 'stream'}{stream.quality ? ` · ${stream.quality}` : ''} · 复制</button>)}</div>}
  </article>;
}

function MediaDiscoveryTool({ active, visible, space, hash, showToast }) {
  const { status, jobs, loading, error, setError, refresh, update } = useDiscoveryJobs(active);
  const initialJob = videoTabForHash(hash) === 'discover' ? workspaceHashParams(hash).get('job') || '' : '';
  const [mode, setMode] = React.useState('search-posts');
  const [platform, setPlatform] = React.useState('bilibili');
  const [text, setText] = React.useState('');
  const [board, setBoard] = React.useState('hot');
  const [sort, setSort] = React.useState('hot');
  const [selected, setSelected] = React.useState(initialJob);
  const [submitting, setSubmitting] = React.useState(false);
  const epoch = React.useRef(0);
  React.useEffect(() => { epoch.current += 1; return () => { epoch.current += 1; }; }, [active, space, hash]);
  React.useEffect(() => {
    if (videoTabForHash(hash) !== 'discover') return;
    const params = workspaceHashParams(hash);
    if (params.get('job')) setSelected(params.get('job'));
    if (params.get('discoveryMode') && discoveryMode(discoveryFormMode(params.get('discoveryMode'))).id === discoveryFormMode(params.get('discoveryMode'))) setMode(discoveryFormMode(params.get('discoveryMode')));
    if (params.get('input')) setText(params.get('input'));
  }, [hash]);
  const definition = discoveryMode(mode);
  React.useEffect(() => { if (!definition.platforms.includes(platform)) setPlatform(definition.platforms[0]); }, [definition.id, platform]);
  const selectedJob = jobs.find(job => job.id === selected) || null;
  React.useEffect(() => {
    if (!selectedJob) return;
    const next = discoveryMode(discoveryFormMode(selectedJob.operation));
    const query = selectedJob.discoveryQuery || {};
    setMode(next.id);
    setPlatform(next.platforms.includes(selectedJob.platform) ? selectedJob.platform : next.platforms[0]);
    setText(selectedJob.input || '');
    if (typeof query.board === 'string') setBoard(query.board);
    if (typeof query.sort === 'string') setSort(query.sort);
  }, [selectedJob?.id]);
  const navigate = (params) => { window.location.hash = `#media-tools?${new URLSearchParams({ tab: 'discover', space, ...params })}`; };
  const select = (job) => { setSelected(job.id); navigate({ job: job.id }); };
  const submit = async (extra = {}) => {
    if (definition.needsText && !text.trim()) { setError('请先输入关键词或链接。'); return; }
    const requestEpoch = epoch.current;
    setSubmitting(true); setError('');
    try {
      const job = await videoToolApi('/api/tools/video/jobs', { method: 'POST', body: {
        kind: 'discovery', operation: extra.operation || definition.id, platform: extra.platform || platform,
        text: extra.text == null ? text.trim() : extra.text, resourceId: extra.resourceId,
        commentId: extra.commentId, board: extra.board || board, sort: extra.sort || sort,
        visibility: status.scope,
      }});
      if (requestEpoch !== epoch.current) return;
      update(job); select(job);
    } catch (error) { if (requestEpoch === epoch.current) setError(error.message); } finally { if (requestEpoch === epoch.current) setSubmitting(false); }
  };
  const more = async () => { if (!selectedJob) return; const requestEpoch = epoch.current; setSubmitting(true); try { const next = await videoToolApi(`/api/tools/video/jobs/${selectedJob.id}/more`, { method: 'POST', body: { visibility: status.scope } }); if (requestEpoch === epoch.current) update(next); } catch (error) { if (requestEpoch === epoch.current) setError(error.message); } finally { if (requestEpoch === epoch.current) setSubmitting(false); } };
  const retry = async () => { if (!selectedJob) return; const requestEpoch = epoch.current; setSubmitting(true); try { const next = await videoToolApi(`/api/tools/video/jobs/${selectedJob.id}/retry`, { method: 'POST', body: { visibility: status.scope } }); if (requestEpoch === epoch.current) { update(next); setSelected(next.id); } } catch (error) { if (requestEpoch === epoch.current) setError(error.message); } finally { if (requestEpoch === epoch.current) setSubmitting(false); } };
  const fill = (job) => { setText(job.input || ''); const next = discoveryMode(job.operation); setMode(next.id); setPlatform(next.platforms.includes(job.platform) ? job.platform : next.platforms[0]); navigate({ discoveryMode: next.id, input: job.input || '' }); };
  const download = (input, target = 'download') => { window.location.hash = `#media-tools?${new URLSearchParams({ tab: target, space, input })}`; };
  const related = (operation, resourceId, sourceJob = selectedJob) => { const next = operation === 'hashtag-posts' ? 'hashtag' : 'music'; const sourcePlatform = sourceJob?.platform || platform; setMode(next); void submit({ operation, resourceId, text: sourceJob?.input || text.trim(), platform: sourcePlatform }); };
  const replies = (commentId) => void submit({ operation: 'replies', commentId, text: selectedJob?.input || text.trim(), platform: selectedJob?.platform || platform });
  const copy = async (job) => { try { await navigator.clipboard.writeText(job.input || ''); showToast?.('已复制原始输入'); } catch { showToast?.('复制失败'); } };
  const rows = selectedJob?.discovery?.items || [];
  const detail = selectedJob?.discovery?.detail;
  return <section id="media-tools-panel-discover" role="tabpanel" className="media-discovery" hidden={!visible} aria-labelledby="media-tools-tab-discover">
    <div className="discovery-head"><div><p>搜索、热榜、评论和公开直播信息。</p></div>{status.scope && <ScopeNote scope={status.scope} />}</div>
    <div className="discovery-mode" role="tablist" aria-label="内容发现方式">{DISCOVERY_MODES.map(item => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => { setMode(item.id); setError(''); }}>{item.label}</button>)}</div>
    <div className="discovery-workbench"><div className="discovery-query"><div className="discovery-form"><div className="discovery-form-row"><label>平台<select value={platform} onChange={event => setPlatform(event.target.value)}>{definition.platforms.map(value => <option key={value} value={value}>{DISCOVERY_PLATFORM_NAMES[value]}</option>)}</select></label>{mode === 'trending' && platform === 'douyin' && <label>榜单<select value={board} onChange={event => setBoard(event.target.value)}><option value="hot">热榜</option><option value="entertainment">娱乐</option><option value="society">社会</option><option value="challenge">挑战</option></select></label>}{mode === 'comments' && platform === 'bilibili' && <label>排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="hot">最热</option><option value="new">最新</option></select></label>}</div>{definition.needsText && <label className="discovery-input"><span>{mode.startsWith('search') ? '关键词' : mode === 'music' ? '音乐链接或 ID' : '链接或名称'}</span><textarea value={text} rows="3" placeholder={definition.hint} onChange={event => setText(event.target.value)} /></label>}<div className="discovery-submit-row">{!definition.needsText&&<p>{definition.hint}</p>}<button type="button" className="btn btn-primary" disabled={submitting || !status.available || definition.needsText && !text.trim()} onClick={() => void submit()}>{submitting ? '正在提交…' : '开始查询'}</button></div></div>
    {error && <div className="video-error" role="alert">{error}</div>}
    <details className="discovery-history"><summary>查询记录 <span>{jobs.length}</span></summary>{loading ? <p>正在读取…</p> : <div>{jobs.slice(0, 12).map(job => <button type="button" key={job.id} className={job.id === selected ? 'active' : ''} onClick={() => select(job)}><strong>{discoveryText(job.discovery?.detail) || job.input || discoveryMode(job.operation).label}</strong><small>{discoveryMode(job.operation).label} · {DISCOVERY_PLATFORM_NAMES[job.platform] || job.platform} · {videoBusy(job) ? '处理中' : job.state === 'ready' ? '已准备' : '失败'}</small></button>)}</div>}</details>
    </div><div className="discovery-output">
    {selectedJob && <section className="discovery-result" aria-label="发现结果"><div className="discovery-result-head"><div><span className="discovery-kicker">{discoveryMode(discoveryFormMode(selectedJob.operation)).label}</span><h2>{selectedJob.state === 'ready' ? (rows.length ? `${rows.length} 条结果` : '查询完成') : videoBusy(selectedJob) ? '正在读取' : '查询失败'}</h2></div><div>{(selectedJob.state === 'failed' || selectedJob.error) && <button type="button" className="btn btn-ghost" disabled={submitting} onClick={() => void retry()}>重试</button>}{selectedJob.discovery && <><a className="btn btn-ghost" href={`/api/tools/video/jobs/${selectedJob.id}/export.json`} download>JSON</a><a className="btn btn-ghost" href={`/api/tools/video/jobs/${selectedJob.id}/export.csv`} download>CSV</a></>}</div></div>{selectedJob.error && <div className="video-error" role="alert">{selectedJob.error}</div>}{videoBusy(selectedJob) && <p className="discovery-muted">正在从平台读取，完成后会自动显示。</p>}<DiscoveryDetail detail={detail} platform={selectedJob.platform} onRelated={related} showToast={showToast} />{selectedJob.state === 'ready' && !detail && rows.length === 0 && !selectedJob.error && <p className="discovery-muted">没有找到公开结果。可以更换关键词、链接或平台后重试。</p>}{rows.length > 0 && <div className="discovery-list">{rows.map((item, index) => <DiscoveryItem key={item.id || `${index}:${item.title}`} item={item} job={selectedJob} onDownload={download} onSearchPosts={(keyword, resultPlatform) => { setMode('search-posts'); setPlatform(resultPlatform); setText(keyword); navigate({ discoveryMode: 'search-posts', input: keyword }); }} onReplies={replies} onRelated={(resourceId) => related(selectedJob.operation === 'hashtag' ? 'hashtag-posts' : 'music-posts', resourceId, selectedJob)} />)}</div>}{selectedJob.discovery?.hasMore && <button type="button" className="btn btn-ghost discovery-more" disabled={submitting || videoBusy(selectedJob)} onClick={() => void more()}>加载更多</button>}<div className="discovery-original"><button type="button" onClick={() => void copy(selectedJob)}>复制原始输入</button><button type="button" onClick={() => fill(selectedJob)}>填回编辑</button></div></section>}

    {!selectedJob&&<div className="discovery-empty"><strong>{loading?'正在读取记录…':'查询结果'}</strong><p>选择查询方式和平台，结果会显示在这里。</p></div>}
    </div></div>
  </section>;
}
