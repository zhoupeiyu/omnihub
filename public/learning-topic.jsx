(function () {
  const { useEffect, useMemo, useRef, useState } = React;
  const LAB_CATALOG_URL = '/assets/learning-lab/catalog.json';
  const LAB_SUBJECTS = { all: '全部学科', phys: '物理', chem: '化学', bio: '生物', geo: '地理' };
  const GRAPH_ENTRIES = {
    explore: { label: '知识图谱', path: '/explore/', detail: '从知识点关系开始浏览' },
    diagnose: { label: '诊断练习', path: '/diagnose/', detail: '按知识点进行自测与诊断' },
    children: { label: '学习档案', path: '/children/', detail: '管理学习者与本地学习记录' }
  };

  function parseHash(hash) {
    const raw = String(hash || window.location.hash || '#topics?topic=learning');
    const question = raw.indexOf('?');
    return new URLSearchParams(question >= 0 ? raw.slice(question + 1) : '');
  }

  function topicHash(changes, hash) {
    const params = parseHash(hash);
    params.set('topic', 'learning');
    Object.keys(changes).forEach((key) => {
      const value = changes[key];
      if (value === null || value === undefined || value === '') params.delete(key);
      else params.set(key, value);
    });
    return `#topics?${params.toString()}`;
  }

  function officialLabUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'lab.tongjiang.app' && /^\/c\/[a-z0-9-]+\/$/.test(url.pathname) ? url.href : '';
    } catch (_) { return ''; }
  }

  function graphUrl(entry, subject) {
    const current = GRAPH_ENTRIES[entry] ? entry : 'explore';
    const url = new URL(`/apps/knowledge-graph${GRAPH_ENTRIES[current].path}index.html`, window.location.origin);
    if (subject && subject !== 'math') url.searchParams.set('subject', subject);
    return url.href;
  }

  function LearningTopic({ hash }) {
    const params = parseHash(hash);
    const standalone = ['body', 'history'].includes(params.get('topic'));
    const view = standalone ? params.get('topic') : ['lab', 'physics', 'body', 'history', 'graph', 'homework'].includes(params.get('view')) ? params.get('view') : 'lab';
    const requestedSubject = params.get('subject') || 'all';
    const requestedCourse = params.get('course') || '';
    const [catalog, setCatalog] = useState([]);
    const [catalogState, setCatalogState] = useState('loading');
    const [query, setQuery] = useState('');
    const [type, setType] = useState('all');
    const [embed, setEmbed] = useState('');
    const frameRef = useRef(null);
    const [fullscreen, setFullscreen] = useState(false);
    useEffect(() => {
      const update = () => setFullscreen(Boolean(document.fullscreenElement));
      document.addEventListener('fullscreenchange', update);
      return () => document.removeEventListener('fullscreenchange', update);
    }, []);

    useEffect(() => {
      let alive = true;
      fetch(LAB_CATALOG_URL, { credentials: 'same-origin' })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
        .then((items) => { if (alive && Array.isArray(items)) { setCatalog(items); setCatalogState('ready'); } })
        .catch(() => { if (alive) setCatalogState('error'); });
      return () => { alive = false; };
    }, []);

    useEffect(() => { setEmbed(''); }, [view, requestedCourse, params.get('graph'), requestedSubject]);

    const course = useMemo(() => catalog.find((item) => item.slug === requestedCourse), [catalog, requestedCourse]);
    const courseTypes = useMemo(() => Array.from(new Set(catalog.map((item) => item.type).filter(Boolean))).sort(), [catalog]);
    const shownCourses = useMemo(() => {
      const normalized = query.trim().toLowerCase();
      return catalog.filter((item) => (requestedSubject === 'all' || item.subject === requestedSubject) && (type === 'all' || item.type === type) && (!normalized || [item.title, item.question, item.type, ...(item.textbook || [])].join(' ').toLowerCase().includes(normalized)));
    }, [catalog, query, requestedSubject, type]);
    const graphEntry = GRAPH_ENTRIES[params.get('graph')] ? params.get('graph') : 'explore';
    const graphSubject = params.get('subject') || 'math';
    const go = (changes) => { window.location.hash = topicHash(changes, hash); };
    const selectView = (next) => {
      const labSubject = Object.prototype.hasOwnProperty.call(LAB_SUBJECTS, requestedSubject) && requestedSubject !== 'all' ? requestedSubject : null;
      go({ view: next, course: null, learn: null, subject: next === 'lab' ? labSubject : null, graph: null });
    };
    const subjectCount = (key) => key === 'all' ? catalog.length : catalog.filter((item) => item.subject === key).length;

    useEffect(() => {
      if (requestedCourse) {
        window.scrollTo(0, 0);
        document.querySelector('.learning-classroom')?.scrollIntoView({ block: 'start' });
      }
    }, [params.get('learn'), requestedCourse, catalogState]);

    if (params.get('topic') && !['learning', 'body', 'history'].includes(params.get('topic'))) return null;

    if (view === 'lab' && course && officialLabUrl(course.online)) {
      return <main className="learning-classroom">
        <header className="learning-classroom-bar">
          <button className="learning-link-button" onClick={async () => { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); go({ course: null, learn: null }); }}>← 课程目录</button>
          <h1>{course.title}</h1>
          <div className="learning-actions">
            <a className="btn" href={officialLabUrl(course.online)} target="_blank" rel="noopener noreferrer">原站打开 ↗</a>
            <button className="btn" onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
              else frameRef.current?.closest('.learning-classroom')?.requestFullscreen?.().catch(() => {});
            }}>{fullscreen ? '退出全屏' : '全屏'}</button>
            <button className="btn learning-close-course" onClick={async () => {
              if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
              go({ course: null, learn: null });
            }}>× 关闭课程</button>
          </div>
        </header>
        <details className="learning-course-notes"><summary>课程说明与教材</summary><div><p>{course.question}</p><h2>教材定位</h2><ul>{(course.textbook || []).map(item => <li key={item}>{item}</li>)}</ul><h2>学习步骤</h2><ol>{(course.steps || []).map(item => <li key={item}>{item}</li>)}</ol><p>来源：铜匠实验室 · CC BY-NC 4.0。当前使用本站归档的离线课程；隔离模式下不保存学习进度。</p></div></details>
        <LoadingFrame key={course.slug} frameRef={frameRef} title={course.title} src={`/assets/learning-html/4d63ce0a72d9/${course.slug}.html`} sandbox="allow-scripts" allow="fullscreen 'none'" />
      </main>;
    }

    const hosted = {
      history: {title:'江山时序',url:'/apps/jiangshan-map/index.html',source:'DeanChensj / jiangshan-map · GPL-3.0',license:'/apps/jiangshan-map/source.tar.gz'},
      body: {title:'人体探索',url:'/apps/bodyvista/index.html',source:'FreedomIntelligence / BodyVista',license:'/apps/bodyvista/THIRD_PARTY_NOTICES.md'},
      physics: {title:'物理图解',url:'/apps/atlas-of-physics/index.html',source:'nathanliow / atlas-of-physics · MIT'},
      homework: {title:'作业助手',url:'/apps/homework/',source:'cubewhy / skid-homework · GPL-3.0'},
      graph: {title:'知识图谱',url:graphUrl(graphEntry,graphSubject),source:'cn-math-taxonomy · CC BY-NC 4.0'}
    }[view];
    if (hosted) return <main className="learning-map-workspace">
      <header className="learning-map-toolbar"><h1>{hosted.title}</h1>
        {!standalone && <nav className="learning-tabs" aria-label="学习实验室功能">{[['lab','互动课程'],['physics','物理图解'],['graph','知识图谱'],['homework','作业助手']].map(([id,label])=><button key={id} className={view===id?'active':''} onClick={()=>selectView(id)}>{label}</button>)}</nav>}
        <a className="btn" href={hosted.url} target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button className="btn" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else frameRef.current?.closest('.learning-map-workspace')?.requestFullscreen?.(); }}>{fullscreen ? '退出全屏' : '全屏'}</button>
      </header>
      {view==='graph' && <div className="learning-map-filters"><nav className="learning-tabs" aria-label="知识图谱功能">{Object.keys(GRAPH_ENTRIES).map(key=><button key={key} className={graphEntry===key?'active':''} onClick={()=>go({graph:key})}>{GRAPH_ENTRIES[key].label}</button>)}</nav><label>学科 <select value={graphSubject} onChange={event=>go({subject:event.target.value})}>{[['math','数学'],['chinese','语文'],['english','英语'],['physics','物理'],['history','历史'],['geography','地理'],['science','科学'],['morality','道德与法治']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>}
      {view==='homework' ? <HomeworkContent frameRef={frameRef}/> : <LoadingFrame key={hosted.url} frameRef={frameRef} title={hosted.title} src={hosted.url} sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" allow="fullscreen" />}
      <small className="learning-map-credit">来源：{hosted.source}{hosted.license && <> · <a href={hosted.license} target="_blank" rel="noopener noreferrer">授权与来源</a></>}{['graph','homework'].includes(view) && ' · 学习记录保存在当前浏览器'}</small>
    </main>;

    return <main className="learning-topic">
      <header className="learning-topic-head">
        <div>
          <h1>{standalone ? (view === 'body' ? '人体探索' : '江山时序') : '学习实验室'}</h1>
        </div>
        {!standalone && <nav className="learning-tabs" aria-label="学习实验室功能">
          <button className={view === 'lab' ? 'active' : ''} onClick={() => selectView('lab')}>互动课程</button>
          <button className={view === 'physics' ? 'active' : ''} onClick={() => selectView('physics')}>物理图解</button>
          <button className={view === 'graph' ? 'active' : ''} onClick={() => selectView('graph')}>知识图谱</button>
          <button className={view === 'homework' ? 'active' : ''} onClick={() => selectView('homework')}>作业助手</button>
        </nav>}
      </header>
      {view === 'lab' && <LabView catalog={catalog} catalogState={catalogState} course={course} requestedSubject={requestedSubject} query={query} type={type} courseTypes={courseTypes} shownCourses={shownCourses} subjectCount={subjectCount} setQuery={setQuery} setType={setType} go={go} embed={embed} setEmbed={setEmbed} frameRef={frameRef} />}
      {view === 'graph' && <GraphView entry={graphEntry} subject={graphSubject} go={go} embed={embed} setEmbed={setEmbed} frameRef={frameRef} />}
      {view === 'body' && <section className="learning-bodyvista"><div className="learning-actions"><strong>BodyVista · 人体探索</strong><a className="btn" href="/apps/bodyvista/index.html" target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button className="btn" onClick={() => { const node = frameRef.current?.parentElement; if (document.fullscreenElement) document.exitFullscreen(); else node?.requestFullscreen?.(); }}>{fullscreen ? '退出全屏' : '全屏'}</button></div><LoadingFrame frameRef={frameRef} title="BodyVista 人体探索" src="/apps/bodyvista/index.html" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" allow="fullscreen" /><small>来源：FreedomIntelligence / BodyVista · <a href="/apps/bodyvista/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">模型与内容授权说明</a></small></section>}
      {view === 'physics' && <HostedLearningApp title="物理图解 · Atlas of Physics" url="/apps/atlas-of-physics/index.html" source="nathanliow / atlas-of-physics · MIT" />}
      {view === 'homework' && <HostedLearningApp title="作业助手" url="/apps/homework/" source="cubewhy / skid-homework · GPL-3.0" note="支持图片、PDF 和文本。共用工作台 AI 服务，无需重复配置；学习记录保存在当前浏览器。" />}
    </main>;
  }

  function LabView({ catalog, catalogState, course, requestedSubject, query, type, courseTypes, shownCourses, subjectCount, setQuery, setType, go, embed, setEmbed, frameRef }) {
    if (course) {
      const online = officialLabUrl(course.online);
      return <section className="learning-detail">
        <div className="learning-detail-bar"><button className="learning-link-button" onClick={() => go({ course: null, learn: null })}>← 返回课程目录</button><span>{LAB_SUBJECTS[course.subject] || course.subject} · {course.type}</span></div>
        <div className="learning-detail-grid">
          <article><p className="learning-eyebrow">互动课 · 官方嵌入</p><h2>{course.title}</h2><p className="learning-question">{course.question}</p>
            <section><h3>教材定位</h3><ul>{(course.textbook || []).map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section><h3>学习步骤</h3><ol>{(course.steps || []).map((item) => <li key={item}>{item}</li>)}</ol></section>
            <p className="learning-note">课程由铜匠实验室提供，当前使用本站归档的离线课程；隔离模式下不保存学习进度。</p>
          </article>
          <aside className="learning-action-card"><strong>开始互动</strong><p>首次点击才会加载官方课程。</p>{online ? <><button className="btn btn-primary" onClick={() => go({ learn: '1' })}>开始学习</button><a className="btn" href={online} target="_blank" rel="noopener noreferrer">在原站打开 ↗</a></> : <p className="learning-warning">该课程链接未通过官方域名校验，已禁用嵌入。</p>}<small>来源：铜匠实验室 · CC BY-NC 4.0</small></aside>
        </div>
      </section>;
    }
    return <section className="learning-lab">
      <div className="learning-filter-row"><div className="learning-chips">{Object.keys(LAB_SUBJECTS).map((key) => <button key={key} className={requestedSubject === key ? 'active' : ''} onClick={() => go({ subject: key === 'all' ? null : key })}>{LAB_SUBJECTS[key]} <small>{subjectCount(key)}</small></button>)}</div><label className="learning-search"><span className="sr-only">搜索课程</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课名、问题或教材" /></label><InlineSelect value={type} onChange={(event) => setType(event.target.value)} aria-label="按课程类型筛选"><option value="all">全部类型</option>{courseTypes.map((item) => <option key={item} value={item}>{item}</option>)}</InlineSelect></div>
      {catalogState === 'loading' && <div role="status" aria-label="正在载入课程索引" aria-busy="true"><span className="loading-sr">正在载入课程索引</span><div className="learning-course-grid" aria-hidden="true">{Array.from({length:8},(_,i)=><div className="learning-course-card course-skeleton" key={i}><div className="sk-line sm" /><div className="sk-line lg" /><div className="sk-line" /><div className="sk-line" /><div className="sk-line course-skeleton-action" /></div>)}</div></div>}
      {catalogState === 'error' && <p className="learning-state learning-warning">课程索引未能载入，请刷新后重试。</p>}
      {catalogState === 'ready' && <><p className="learning-count">{shownCourses.length} 节课程</p><div className="learning-course-grid">{shownCourses.map((item) => <a className="learning-course-card learning-book" key={item.slug} href={topicHash({ course: item.slug })} aria-label={`开始学习：${item.title}`}><div className="book-board" aria-hidden="true" />{[4,3,2,1].map(n => <div key={n} className="book-leaf" aria-hidden="true" style={{"--leaf":n,"--leaf-angle":`${-42 * .7 ** n}deg`}}><i /><i /><i /><i /></div>)}<div className="learning-course-cover book-cover"><img className="learning-course-image" src={`/assets/course-covers/${item.slug}.jpg`} alt="" loading="lazy" decoding="async" /><span>{LAB_SUBJECTS[item.subject] || item.subject} · {item.type}</span><h3><PhraseText>{item.title}</PhraseText></h3><p>{item.question}</p></div></a>)}</div>{shownCourses.length === 0 && <p className="learning-state">没有符合当前筛选的课程。</p>}</>}
      <Attribution source="铜匠实验室 / tongjiang-lab" license="CC BY-NC 4.0" repo="https://github.com/smithjohn78390/tongjiang-lab" />
    </section>;
  }

  function GraphView({ entry, subject, go, embed, setEmbed, frameRef }) {
    const url = graphUrl(entry, subject);
    return <section className="learning-graph"><div className="learning-section-head"><div><h2>中国学科知识图谱</h2><p>浏览知识关系、做知识点诊断，并在学习档案中管理学习者。</p></div><a href="https://math.pansgo.com/" target="_blank" rel="noopener noreferrer">原站 ↗</a></div>
      <div className="learning-tool-row"><div className="learning-tabs compact">{Object.keys(GRAPH_ENTRIES).map((key) => <button key={key} className={entry === key ? 'active' : ''} onClick={() => go({ graph: key })}>{GRAPH_ENTRIES[key].label}</button>)}</div><label>学科 <select value={subject} onChange={(event) => go({ subject: event.target.value })}><option value="math">数学</option><option value="chinese">语文</option><option value="english">英语</option><option value="physics">物理</option><option value="history">历史</option><option value="geography">地理</option><option value="science">科学</option><option value="morality">道德与法治</option></select></label></div>
      <HostedLearningApp title={GRAPH_ENTRIES[entry].label} url={url} note="学习者与练习记录保存在当前浏览器，请在应用内导出备份。" />
      <Attribution source="cn-math-taxonomy" license="CC BY-NC 4.0" repo="https://github.com/xiaoyang111222/cn-math-taxonomy" />
    </section>;
  }

  function HomeworkContent({frameRef}) {
    const [state,setState] = useState('loading'), [retry,setRetry] = useState(0);
    useEffect(()=>{
      const abort=new AbortController();setState('loading');
      fetch('/api/ai-config',{credentials:'same-origin',signal:abort.signal}).then(async response=>{
        if(!response.ok)throw new Error('configuration');
        const config=await response.json();if(!abort.signal.aborted)setState(config.hasKey?'ready':'unconfigured');
      }).catch(()=>{if(!abort.signal.aborted)setState('error');});
      return()=>abort.abort();
    },[retry]);
    if(state==='ready')return <LoadingFrame frameRef={frameRef} title="作业助手" src="/apps/homework/" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" allow="fullscreen"/>;
    return <section className="learning-setup-state" role={state==='error'?'alert':'status'}>
      {state==='loading'?<LoadingSkeleton variant="form" count={3} label="正在读取作业助手配置"/>:<><h2>{state==='error'?'暂时无法读取 AI 配置':'连接 AI 服务后开始学习'}</h2><p>{state==='error'?'请重试读取配置，已保存的连接不会改变。':'作业助手使用工作台的文字 AI 服务。先在设置中添加、测试并选用连接，再回来上传题目。'}</p><div>{state==='unconfigured'&&<a className="btn btn-primary" href="#settings?category=ai&space=mine">前往 AI 设置</a>}<button className="btn" onClick={()=>setRetry(v=>v+1)}>{state==='error'?'重试':'重新检查'}</button></div></>}
    </section>;
  }

  function HostedLearningApp({title,url,source,note}) {
    return <section className="learning-bodyvista"><div className="learning-actions"><strong>{title}</strong><a className="btn" href={url} target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button className="btn" onClick={e=>e.currentTarget.closest('section')?.requestFullscreen?.()}>全屏</button></div>{note&&<p>{note}</p>}<LoadingFrame key={url} title={title} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" allow="fullscreen" />{source&&<small>{source}</small>}</section>;
  }

  function EmbedPanel({ url, label, onClose, frameRef }) { return <section className="learning-embed"><div><strong>{label}</strong><span>官方页面嵌入</span></div><div className="learning-actions"><a className="btn" href={url} target="_blank" rel="noopener noreferrer">原站打开 ↗</a><button className="btn" onClick={() => { const node = frameRef.current?.closest('.learning-embed'); if (node && node.requestFullscreen) node.requestFullscreen().catch(() => {}); }}>全屏</button><button className="btn" onClick={onClose}>关闭</button></div><LoadingFrame frameRef={frameRef} title={label} src={url} sandbox="allow-forms allow-popups allow-same-origin allow-scripts" allow="fullscreen 'none'" /></section>; }
  function Attribution({ source, license, repo }) { return <footer className="learning-attribution">索引与官方嵌入：{source} · <a href={repo} target="_blank" rel="noopener noreferrer">仓库</a> · <a href={`${repo}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">{license}</a>。学习记录由原工具保存。</footer>; }
  window.LearningTopic = LearningTopic;
}());
