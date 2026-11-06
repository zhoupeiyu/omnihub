// Shared loading language from the private repository library.
function LoadingSkeleton({ variant = 'list', count = 6, label = '正在加载内容', heading = false, className = '' }) {
  const media = ['gallery','detail','player','works'].includes(variant);
  return <div className={`loading-skeleton loading-${variant} ${className}`} role="status" aria-label={label} aria-busy="true">
    <span className="loading-sr">{label}</span>
    <div aria-hidden="true">
      {heading && <div className="loading-heading"><div className="sk-line loading-title" /><div className="sk-line loading-description" /><div className="loading-tabs">{[0,1,2].map(i => <div className="sk-line" key={i} />)}</div><div className="sk-line loading-search" /></div>}
      <div className="loading-grid">{Array.from({ length: variant === 'detail' || variant === 'player' ? 1 : count }, (_, i) => <div className="loading-tile" key={i}>
        {media && <div className="sk-line loading-media" />}
        <div className="loading-copy"><div className="sk-line lg" /><div className="sk-line" /><div className="sk-line sm" /></div>
      </div>)}</div>
    </div>
  </div>;
}

function LoadingFrame({ frameRef, src, title, onLoad, onError, layout, timeoutMs = 20000, ...props }) {
  const [loaded, setLoaded] = React.useState('');
  const [failed, setFailed] = React.useState('');
  const [slow, setSlow] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  const localRef = React.useRef(null);
  const identity = `${src}:${retry}`;
  const kind = layout || (String(src).includes('/mdskill/') ? 'editor' : 'application');
  React.useEffect(() => {
    if (loaded === identity || failed === identity) return;
    // Same-origin apps can render before their fonts/images finish loading.
    // A populated application root is a better signal than the window load event.
    const check = () => {
      try {
        const doc = localRef.current?.contentDocument;
        if (!doc || doc.URL === 'about:blank') return;
        const root = doc.querySelector('#root, #app');
        if (root?.children.length && root.textContent.trim()) setLoaded(identity);
      } catch (_) { /* Cross-origin/sandboxed frames report through onLoad instead. */ }
    };
    const poll = setInterval(check, 400);
    const timer = setTimeout(() => { clearInterval(poll); setSlow(identity); }, timeoutMs);
    check();
    return () => { clearInterval(poll); clearTimeout(timer); };
  }, [identity, loaded, failed, timeoutMs]);
  return <div className="loading-frame" aria-busy={loaded !== identity && failed !== identity && slow !== identity}>
    <iframe {...props} key={identity} ref={node => {localRef.current = node; if (typeof frameRef === 'function') frameRef(node); else if (frameRef) frameRef.current = node;}} src={src} title={title}
      onLoad={event => { setLoaded(identity); onLoad?.(event); }}
      onError={event => { setFailed(identity); onError?.(event); }} />
    {loaded !== identity && <div className="loading-frame-cover">
      {failed === identity || slow === identity
        ? <div className="frame-loading-feedback" role={failed === identity ? 'alert' : 'status'}><strong>{failed === identity ? '内容未能加载' : '加载时间较长'}</strong><p>{title || '此应用'}尚未就绪，可以重试或在独立页面打开。</p><div><button className="btn" onClick={() => setRetry(value => value + 1)}>重新加载</button><a className="btn" href={src} target="_blank" rel="noopener noreferrer">独立打开 ↗</a></div></div>
        : <ApplicationSkeleton layout={kind} label={`正在加载${title || '内容'}`} />}
    </div>}
  </div>;
}

function SkeletonLines({ count = 3 }) {
  return <div className="loading-copy">{Array.from({length:count},(_,i)=><i key={i} className={`sk-line ${i===0?'lg':i===count-1?'sm':''}`} />)}</div>;
}

function ApplicationSkeleton({ layout = 'application', label = '正在加载应用' }) {
  return <div className={`application-skeleton is-${layout}`} role="status" aria-label={label}><span className="loading-sr">{label}</span><div className="application-skeleton-toolbar" aria-hidden="true"><i className="sk-line"/><i className="sk-line"/><i className="sk-line"/></div><div className="application-skeleton-body" aria-hidden="true"><aside><SkeletonLines count={6}/></aside><div className="application-skeleton-canvas">{layout==='editor'&&<><section><SkeletonLines count={9}/></section><section><SkeletonLines count={9}/></section></>}</div></div></div>;
}

function TimelineSkeleton({ count = 4, label = '正在读取动态', compact = false }) {
  return <div className={`timeline-skeleton${compact?' is-compact':''}`} role="status" aria-label={label}><span className="loading-sr">{label}</span><div aria-hidden="true">{Array.from({length:count},(_,i)=><div className="timeline-loading-day" key={i}><i className="sk-line timeline-loading-date"/><article><div className="timeline-loading-author"><i className="sk-line"/><i className="sk-line"/></div><SkeletonLines count={compact?2:4}/>{!compact&&i%2===0&&<div className="sk-line timeline-loading-media"/>}</article></div>)}</div></div>;
}

function KnowledgePageSkeleton({label}) {
  return <div className="knowledge-hub"><div className="knowledge-hub-tabs skeleton-hub-tabs" aria-hidden="true"><i className="sk-line"/><i className="sk-line"/></div><div className="knowledge-workspace knowledge-page-loading" role="status" aria-label={label}><span className="loading-sr">{label}</span><div className="knowledge-workspace-bar" aria-hidden="true"><i className="sk-line knowledge-loading-title"/><i className="sk-line knowledge-loading-search"/></div><div className="knowledge-index" aria-hidden="true"><div className="knowledge-results"><div className="knowledge-browse-toolbar"><SkeletonChips count={3}/><SkeletonChips count={2}/></div><div className="knowledge-kind-tabs"><SkeletonChips count={4}/></div><div className="knowledge-facet-row"><SkeletonChips count={6}/></div><div className="knowledge-index-list">{Array.from({length:7},(_,i)=><div className="knowledge-list-item" key={i}><SkeletonLines/></div>)}</div></div></div></div></div>;
}

function SkeletonChips({count=5}) {return <div className="skeleton-chips">{Array.from({length:count},(_,i)=><i key={i} className="sk-line"/>)}</div>;}

function PromptPageSkeleton({label}) {
  const grid = React.useRef(null);
  React.useEffect(()=> typeof observePromptMasonry==='function' && grid.current ? observePromptMasonry(grid.current) : undefined,[]);
  return <div className="prompt-refinery-page" role="status" aria-label={label}><span className="loading-sr">{label}</span><div className="prompt-refinery-main" aria-hidden="true"><div className="repository-head"><div><h1><i className="sk-line" style={{width:110,height:28}}/></h1><p><i className="sk-line" style={{width:260,height:12}}/></p></div><i className="sk-line" style={{width:110,height:32}}/></div><div className="prompt-category-tabs"><SkeletonChips count={8}/></div><div className="prompt-facet-toolbar skeleton-prompt-facets"><SkeletonChips count={7}/><SkeletonChips count={6}/></div><div className="prompt-results-count" aria-hidden="true"><i className="sk-line" style={{width:90,height:18}}/></div><div className="prompt-refinery-grid" ref={grid}>{Array.from({length:10},(_,i)=><div key={i} className="prompt-refinery-card prompt-loading-card"><i className="sk-line" style={{aspectRatio:[1,.8,1.3,.75,1][i%5]}}/><div className="prompt-card-content"><SkeletonLines/></div></div>)}</div></div></div>;
}

function WorkspaceBootSkeleton() {
  return <div className="workspace-boot"><header className="header-bar"><div className="header-inner" aria-hidden="true"><span className="header-toggle"><i className="sk-line"/></span><div className="logo-mark"><img src="/assets/omnihub-logo.svg" alt=""/></div><div className="header-brand"><div className="brand-title">万象台</div></div><div className="header-greet"><SkeletonLines count={2}/></div></div></header><div className="layout"><aside className="sidebar boot-sidebar" aria-hidden="true">{Array.from({length:10},(_,i)=><i className="sk-line" key={i}/>)}</aside><main className="main"><PageLoadingSkeleton label="正在加载工作台"/></main></div></div>;
}
window.LoadingSkeleton = LoadingSkeleton;
window.LoadingFrame = LoadingFrame;

// Cover placeholders occupy the real card, so breakpoints and dimensions stay identical.
function CoverCardSkeleton() {
  return <span className="cover-card-skeleton" aria-hidden="true"><span className="cover-skeleton-copy"><i className="sk-line" /><i className="sk-line" /><i className="sk-line" /></span></span>;
}
function CoverGridSkeleton({ count = 3, label = '正在加载工具' }) {
  return <section className="topics-catalog tools-catalog tool-catalog" role="status" aria-label={label} aria-busy="true"><span className="loading-sr">{label}</span><ul className="topics-grid" aria-hidden="true">{Array.from({length:count},(_,i)=><li key={i}><div className="topics-card video-tool-card cover-card-pending"><CoverCardSkeleton /></div></li>)}</ul></section>;
}

function DriveShelfSkeleton({ reactRuntime, category = '', routeKey = '', label = '正在加载资料', count, decorative = false }) {
  const React = reactRuntime;
  if (category && window.DriveShelfLoading) return <window.DriveShelfLoading reactRuntime={React} category={category} routeKey={routeKey} label={label} decorative={decorative} />;
  const isBooks = category === 'books';
  const resolvedCount = count || (isBooks ? 10 : category ? 8 : 7);
  const shelfClassName = `${category ? 'drive-shelf' : 'drive-category-grid'} drive-shelf-loading${isBooks ? ' is-book-grid' : ''}`;
  const list = <ul className={shelfClassName} aria-hidden={decorative ? 'true' : undefined}>
    {Array.from({ length: resolvedCount }, (_, i) => <li className="drive-resource-card drive-loading-card" key={i}>
      <span className={`drive-cover drive-loading-cover${isBooks ? ' book-cover' : ''}`} />
      {category && <span className="drive-card-copy drive-loading-copy"><i className="sk-line" /><i className="sk-line sm" /></span>}
    </li>)}
  </ul>;
  if (decorative) return list;
  return <div className="drive-shelf-loading-wrap" role="status" aria-label={label} aria-busy="true">
    <span className="loading-sr">{label}</span>
    <div aria-hidden="true">{list}</div>
  </div>;
}

function DrivePageSkeleton({ reactRuntime, hash = '', label = '正在加载云盘' }) {
  const React = reactRuntime;
  const query = String(hash || '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  const category = params.get('category') || params.get('cat') || '';
  const course = params.get('course');
  const file = params.get('file') || params.get('lesson') || course;
  const routeKey=[category,params.get('path')||'',params.get('q')||'',params.get('filter')||'all',params.get('page')||'1'].join('|');
  return <div className="knowledge-hub is-drive drive-loading" role="status" aria-label={label} aria-busy="true">
    <span className="loading-sr">{label}</span>
    <div className="drive-workspace drive-loading-workspace" aria-hidden="true">
      <div className={`drive-topbar drive-loading-topbar${file ? ' is-loading-study' : ''}`}>
        <div className="knowledge-hub-tabs drive-loading-tabs"><i className="sk-line" /><i className="sk-line" /></div>
        {!file && <div className="drive-topbar-actions drive-loading-actions"><i className="sk-line" /><i className="sk-line" /></div>}
      </div>
      <div className={`drive-layout drive-loading-layout${file ? ' is-loading-study' : ''}`}>
        {!file && <div className="drive-categories drive-loading-categories">{Array.from({ length: 8 }, (_, i) => <i className="sk-line" key={i} />)}</div>}
        <div className="drive-main drive-loading-main">
          {file
            ? <div className={`drive-loading-media-view${course ? ' has-course' : ''}`}>
                {course && !params.get('file') && window.DriveStudyLoading ? <window.DriveStudyLoading reactRuntime={React} hasCourse decorative/> : <div className="drive-loading-media" />}
                {course && <div className="drive-loading-course-rail">{Array.from({ length: 4 }, (_, i) => <i className="sk-line" key={i} />)}</div>}
              </div>
            : <><div className="drive-shelf-heading"><i className="sk-line" style={{width:120,height:20}}/></div><DriveShelfSkeleton reactRuntime={React} category={category} routeKey={routeKey} decorative /></>}
        </div>
      </div>
    </div>
  </div>;
}

function PageLoadingSkeleton({ section, label = '正在读取内容' }) {
  const hash = String(window.location.hash || '');
  const route = section || hash.split('?')[0].slice(1);
  if (route === 'tools') return <CoverGridSkeleton label={label} />;
  if (route === 'topics') return <CoverGridSkeleton count={4} label={label} />;
  if (route === 'knowledgeLibrary') {
    const query = hash.split('?')[1] || '';
    const tab = new URLSearchParams(query).get('tab');
    if (tab === 'drive') return <DrivePageSkeleton reactRuntime={React} hash={hash} label={label} />;
    return <KnowledgePageSkeleton label={label}/>;
  }
  if (route === 'promptLibrary') return <PromptPageSkeleton label={label}/>;
  if (route === 'inbox') return <div className="route-loading-inbox"><SkeletonChips count={4}/><SkeletonChips count={5}/><TimelineSkeleton label={label}/></div>;
  if (route === 'feed') return <div className="route-loading-feed"><SkeletonChips/><div className="feed-layout"><TimelineSkeleton compact label={label}/><aside className="feed-side"><LoadingSkeleton variant="compact" count={5} label="正在加载热点"/></aside></div></div>;
  if (route === 'studio') return <div className="route-loading-studio media-studio"><header className="media-page-head"><div><h1>创作台</h1><p>从收藏或提示词开始生成，结果自动回到作品库。</p></div><i className="sk-line" style={{width:110,height:32}} aria-hidden="true"/></header><div className="media-studio-tabs"><SkeletonChips count={4}/></div><div className="media-studio-layout has-result" data-view="input"><div className="media-compose"><LoadingSkeleton variant="form" count={5} label={label}/></div><div className="media-result-preview"><div className="sk-line" style={{width:110,height:18}}/><div className="sk-line studio-loading-preview" aria-hidden="true"/></div></div></div>;
  if (route === 'works') return <div className="route-loading-works workspace-library works-library"><header className="workspace-library-head"><div><h1>作品</h1><p>保留生成提示词、参数、版本关系和可继续创作的结果。</p></div><i className="sk-line" style={{width:100,height:32}} aria-hidden="true"/></header><SkeletonChips count={5}/><LoadingSkeleton variant="works" count={8} label={label}/></div>;
  const variant = ['prompts','manualPrompts','ai-art'].includes(route) ? 'gallery' : route === 'settings' ? 'form' : route === 'repositories' ? 'catalog' : 'list';
  return <LoadingSkeleton heading variant={variant} label={label} />;
}
window.CoverCardSkeleton = CoverCardSkeleton;
window.PageLoadingSkeleton = PageLoadingSkeleton;
window.DriveShelfSkeleton = DriveShelfSkeleton;
window.DrivePageSkeleton = DrivePageSkeleton;
window.WorkspaceBootSkeleton = WorkspaceBootSkeleton;
window.TimelineSkeleton = TimelineSkeleton;
