function KnowledgeLibraryHub(props) {
  const read = () => new URLSearchParams(location.hash.split('?')[1] || '').get('tab') === 'drive';
  const [drive,setDrive] = React.useState(read);
  React.useEffect(()=>{const update=()=>setDrive(read());window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
  const canUseDrive = Boolean(props.canUseDrive), driveReadOnly=Boolean(props.driveReadOnly);
  React.useEffect(()=>{if(drive)props.onReadingNavigationChange?.(null);},[drive]);
  const navigation=canUseDrive&&<nav className="knowledge-hub-tabs" aria-label="知识库内容来源"><a href="#knowledgeLibrary?space=mine" aria-current={!drive?'page':undefined}>知识文章</a><a href="#knowledgeLibrary?space=mine&tab=drive" aria-current={drive?'page':undefined}>我的网盘</a></nav>;
  return <div className={'knowledge-hub'+(drive && canUseDrive?' is-drive':'')}>
    {!drive&&navigation}
    {drive && canUseDrive ? <DriveLibrary active={props.active} nav={navigation} readOnly={driveReadOnly} userId={props.userId} /> : <KnowledgeLibraryArticles {...props} />}
  </div>;
}
function DriveLibrary({active=true,nav,readOnly=false,userId}) {
  const parse=()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]||''));
  const [route,setRoute]=React.useState(parse),[catalog,setCatalog]=React.useState(null),[data,setData]=React.useState(null),[course,setCourse]=React.useState(null),[query,setQuery]=React.useState(route.q||''),[loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[retry,setRetry]=React.useState(0),[tab,setTab]=React.useState('outline'),[continueOpen,setContinueOpen]=React.useState(false),[bookToc,setBookToc]=React.useState(null),[bookTocState,setBookTocState]=React.useState('idle'),[bookChapter,setBookChapter]=React.useState('');
  const shelfRef=React.useRef(null),browseMemory=React.useRef(new Map()),dataSourceRef=React.useRef(''),continueRef=React.useRef(null),bookReaderRef=React.useRef(null),filter=route.filter||'all';
  const collections=catalog?.collections||[],category=collections.find(c=>c.id===route.category),folder=route.path||category?.root;
  const inferred=route.file&&category&&['courses','ai','development','business','finance'].includes(category.id)&&route.file.slice(category.root.length+1).includes('/')?category.root+'/'+route.file.slice(category.root.length+1).split('/')[0]:null;
  const coursePath=route.course||(!route.path&&route.file?inferred:null),learning=Boolean(coursePath||route.file);
  const selected=route.file?{path:route.file,name:route.file.split('/').at(-1),kind:driveFileKind(route.file)}:null;
  const files=course?.files||[],videos=files.filter(f=>['video','audio'].includes(f.kind)),materials=files.filter(f=>!['video','audio'].includes(f.kind));
  const isBook=course?.contentType==='book',bookFiles=isBook?files.filter(f=>!f.isDir):[];
  const lesson=selected&&['video','audio'].includes(selected.kind)?selected:route.lesson?{path:route.lesson,name:route.lesson.split('/').at(-1),kind:driveFileKind(route.lesson)}:null;
  function rememberBrowse(){if(!learning&&shelfRef.current&&!loading)browseMemory.current.set((route.category||'')+'|'+(route.path||''),{route:{...route},scroll:shelfRef.current.scrollTop});}
  function browseTo(target){const path=target===category?.root?undefined:target,old=browseMemory.current.get((route.category||'')+'|'+(path||''));go(old?old.route:{category:route.category,path});}
  function go(values){rememberBrowse();const p=new URLSearchParams({space:'mine',tab:'drive'});for(const [k,v] of Object.entries(values))if(v!=null&&v!=='')p.set(k,String(v));location.hash='knowledgeLibrary?'+p;}
  function replaceRoute(values){const p=new URLSearchParams({space:'mine',tab:'drive'});for(const [k,v] of Object.entries(values))if(v!=null&&v!=='')p.set(k,String(v));history.replaceState(null,'','#knowledgeLibrary?'+p);window.dispatchEvent(new HashChangeEvent('hashchange'));}
  function open(item){const c=collections.find(c=>item.path===c.root||item.path.startsWith(c.root+'/'));if(!c)return;
    if(item.isDir){if(driveOpensAsCourse(item))go({category:c.id,course:item.path});else go({category:c.id,path:item.path});}
    else if(coursePath)go({...route,file:item.path,lesson:['video','audio'].includes(item.kind)?item.path:lesson?.path});
    else go({category:c.id,file:item.path,...(route.path&&['courses','ai','development','business','finance'].includes(c.id)?{course:route.path}:{})});
  }
  React.useEffect(()=>{const update=()=>{const r=parse();setRoute(r);setQuery(r.q||'');setError('');};window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
  React.useEffect(()=>{if(!continueOpen)return;const dismiss=e=>{if(e.type==='keydown'&&e.key==='Escape')setContinueOpen(false);else if(e.type==='pointerdown'&&!continueRef.current?.contains(e.target))setContinueOpen(false);};window.addEventListener('keydown',dismiss);window.addEventListener('pointerdown',dismiss);return()=>{window.removeEventListener('keydown',dismiss);window.removeEventListener('pointerdown',dismiss);};},[continueOpen]);
  React.useEffect(()=>{if(!active)return;const c=new AbortController();api('/api/openlist/library',{signal:c.signal}).then(setCatalog).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[active,retry,learning]);
  React.useLayoutEffect(()=>{
    if(learning||loading||!data||!shelfRef.current)return;
    const previous=browseMemory.current.get((route.category||'')+'|'+(route.path||''));
    shelfRef.current.scrollTop=previous&&['q','page','filter'].every(k=>(previous.route[k]||'')===(route[k]||''))?previous.scroll:0;
  },[data,learning,loading]);
  React.useEffect(()=>{
    if(!course||course.viewKind!=='collection'||['course','audio','book'].includes(course.contentType))return;
    if(route.file){
      const child=course.outline.children.find(n=>n.isDir&&[n.path,n.sourcePath].filter(Boolean).some(p=>route.file.startsWith(p+'/')));
      if(child){go({...route,course:child.path,source:undefined});return;}
    }
    if(!route.file)go({category:route.category,path:course.path});
  },[course]);
  React.useEffect(()=>{if(!active||learning){setData(null);setLoading(false);return;}const c=new AbortController();setLoading(true);setData(null);setError('');const url=route.q?'/api/openlist/library/search?'+new URLSearchParams({q:route.q,category:route.category||''}):folder?'/api/openlist/library/shelf?'+new URLSearchParams({path:folder,page:route.page||'1'}):null;
    if(!url){setLoading(false);return;}const sourceKey=[route.category||'',route.path||'',route.q||'',route.page||'1'].join('|');api(url,{signal:c.signal}).then(value=>{dataSourceRef.current=sourceKey;setData(value);}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();
  },[active,learning,route.q,folder,route.page,retry]);
  React.useEffect(()=>{setCourse(null);setTab('outline');setBookToc(null);setBookTocState('idle');setBookChapter('');bookReaderRef.current=null;if(!active||!coursePath)return;const c=new AbortController();setLoading(true);setError('');api('/api/openlist/library/course?'+new URLSearchParams({path:coursePath,...(route.source?{source:route.source}:{})}),{signal:c.signal}).then(setCourse).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[active,coursePath,route.source,retry]);
  React.useEffect(()=>{if(!course||!isBook||route.file)return;const readable=files.filter(driveReadableBookFile),next=readable.find(f=>f.path===course.recent?.path)||readable.find(f=>f.kind==='epub')||readable.find(f=>f.kind==='pdf');if(next)replaceRoute({...route,file:next.path,lesson:undefined});},[course,isBook,route.file]);
  React.useEffect(()=>{if(!selected||['video','audio'].includes(selected.kind))return;api('/api/openlist/library/progress',{method:'POST',body:{path:selected.path,position:0,duration:0}}).catch(()=>{});},[route.file]);
  const current=lesson?.path||selected?.path,currentIndex=videos.findIndex(f=>f.path===current),chapter=current?.slice(0,current.lastIndexOf('/'));
  const chapterFiles=materials.filter(f=>f.path!==selected?.path&&(f.parent===chapter||f.parent.startsWith(chapter+'/')));
  const onBookToc=React.useCallback(items=>{setBookToc(items);setBookTocState('ready');},[]),onBookTocState=React.useCallback(state=>setBookTocState(state),[]),onBookChapter=React.useCallback(href=>setBookChapter(href),[]);
  const start=()=>{const f=files.find(f=>f.path===course?.recent?.path)||videos[0]||files[0];if(f)open(f);};
  const title=driveTitle(course?.name||selected?.name||category?.label||'我的网盘');
  const crumbPath=learning?coursePath:route.path;
  const crumbs=category&&crumbPath?.startsWith(category.root+'/')?crumbPath.slice(category.root.length+1).split('/').map((name,i,parts)=>({name:driveTitle(name),path:category.root+'/'+parts.slice(0,i+1).join('/')})):[];
  const breadcrumbs=<nav className="drive-location" aria-label="网盘面包屑"><button onClick={()=>go({})}>我的网盘</button>{category&&<><span>/</span>{crumbs.length?<button onClick={()=>browseTo()}>{category.label}</button>:<span aria-current="page">{category.label}</span>}</>}{crumbs.map((c,i)=><React.Fragment key={c.path}><span>/</span>{i===crumbs.length-1?<span aria-current="page">{c.name}</span>:<button onClick={()=>browseTo(c.path)}>{c.name}</button>}</React.Fragment>)}{learning&&!coursePath&&selected&&<><span>/</span><span aria-current="page">{driveTitle(selected.name)}</span></>}</nav>;

  const rows=React.useMemo(()=>(data?.items||[]).filter(r=>driveMatchesFilter(r,filter)),[data,filter]);
  const shelfKey=driveShelfKey(route);
  const sourceKey=[route.category||'',route.path||'',route.q||'',route.page||'1'].join('|');
  React.useEffect(()=>{
    if(active&&!learning&&data&&dataSourceRef.current===sourceKey)rememberDriveShelfShape(shelfKey,rows,category?.id);
  },[active,learning,data,rows,category?.id,shelfKey,sourceKey]);
  const standaloneReader=selected&&['pdf','epub'].includes(selected.kind)&&!coursePath;
  return <section className={'drive-workspace drive-v2'+(learning?' is-learning':'')+(standaloneReader?' is-standalone-reader':'')} aria-label="我的网盘">
    <div className="drive-topbar">
      {nav}
      {!learning&&<div className="drive-topbar-actions"><form role="search" onSubmit={e=>{e.preventDefault();go({category:route.category,q:query.trim()});}}><input type="search" aria-label="搜索网盘资源" placeholder="搜索课程、书籍或资料" value={query} onChange={e=>setQuery(e.target.value)}/><button className="btn">搜索</button></form><div className="drive-continue-menu" ref={continueRef}><button type="button" className="btn" aria-haspopup="menu" aria-expanded={continueOpen} onClick={()=>setContinueOpen(v=>!v)}>继续学习</button>{continueOpen&&<div role="menu">{catalog?.recent?.length?catalog.recent.map(r=><button type="button" role="menuitem" key={r.path} onClick={()=>{setContinueOpen(false);open(r);}}><span className="drive-kind">{driveLabels[r.kind]}</span><span><strong>{driveTitle(r.name)}</strong><small>{r.duration?`上次看到 ${driveTime(r.position)} / ${driveTime(r.duration)}`:'继续阅读'}</small></span></button>):<p>暂时没有学习或阅读记录。</p>}</div>}</div>{!readOnly&&<details className="drive-manage"><summary>同步与管理</summary><div><DriveScanStatus reactRuntime={React} request={api} active={active}/><a href="#settings?category=sync&space=mine">连接设置</a></div></details>}</div>}
    </div>
    {(learning||route.path)&&<div className="drive-crumbbar">{breadcrumbs}</div>}
    {error&&<div className="drive-error" role="alert">{error}<button className="btn" onClick={()=>setRetry(v=>v+1)}>重试</button></div>}
    {learning?<div className="drive-study">
      <main className="drive-stage">
        {loading&&!course&&!selected&&<DriveStudyLoading reactRuntime={React} hasCourse={Boolean(coursePath)} />}
        {!selected&&course&&<><div className="drive-course-intro"><span className="drive-eyebrow">{isBook?'书籍阅读':videos.length?'课程学习':'资料阅读'}</span><h2>{driveTitle(course.name)}</h2><p>{isBook?`${bookFiles.length} 个格式或附件`:`${videos.length} 个视频或音频 · ${materials.length} 份资料`}</p><button className="btn drive-primary" disabled={!files.length} onClick={start}>{course.recent?'继续上次阅读':'开始学习'}</button>{!files.length&&<p>此目录暂时没有可用内容，请查看右侧来源。</p>}</div>{!isBook&&files.length>0&&<section className="drive-course-overview"><h3>课程内容</h3><p>按章节浏览，或从上次学习位置继续。</p><div>{(course.outline?.children||[]).map(node=>{const first=driveFirstContent(node);return <button key={node.path} disabled={!first} onClick={()=>first&&open(first)}><strong>{driveTitle(node.name)}</strong><span>{node.isDir?first?'进入本章':'暂无内容':'打开内容'} →</span></button>;})}</div></section>}</>}
        {selected&&<div className="drive-lesson-heading"><div><span>{isBook?'书籍阅读':driveTitle(files.find(f=>f.path===selected.path)?.chapter||driveLabels[selected.kind])}</span><h2>{driveTitle(selected.name)}</h2></div>{lesson&&selected.path!==lesson.path&&<button className="btn" onClick={()=>open(lesson)}>返回视频</button>}</div>}
        {selected&&isBook&&<DriveBookToolbar reactRuntime={React} selected={selected} files={bookFiles} onOpen={open}/>}
        {lesson&&<div hidden={selected?.path!==lesson.path}><DriveMedia key={lesson.path} reactRuntime={React} request={api} file={lesson} active={active&&selected?.path===lesson.path}/></div>}
        {selected&&!['video','audio'].includes(selected.kind)&&<DriveDocument reactRuntime={React} file={selected} readerRef={isBook?bookReaderRef:undefined} onEpubToc={isBook?onBookToc:undefined} onEpubTocState={isBook?onBookTocState:undefined} onEpubChapter={isBook?onBookChapter:undefined}/>}

        {lesson&&!isBook&&<nav className="drive-lesson-nav" aria-label="课时切换"><button className="btn" disabled={currentIndex<=0} onClick={()=>open(videos[currentIndex-1])}>上一课</button><span>{currentIndex>=0?`${currentIndex+1} / ${videos.length} 课时`:''}</span><button className="btn" disabled={currentIndex<0||currentIndex>=videos.length-1} onClick={()=>open(videos[currentIndex+1])}>下一课</button></nav>}
        {!isBook&&chapterFiles.length>0&&<section className="drive-current-materials"><h3>本节与章节资料 <small>{chapterFiles.length}</small></h3><p>同一章节下的资料；课程通用资料见右侧“资料”。</p><DriveMaterialList reactRuntime={React} items={chapterFiles} onOpen={open}/></section>}
        {(course||selected)&&<DriveStudyTools key={String(userId??'')+'::'+(coursePath||selected.path)} reactRuntime={React} userId={userId} scope={coursePath||selected.path} title={title}/>}
        {selected&&!isBook&&<details className="drive-original"><summary>文件信息与下载</summary><p>{selected.path}</p><a className="btn" href={driveFileUrl(selected.path)+'&download=1'} download>下载到设备</a></details>}
      </main>
      {loading&&!course&&coursePath&&<aside className="drive-curriculum drive-curriculum-loading" aria-label="正在加载课程目录"><div className="drive-course-meta"><i className="sk-line"/><i className="sk-line"/></div><div className="drive-study-tabs"><i className="sk-line"/><i className="sk-line"/></div><div className="drive-curriculum-body">{[0,1,2,3,4].map(i=><i className="sk-line" key={i}/>)}</div></aside>}
      {course&&isBook&&<DriveBookSidebar reactRuntime={React} course={course} selected={selected} toc={bookToc} tocState={bookTocState} chapter={bookChapter} onChapter={href=>bookReaderRef.current?.display(href)}/>}
      {course&&!isBook&&<aside className="drive-curriculum" aria-label="当前课程"><div className="drive-course-meta"><strong>{driveTitle(course.name)}</strong><span>{videos.length} 个课时 · {materials.length} 份资料</span><details className="drive-sources"><summary>来源{course.sources.length>1?`（${course.sources.length}）`:''}{course.substituted.length?' · 已关联可用内容':''}</summary><p>同名目录独立保留，优先使用有内容的来源。</p>{course.sources.map(s=><button key={s.path} className={s.path===course.sourcePath?'selected':''} onClick={()=>go({category:route.category,course:coursePath,source:s.path})}><strong>{s.category} · {s.counts.files} 个文件{s.path===course.sourcePath?' · 当前':''}</strong><small>{s.path}</small></button>)}{course.substituted.map(s=><p key={s.from}>{driveTitle(s.name)}：原目录为空，已关联 {s.to}</p>)}</details></div><div className="drive-study-tabs" role="tablist"><button role="tab" aria-selected={tab==='outline'} onClick={()=>setTab('outline')}>课程目录</button><button role="tab" aria-selected={tab==='materials'} onClick={()=>setTab('materials')}>资料 {materials.length}</button></div><div className="drive-curriculum-body">{tab==='outline'?<DriveChapter reactRuntime={React} node={course.outline} root selected={selected?.path} onOpen={open} onSource={(node,source)=>go({category:route.category,course:node.path,source})}/>:<DriveMaterialList reactRuntime={React} items={materials} onOpen={open} showChapter/>}</div></aside>}
    </div>:<div className="drive-layout"><nav className="drive-categories" aria-label="网盘资源分类"><button className={!route.category?'active':''} onClick={()=>go({})}>全部资源</button>{collections.map(c=><button key={c.id} className={route.category===c.id?'active':''} onClick={()=>go({category:c.id})}>{c.label}</button>)}</nav><main className="drive-main" ref={shelfRef} onScroll={rememberBrowse}>
      {!route.category&&!route.q?<><h2>我的资源</h2>{!catalog&&!error?<DriveShelfSkeleton reactRuntime={React}/>:<div className="drive-category-grid">{collections.map(c=><button key={c.id} className="drive-category-card" onClick={()=>go({category:c.id})}><img className="drive-category-image" src={`/assets/drive-category-covers/${c.id}.jpg`} alt="" loading="lazy" decoding="async"/><div className="drive-category-copy"><strong>{c.label}</strong><span>{c.description}</span></div></button>)}</div>}</>:<>
        {!route.path&&breadcrumbs}
        <div className="drive-shelf-heading"><h2>{route.q?`“${route.q}”的搜索结果`:driveTitle(route.path?.split('/').at(-1)||category?.label||'资源')}</h2><span>{route.q?`${data?.items?.length||0} 个结果`:data?`${data.total} 个合集或资源`:''}</span>{!route.q&&category?.id!=='materials'&&<div className="drive-filters">{[['all','全部'],['video','视频课程'],['reading','阅读资料']].map(([id,label])=><button key={id} className={filter===id?'active':''} onClick={()=>go({...route,filter:id,page:1})}>{label}</button>)}</div>}</div>
        {(loading||!catalog&&!error)&&<DriveShelfLoading reactRuntime={React} category={category?.id||route.category||'search'} routeKey={shelfKey}/>}
        {!loading&&catalog&&!rows.length&&<p className="drive-empty">{route.q?'没有找到匹配的资源。':'当前筛选下没有资源。'}</p>}
        {!loading&&<DriveShelf reactRuntime={React} items={rows} category={category?.id} onOpen={item=>{if(route.q&&item.isDir){go({category:collections.find(c=>item.path.startsWith(c.root+'/'))?.id,...(driveOpensAsCourse(item)?{course:item.path}:{path:item.path})});}else open(item);}}/>}
        {!route.q&&data?.total>60&&<div className="drive-pagination"><button className="btn" disabled={data.page<=1} onClick={()=>go({...route,page:data.page-1})}>上一页</button><span>第 {data.page} / {Math.ceil(data.total/60)} 页</span><button className="btn" disabled={data.page*60>=data.total} onClick={()=>go({...route,page:data.page+1})}>下一页</button></div>}
      </>}
    </main></div>}
  </section>;
}
const driveLabels={folder:'合集',video:'视频',audio:'音频',pdf:'PDF',epub:'EPUB',image:'图片',text:'文本',file:'文件'};
function driveFileKind(name){const ext=name.split('.').at(-1).toLowerCase();return /^(mp4|webm|m4v|mov|mkv)$/.test(ext)?'video':/^(mp3|m4a|wav|ogg|flac|aac)$/.test(ext)?'audio':/^(jpg|jpeg|png|gif|webp|avif)$/.test(ext)?'image':ext==='pdf'?'pdf':ext==='epub'?'epub':/^(txt|md|csv|json|log)$/.test(ext)?'text':'file';}
function driveReadableBookFile(file){return ['epub','pdf'].includes(file?.kind||driveFileKind(file?.name||file?.path||''));}
function driveBookFormat(name){const ext=String(name||'').split('.').at(-1).toUpperCase();return /^(EPUB|PDF|MOBI|AZW3|DOCX|DOC|TXT)$/.test(ext)?ext:/\.(?:jpe?g|png|webp|avif)$/i.test(name||'')?'封面':'附件';}
function DriveBookToolbar({reactRuntime:React,selected,files,onOpen}){const reader=selected.kind==='epub'?'/assets/readers/epub.html?'+new URLSearchParams({path:selected.path}):selected.kind==='pdf'?'/assets/readers/pdfjs-6.5.438/web/viewer.html?'+new URLSearchParams({file:driveFileUrl(selected.path)}):null;return <div className="drive-book-toolbar" aria-label="书籍格式和阅读操作"><span>当前格式：{driveBookFormat(selected.name)}</span><details><summary>格式与下载</summary><div>{files.map(f=><p key={f.path}><button className={f.path===selected.path?'selected':''} onClick={()=>onOpen(f)}>{driveBookFormat(f.name)} · {driveTitle(f.name)}</button><a href={driveFileUrl(f.path)+'&download=1'} download>下载</a></p>)}</div></details>{reader&&<a className="btn" href={reader} target="_blank" rel="noopener">独立窗口</a>}</div>;}
function DriveBookSidebar({reactRuntime:React,course,selected,toc,tocState,chapter,onChapter}){const note=!selected?'正在选择可阅读格式…':selected.kind==='pdf'?'PDF 使用阅读器的页码与书内搜索；该文件未提供独立书签目录。':tocState==='loading'?'正在读取书内目录…':tocState==='error'?'书内目录读取失败，可继续翻页阅读。':tocState==='ready'?'本书没有可用目录。':'正在准备书内目录…';return <aside className="drive-curriculum drive-book-sidebar" aria-label="书内目录"><div className="drive-course-meta"><strong>{driveTitle(course.name)}</strong><span>{(course.files||[]).filter(f=>!f.isDir).length} 个格式或附件</span></div><details className="drive-book-toc" open><summary>书内目录</summary>{selected?.kind==='epub'&&toc?.length?<div>{toc.map(t=><button key={t.href} className={t.href===chapter?'selected':''} onClick={()=>onChapter(t.href)}>{t.label.trim()}</button>)}</div>:<p>{note}</p>}</details></aside>;}
function driveTitle(name){return String(name||'').replace(/（点进去分开存）/g,'').replace(/\.(mp4|webm|m4v|mov|mkv|pdf|epub|mp3|m4a|txt)$/i,'').replace(/^\s*\d+[.、]\s*/,'').replace(/^\{\d+\}--/,'').replace(/^\[[\d.]+\]--/,'').replace(/^\([\d.]+\)--/,'').replace(/&amp;/gi,'&').replace(/&(?:ldquo|rdquo|quot);/gi,'"').replace(/&(?:lsquo|rsquo|apos|#39);/gi,"'").replace(/iclass=.*$/i,'').trim();}
function driveTime(n){return Math.floor((n||0)/60)+':'+String(Math.floor((n||0)%60)).padStart(2,'0');}
function driveFileUrl(path){return '/api/openlist/file?'+new URLSearchParams({path});}
function driveIsBook(item){
 if(item.contentType)return item.contentType==='book';
 if(!item.isDir)return ['pdf','epub'].includes(item.kind)||/\.(mobi|azw3?|fb2)$/i.test(item.name||'');
 if(item.viewKind==='collection'||!String(item.path||'').includes('/20-电子书/'))return false;
 const c=item.availableCounts||item.counts||{};
 return !c.video && (/有声读物|有声小说/.test(item.name||'') || c.audio>0 || ((c.pdf||0)+(c.epub||0)>0 && (c.pdf||0)+(c.epub||0)<=3));
}
const driveContentLabels={book:'书籍',presentation:'演示文稿',document:'文档',course:'视频课程',audio:'音频',image:'图片',assets:'素材合集',archive:'压缩包',code:'代码',collection:'合集',resource:'资源',video:'视频'};
function driveContentType(item){
 if(item.contentType)return item.contentType;
 if(driveIsBook(item))return 'book';
 if(item.isDir)return item.viewKind==='collection'?'collection':item.viewKind==='course'?'course':'resource';
 return ({pdf:'document',epub:'document',audio:'audio',image:'image',video:'video',text:'document'})[item.kind]||'resource';
}
function driveDisplayType(item){return item.displayType||driveContentLabels[driveContentType(item)]||driveLabels[item.kind]||'资源';}
function driveCoverLayout(item){return driveIsBook(item)?'portrait':item.coverLayout==='square'?'square':'wide';}
function driveOpensAsCourse(item){return item.isDir&&(['course','audio'].includes(driveContentType(item))||(driveContentType(item)==='book'&&item.viewKind==='course'));}
function driveMatchesFilter(item,filter){
 if(filter==='video')return ['course','video'].includes(driveContentType(item));
 if(filter==='reading')return ['book','document','presentation','code'].includes(driveContentType(item));
 return true;
}
function driveHasVisual(item){
 return Boolean(item.coverUrl||item.collectionCovers?.some(cover=>cover.url)||
  window.OmniDrivePreview?.ContentPreview&&window.OmniDrivePreview.validCandidates?.(item.previewCandidates).length);
}
function driveIsCompactFile(item){
 if(item.isDir)return false;
 const type=driveContentType(item);
 if(type==='audio'||item.kind==='audio'||type==='code'||item.kind==='text')return true;
 if(driveIsBook(item))return false;
 return !driveHasVisual(item);
}
function driveFileSize(size){
 if(!Number.isFinite(size)||size<0)return '';
 if(size<1024)return size+' B';
 if(size<1048576)return (size/1024).toFixed(size<10240?1:0)+' KB';
 if(size<1073741824)return (size/1048576).toFixed(size<10485760?1:0)+' MB';
 return (size/1073741824).toFixed(1)+' GB';
}
function driveBookName(item){
 const raw=driveTitle(item.name);if(!driveIsBook(item))return raw;
 const quoted=raw.match(/《([^》]+)》/);if(quoted)return quoted[1];
 return raw.split(/作者[:：]|演播[:：]|\.(?=[\u4e00-\u9fff])|\.(?:20\d{2}|AAC|FLAC|MP3)/i)[0].replace(/\.(mobi|azw3?|fb2)$/i,'').trim();
}
function driveBookByline(item){
 if(!driveIsBook(item))return '';
 const name=String(item.name||'');const author=name.match(/作者[:：]\s*([^\s]+)/)?.[1],voice=name.match(/演播[:：]\s*([^\s]+)/)?.[1];
 if(author||voice)return [author,voice&&voice+' 演播'].filter(Boolean).join(' · ');
 const parts=name.split('.');if(parts[2]?.startsWith('演播'))return parts[1]+' · '+parts[2].slice(2)+' 演播';
 return '';
}
const driveShelfShapes=new Map();
function driveShelfKey(route){return [route.category||'',route.path||'',route.q||'',route.filter||'all',route.page||'1'].join('|');}
function driveShelfSections(items,category){
 const books=items.filter(item=>driveIsBook(item)&&!driveIsCompactFile(item));
 const files=items.filter(driveIsCompactFile);
 const other=items.filter(item=>!driveIsBook(item)&&!driveIsCompactFile(item));
 const sections=[];
 if(books.length)sections.push({kind:'books',title:'书籍',items:books});
 if(other.length)sections.push({kind:books.length?'collections':'resources',title:books.length?'合集与资源':'',items:other});
 if(category==='courses'||other.length>books.length)sections.sort((a,b)=>(a.kind==='books')-(b.kind==='books'));
 if(files.length)sections.push({kind:'files',title:files.every(item=>driveContentType(item)==='audio')?'音频曲目':files.some(item=>driveContentType(item)==='audio')?'音频与文件':'文件',items:files});
 return sections;
}
function driveFirstContent(node){
 if(!node)return null;
 const walk=current=>current.isDir?(current.children||[]).flatMap(walk):[current];
 const leaves=walk(node);
 return leaves.find(child=>['video','audio'].includes(child.kind))||leaves[0]||null;
}
function rememberDriveShelfShape(key,items,category){
 const sections=driveShelfSections(items,category);
 if(!sections.length)return;
 driveShelfShapes.set(key,sections.map(section=>({kind:section.kind,title:section.title,layouts:section.kind==='files'?undefined:section.items.map(driveCoverLayout),count:section.items.length})));
 if(driveShelfShapes.size>30)driveShelfShapes.delete(driveShelfShapes.keys().next().value);
}
function driveFallbackShelfShape(category){
 return [{kind:'resources',title:'',layouts:['wide','wide','wide','wide']}];
}
function DriveShelfLoading({reactRuntime:React,category='',routeKey='',label='正在加载资料',decorative=false}){
 const sections=driveShelfShapes.get(routeKey)||driveFallbackShelfShape(category);
 return <div className="drive-shelf-loading-wrap" role={decorative?undefined:'status'} aria-label={decorative?undefined:label} aria-busy={decorative?undefined:'true'}>{!decorative&&<span className="loading-sr">{label}</span>}<div aria-hidden="true">{sections.map((section,index)=><section className={'drive-shelf-section'+(section.kind==='collections'?' is-collection-section':'')} key={index}>{section.title&&<h3>{section.title}</h3>}{section.kind==='files'?<div className="drive-file-list drive-file-list-loading">{Array.from({length:section.count},(_,i)=><div className="drive-file-row" key={i}><i className="sk-line"/><i className="sk-line"/><i className="sk-line"/></div>)}</div>:<div className={'drive-shelf drive-shelf-loading'+(section.kind==='books'?' is-books is-book-grid':category==='materials'?' is-assets':'')}>{section.layouts.map((layout,i)=><div className={'drive-resource-card drive-loading-card cover-layout-'+layout} key={i}><span className={'drive-cover drive-loading-cover'+(layout==='portrait'?' book-cover':'')}/><span className="drive-card-copy drive-loading-copy"><i className="sk-line"/><i className="sk-line sm"/></span></div>)}</div>}</section>)}</div></div>;
}
window.DriveShelfLoading=DriveShelfLoading;
function DriveShelf({reactRuntime:React,items,category,onOpen}){
 return <>{driveShelfSections(items,category).map(section=><section key={section.kind} className={'drive-shelf-section'+(section.kind==='collections'?' is-collection-section':'')}>
   {section.title&&<h3>{section.title}</h3>}
   {section.kind==='files'?<DriveFileList items={section.items} onOpen={onOpen}/>:<div className={'drive-shelf '+(section.kind==='books'?'is-books is-book-grid':category==='materials'?'is-assets':'')}>{section.items.map(item=><DriveResourceCard key={item.path} reactRuntime={React} item={item} onOpen={onOpen}/>)}</div>}
 </section>)}</>;
}
function DriveFileList({items,onOpen}){
 return <div className="drive-file-list">{items.map(item=>{const type=driveDisplayType(item),audio=driveContentType(item)==='audio'||item.kind==='audio';return <button className="drive-file-row" key={item.path} onClick={()=>onOpen(item)} aria-label={(audio?'播放':'打开')+type+'：'+item.name}><span className="drive-file-kind">{type}</span><strong>{driveTitle(item.name)}</strong><small>{driveFileSize(item.size)}</small><span className="drive-file-action">{audio?'播放':'打开'}</span></button>;})}</div>;
}
function DriveStudyLoading({selected,hasCourse,reactRuntime=React,decorative=false}){
 const h=reactRuntime.createElement;
 return h('div',{className:'drive-study-loading',role:decorative?undefined:'status','aria-label':decorative?undefined:'正在整理课程章节','aria-busy':decorative?undefined:'true'},!decorative&&h('span',{className:'loading-sr'},'正在整理课程章节'),h('div',{className:'drive-study-loading-heading'},h('i',{className:'sk-line'}),h('i',{className:'sk-line'})),h('div',{className:'drive-study-loading-panel'},...Array.from({length:selected?3:4},(_,i)=>h('i',{className:'sk-line',key:i}))),hasCourse&&h('div',{className:'drive-study-loading-list'},...[0,1,2,3].map(i=>h('i',{className:'sk-line',key:i}))));
}
window.DriveStudyLoading=DriveStudyLoading;
function DriveResourceCard({reactRuntime:React,item,onOpen}){
 const [coverIndex,setCoverIndex]=React.useState(0),[failedMosaic,setFailedMosaic]=React.useState([]);
 const layout=driveCoverLayout(item),type=driveDisplayType(item),title=driveBookName(item);
 const coverSources=[item.coverUrl,item.kind==='image'?driveFileUrl(item.path):null].filter(Boolean);
 const coverUrl=coverSources[coverIndex];
 const mosaic=(item.collectionCovers||[]).filter(c=>c.url&&!failedMosaic.includes(c.url));
 const counts=item.availableCounts||item.counts||{};
 const emptyFolder=item.isDir&&(item.empty===true||counts.files===0);
 const summary=item.isDir?emptyFolder?'空目录':[counts.video&&`${counts.video} 个视频`,counts.audio&&`${counts.audio} 个音频`,counts.files&&`${counts.files} 个文件`].filter(Boolean).join(' · ')||'打开查看内容':driveFileSize(item.size);
 const missing=<div className="drive-cover-missing"><strong>{title}</strong><small>{emptyFolder?'空目录 · 暂无内容':'暂无真实预览'}</small></div>;
 const ContentPreview=window.OmniDrivePreview?.ContentPreview;
 return <button className={'drive-resource-card cover-layout-'+layout+' content-type-'+driveContentType(item)} onClick={()=>onOpen(item)} aria-label={'打开'+type+'：'+item.name}>
  <div data-cover-kind={item.coverKind||undefined} className={'drive-cover'+(layout==='portrait'?' book-cover':'')+(coverUrl?' has-image':'')+(item.coverKind==='pdf'?' pdf-cover':'')+(item.coverKind==='pdf'&&item.coverAspect>0&&item.coverAspect<0.4&&layout!=='portrait'?' long-document-preview':'')}>
   {coverUrl?<img loading="lazy" decoding="async" src={coverUrl} alt={title+'封面'} onError={()=>setCoverIndex(index=>index+1)}/>:
    mosaic.length?<div className={'drive-cover-mosaic'+(mosaic.some(c=>c.kind==='video')?' media-mosaic':'')}>{mosaic.slice(0,3).map(c=><img key={c.url} src={c.url} alt={driveTitle(c.name)+'封面'} loading="lazy" onError={()=>setFailedMosaic(previous=>previous.includes(c.url)?previous:[...previous,c.url])}/>)}</div>:
    ContentPreview&&item.previewCandidates?.length?<ContentPreview reactRuntime={React} item={item} fallback={missing}/>:missing}
   <span className="drive-cover-type">{type}</span>
  </div>
  <div className="drive-card-copy"><h3>{title}</h3>{driveBookByline(item)&&<div className="drive-book-byline">{driveBookByline(item)}</div>}{summary&&<p>{summary}</p>}</div>
 </button>;
}

function DriveMedia({reactRuntime:React,request,file,active}){
 const ref=React.useRef(null),stamp=React.useRef(0),[position,setPosition]=React.useState(null),[error,setError]=React.useState('');
 React.useEffect(()=>{let alive=true;request('/api/openlist/library/progress?'+new URLSearchParams({path:file.path})).then(p=>{if(alive)setPosition(p.duration&&p.position>p.duration-5?0:p.position||0);}).catch(()=>{if(alive)setPosition(0);});return()=>{alive=false;};},[file.path]);
 const save=(force=false)=>{const m=ref.current;if(!m||!Number.isFinite(m.duration)||!force&&Date.now()-stamp.current<10000)return;stamp.current=Date.now();request('/api/openlist/library/progress',{method:'POST',body:{path:file.path,position:m.currentTime,duration:m.duration}}).catch(()=>{});};
 React.useEffect(()=>{if(!active){save(true);ref.current?.pause();}},[active]);
 if(error)return <section className="drive-playback-error" role="alert"><strong>这节视频暂时无法播放</strong><p>{error}</p><div><button className="btn" onClick={()=>setError('')}>重新加载</button><a className="btn" href={driveFileUrl(file.path)+'&download=1'} download>下载到设备</a></div><small>可先查看本课资料，或在课程目录中切换其他课时。</small></section>;
 return <div className="drive-player">{position===null&&<div className="drive-player-loading" role="status">正在恢复播放位置…</div>}{position!==null&&React.createElement(file.kind,{ref,src:driveFileUrl(file.path),controls:true,autoPlay:false,playsInline:true,preload:'metadata',onLoadedMetadata:e=>{if(position>0&&position<e.currentTarget.duration-5)e.currentTarget.currentTime=position;},onTimeUpdate:()=>save(),onPause:()=>save(true),onEnded:()=>save(true),onError:e=>setError(e.currentTarget.error?.code===2?'视频读取中断，请重试。':'浏览器未能加载或解码此视频，请重试或下载到设备后打开。')})}</div>;
}
function DriveDocument({reactRuntime:React,file,readerRef,onEpubToc,onEpubTocState,onEpubChapter}){
 const url=driveFileUrl(file.path),reader=file.kind==='pdf'?'/assets/readers/pdfjs-6.5.438/web/viewer.html?'+new URLSearchParams({file:url,embedded:'1'}):file.kind==='epub'?'/assets/readers/epub.html?'+new URLSearchParams({path:file.path,embedded:'1'}):null;
 return <div className="drive-document-stage">{reader?<>{file.kind==='pdf'?<DrivePdf reactRuntime={React} file={file}/>:<DriveEpub key={file.path} reactRuntime={React} file={file} readerRef={readerRef} onTocChange={onEpubToc} onTocStateChange={onEpubTocState} onChapterChange={onEpubChapter}/>} {!readerRef&&<a href={reader.replace(/&embedded=1/,'')} target="_blank" rel="noopener">独立窗口阅读 ↗</a>}</>:file.kind==='image'?<img src={url} alt={file.name}/>:file.kind==='text'?<iframe title={file.name} src={url}/>:<div className="drive-download-card"><strong>{file.name.split('.').at(-1).toUpperCase()} 文件</strong><p>此格式使用本地应用打开。</p><a className="btn" href={url+'&download=1'} download>下载到设备</a></div>}</div>;
}
function DriveMaterialList({reactRuntime:React,items,onOpen,showChapter=false}){return <div className="drive-attachments">{items.length?items.map(f=><button key={f.path} onClick={()=>onOpen(f)} aria-label={'查看资料：'+driveTitle(f.name)}><span className="drive-kind">{driveLabels[f.kind]}</span><span><strong>{driveTitle(f.name)}</strong>{showChapter&&<small>{driveTitle(f.chapter)}</small>}</span><small>{['pdf','epub','text','image'].includes(f.kind)?'查看':'下载'}</small></button>):<p>此课程暂无已索引的配套资料。</p>}</div>;}
function DriveChapter({reactRuntime:React,node,root=false,selected,onOpen,onSource}){
 const has=n=>n.path===selected||(n.children||[]).some(has);
 const [expanded,setExpanded]=React.useState(root||has(node));
 React.useEffect(()=>{if(has(node))setExpanded(true);},[selected]);
 if(!node.isDir)return <button className={'drive-lesson'+(node.path===selected?' selected':'')} onClick={()=>onOpen(node)} aria-label={'打开课时：'+node.name}><span>{node.kind==='video'?'▷':node.kind==='audio'?'♪':driveLabels[node.kind]}</span><strong>{driveTitle(node.name)}</strong></button>;
 const children=node.children||[];
 const body=<>{node.sources?.length>1&&<details className="drive-node-sources"><summary>同名来源 {node.sources.length}</summary>{node.sources.map(s=><button key={s.path} onClick={()=>onSource?.(node,s.path)}>{s.category} · {s.counts.files} 个文件<small>{s.path}</small></button>)}</details>}{node.sourcePath!==node.path&&<p className="drive-alternate-note">原目录为空，已关联同名可用来源</p>}{children.map(child=><DriveChapter key={child.path} reactRuntime={React} node={child} selected={selected} onOpen={onOpen} onSource={onSource}/>)}{!children.length&&<p className="drive-chapter-empty">此来源暂无内容</p>}</>;
 return root?<div>{body}</div>:<section className="drive-chapter"><button className="drive-chapter-title" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><span>{expanded?'▾':'▸'}</span><strong>{driveTitle(node.name)}</strong><small>{children.length}</small></button>{expanded&&<div className="drive-chapter-content">{body}</div>}</section>;
}
function DriveScanStatus({reactRuntime:React,request,active}){
 const [scan,setScan]=React.useState(null),[error,setError]=React.useState('');
 React.useEffect(()=>{if(!active)return;let stop=false,timer;const poll=async()=>{try{const s=await request('/api/openlist/library/scan');if(!stop){setScan(s);if(s.state==='running')timer=setTimeout(poll,5000);}}catch(e){if(!stop)setError(e.message);}};poll();return()=>{stop=true;clearTimeout(timer);};},[active,scan?.state]);
 return <section className="drive-scan-status" aria-label="完整扫描进度"><strong>{scan?.state==='complete'?'目录已同步':scan?.state==='running'?'正在同步目录':'目录同步'}</strong>{scan&&<p>{scan.done} / {scan.directories} 个目录 · {scan.files} 个文件{scan.failed?` · ${scan.failed} 个失败`:''}</p>}<button className="btn" disabled={!scan||scan.state==='running'} onClick={async()=>{try{setScan(await request('/api/openlist/library/scan',{method:'POST',body:{retry:scan?.state==='incomplete'}}));}catch(e){setError(e.message);}}}>重新扫描</button>{error&&<p role="alert">{error}</p>}</section>;
}
function DrivePdf({reactRuntime:React,file}){
 const canvas=React.useRef(null),panel=React.useRef(null),[doc,setDoc]=React.useState(null),[page,setPage]=React.useState(1),[total,setTotal]=React.useState(0),[zoom,setZoom]=React.useState(1),[width,setWidth]=React.useState(600),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(true),[query,setQuery]=React.useState(''),[hits,setHits]=React.useState([]),[finding,setFinding]=React.useState(false);
 React.useEffect(()=>{let stopped=false,task,document;setBusy(true);setDoc(null);setError('');setPage(1);setHits([]);
  (async()=>{try{const pdfjs=await import('/assets/readers/pdfjs-6.5.438/build/pdf.mjs');if(stopped)return;pdfjs.GlobalWorkerOptions.workerSrc='/assets/readers/pdfjs-6.5.438/build/pdf.worker.mjs';task=pdfjs.getDocument({url:driveFileUrl(file.path),withCredentials:true,disableAutoFetch:true,disableStream:true,isEvalSupported:false,cMapUrl:'/assets/readers/pdfjs-6.5.438/web/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/readers/pdfjs-6.5.438/web/standard_fonts/',wasmUrl:'/assets/readers/pdfjs-6.5.438/web/wasm/'});document=await task.promise;if(stopped){document.destroy();return;}const saved=await fetch('/api/openlist/library/reading?'+new URLSearchParams({path:file.path}),{credentials:'same-origin'}).then(r=>r.json()).catch(()=>({}));if(stopped)return;setTotal(document.numPages);setPage(Math.max(1,Math.min(document.numPages,Number(saved.location)||1)));setDoc(document);}catch(e){if(!stopped){setError(e.message||'PDF 加载失败');setBusy(false);}}})();return()=>{stopped=true;task?.destroy();};
 },[file.path]);
 React.useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(Math.max(220,entries[0].contentRect.width-24)));if(panel.current)observer.observe(panel.current);return()=>observer.disconnect();},[]);
 React.useEffect(()=>{if(!doc)return;let cancelled=false,render;setBusy(true);(async()=>{try{const p=await doc.getPage(page);if(cancelled)return;const base=p.getViewport({scale:1}),viewport=p.getViewport({scale:width/base.width*zoom}),ratio=Math.min(window.devicePixelRatio||1,2),c=canvas.current;c.width=Math.floor(viewport.width*ratio);c.height=Math.floor(viewport.height*ratio);c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';render=p.render({canvasContext:c.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});await render.promise;if(!cancelled)setBusy(false);}catch(e){if(!cancelled&&e.name!=='RenderingCancelledException'){setError(e.message);setBusy(false);}}})();const timer=setTimeout(()=>fetch('/api/openlist/library/reading',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:file.path,location:String(page)}),keepalive:true}).catch(()=>{}),400);return()=>{cancelled=true;render?.cancel();clearTimeout(timer);};},[doc,page,zoom,width]);
 async function find(e){e.preventDefault();if(!doc||!query.trim())return;setFinding(true);const results=[];try{for(let n=1;n<=doc.numPages;n++){const p=await doc.getPage(n),text=(await p.getTextContent()).items.map(i=>i.str||'').join('');if(text.toLowerCase().includes(query.trim().toLowerCase()))results.push(n);if(results.length>=100)break;}setHits(results);if(results.length)setPage(results[0]);}catch(e){setError(e.message);}finally{setFinding(false);}}
 return <section className="drive-pdf" aria-label="PDF 阅读器"><div className="drive-pdf-tools"><button className="btn" disabled={!doc||page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><label>第 <input type="number" aria-label="PDF 页码" min="1" max={total||1} value={page} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=total)setPage(n);}}/> / {total||'—'} 页</label><button className="btn" disabled={!doc||page>=total} onClick={()=>setPage(p=>p+1)}>下一页</button><select aria-label="PDF 缩放" value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value="1">适合宽度</option><option value="0.75">75%</option><option value="1.25">125%</option><option value="1.5">150%</option></select><form onSubmit={find}><input aria-label="PDF 内搜索" placeholder="搜索书内文字" value={query} onChange={e=>setQuery(e.target.value)}/><button className="btn" disabled={finding||!doc}>{finding?'查找中…':'查找'}</button></form></div>{hits.length>0&&<div className="drive-pdf-hits">匹配页：{hits.map(n=><button key={n} onClick={()=>setPage(n)}>{n}</button>)}</div>}{error&&<p role="alert">{error}</p>}<div className="drive-pdf-page" ref={panel}>{busy&&<span role="status">正在加载第 {page} 页…</span>}<canvas ref={canvas} aria-label={'PDF 第 '+page+' 页'}/></div></section>;
}
let driveEpubReady;
function loadDriveEpub(){
 if(!driveEpubReady)driveEpubReady=(async()=>{for(const src of ['/assets/readers/jszip-3.10.2/jszip.min.js','/assets/readers/epubjs-0.3.93/epub.min.js'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('阅读器组件加载失败'));};document.head.append(script);});})().catch(e=>{driveEpubReady=null;throw e;});return driveEpubReady;
}
function DriveEpub({reactRuntime:React,file,readerRef,onTocChange,onTocStateChange,onChapterChange}){
 const host=React.useRef(null),engine=React.useRef(null),bookRef=React.useRef(null),[toc,setToc]=React.useState([]),[chapter,setChapter]=React.useState(''),[position,setPosition]=React.useState('正在读取电子书…'),[error,setError]=React.useState(''),[retry,setRetry]=React.useState(0),[font,setFont]=React.useState(100),[dark,setDark]=React.useState(true),[ready,setReady]=React.useState(false),[query,setQuery]=React.useState(''),[hits,setHits]=React.useState([]),[finding,setFinding]=React.useState(false);
 const tocCallback=React.useRef(onTocChange),tocStateCallback=React.useRef(onTocStateChange),chapterCallback=React.useRef(onChapterChange);React.useEffect(()=>{tocCallback.current=onTocChange;tocStateCallback.current=onTocStateChange;chapterCallback.current=onChapterChange;},[onTocChange,onTocStateChange,onChapterChange]);
 React.useEffect(()=>{let stopped=false,book,rendition,timer;const controller=new AbortController();setReady(false);setError('');tocStateCallback.current?.('loading');
  (async()=>{try{await loadDriveEpub();if(stopped)return;const saved=fetch('/api/openlist/library/reading?'+new URLSearchParams({path:file.path}),{credentials:'same-origin',signal:controller.signal}).then(r=>r.json()).catch(()=>({}));const response=await fetch(driveFileUrl(file.path),{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('电子书读取失败（'+response.status+'）');book=window.ePub(await response.arrayBuffer());bookRef.current=book;const loadSection=book.load.bind(book);book.load=async url=>{const value=await loadSection(url);if(typeof value==='string'&&/<(?:html|\?xml)[\s>]/i.test(value)){const doc=new DOMParser().parseFromString(value,'application/xhtml+xml');if(doc.querySelector('parsererror'))throw Error('电子书章节格式无效');return doc;}return value;};
    book.spine.hooks.content.register(doc=>{doc.querySelectorAll('script,iframe,object,embed,form,base,meta[http-equiv]').forEach(n=>n.remove());doc.querySelectorAll('*').forEach(el=>{for(const a of [...el.attributes])if(/^on/i.test(a.name))el.removeAttribute(a.name);});doc.querySelectorAll('a[href]').forEach(a=>{if(/^(?:https?:|javascript:|data:|\/\/)/i.test(a.getAttribute('href')))a.removeAttribute('href');});const meta=doc.createElement('meta');meta.setAttribute('http-equiv','Content-Security-Policy');meta.setAttribute('content',"default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:; form-action 'none'; base-uri 'none'");doc.head.prepend(meta);});
    await book.ready;if(stopped)return;rendition=book.renderTo(host.current,{width:'100%',height:'100%',spread:'none',flow:'paginated',allowScriptedContent:false,allowPopups:false});engine.current=rendition;if(readerRef)readerRef.current={display:href=>rendition.display(href).catch(e=>setError(e.message))};
    for(const name of ['day','night'])rendition.themes.register(name,{'body':{color:(name==='night'?'#e5e7eb':'#252525')+' !important',background:(name==='night'?'#1c2025':'#f8f7f3')+' !important','line-height':'1.8 !important','padding':'0 18px !important'},'p,span,h1,h2,h3,h4,h5,h6,strong,em,a,li,div':{color:'inherit !important',background:'transparent !important'}});rendition.themes.select('night');
    const nav=await book.loaded.navigation,rows=[];const walk=(items,depth=0)=>{for(const item of items){rows.push({href:item.href,label:'　'.repeat(depth)+item.label.trim()});if(item.subitems)walk(item.subitems,depth+1);}};walk(nav.toc);if(stopped)return;setToc(rows);tocCallback.current?.(rows);tocStateCallback.current?.('ready');
    rendition.on('displayError',e=>{if(!stopped)setError(e.message);});
    rendition.on('relocated',loc=>{if(stopped)return;setPosition(`第 ${loc.start.index+1} 节 · 本节 ${loc.start.displayed.page}/${loc.start.displayed.total} 页`);const current=rows.find(r=>r.href.split('#')[0]===loc.start.href);if(current){setChapter(current.href);chapterCallback.current?.(current.href);}clearTimeout(timer);timer=setTimeout(()=>fetch('/api/openlist/library/reading',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:file.path,location:loc.start.cfi}),keepalive:true}).catch(()=>{}),400);});
    const previous=await saved;if(stopped)return;try{await rendition.display(previous.location||undefined);}catch{await rendition.display();}if(!stopped)setReady(true);
  }catch(e){if(!stopped){setError(e.message||'电子书加载失败');tocStateCallback.current?.('error');}}})();return()=>{stopped=true;controller.abort();clearTimeout(timer);book?.destroy();engine.current=null;if(readerRef)readerRef.current=null;bookRef.current=null;};
 },[file.path,retry]);
 React.useEffect(()=>{engine.current?.themes.fontSize(font+'%');},[font,ready]);React.useEffect(()=>{engine.current?.themes.select(dark?'night':'day');},[dark,ready]);
 async function find(e){e.preventDefault();const book=bookRef.current;if(!ready||!query.trim())return;setFinding(true);const rows=[];try{for(const section of book.spine.spineItems){await section.load(book.load.bind(book));if(bookRef.current!==book)return;for(const hit of section.find(query.trim())){rows.push(hit);if(rows.length>=100)break;}if(rows.length>=100)break;}setHits(rows);if(!rows.length)setPosition('未找到匹配文字');}catch(e){setError(e.message);}finally{setFinding(false);}}
 return <section className={'drive-epub'+(dark?' dark':'')} aria-label="EPUB 阅读器"><div className="drive-epub-tools"><select aria-label="电子书章节" value={chapter} onChange={e=>engine.current?.display(e.target.value).catch(e=>setError(e.message))}>{toc.map(t=><option key={t.href} value={t.href}>{t.label}</option>)}</select><button className="btn" aria-label="减小字号" onClick={()=>setFont(v=>Math.max(70,v-10))}>A−</button><button className="btn" aria-label="增大字号" onClick={()=>setFont(v=>Math.min(200,v+10))}>A＋</button><button className="btn" onClick={()=>setDark(v=>!v)}>{dark?'日间模式':'夜间模式'}</button><form onSubmit={find}><input aria-label="电子书内搜索" placeholder="书内搜索" value={query} onChange={e=>setQuery(e.target.value)}/><button className="btn" disabled={!ready||finding}>{finding?'查找中…':'查找'}</button></form></div>{ready&&error&&<p role="alert">{error} <button className="btn" onClick={()=>setRetry(v=>v+1)}>重新加载</button></p>}{hits.length>0&&<div className="drive-epub-hits">{hits.map((h,i)=><button key={i} onClick={()=>{engine.current?.display(h.cfi);setHits([]);}}>{h.excerpt}</button>)}</div>}<div className="drive-epub-paper"><div className="drive-epub-body" ref={host}/>{!ready&&<div className="drive-epub-placeholder" role={error?'alert':'status'}>{error?<><strong>电子书暂时无法打开</strong><p>{error}</p><button className="btn" onClick={()=>setRetry(v=>v+1)}>重新加载</button></>:<><i className="sk-line"/><i className="sk-line"/><i className="sk-line"/><span>正在读取电子书…</span></>}</div>}</div><footer><button className="btn" disabled={!ready} onClick={()=>engine.current?.prev().catch(e=>setError(e.message))}>上一页</button><span>{position}</span><button className="btn" disabled={!ready} onClick={()=>engine.current?.next().catch(e=>setError(e.message))}>下一页</button></footer></section>;
}

/* Course study tools: notes, flashcards and focus timer stay in this browser, keyed by account and course. */
/* study-tools:pure:start */
const DRIVE_FOCUS_MS=25*60*1000,DRIVE_STUDY_LIMITS={notes:50000,text:2000,cards:500};
function driveStudyKey(userId,scope){const id=userId==null?'':String(userId).trim(),path=String(scope||'').trim();return id&&path?'omnihub:study:v1:'+encodeURIComponent(id)+':'+encodeURIComponent(path):null;}
function driveStudyEmpty(){return {version:1,notes:'',cards:[],updatedAt:0};}
function driveStudyNormalize(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return driveStudyEmpty();
 const text=(value,max)=>typeof value==='string'?value.slice(0,max):'',time=value=>Number.isFinite(value)&&value>0?value:0,ids=new Set(),cards=[];
 for(const card of Array.isArray(raw.cards)?raw.cards:[]){
  if(!card||typeof card!=='object'||typeof card.id!=='string'||!card.id||ids.has(card.id)||cards.length>=DRIVE_STUDY_LIMITS.cards)continue;
  const front=text(card.front,DRIVE_STUDY_LIMITS.text),back=text(card.back,DRIVE_STUDY_LIMITS.text);
  if(!front.trim()||!back.trim())continue;
  ids.add(card.id);
  cards.push({id:card.id,front,back,status:['new','again','known'].includes(card.status)?card.status:'new',reviews:Number.isInteger(card.reviews)&&card.reviews>0?card.reviews:0,reviewedAt:time(card.reviewedAt),createdAt:time(card.createdAt)});
 }
 return {version:1,notes:text(raw.notes,DRIVE_STUDY_LIMITS.notes),cards,updatedAt:time(raw.updatedAt)};
}
function driveStudyLoad(storage,key){
 if(!key)return {state:driveStudyEmpty(),error:null};
 let raw;
 try{if(!storage)throw Error('storage unavailable');raw=storage.getItem(key);}catch{return {state:driveStudyEmpty(),error:'unavailable'};}
 if(raw==null)return {state:driveStudyEmpty(),error:null};
 try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return {state:driveStudyNormalize(parsed),error:null};}catch{}
 return {state:driveStudyEmpty(),error:'corrupt'};
}
function driveStudySave(storage,key,state){if(!key||!storage)return false;try{storage.setItem(key,JSON.stringify(driveStudyNormalize(state)));return true;}catch{return false;}}
function driveStudySetNotes(state,notes,now){return {...state,notes:String(notes??'').slice(0,DRIVE_STUDY_LIMITS.notes),updatedAt:now};}
function driveStudyAddCard(state,front,back,id,now){
 const question=String(front??'').trim().slice(0,DRIVE_STUDY_LIMITS.text),answer=String(back??'').trim().slice(0,DRIVE_STUDY_LIMITS.text);
 if(!question||!answer||!id||state.cards.length>=DRIVE_STUDY_LIMITS.cards||state.cards.some(card=>card.id===id))return state;
 return {...state,cards:[...state.cards,{id,front:question,back:answer,status:'new',reviews:0,reviewedAt:0,createdAt:now}],updatedAt:now};
}
function driveStudyRateCard(state,id,rating,now){
 if(!['again','known'].includes(rating)||!state.cards.some(card=>card.id===id))return state;
 return {...state,cards:state.cards.map(card=>card.id===id?{...card,status:rating,reviews:card.reviews+1,reviewedAt:now}:card),updatedAt:now};
}
function driveStudyRemoveCard(state,id,now){return state.cards.some(card=>card.id===id)?{...state,cards:state.cards.filter(card=>card.id!==id),updatedAt:now}:state;}
function driveStudyResetCards(state,now){return {...state,cards:state.cards.map(card=>({...card,status:'new',reviewedAt:0})),updatedAt:now};}
function driveStudyNextCard(state){let next=null;for(const card of state.cards)if(card.status!=='known'&&(!next||card.reviewedAt<next.reviewedAt))next=card;return next;}
function driveStudyCounts(state){const known=state.cards.filter(card=>card.status==='known').length;return {total:state.cards.length,known,pending:state.cards.length-known};}
function driveStudyBackup(state,{scope,title,now}){const study=driveStudyNormalize(state);return {format:'omnihub-study-notes',version:1,exportedAt:new Date(now).toISOString(),storage:'导出自当前浏览器的本地记录，未同步到账号或服务器',course:{title:String(title||''),path:String(scope||'')},notes:study.notes,cards:study.cards,updatedAt:study.updatedAt?new Date(study.updatedAt).toISOString():null};}
function driveFocusInitial(duration=DRIVE_FOCUS_MS){return {status:'idle',duration,remaining:duration,deadline:null};}
function driveFocusStart(timer,now){if(timer.status==='running')return timer;const remaining=timer.status==='done'||timer.remaining<=0?timer.duration:timer.remaining;return {...timer,status:'running',remaining,deadline:now+remaining};}
function driveFocusPause(timer,now){if(timer.status!=='running')return timer;const remaining=Math.max(0,timer.deadline-now);return remaining>0?{...timer,status:'paused',remaining,deadline:null}:{...timer,status:'done',remaining:0,deadline:null};}
function driveFocusReset(timer){return driveFocusInitial(timer.duration);}
function driveFocusRemaining(timer,now){return timer.status==='running'?Math.max(0,timer.deadline-now):timer.remaining;}
function driveFocusTick(timer,now){return timer.status==='running'&&timer.deadline<=now?{...timer,status:'done',remaining:0,deadline:null}:timer;}
function driveFocusFormat(ms){const total=Math.ceil(Math.max(0,ms)/1000);return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');}
/* study-tools:pure:end */
/* study-tools:sync:start */
/* Cross-tab safety. Each save re-reads the stored text and only writes if it still equals this tab's baseline (the text it last loaded or wrote).
   Web Locks, when available, serialise that read-compare-write per key between tabs. localStorage itself has no atomic compare-and-set and other
   tabs may briefly read a stale copy, so every record also carries rev/parent: a storage event whose parent is not the rev of this tab's current
   baseline (whether this tab wrote it or only loaded it) means a write based on an older revision replaced it unseen, and is reported as a
   conflict instead of being refreshed away. This may also flag legacy rev-less writes or a cleared record; that is deliberately conservative.
   Conflicts never overwrite local edits automatically. */
function driveStudyRev(){return Date.now().toString(36)+Math.random().toString(36).slice(2,10);}
function driveStudyParse(raw){
 if(raw==null)return {state:driveStudyEmpty(),rev:null,parent:null,error:null};
 try{const data=JSON.parse(raw),meta=data&&typeof data==='object'?data:{};return {state:driveStudyNormalize(data),rev:typeof meta.rev==='string'?meta.rev:null,parent:typeof meta.parent==='string'?meta.parent:null,error:null};}
 catch{return {state:driveStudyEmpty(),rev:null,parent:null,error:'corrupt'};}
}
function driveStudyRead(storage,key){
 if(!key)return {...driveStudyParse(null),raw:null};
 let raw;
 try{if(!storage)throw Error('storage unavailable');raw=storage.getItem(key)??null;}catch{return {...driveStudyParse(null),raw:undefined,error:'unavailable'};}
 return {...driveStudyParse(raw),raw};
}
function driveStudyCommit(storage,key,base,state,rev){
 if(!key||!storage)return {status:'error'};
 let current;
 try{current=storage.getItem(key)??null;}catch{return {status:'error'};}
 if(current!==base)return {status:'conflict',raw:current};
 const raw=JSON.stringify({...driveStudyNormalize(state),rev,parent:driveStudyParse(base).rev});
 try{storage.setItem(key,raw);}catch{return {status:'error'};}
 return {status:'saved',raw};
}
function driveStudySession({storage=null,key=null,locks=null,makeRev=driveStudyRev,clock=Date.now}={}){
 const loaded=driveStudyRead(storage,key),listeners=new Set();
 let study=loaded.state,base=loaded.raw,baseRev=loaded.rev,dirty=false,seq=0,epoch=0,saving=false,pending=Promise.resolve(),conflict=null,
  lock=locks&&typeof locks.request==='function'?locks:null,status=loaded.error==='unavailable'?'error':loaded.error||'ok';
 const notify=()=>{for(const listener of [...listeners])listener();};
 async function pump(){
  saving=true;
  try{
   while(key&&dirty&&!conflict){
    const from=base,snap=study,at=seq,started=epoch,rev=makeRev();
    const commit=()=>started===epoch?driveStudyCommit(storage,key,from,snap,rev):{status:'stale'};
    let result;
    if(lock){try{result=await lock.request(key,{mode:'exclusive'},commit);}catch{lock=null;result=commit();}}
    else result=commit();
    if(result.status==='stale'||started!==epoch)continue;
    if(result.status==='saved'){base=result.raw;baseRev=rev;if(at===seq)dirty=false;status='ok';}
    else if(result.status==='conflict'){conflict={raw:result.raw};status='conflict';}
    else{status='error';notify();break;}
    notify();
   }
  }finally{saving=false;}
 }
 function flush(){if(!saving)pending=pump();return pending;}
 return {
  key,storage,
  snapshot(){return {study,status,dirty,saving,conflict:!!conflict,locked:!!lock};},
  subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
  edit(change){const next=change(study,clock());if(next===study)return;study=next;seq++;dirty=true;notify();flush();},
  flush,
  onStorage(event){
   if(!key||!event||event.key!==null&&event.key!==key)return;
   const raw=event.key===null?null:event.newValue??null;
   if(raw===base)return;
   const external=driveStudyParse(raw);
   if(dirty||saving||conflict||external.error||external.parent!==baseRev){conflict={raw};status='conflict';}
   else{study=external.state;base=raw;baseRev=external.rev;status='ok';}
   notify();
  },
  reload(){
   const fresh=driveStudyRead(storage,key);
   if(fresh.error==='unavailable'){status='error';notify();return false;}
   epoch++;study=fresh.state;base=fresh.raw;baseRev=fresh.rev;dirty=false;conflict=null;status=fresh.error||'ok';notify();return true;
  }
 };
}
/* study-tools:sync:end */
/* study-tools:vm:start */
function DriveFocusTimer({reactRuntime:React,clock=Date.now}){
 const h=React.createElement;
 const [timer,setTimer]=React.useState(()=>driveFocusInitial()),[now,setNow]=React.useState(clock);
 React.useEffect(()=>{
  if(timer.status!=='running')return;
  const tick=()=>{const t=clock();setNow(t);setTimer(value=>driveFocusTick(value,t));};
  tick();
  const interval=setInterval(tick,1000);
  document.addEventListener('visibilitychange',tick);
  return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',tick);};
 },[timer.status]);
 const act=change=>{const t=clock();setNow(t);setTimer(value=>change(value,t));};
 const remaining=driveFocusRemaining(timer,now),running=timer.status==='running';
 const status=running?'专注中。切到其他页面也按截止时间计算，回来即校准。':timer.status==='paused'?'已暂停，可继续或重置。':timer.status==='done'?'本轮 25 分钟专注已完成，休息一下。':'25 分钟专注计时，需手动开始，不发送通知。';
 return h('div',{className:'drive-focus'},
  h('time',{role:'timer','aria-label':'专注剩余时间',dateTime:'PT'+Math.ceil(remaining/1000)+'S'},driveFocusFormat(remaining)),
  h('p',{'aria-live':'polite'},status),
  h('div',null,
   running?h('button',{type:'button',className:'btn',onClick:()=>act(driveFocusPause)},'暂停'):h('button',{type:'button',className:'btn drive-primary',onClick:()=>act(driveFocusStart)},timer.status==='paused'?'继续':timer.status==='done'?'再来一轮':'开始'),
   h('button',{type:'button',className:'btn',disabled:timer.status==='idle',onClick:()=>act(driveFocusReset)},'重置')));
}
/* study-tools:vm:end */
function driveStudyStorage(){try{return window.localStorage;}catch{return null;}}
function driveStudyLocks(){try{const locks=navigator.locks;return locks&&typeof locks.request==='function'?locks:null;}catch{return null;}}
function DriveStudyTools({reactRuntime:React,userId,scope,title}){
 const key=driveStudyKey(userId,scope),sessionRef=React.useRef(null);
 if(!sessionRef.current||sessionRef.current.key!==key)sessionRef.current=driveStudySession({storage:driveStudyStorage(),key,locks:driveStudyLocks()});
 const session=sessionRef.current,[,setRevision]=React.useState(0);
 React.useEffect(()=>{
  const off=session.subscribe(()=>setRevision(n=>n+1)),onStorage=e=>{if(e.storageArea===session.storage)session.onStorage(e);};
  window.addEventListener('storage',onStorage);
  return()=>{off();window.removeEventListener('storage',onStorage);};
 },[session]);
 const {study,status:saveState,locked}=session.snapshot();
 const [panel,setPanel]=React.useState('notes'),[front,setFront]=React.useState(''),[back,setBack]=React.useState(''),[flipped,setFlipped]=React.useState(null);
 const update=change=>session.edit(change);
 const current=driveStudyNextCard(study),counts=driveStudyCounts(study),full=counts.total>=DRIVE_STUDY_LIMITS.cards;
 function addCard(e){e.preventDefault();if(!front.trim()||!back.trim()||full)return;const id='c'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);update((state,now)=>driveStudyAddCard(state,front,back,id,now));setFront('');setBack('');}
 function rate(rating){const id=current.id;setFlipped(null);update((state,now)=>driveStudyRateCard(state,id,rating,now));}
 function download(){const backup=driveStudyBackup(study,{scope,title,now:Date.now()});const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='学习笔记-'+(String(title||'课程').replace(/[\\/:*?"<>|\s]+/g,'-').slice(0,60)||'课程')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function reload(){if(window.confirm('将用浏览器中已保存的记录替换本页内容，本页未保存的修改会丢失。建议先下载 JSON 备份。继续吗？')){setFlipped(null);session.reload();}}
 const message=saveState==='conflict'?'另一个标签页或窗口已修改此课程的本地记录。为避免互相覆盖，本页已暂停保存，当前编辑仍保留在本页：请先下载 JSON 备份，再决定是否放弃本页修改并重新加载已保存的记录。':saveState==='error'?'浏览器无法保存（存储可能已满或被禁用）。当前编辑仍保留在本页，请立即下载 JSON 备份。':saveState==='corrupt'?'此课程原有的本地记录无法读取，已从空白开始；继续编辑会覆盖原记录。':!key?'未识别当前账号，笔记和闪卡只保留在本页，刷新后会丢失，请下载 JSON 备份。':'仅保存在当前浏览器，按账号和课程分开存放；换设备、换浏览器或清除网站数据后不会保留，可随时下载 JSON 备份。';
 const lockNote=key&&!locked?' 此浏览器不支持跨标签页锁：保存前仍会检查其他标签页的修改，但几乎同时保存时只能事后发现冲突，请尽量只在一个标签页中编辑。':'';
 const tabs=[['notes','笔记'],['cards','闪卡 '+counts.total],['focus','专注']];
 return <section className="drive-study-tools" aria-label="学习工具">
  <div className="drive-study-tools-head"><h3>学习工具</h3><div role="tablist" aria-label="学习工具">{tabs.map(([id,label])=><button key={id} type="button" role="tab" id={'drive-study-tab-'+id} aria-controls={'drive-study-panel-'+id} aria-selected={panel===id} onClick={()=>setPanel(id)}>{label}</button>)}</div><button type="button" className="btn" onClick={download}>下载 JSON 备份</button></div>
  <div className="drive-study-panel" role="tabpanel" id="drive-study-panel-notes" aria-labelledby="drive-study-tab-notes" hidden={panel!=='notes'}><textarea rows="9" aria-label="课程笔记" maxLength={DRIVE_STUDY_LIMITS.notes} placeholder="记录要点、疑问和时间点，例如“12:30 关键公式推导”。" value={study.notes} onChange={e=>{const value=e.target.value;update((state,now)=>driveStudySetNotes(state,value,now));}}/><small>{study.notes.length} / {DRIVE_STUDY_LIMITS.notes} 字</small></div>
  <div className="drive-study-panel" role="tabpanel" id="drive-study-panel-cards" aria-labelledby="drive-study-tab-cards" hidden={panel!=='cards'}>
   <div className="drive-flashcard-meta"><span>待练 {counts.pending} · 已掌握 {counts.known}</span>{counts.known>0&&<button type="button" className="btn" onClick={()=>{setFlipped(null);update(driveStudyResetCards);}}>全部重新练习</button>}</div>
   <div className="drive-flashcard" aria-live="polite">{current?<><span>问题</span><p>{current.front}</p>{flipped===current.id?<><span>答案</span><p>{current.back}</p><div className="drive-flashcard-actions"><button type="button" className="btn" onClick={()=>rate('again')}>再练</button><button type="button" className="btn drive-primary" onClick={()=>rate('known')}>掌握</button></div></>:<div className="drive-flashcard-actions"><button type="button" className="btn" onClick={()=>setFlipped(current.id)}>翻面看答案</button></div>}</>:<p>{counts.total?'全部闪卡已掌握，可以重新练习。':'还没有闪卡。在下方写下问题和答案，开始自测。'}</p>}</div>
   <form className="drive-flashcard-form" onSubmit={addCard}><label>问题<textarea rows="2" maxLength={DRIVE_STUDY_LIMITS.text} value={front} onChange={e=>setFront(e.target.value)}/></label><label>答案<textarea rows="2" maxLength={DRIVE_STUDY_LIMITS.text} value={back} onChange={e=>setBack(e.target.value)}/></label><button className="btn" disabled={!front.trim()||!back.trim()||full}>添加闪卡</button></form>
   {full&&<small>已达 {DRIVE_STUDY_LIMITS.cards} 张上限，请先删除不再需要的闪卡。</small>}
   {counts.total>0&&<details className="drive-flashcard-list"><summary>管理闪卡（{counts.total}）</summary><ul>{study.cards.map(card=><li key={card.id}><span>{card.front}</span><small>{card.status==='known'?'已掌握':card.status==='again'?'再练':'未练'}</small><button type="button" className="btn" aria-label={'删除闪卡：'+card.front} onClick={()=>update((state,now)=>driveStudyRemoveCard(state,card.id,now))}>删除</button></li>)}</ul></details>}
  </div>
  <div className="drive-study-panel" role="tabpanel" id="drive-study-panel-focus" aria-labelledby="drive-study-tab-focus" hidden={panel!=='focus'}><DriveFocusTimer reactRuntime={React}/></div>
  <p className="drive-study-storage" role={saveState==='error'||saveState==='conflict'?'alert':undefined}>{message}{lockNote}</p>
  {saveState==='conflict'&&<button type="button" className="btn" onClick={reload}>放弃本页修改并重新加载</button>}
 </section>;
}
