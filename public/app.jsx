/// 主应用 —— 登录态管理 + 五大模块（收藏/提示词/AI对话/信息流/工具箱），业务数据走服务器
const { useState: useAppState, useEffect: useAppEffect, useMemo: useAppMemo, useRef: useAppRef } = React;

// Only modules whose header search actually filters their own content.
const SEARCH_PLACEHOLDERS = {
  repositories: "搜索仓库名称、用途或主题……",
  knowledgeLibrary: "搜索知识文章……",
  promptLibrary: "搜索提示词、主体或风格……",
  inbox: "搜索待处理内容……",
  resources: "搜索收藏的资源、提示词或知识……",
  works: "搜索作品……",
  feed: "搜索资讯……",
};

const GREETINGS = [
  { until: 6, text: "夜深了，注意休息" },
  { until: 9, text: "早上好" },
  { until: 12, text: "上午好" },
  { until: 14, text: "中午好" },
  { until: 18, text: "下午好" },
  { until: 24, text: "晚上好" },
];

function getGreeting(hour) {
  const matched = GREETINGS.find((g) => hour < g.until);
  return matched ? matched.text : "你好";
}

const LUNAR_DAY_NAMES = [
  "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

/** 用浏览器内置的中国农历日历计算农历日期，如「五月廿八」；不支持时返回空串 */
function getLunarDate(date) {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" }).formatToParts(date);
    const month = (parts.find((p) => p.type === "month") || {}).value || "";
    const day = Number((parts.find((p) => p.type === "day") || {}).value || 0);
    if (!month || !day) return "";
    return month + (LUNAR_DAY_NAMES[day - 1] || "");
  } catch (err) {
    return "";
  }
}

function formatToday(now) {
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const lunar = getLunarDate(now);
  const base = `${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${week}`;
  return lunar ? `${base} · 农历${lunar}` : base;
}

/** 收藏模块 */
function FavoritesView({ favorites, query, category, onAdd, onEdit, onDelete }) {
  const [assetLens, setAssetLens] = useAppState("全部");
  const visible = favorites.filter((fav) => {
    const inCategory = category === "全部" || fav.category === category;
    const q = query.toLowerCase();
    const inQuery = !q || fav.name.toLowerCase().includes(q)
      || fav.url.toLowerCase().includes(q) || (fav.desc || "").toLowerCase().includes(q)
      || (fav.tags || "").toLowerCase().includes(q) || (fav.note || "").toLowerCase().includes(q);
    const inLens = assetLens === "全部"
      || (assetLens === "待完善" ? !(fav.desc && fav.type && fav.tags) : fav.type === assetLens);
    return inCategory && inQuery && inLens;
  });

  const lensItems = [
    { id: "全部", label: "全部" }, { id: "site", label: "网站" },
    { id: "tool", label: "工具" }, { id: "repo", label: "开源项目" },
    { id: "article", label: "课程·文章" }, { id: "待完善", label: "待完善" },
  ];
  const lensCount = (lens) => {
    if (lens === "全部") return favorites.length;
    if (lens === "待完善") return favorites.filter((fav) => !(fav.desc && fav.type && fav.tags)).length;
    return favorites.filter((fav) => fav.type === lens).length;
  };

  const groups = (category === "全部" ? FAV_CATEGORIES : [category])
    .map((cat) => ({ cat, items: visible.filter((f) => f.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      <div className="asset-compact-head">
        <div className="asset-lens-row" role="group" aria-label="按资源类型筛选">
        {lensItems.map((lens) => (
          <button key={lens.id} className={"asset-lens" + (assetLens === lens.id ? " active" : "")}
            aria-pressed={assetLens === lens.id} onClick={() => setAssetLens(lens.id)}>
            <span>{lens.label}</span><em>{lensCount(lens.id)}</em>
          </button>
        ))}
        </div>
        <button className="btn btn-primary" onClick={onAdd} aria-label="手动收录资源（网站、工具、文章或开源项目）"><IconPlus />收录资源</button>
      </div>
      {groups.length === 0 && (
        <div>
          <EmptyState message="没有找到相关资源" hint="换个筛选，或点击「收录资源」手动添加网站、工具或文章" />
        </div>
      )}
      {groups.map((group, gi) => (
        <section key={group.cat}>
          <SectionHead icon={<IconBookmark />} title={group.cat} count={group.items.length}>
          </SectionHead>
          <div className="fav-grid">
            {group.items.map((fav) => (
              <FavCardV2 key={fav.id} fav={fav} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 提示词灵感库模块（模型/标签/收藏/归档筛选 + 导出） */
function PromptsView({ prompts, query, category, onAdd, onDelete, onCopy, onOpen, onTryRun, onCreateMedia, onToggleFavorite }) {
  const [modelFilter, setModelFilter] = useAppState("");
  const [tagFilter, setTagFilter] = useAppState("");
  const [stageFilter, setStageFilter] = useAppState("active");

  const models = useAppMemo(
    () => [...new Set(prompts.map((p) => p.model).filter(Boolean))],
    [prompts]
  );
  const tags = useAppMemo(
    () => [...new Set(prompts.flatMap((p) => (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean)))],
    [prompts]
  );

  const visible = prompts.filter((p) => {
    const needsReview = !(p.note || p.successNotes || p.reproTips || p.tags || p.model);
    const showArchived = stageFilter === "archived";
    if (Boolean(p.archived) !== showArchived) return false;
    if (stageFilter === "favorite" && !p.favorite) return false;
    if (stageFilter === "needs-review" && !needsReview) return false;
    if (category !== "全部" && p.category !== category) return false;
    if (modelFilter && p.model !== modelFilter) return false;
    if (tagFilter && !(p.tags || "").split(",").map((t) => t.trim()).includes(tagFilter)) return false;
    const q = query.toLowerCase();
    return !q || p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q)
      || (p.note || "").toLowerCase().includes(q) || (p.tags || "").toLowerCase().includes(q);
  });

  // 「全部」视图下按分类分组；分类外的（自定义分类）归到末尾「其他」组
  const knownCats = PROMPT_CATEGORIES.filter((c) => visible.some((p) => p.category === c));
  const otherCats = [...new Set(visible.map((p) => p.category).filter((c) => !PROMPT_CATEGORIES.includes(c)))];
  const promptGroups = [...knownCats, ...otherCats]
    .map((cat) => ({ cat, items: visible.filter((p) => p.category === cat) }))
    .filter((g) => g.items.length > 0);

  function renderCard(p) {
    return (
      <PromptCard key={p.id} prompt={p}
        onCopy={onCopy} onDelete={onDelete} onOpen={onOpen}
        onTryRun={onTryRun} onCreateMedia={onCreateMedia} onToggleFavorite={onToggleFavorite} />
    );
  }

  const activePrompts = prompts.filter((p) => !p.archived);
  const favoriteCount = prompts.filter((p) => p.favorite && !p.archived).length;
  const reviewCount = activePrompts.filter((p) => !(p.note || p.successNotes || p.reproTips || p.tags || p.model)).length;
  const archivedCount = prompts.filter((p) => p.archived).length;
  const stageItems = [
    { id: "active", label: "可复用", count: activePrompts.length },
    { id: "favorite", label: "高价值", count: favoriteCount },
    { id: "needs-review", label: "待提炼", count: reviewCount },
    { id: "archived", label: "归档", count: archivedCount },
  ];

  return (
    <div>
      <div className="asset-compact-head">
        <div className="asset-lens-row prompt-stage-row">
          {stageItems.map((item) => (
            <button key={item.id} className={"asset-lens" + (stageFilter === item.id ? " active" : "")}
              onClick={() => setStageFilter(item.id)}>
              <span>{item.label}</span><em>{item.count}</em>
            </button>
          ))}
        </div>
        <div className="asset-head-actions">
          <button className="btn" title="导出全部为 JSON"
            onClick={() => { window.location.href = "/api/prompts/export"; }}>
            <IconDownload style={{ width: 14, height: 14 }} />导出
          </button>
          <button className="btn btn-primary" onClick={onAdd}><IconPlus />新建提示词</button>
        </div>
      </div>
      <div className="prompt-toolbar">
        {models.length > 0 && (
          <select className="select-mini" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
            <option value="">全部模型</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {tags.length > 0 && (
          <PillTabs activeKey={tagFilter} pillVariant="chip">
            {tags.map((t) => (
              <button key={t} className={"filter-chip" + (tagFilter === t ? " active" : "")}
                onClick={() => setTagFilter(tagFilter === t ? "" : t)}>{t}</button>
            ))}
          </PillTabs>
        )}
      </div>
      {visible.length === 0 ? (
        <EmptyState message={stageFilter === "archived" ? "归档箱是空的" : "还没有匹配的提示词资产"}
          hint={stageFilter === "needs-review" ? "缺少模型、标签或复盘的资产会出现在这里" : "点击右上角「新建提示词」开始沉淀"} />
      ) : category === "全部" ? (
        promptGroups.map((group) => (
          <section className="prompt-group" key={group.cat}>
            <SectionHead title={group.cat} count={group.items.length} />
            <div className="prompt-grid">{group.items.map(renderCard)}</div>
          </section>
        ))
      ) : (
        <div className="prompt-grid">{visible.map(renderCard)}</div>
      )}
    </div>
  );
}

// 收藏 holds hand-added records; 作品 holds generated results only.
const ASSET_SCOPE_TABS = { collection: ["resources", "prompts", "knowledge"], works: ["works"] };

/** 资产视图：scope="collection" 为手动收藏（资源/提示词/知识），scope="works" 只含生成作品。 */
function AssetLibraryView({ assetTab, onAssetTabChange, favorites, prompts, knowledge, mediaAssets, query,
                            favCategory, promptCategory, onAddFavorite, onEditFavorite, onDeleteFavorite,
                            onAddPrompt, onDeletePrompt, onCopyPrompt, onOpenPrompt, onTryPrompt, onCreateFromPrompt, onTogglePromptFavorite,
                            onAddKnowledge, onOpenKnowledge, onDeleteKnowledge,
                            onCreateMedia, onContinueMedia, onMediaUpdated, onOpenMediaAssetHandled, openMediaAssetId, showToast,
                            scope = "collection" }) {
  const works = mediaAssets.filter((item) => item.origin !== "reference");
  const allowed = ASSET_SCOPE_TABS[scope] || ASSET_SCOPE_TABS.collection;
  const tabs = [
    { id: "resources", label: "资源", count: favorites.length, icon: <IconBookmark /> },
    { id: "prompts", label: "提示词", count: prompts.length, icon: <IconSparkle /> },
    { id: "knowledge", label: "知识", count: knowledge.length, icon: <IconBookOpen /> },
    { id: "works", label: "作品", count: works.length, icon: <IconPalette /> },
  ].filter((tab) => allowed.includes(tab.id));
  const currentTab = allowed.includes(assetTab) ? assetTab : allowed[0];
  const total = tabs.reduce((sum, tab) => sum + tab.count, 0);
  const isWorks = scope === "works";
  return (
    <div className="asset-library" data-scope={scope}>
      <div className="asset-library-head">
        <div>
          <h1>{isWorks ? "作品" : "收藏"}</h1>
          <p>{isWorks ? `${total} 件生成作品` : `${total} 条手动收藏的资源、提示词与知识`}</p>
        </div>
        {tabs.length > 1 && (
          <div className="asset-tabs" role="tablist" aria-label="收藏类型">
            {tabs.map((tab) => (
              <button key={tab.id} role="tab" aria-selected={currentTab === tab.id}
                className={currentTab === tab.id ? "active" : ""} onClick={() => onAssetTabChange(tab.id)}>
                {tab.icon}<span>{tab.label}</span><em>{tab.count}</em>
              </button>
            ))}
          </div>
        )}
      </div>
      {currentTab === "prompts" && (
        <PromptsView prompts={prompts} query={query} category={promptCategory}
          onAdd={onAddPrompt} onDelete={onDeletePrompt} onCopy={onCopyPrompt}
          onOpen={onOpenPrompt} onTryRun={onTryPrompt} onCreateMedia={onCreateFromPrompt}
          onToggleFavorite={onTogglePromptFavorite} />
      )}
      {currentTab === "resources" && (
        <FavoritesView favorites={favorites} query={query} category={favCategory}
          onAdd={onAddFavorite} onEdit={onEditFavorite} onDelete={onDeleteFavorite} />
      )}
      {currentTab === "knowledge" && (
        <KnowledgeView items={knowledge} query={query}
          onAdd={onAddKnowledge} onOpen={onOpenKnowledge} onDelete={onDeleteKnowledge} />
      )}
      {currentTab === "works" && <MediaAssetsView assets={mediaAssets} query={query}
        onCreate={onCreateMedia} onContinue={onContinueMedia} onUpdated={onMediaUpdated}
        openAssetId={openMediaAssetId} onOpenAssetHandled={onOpenMediaAssetHandled}
        showToast={showToast} />}
    </div>
  );
}

/** 把 ISO 时间格式化为本地 HH:MM */
function toHHMM(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 把发布时间向下取整到「分钟」作为同一时间点的判定键；无效时间返回 0 */
function toMinuteKey(iso) {
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return 0;
  return Math.floor(ms / 60000);
}

/** 复刻 AI HOT 的排序：时间倒序在前；同一时间点（同一分钟）内按打分从高到低 */
function sortByTimeThenScore(items) {
  return [...items].sort((a, b) => {
    const minuteB = toMinuteKey(b.publishedAt);
    const minuteA = toMinuteKey(a.publishedAt);
    if (minuteB !== minuteA) return minuteB - minuteA;
    const scoreB = typeof b.score === "number" ? b.score : -1;
    const scoreA = typeof a.score === "number" ? a.score : -1;
    return scoreB - scoreA;
  });
}

/** 按发布日期把条目分组成时间线，返回 [{ key, label, items }]（保持传入顺序） */
function groupByDate(items) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = [];
  const index = {};
  for (const it of items) {
    const d = new Date(it.publishedAt);
    const valid = !isNaN(d.getTime());
    const dayStart = valid ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
    const key = valid ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : "unknown";
    let label;
    if (!valid) label = "更早";
    else if (dayStart.getTime() === today.getTime()) label = "今天";
    else if (dayStart.getTime() === yesterday.getTime()) label = "昨天";
    else label = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    if (index[key] === undefined) { index[key] = groups.length; groups.push({ key, label, items: [] }); }
    groups[index[key]].items.push(it);
  }
  return groups;
}

const ROSE_FOUR = {
  particleCount: 78,
  trailSpan: 0.32,
  durationMs: 5400,
  rotationDurationMs: 28000,
  pulseDurationMs: 4500,
  strokeWidth: 4.6,
  roseA: 9.2,
  roseABoost: 0.6,
  roseBreathBase: 0.72,
  roseBreathBoost: 0.28,
  roseScale: 3.25,
};
const MIN_FEED_LOADING_MS = 450;
const REFRESH_COLLAPSE_MS = 2000;

function normalizeProgress(progress) {
  return ((progress % 1) + 1) % 1;
}

function roseFourPoint(progress, detailScale) {
  const t = progress * Math.PI * 2;
  const a = ROSE_FOUR.roseA + detailScale * ROSE_FOUR.roseABoost;
  const r = a * (ROSE_FOUR.roseBreathBase + detailScale * ROSE_FOUR.roseBreathBoost) * Math.cos(4 * t);
  return {
    x: 50 + Math.cos(t) * r * ROSE_FOUR.roseScale,
    y: 50 + Math.sin(t) * r * ROSE_FOUR.roseScale,
  };
}

function RoseFourLoader({ label }) {
  const groupRef = useAppRef(null);
  const pathRef = useAppRef(null);
  const particlesRef = useAppRef([]);

  useAppEffect(() => {
    let frame = 0;
    const startedAt = performance.now();

    function getDetailScale(time) {
      const pulseProgress = (time % ROSE_FOUR.pulseDurationMs) / ROSE_FOUR.pulseDurationMs;
      const pulseAngle = pulseProgress * Math.PI * 2;
      return 0.52 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.48;
    }

    function buildPath(detailScale, steps = 320) {
      return Array.from({ length: steps + 1 }, (_, index) => {
        const point = roseFourPoint(index / steps, detailScale);
        return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
      }).join(" ");
    }

    function render(now) {
      const time = now - startedAt;
      const progress = (time % ROSE_FOUR.durationMs) / ROSE_FOUR.durationMs;
      const detailScale = getDetailScale(time);
      const rotation = -((time % ROSE_FOUR.rotationDurationMs) / ROSE_FOUR.rotationDurationMs) * 360;

      if (groupRef.current) groupRef.current.setAttribute("transform", `rotate(${rotation} 50 50)`);
      if (pathRef.current) pathRef.current.setAttribute("d", buildPath(detailScale));
      particlesRef.current.forEach((node, index) => {
        if (!node) return;
        const tailOffset = index / (ROSE_FOUR.particleCount - 1);
        const point = roseFourPoint(normalizeProgress(progress - tailOffset * ROSE_FOUR.trailSpan), detailScale);
        const fade = Math.pow(1 - tailOffset, 0.56);
        node.setAttribute("cx", point.x.toFixed(2));
        node.setAttribute("cy", point.y.toFixed(2));
        node.setAttribute("r", (0.9 + fade * 2.7).toFixed(2));
        node.setAttribute("opacity", (0.04 + fade * 0.96).toFixed(3));
      });

      frame = requestAnimationFrame(render);
    }

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="rose-four-loader" role="status" aria-live="polite">
      <svg className="rose-four-svg" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <g ref={groupRef}>
          <path ref={pathRef}
            stroke="currentColor" strokeWidth={ROSE_FOUR.strokeWidth}
            strokeLinecap="round" strokeLinejoin="round" opacity="0.12" />
          {Array.from({ length: ROSE_FOUR.particleCount }, (_, index) => (
            <circle key={index} ref={(node) => { particlesRef.current[index] = node; }} fill="currentColor" />
          ))}
        </g>
      </svg>
      {label && <span className="rose-four-label">{label}</span>}
    </div>
  );
}

function ContentDraftDetail({detail,onClose}) {
  const article=detail.article;
  return <DetailDrawer title="收藏整理详情" onClose={onClose}>
    <div className="detail-drawer-body watch-detail-body"><small>{detail.state==='ready'?'已完成引用核验':'待复核草稿，不代表确认结论'}</small><h2>{article.title||detail.source.title}</h2><p>{article.summary||detail.classification.reason}</p>
      {(article.sections||[]).map((section,index)=><section key={index}><h3>{section.heading}</h3><p className="watch-original">{section.text}</p>
        <details><summary>原文依据</summary>{section.evidence.map((item,n)=><blockquote key={n}>{item.quote}</blockquote>)}</details></section>)}
      {!!article.limitations?.length&&<section><h3>适用边界</h3><ul>{article.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
      {article.promptText&&<details><summary>完整提示词原文</summary><p className="watch-original">{article.promptText}</p></details>}
      {detail.source.url&&<a href={detail.source.url} target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a>}
    </div>
  </DetailDrawer>;
}

function ContentPipelineStatus({ onCorrectClassification, onOpenSettings, onOpenDevices, settingsOnly = false, active = true }) {
  const [state,setState]=useAppState(null);
  const [error,setError]=useAppState('');
  const [busy,setBusy]=useAppState(false);
  const [includePrivate,setIncludePrivate]=useAppState(false);
  const [sampleSize,setSampleSize]=useAppState(50);
  const [detail,setDetail]=useAppState(null);
  async function openDraft(sourceId){setError('');try{setDetail(await api(`/api/content-pipeline/results/${sourceId}`));}catch(e){setError(e.message);}}
  useAppEffect(()=>{
    if (!active) return;
    let alive=true;
    const load=()=>api('/api/content-pipeline').then(value=>{if(alive)setState(value);}).catch(err=>{if(alive)setError(err.message);});
    load();const timer=window.setInterval(load,15000);
    return ()=>{alive=false;window.clearInterval(timer);};
  },[active]);
  async function act(action,jobId) {
    setBusy(true);setError('');
    try {setState(await api('/api/content-pipeline',{method:'POST',body:{action,...(jobId?{jobId}:{}),...(action==='enable'?{includePrivate,sampleSize}:{})}}));
      if(action==='publish')window.dispatchEvent(new Event('omnihub:collection-updated'));}
    catch(err){setError(err.message);}finally{setBusy(false);}
  }
  const labels={queued:'待整理',running:'整理中',done:'已整理',review:'待复核',retry:'等待重试',protected:'已保护或跳过'};
  const errors={needs_material:'缺少正文或必要素材',uncertain:'归类不确定',unsupported:'原文不足以支持整理结论',synthesis_unsupported:'综合文章需要复核',source_too_long:'长文需要分段整理',budget:'达到调用上限，稍后继续',configuration:'模型未配置',upstream:'模型连接失败',invalid_result:'模型结果未通过校验',stale:'来源或人工归类已改变',internal:'处理异常'};
  if (settingsOnly) return <section className="connection-section sync-module pipeline-settings" aria-label="收藏整理">
    <div className="sync-module-heading"><div className="sync-module-title"><h3>收藏整理</h3>{state && <span className="sync-status" data-tone={state.enabled ? 'success' : 'neutral'}>{state.enabled ? '已启用' : '已暂停'}</span>}</div>{onOpenDevices && <button className="btn btn-ghost" onClick={onOpenDevices}>管理整理设备</button>}</div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!state && !error && <p className="sync-meta" role="status">正在读取整理设置…</p>}
    {!state && error && <button className="btn" onClick={() => {setError(''); api('/api/content-pipeline').then(setState).catch(e=>setError(e.message));}}>重新加载</button>}
    {state && <>
      <p className="sync-meta">将导入的收藏分类、提炼，结果保存为草稿。</p>
      <div className="sync-row"><span className="sync-meta">最近 24 小时调用 · {state.callsToday} / {state.limits.dailyCalls} 次</span>{state.enabled && <button className="btn" disabled={busy} onClick={() => act('pause')}>暂停整理</button>}</div>
      {!state.model.configured && <p className="sync-meta">{state.model.provider === 'local' ? '请先配置并启用本地整理设备。' : '请先配置服务器整理模型。'}</p>}
      {!state.enabled && <div className="sync-expanded pipeline-options">
        <label className="pipeline-range"><span>整理范围</span><select className="select" aria-label="本轮整理数量" value={sampleSize} onChange={e=>setSampleSize(Number(e.target.value))}>
          <option value={50}>50 条，完成后暂停</option><option value={100}>100 条，完成后暂停</option><option value={0}>全部及以后新增收藏</option>
        </select></label>
        <label className="pipeline-private"><input type="checkbox" checked={includePrivate} onChange={e=>setIncludePrivate(e.target.checked)} />允许模型处理私有及未公开收藏</label>
        <div className="sync-row"><span className="sync-meta">启用后将调用模型，结果先存为草稿。</span><button className="btn btn-primary" disabled={busy || !state.model.configured} onClick={() => act('enable')}>启用自动整理</button></div>
      </div>}
      <details className="sync-details"><summary>手动操作与规则</summary>
        <p className="sync-meta">模型：{state.model.model || '未配置'}。保留人工归类，原始收藏不公开。</p>
        <div className="connection-actions"><button className="btn" disabled={busy} onClick={()=>act('enqueue')}>登记已有收藏</button><button className="btn" disabled={busy || !state.enabled} onClick={()=>act('run')}>处理下一条</button></div>
      </details>
    </>}
  </section>;
  return <details style={{margin:'0 0 16px',padding:'12px 0',borderBottom:'1px solid var(--border)'}}>
    <summary style={{cursor:'pointer',fontSize:13,color:'var(--text-secondary)'}}>
      收藏整理 · {state?.enabled?'自动运行':'已暂停'}{state?` · 已整理 ${state.counts.done||0} · 待复核 ${state.counts.review||0}`:''}
    </summary>
    {error&&<p role="alert">{error}</p>}
    {state&&<div style={{paddingTop:12,fontSize:13}}>
      <p>保存原文 → 分类 → 分项评分 → 同问题归组 → 中文整理与引用核验。人工归类始终优先。</p>
      <p>{state.model.configured?`生成模型 ${state.model.model}`:'尚未配置生成模型'} · 最近 24 小时 {state.callsToday}/{state.limits.dailyCalls} 次调用</p>
      <p>只整理个人收藏，AIHOT 资讯保持原样。整理结果先供本人预览，发布不改变原文。</p>
      <div className="pipeline-actions"><button className="btn" onClick={onOpenSettings}>整理设置</button></div>
      <p>待整理 {state.counts.queued||0} · 等待重试 {state.counts.retry||0} · 已保护或跳过 {state.counts.protected||0}</p>
      {!!state.selected?.length&&<details><summary>精选待读 · 达到 {state.selectionScore} 分并通过核验 · 最多 50 条</summary>
        <ul>{state.selected.map(item=><li key={item.sourceId}><button className="btn btn-ghost" onClick={()=>openDraft(item.sourceId)}>{item.title} · {item.score} 分</button><p>{item.summary}</p></li>)}</ul>
      </details>}
      <ul style={{paddingLeft:18}}>{state.recent.map(item=><li key={item.id} style={{margin:'8px 0'}}>
        {item.title} · {labels[item.state]||item.state}{item.errorCode?` · ${errors[item.errorCode]||'需检查'}`:''}
        {item.score!==null&&<span> · 收藏价值 {item.score}/100</span>}
        {item.manualProtected&&<span> · 保留已确认归类</span>}
        {item.summary&&<p>{item.summary}</p>}
        {item.summary&&<button className="btn btn-ghost" onClick={()=>openDraft(item.sourceId)}>查看整理全文</button>}
        {item.classificationReason&&<p>归类依据：{item.classificationReason}</p>}
        {!!item.reviewReasons?.length&&<details><summary>待复核问题 · {item.reviewReasons.length}</summary><ul>{item.reviewReasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul></details>}
        {item.scores&&<details><summary>评分依据</summary><ul>{Object.entries(item.scores).map(([axis,score])=><li key={axis}>
          {({substance:'可复用内容',novelty:'信息增量',evidence:'材料依据',relevance:'需求相关',actionability:'可操作性'})[axis]||axis} {score}/10：{item.scoreReasons?.[axis]}
        </li>)}</ul></details>}
        {['review','retry'].includes(item.state)&&<button className="btn btn-ghost" disabled={busy} onClick={()=>act('retry',item.id)}>重试</button>}
        {item.canPublish&&!item.published&&<button className="btn btn-ghost" disabled={busy} onClick={()=>act('publish',item.id)}>发布整理结果</button>}
        {item.published&&<span> · 已发布</span>}
        {onCorrectClassification&&<button className="btn btn-ghost" onClick={()=>onCorrectClassification({sourceInboxId:item.sourceId})}>调整归类</button>}
      </li>)}</ul>
      <small>规则版本 {state.version}</small>
    </div>}
    {detail&&<ContentDraftDetail detail={detail} onClose={()=>setDetail(null)}/>}
  </details>;
}

function WatchPostDetail({post,onClose,onBookmark,busy,error}) {
  const labels={announcement:'公告类内容',opinion:'作者观点',unverified:'未经证实',promotion:'推广内容',tutorial:'教程方法'};
  return <DetailDrawer title="关注帖子详情" onClose={onClose}>
    <div className="detail-drawer-body watch-detail-body"><p>@{post.author}</p>
      <small>{post.analysis?labels[post.analysis.claimType]:'原文已保存，中文整理尚未完成'}</small>
      <h2>{post.analysis?.title||post.title||'原帖媒体'}</h2>
      {post.analysis&&<p>{post.analysis.summary}</p>}
      {post.media?.length>0&&<div className="watch-media">{post.media.map((media,index)=><div key={index}>
        {media.type!=='photo'&&media.url?<video controls playsInline preload="metadata" src={media.url} poster={media.preview_image_url||undefined} aria-label={`原帖视频 ${index+1}`}/>
          :media.preview_image_url||media.url?<a href={media.preview_image_url||media.url} target="_blank" rel="noopener noreferrer" aria-label={`打开已保存图片 ${index+1}`}>
            <img src={media.preview_image_url||media.url} alt={media.alt_text||`原帖图片 ${index+1}`} loading="lazy"/></a>:null}
        {media.archiveState!=='ready'&&<p className="watch-caption">{media.archiveState==='pending'?'媒体正在保存到服务器…':'媒体未能完整保存，原帖正文仍在。'}</p>}
      </div>)}</div>}
      <details open={!post.analysis}><summary>原始帖子</summary><p className="watch-original">{post.content}</p></details>
      <div className="watch-actions"><a className="btn" href={post.url} target="_blank" rel="noopener noreferrer">打开 X 原文 ↗</a>
        <button className="btn" disabled={busy||post.bookmarked} onClick={()=>onBookmark(post)}>{post.bookmarked?'已在我的收藏':'收藏并整理'}</button></div>
      {error&&<p role="alert">{error}</p>}
      <p className="watch-caption">原始内容始终保留。中文摘要与内容类型是辅助整理，不代表消息已获独立证实。</p>
    </div>
  </DetailDrawer>;
}

function XWatchView({active = true,mode,query,onManage}) {
  const [state,setState]=useAppState(null),[posts,setPosts]=useAppState([]),[hot,setHot]=useAppState([]);
  const [error,setError]=useAppState(''),[busy,setBusy]=useAppState(false),[group,setGroup]=useAppState(''),[selected,setSelected]=useAppState(null);
  useAppEffect(() => { if (!active) setSelected(null); }, [active]);
  async function refresh(isCurrent=()=>true){
    const [settings,items,events]=await Promise.all([api('/api/x-watch'),api('/api/x-watch/posts'),api('/api/x-watch/hot')]);
    if(!isCurrent())return;
    setState(settings);setPosts(items);setHot(events);setError('');
    setSelected(current=>current?(items.find(p=>p.id===current.id)||current):null);
  }
  useAppEffect(()=>{
    if(!active)return;
    let alive=true;
    // Read our database only; viewing or refreshing never triggers a paid provider request.
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')refresh(()=>alive).catch(()=>{});},30000);
    refresh(()=>alive).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;clearInterval(timer);};
  },[active]);
  async function bookmark(post){setBusy(true);setError('');try{
    await api(`/api/x-watch/posts/${post.id}/bookmark`,{method:'POST',body:{}});await refresh();setSelected(current=>current?.id===post.id?{...current,bookmarked:true}:current);
    window.dispatchEvent(new Event('omnihub:collection-updated'));
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  async function retry(post){setBusy(true);setError('');try{
    await api(`/api/x-watch/posts/${post.id}/retry`,{method:'POST',body:{}});await refresh();
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  const matches=p=>(!group||p.groups.includes(group))&&`${p.content} ${p.analysis?.title||''} ${p.analysis?.summary||''} ${p.author}`.toLowerCase().includes(query.toLowerCase());
  const items=posts.filter(matches),events=hot.filter(h=>h.items.some(matches));
  const enabled=state?.accounts.filter(a=>a.enabled)||[];
  const pageReserve=state?.pageReserveUsd??0.04;
  const requestLimitMissing=!!(state&&enabled.length&&!state.dailyRequests);
  const requestLimitReached=!!(state&&state.dailyRequests>0&&state.requestsToday>=state.dailyRequests);
  const dailyBudgetReached=!!(state&&(state.budgetRemaining??0)<pageReserve);
  const monthlyBudgetReached=!!(state&&(state.monthlyBudgetRemainingUsd??0)<pageReserve);
  const collectionBlocked=!!(state&&(state.costUncertain||requestLimitMissing||requestLimitReached||dailyBudgetReached||monthlyBudgetReached));
  const collectionMessage=!state?'':!state.accounts.length?'还没有添加监听账号':!enabled.length?'账号已添加，但尚未启用采集':!state.available?'服务器采集服务尚未启用':state.costUncertain?'上游费用无法核对，已停止自动采集 24 小时':requestLimitMissing?'尚未设置 24 小时请求上限，已暂停采集':requestLimitReached?`已达到 24 小时请求上限 ${state.requestsToday}/${state.dailyRequests}，等待额度释放`:dailyBudgetReached?'24 小时采集费用预算不足，已暂停请求':monthlyBudgetReached?'31 天 SocialData 费用上限不足，已暂停请求':enabled.some(a=>a.errorCode)?'部分账号采集失败，服务器会自动重试':'正在监听，首次读取最近 7 天的公开帖子';
  return <section className="watch-view">
    <div className="watch-heading"><div><h2>{mode==='hot'?'关注热点':'监听动态'}</h2><p>{mode==='hot'?'仅统计关注范围内最近 48 小时的事件；热度与可信程度分开。':'这里是保存到你服务器的帖子。仅你可见，不会自动变成个人收藏。'}</p></div>
      <div className="watch-heading-actions"><button className="btn" onClick={onManage}>管理监听</button><button className="btn" title="读取服务器上已保存的帖子，不产生采集费用" disabled={busy} onClick={()=>refresh().catch(e=>setError(e.message))}>刷新动态</button></div></div>
    {error&&<p role="alert" className="classification-error">{error}</p>}
    {!state&&!error&&<p role="status">正在读取关注设置…</p>}
    {state&&<div className="watch-settings-status"><span>{enabled.length} 个账号监听中 · 已保存 {state.savedPosts??posts.length} 条帖子{posts.length>=300?'（展示最近 300 条）':''}</span>
      <details className="watch-runtime-details"><summary>{collectionMessage} · 运行详情</summary>
      <p>24 小时预估用量 ${(state.estimatedCostUsd||0).toFixed(4)} / ${(state.dailyBudgetUsd||0).toFixed(2)} · 请求 {state.requestsToday} / {state.dailyRequests} · 31 天 SocialData ${(state.monthlyEstimatedCostUsd||0).toFixed(4)} / ${(state.monthlyBudgetUsd||0).toFixed(2)}</p>
      <p>中文整理：{state.analysisEnabled?'已启用，采集后会生成中文标题、摘要与聚簇':'尚未启用；当前只保存原帖，中文标题、摘要与热点聚簇不会生成'}</p>
      {state.mediaStorage&&<p>服务器媒体：{state.mediaStorage.ready} 个已保存{state.mediaStorage.pending?` · ${state.mediaStorage.pending} 个待保存`:''}{state.mediaStorage.failed?` · ${state.mediaStorage.failed} 个失败或超出限制`:''} · 图片上限 10 MB，视频 64 MB，媒体总量 2 GB；不会删除旧文件。
        {state.mediaStorage.failed>0&&<button className="watch-text-button" disabled={busy} onClick={async()=>{setBusy(true);try{await api('/api/x-watch/media/retry',{method:'POST',body:{}});await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}}>重试下载失败的媒体</button>}</p>}</details></div>}
    <label className="watch-filter">账号分组 <select value={group} onChange={e=>setGroup(e.target.value)}><option value="">全部分组</option>
      {[...new Set(state?.accounts.map(a=>a.group)||[])].map(name=><option key={name}>{name}</option>)}</select></label>
    {mode==='hot'?events.map(event=><article className="watch-post" key={event.id}><h3>{event.title}</h3><p>{event.summary}</p>
      <small>{event.participants} 个来源账号参与讨论 · 热度 {event.heat.toFixed(1)}，不代表可信度</small>
      <details><summary>查看事件帖子 · {event.items.length}</summary>{event.items.map(post=><button className="watch-open" key={post.id} onClick={()=>setSelected(post)}>@{post.author} · {post.analysis.title}</button>)}</details>
    </article>):items.map(post=><article className="watch-post" key={post.id}>
      <div className="watch-caption">@{post.author} · {new Date(post.publishedAt).toLocaleString('zh-CN')} · {post.analysis?'已中文整理':post.analysisState==='review'?'材料待复核':'原文已保存，待整理'}</div>
      <button className="watch-open" onClick={()=>setSelected(post)}><h3>{post.analysis?.title||post.title||'原帖媒体'}</h3><p>{post.analysis?.summary||post.content.slice(0,240)}</p></button>
      <button className="btn btn-ghost" disabled={busy||post.bookmarked} onClick={()=>bookmark(post)}>{post.bookmarked?'已在我的收藏':'收藏并整理'}</button>
      {['review','error'].includes(post.analysisState)&&<button className="btn btn-ghost" disabled={busy||!state?.analysisEnabled} onClick={()=>retry(post)}>重新整理</button>}
    </article>)}
    {state&&(mode==='hot'?events:items).length===0&&<div className="watch-empty"><h3>{mode==='hot'?'还没有符合条件的热点':posts.length?'没有匹配的帖子':collectionMessage}</h3>
      <p>{mode==='hot'?'至少两个不同来源账号参与同一事件，并完成整理，才进入这里。':posts.length?'试试其他分组或搜索词。':!enabled.length?'进入「监听账号 → 已添加 → 设置」，填写预算并启用账号。只添加名单不会开始扣费或抓取帖子。':collectionBlocked?(requestLimitReached?'24 小时滚动请求额度释放后会自动继续；已保存的内容不受影响。':'请检查运行详情中的限制；已保存的内容不受影响。'):'服务器每分钟检查采集任务。最近 7 天没有公开帖子时，这里也会为空；后续新帖会按设定间隔保存。'}</p>
      {mode!=='hot'&&<button className="btn" onClick={onManage}>设置监听账号</button>}</div>}
    {active&&selected&&<WatchPostDetail post={selected} onClose={()=>setSelected(null)} onBookmark={bookmark} busy={busy} error={error}/>}
  </section>;
}

function readFeedMode() {
  const value=new URLSearchParams(window.location.hash.split('?')[1]||'').get('view');
  return ['following','hot','accounts'].includes(value)?value:'aihot';
}
function writeFeedMode(value) {
  const params=new URLSearchParams(window.location.hash.split('?')[1]||'');
  if(value==='aihot')params.delete('view');else params.set('view',value);
  window.location.hash=`#feed${params.size?`?${params}`:''}`;
}
function FeedView(props) {
  const {mode,onModeChange}=props;
  useAppEffect(()=>{const changed=()=>{if(window.location.hash.split('?')[0]==='#feed')onModeChange(readFeedMode());};
    changed();window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[onModeChange,props.active]);
  const setMode=value=>{
    onModeChange(value);
    writeFeedMode(value);
  };
  return <div><div className="watch-tabs" aria-label="资讯与监听视图">
    {(props.canUseMonitoring?[['aihot','AIHOT 资讯'],['following','监听动态'],['hot','关注热点'],['accounts','监听账号']]:[['aihot','AIHOT 资讯']]).map(([key,label])=>
      <button key={key} className="btn btn-ghost" aria-pressed={mode===key} onClick={()=>setMode(key)}>{label}</button>)}
  </div>
    <WorkspacePanel active={props.active && (mode==='aihot'||!props.canUseMonitoring)}>
      <AihotFeedView {...props} active={props.active && (mode==='aihot'||!props.canUseMonitoring)}/>
    </WorkspacePanel>
    {props.canUseMonitoring && <WorkspacePanel active={props.active && mode==='accounts'}><XWatchAccountsView active={props.active && mode==='accounts'}/></WorkspacePanel>}
    {props.canUseMonitoring && <WorkspacePanel active={props.active && ['following','hot'].includes(mode)}><XWatchView active={props.active && ['following','hot'].includes(mode)} mode={mode} query={props.query} onManage={()=>setMode('accounts')}/></WorkspacePanel>}
  </div>;
}

function FeedEvent({ event, onPreview, onSave, rank, showRank }) {
  return <section className="feed-event">
    <FeedItem item={event.item} rank={rank} showRank={showRank} onPreview={onPreview} onSave={onSave} />
    {event.related.length > 0 && <details className="feed-event-related">
      <summary>同一事件 · 共 {event.related.length + 1} 篇报道，查看补充内容</summary>
      {event.related.map(({item, supplement}, index) => <div key={`${item.url}:${index}`} className="feed-event-report">
        {supplement.length > 0 && <div className="feed-event-supplement"><strong>这篇报道的补充</strong><p>{supplement.join(' ')}</p></div>}
        <FeedItem item={item} showRank={false} onPreview={onPreview} onSave={onSave} />
      </div>)}
    </details>}
  </section>;
}

/** AIHOT retains its upstream editorial decisions; only explicitly saved items enter the personal queue. */
function AihotFeedView({ active = true, query, onSaveToInbox, onCorrectClassification }) {
  const [sources, setSources] = useAppState([]);
  const [activeSource, setActiveSource] = useAppState("");
  const [sourceInfo, setSourceInfo] = useAppState(null);
  const [itemsBySource, setItemsBySource] = useAppState({});
  const [catFilter, setCatFilter] = useAppState("");
  const [sourcesStatus, setSourcesStatus] = useAppState("loading"); // loading | ok | error
  const [statusBySource, setStatusBySource] = useAppState({});
  const [loadingSource, setLoadingSource] = useAppState("");
  const [errMsg, setErrMsg] = useAppState("");
  const [preview, setPreview] = useAppState(null); // 图片放大预览的 src
  const [groupEvents, setGroupEvents] = useAppState(true);
  useAppEffect(() => { if (!active) setPreview(null); }, [active]);
  const [showRefreshIndicator, setShowRefreshIndicator] = useAppState(false);
  const [refreshIndicatorClosing, setRefreshIndicatorClosing] = useAppState(false);
  const [refreshCollapseProgress, setRefreshCollapseProgress] = useAppState(0);

  useAppEffect(() => {
    api("/api/feed/sources")
      .then((list) => {
        setSources(list);
        setSourcesStatus("ok");
        if (list.length) { setActiveSource(list[0].id); setSourceInfo(list[0]); }
      })
      .catch((err) => { setErrMsg(err.message); setSourcesStatus("error"); });
  }, []);

  function load(id) {
    if (!id) return;
    const startedAt = Date.now();
    setErrMsg("");
    setLoadingSource(id);
    setStatusBySource((prev) => ({
      ...prev,
      [id]: itemsBySource[id] ? "refreshing" : "loading",
    }));
    function finish(update) {
      const wait = Math.max(0, MIN_FEED_LOADING_MS - (Date.now() - startedAt));
      window.setTimeout(() => {
        update();
        setLoadingSource((current) => current === id ? "" : current);
      }, wait);
    }
    api("/api/feed/" + id)
      .then((data) => {
        finish(() => {
          setItemsBySource((prev) => ({ ...prev, [id]: data }));
          setStatusBySource((prev) => ({ ...prev, [id]: "ok" }));
        });
      })
      .catch((err) => {
        finish(() => {
          setErrMsg(err.message);
          setStatusBySource((prev) => ({ ...prev, [id]: "error" }));
        });
      });
  }

  useAppEffect(() => {
    if (!activeSource) return;
    if (itemsBySource[activeSource]) return;
    load(activeSource);
  }, [activeSource]);

  const items = activeSource ? (itemsBySource[activeSource] || []) : [];
  const sourceStatus = activeSource ? (statusBySource[activeSource] || "loading") : sourcesStatus;
  const isLoading = sourcesStatus === "loading" || sourceStatus === "loading" || loadingSource === activeSource;
  const hasCachedItems = items.length > 0;
  const refreshIsActive = isLoading && hasCachedItems;
  const shouldShowRefreshIndicator = refreshIsActive || showRefreshIndicator;
  const rich = Boolean(sourceInfo && sourceInfo.rich);
  const q = query.toLowerCase();
  let visible = items.filter((it) => !q
    || it.title.toLowerCase().includes(q) || (it.summary || "").toLowerCase().includes(q));
  if (rich && catFilter) visible = visible.filter((it) => (it.tags || []).includes(catFilter));
  if (rich) visible = sortByTimeThenScore(visible);

  useAppEffect(() => {
    if (!hasCachedItems) {
      setShowRefreshIndicator(false);
      setRefreshIndicatorClosing(false);
      setRefreshCollapseProgress(0);
      return;
    }
    if (refreshIsActive) {
      setShowRefreshIndicator(true);
      setRefreshIndicatorClosing(false);
      setRefreshCollapseProgress(0);
      return;
    }
    if (!showRefreshIndicator) return;
    setRefreshIndicatorClosing(true);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / REFRESH_COLLAPSE_MS);
      setRefreshCollapseProgress(progress);
      if (progress < 1) {
        return;
      }
      window.clearInterval(timer);
      setShowRefreshIndicator(false);
      setRefreshIndicatorClosing(false);
      setRefreshCollapseProgress(0);
    }, 16);
    return () => clearInterval(timer);
  }, [hasCachedItems, refreshIsActive, showRefreshIndicator]);

  const hot = rich
    ? [...items].filter((it) => typeof it.score === "number").sort((a, b) => b.score - a.score).slice(0, 10)
    : [];
  const topTags = rich ? (() => {
    const counts = {};
    items.forEach((it) => (it.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
  })() : [];
  const events = groupEvents ? groupFeedEvents(visible) : visible.map(item => ({item, related:[]}));
  const groups = rich ? groupByDate(events.map(event => ({...event.item, event}))) : null;

  function switchSource(s) {
    setActiveSource(s.id); setSourceInfo(s); setCatFilter("");
  }

  return (
    <div className="aihot-feed">
      <div className="feed-toolbar">
        <button className="btn" aria-pressed={groupEvents} onClick={() => setGroupEvents(value => !value)}>
          {groupEvents ? `按事件聚合 · ${events.length} 组 / ${visible.length} 篇` : `原始报道 · ${visible.length} 篇`}
        </button>
        <div className="filter-bar">
          {rich && topTags.length > 0 && (
            <PillTabs activeKey={catFilter} pillVariant="chip">
              {["", ...topTags].map((t) => (
                <button key={t || "all"} className={"filter-chip" + (catFilter === t ? " active" : "")}
                  onClick={() => setCatFilter(t)}>{t || "全部"}</button>
              ))}
            </PillTabs>
          )}
        </div>
        <button className="btn feed-refresh" onClick={() => activeSource && load(activeSource)} disabled={isLoading}>
          <IconRefresh /><BlurText value={isLoading && hasCachedItems ? "刷新中" : "刷新"} />
        </button>
      </div>
      {sources.length > 1 && (
        <PillTabs activeKey={activeSource} className="feed-sources">
          {sources.map((s) => (
            <button key={s.id} title={s.desc}
              className={"feed-source" + (activeSource === s.id ? " active" : "")}
              onClick={() => switchSource(s)}>
              {s.name}<span className="src-cat">{s.category}</span>
            </button>
          ))}
        </PillTabs>
      )}
      <div className={"feed-layout" + (isLoading && !hasCachedItems ? " feed-layout-loading" : "")}>
        <div className={"feed-list" + (isLoading && !hasCachedItems ? " feed-list-loading" : "")}
          role="region" aria-label="资讯列表" tabIndex={0}>
          {isLoading && !hasCachedItems && (
            <FeedSkeleton count={6} />
          )}
          {shouldShowRefreshIndicator && hasCachedItems && (
            <div
              className={"feed-refresh-banner" + (refreshIndicatorClosing ? " closing" : "")}
              style={{
                height: 70 * (1 - refreshCollapseProgress),
                paddingTop: 6 * (1 - refreshCollapseProgress),
                paddingBottom: 6 * (1 - refreshCollapseProgress),
                marginBottom: -7 * refreshCollapseProgress,
                opacity: 1 - refreshCollapseProgress,
                transform: `scale(${1 - 0.28 * refreshCollapseProgress})`,
              }}>
              <RoseFourLoader />
            </div>
          )}
          {sourceStatus === "error" && !hasCachedItems && <EmptyState message={errMsg || "加载失败"} hint="点右上角「刷新」重试" />}
          {sourceStatus === "error" && hasCachedItems && (
            <div className="feed-inline-error">刷新失败，已保留当前内容：{errMsg || "请稍后重试"}</div>
          )}
          {!isLoading && sourceStatus !== "error" && visible.length === 0 && <EmptyState message="暂无内容" />}
          {rich && groups && (
            <div className="feed-content-enter" key={"rich:" + activeSource + ":" + groups.length}>
              {groups.map((g) => (
                <div className="feed-day" key={g.key}>
                  <div className="feed-day-label">{g.label}</div>
                  <div className="timeline">
                    {g.items.map((it, i) => (
                      <div className="tl-row" key={i}>
                        <div className="tl-time">{toHHMM(it.publishedAt)}</div>
                        <div className="tl-rail"><span className="tl-dot" /></div>
                        <FeedEvent event={it.event} showRank={false} onPreview={setPreview} onSave={onSaveToInbox} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!rich && visible.length > 0 && (
            <div className="feed-content-enter" key={"flat:" + activeSource + ":" + visible.length}>
              {events.map((event, idx) => (
                <FeedEvent key={idx} event={event} rank={idx + 1} showRank={true} onPreview={setPreview} onSave={onSaveToInbox} />
              ))}
            </div>
          )}
        </div>
        <div className="feed-side">
          {rich && hot.length > 0 && (
            <div className="hot-card">
              <div className="hot-title">🔥 当前热点</div>
              {hot.map((it, i) => (
                <a className="hot-item" key={i} href={it.url || "#"} target="_blank" rel="noopener noreferrer">
                  <span className={"hot-rank r" + (i + 1)}>{i + 1}</span>
                  <span className="hot-text">{it.title}</span>
                  <span className="hot-score">{it.score}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
      {active && preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// Mount only visited panels. Hidden panels retain filters and scroll, but not media playback.
function WorkspacePanel({ active, name, children }) {
  const [visited, setVisited] = useAppState(active);
  const panel = useAppRef(null);
  const scroll = useAppRef({ top: 0, nested: new Map() });
  useAppEffect(() => { if (active) setVisited(true); }, [active]);
  React.useLayoutEffect(() => {
    if (!active) {
      panel.current?.querySelectorAll('video, audio').forEach(media => media.pause());
      return;
    }
    for (const [element, position] of scroll.current.nested) {
      if (!element.isConnected) { scroll.current.nested.delete(element); continue; }
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
    if (!name) return;
    window.scrollTo({ top: scroll.current.top, behavior: 'instant' });
    const remember = () => { scroll.current.top = window.scrollY; };
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [active, name]);
  if (!active && !visited) return null;
  return <section ref={panel} hidden={!active} inert={active ? undefined : ''} data-workspace-panel={name}
    style={active ? undefined : {display:'none'}} onScrollCapture={event => {
      if (active) scroll.current.nested.set(event.target, {top:event.target.scrollTop, left:event.target.scrollLeft});
    }}>{children}</section>;
}

/** 主界面（登录用户与游客共用；游客 user 为 null） */
/** 专题目录：#topics 显示目录；#life-guide 等专题页由各自脚本渲染到 <main>。 */
function TopicsCatalog({ active }) {
  const [hash, setHash] = useAppState(() => window.location.hash);
  useAppEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('omnihub:route-restored', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('omnihub:route-restored', sync);
    };
  }, []);
  if (!active || workspaceHashName(hash) !== 'topics') return null;
  return <section className="topics-catalog" aria-labelledby="topics-title">
    <div className="topics-head"><h1 id="topics-title">专题</h1><p>围绕一个主题持续整理的专门内容。</p></div>
    <ul className="topics-grid">{TOPIC_REGISTRY.map(topic => <li key={topic.id}>
      <a className="topics-card" href={topicHref(topic, hash)}><strong>{topic.title}</strong><span>{topic.description}</span></a>
    </li>)}</ul>
  </section>;
}

function Workspace({ user, onUserChange, showToast, toast }) {
  const [skin, setSkin] = useAppState(() => loadStored("skin", "minimal"));
  const [theme, setTheme] = useAppState(() => loadStored("theme", "dark"));
  const [section, setSection, sectionHooks] = useWorkspaceSection("repositories");
  const [feedMode, setFeedMode] = useAppState(readFeedMode);
  const [repositories, setRepositories] = useAppState([]);
  const [knowledgeLibrary, setKnowledgeLibrary] = useAppState([]);
  const [promptLibrary, setPromptLibrary] = useAppState([]);
  const [requestedKnowledgeId, setRequestedKnowledgeId] = useAppState(null);
  const [requestedPromptSourceId, setRequestedPromptSourceId] = useAppState(null);
  const [requestedPromptId, setRequestedPromptId] = useAppState(null);
  const [pendingLibraryTarget, setPendingLibraryTarget] = useAppState(null);
  const [chatVisited, setChatVisited] = useAppState(false);
  const [classificationTarget, setClassificationTarget] = useAppState(null);
  const [classificationRevision, setClassificationRevision] = useAppState(0);
  const [favorites, setFavorites] = useAppState([]);
  const [prompts, setPrompts] = useAppState([]);
  const [knowledge, setKnowledge] = useAppState([]);
  const [mediaAssets, setMediaAssets] = useAppState([]);
  const [mediaJobs, setMediaJobs] = useAppState([]);
  const [studioDraft, setStudioDraft] = useAppState(null);
  const [openMediaAssetId, setOpenMediaAssetId] = useAppState("");
  const [mediaConfigVersion, setMediaConfigVersion] = useAppState(0);
  const [inboxItems, setInboxItems] = useAppState([]);
  const [assetTab, setAssetTab] = useAppState("prompts");
  const [dataLoads, setDataLoads] = useAppState({});
  const [moduleCounts, setModuleCounts] = useAppState({});
  const [pendingAssetTarget, setPendingAssetTarget] = useAppState(null);
  const [publicRetryKey, setPublicRetryKey] = useAppState(0);
  const [sectionQueries, setSectionQueries] = useAppState({});
  const queryKey = `${user?.id || 'guest'}:${section}`;
  const query = sectionQueries[queryKey] || '';
  const setQuery = (value, targetSection = section) => {
    const key = `${user?.id || 'guest'}:${targetSection}`;
    setSectionQueries(previous => ({...previous, [key]: typeof value === 'function' ? value(previous[key] || '') : value}));
  };
  const [favCategory, setFavCategory] = useAppState("全部");
  const [promptCategory, setPromptCategory] = useAppState("全部");
  const [modal, setModalState] = useAppState(null); // 收藏、提示词、知识等弹层；设置是 <main> 内的整页路由
  const settingsDirty = React.useRef(false);
  const settingsReturn = React.useRef('');
  // Every legacy settings modal request (sidebar menu, chat, inbox, studio)
  // opens the full-page #settings route on the matching category instead.
  const setModal = value => {
    const target = settingsTargetForModal(value);
    if (!target) return setModalState(value);
    setSection('settings', { params: { category: personalAccess ? target.category : 'appearance', aiTab: personalAccess ? target.aiTab : '' } });
  };
  // Router hooks: dirty settings ask before leaving; an accepted module change
  // (sidebar, link, Back/Forward) closes whatever modal belonged to the old one.
  sectionHooks.canLeave = from => !(from === 'settings' && settingsDirty.current) || confirm('设置有未保存的修改，确定离开吗？');
  sectionHooks.onModuleChange = (to, from) => {
    setModalState(null);
    if (to === 'settings') settingsReturn.current = from;
    if (from === 'settings') { settingsDirty.current = false; setMediaConfigVersion(value => value + 1); }
  };
  const [authOpen, setAuthOpen] = useAppState(false); // 登录/注册弹窗
  const [chatPrefill, setChatPrefill] = useAppState("");
  const [chatMessages, setChatMessages] = useAppState([]);
  const [hasAiConfig, setHasAiConfig] = useAppState(user ? user.hasAiConfig : false);
  const [now, setNow] = useAppState(() => new Date());
  const [quote, setQuote] = useAppState(null);
  const [merit, setMerit] = useAppState(() => Number(localStorage.getItem("omnihub_merit") || 0));
  const [woodFishEnabled, setWoodFishEnabled] = useAppState(() => loadStored("woodFishEnabled", false));
  const [sidebarCollapsed, setSidebarCollapsed] = useAppState(() => window.matchMedia("(max-width: 860px)").matches);
  const [moduleLabels, setModuleLabels] = useAppState(false);
  const [knowledgeNavigation,setKnowledgeNavigation] = useAppState(null);
  const updateKnowledgeNavigation = React.useCallback(navigation => {
    setKnowledgeNavigation(navigation);
    if (navigation && !window.matchMedia('(max-width: 860px)').matches) setSidebarCollapsed(false);
    else if (!navigation && window.matchMedia('(max-width: 860px)').matches) setSidebarCollapsed(true);
  },[]);
  const canUseFullApp = Boolean(user && user.fullAccess);
  useAppEffect(() => {
    if (!user || user?.hasAiConfig != null) return;
    const controller = new AbortController();
    api('/api/ai-config',{signal:controller.signal}).then(config => {
      if (!controller.signal.aborted) setHasAiConfig(Boolean(config.hasKey));
    }).catch(() => {});
    return () => controller.abort();
  }, [user?.id,user?.hasAiConfig,canUseFullApp]);
  const personalAccess = Boolean(user && user.personalAccess !== false);
  const catalogueScope = window.omnihubCatalogueScope?.() || 'public';
  const personalCatalogue = personalAccess && catalogueScope === 'mine';
  const [dataCache] = useAppState(() => createWorkspaceDataCache({ request: api, fullAccess: canUseFullApp, personalAccess,
    onChange: (name, state, results) => {
      if (results) {
        const setters = { knowledgeLibrary: setKnowledgeLibrary, promptLibrary: setPromptLibrary,
          inbox: setInboxItems, favorites: setFavorites, prompts: setPrompts, knowledge: setKnowledge,
          mediaAssets: setMediaAssets, mediaJobs: setMediaJobs };
        for (const [key, rows] of results) setters[key](rows);
        setModuleCounts(previous => ({...previous, ...Object.fromEntries(results.map(([key, rows]) => [key, rows.length]))}));
      }
      if (name) setDataLoads(previous => ({...previous, [name]: state}));
    },
  }));
  const dataLoad = dataLoads[section] || { status: 'idle', hasData: false, error: null };
  const sectionNeedsData = (personalAccess
    ? workspaceDataRequests(section, canUseFullApp, personalAccess)
    : workspaceDataRequests(section, canUseFullApp)).length > 0;
  const sectionDataReady = !sectionNeedsData || dataLoad.hasData;
  const queryFor = name => sectionQueries[`${user?.id || 'guest'}:${name}`] || '';
  const collectionCounts = {repositories:repositories.length, knowledgeLibrary:knowledgeLibrary.length,
    promptLibrary:promptLibrary.length, inbox:inboxItems.length, favorites:favorites.length,
    prompts:prompts.length, knowledge:knowledge.length, mediaAssets:mediaAssets.length, mediaJobs:mediaJobs.length};
  const visibleModuleCounts = Object.fromEntries(Object.keys(moduleCounts).map(key => [key, collectionCounts[key]]));
  const onCorrectClassification = personalCatalogue ? setClassificationTarget : undefined;
  const openMethod = id => { setSectionQueries(previous => ({...previous,[`${user?.id || 'guest'}:knowledgeLibrary`]:''})); setRequestedKnowledgeId(id); setSection('knowledgeLibrary'); };

  useAppEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    document.documentElement.setAttribute("data-theme", theme);
    saveStored("skin", skin);
    saveStored("theme", theme);
  }, [skin, theme]);

  useAppEffect(() => {
    const raw = window.location.hash.slice(1);
    const [currentSection, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    // A copied personal-space URL never grants an anonymous visitor access.
    // Repair it to the public catalogue before guest rendering can reuse it.
    if (!personalAccess && catalogueScope === 'mine') {
      params.set('space', 'public');
      history.replaceState(null, '', `${location.pathname}${location.search}#${currentSection || 'repositories'}?${params.toString()}`);
      window.location.reload();
      return;
    }
    if (!personalAccess || catalogueScope === 'mine') return;
    // A signed-in person lands in their own workspace first. Visitors keep the
    // public catalogue and do not get a personal URL or private prefetch.
    if (params.has('space')) return;
    // Signing in while browsing knowledge must keep the public article available.
    if (currentSection === 'knowledgeLibrary') return;
    params.set('space', 'mine');
    history.replaceState(null, '', `${location.pathname}${location.search}#${currentSection || 'repositories'}?${params.toString()}`);
    window.location.reload();
  }, [personalAccess, catalogueScope]);

  useAppEffect(() => {
    saveStored("woodFishEnabled", woodFishEnabled);
  }, [woodFishEnabled]);

  useAppEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const collapseForMobile = (event) => {
      setSidebarCollapsed(event.matches);
      if (event.matches) setModuleLabels(false);
    };
    collapseForMobile(media);
    media.addEventListener("change", collapseForMobile);
    return () => media.removeEventListener("change", collapseForMobile);
  }, []);

  const retryPublicInbox = () => setPublicRetryKey((key) => key + 1);
  useAppEffect(()=>{
    const changed=()=>{ dataCache.invalidate(); setPublicRetryKey(key=>key+1); };
    window.addEventListener('omnihub:collection-updated',changed);
    return ()=>window.removeEventListener('omnihub:collection-updated',changed);
  },[dataCache]);

  useAppEffect(() => () => dataCache.dispose(), [dataCache]);
  useAppEffect(() => { dataCache.invalidate(); }, [dataCache, classificationRevision, publicRetryKey]);
  useAppEffect(() => { dataCache.load(section); }, [dataCache, section, classificationRevision, publicRetryKey]);

  useAppEffect(() => {
    if (!personalAccess || !['studio', 'works'].includes(section)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      const routes = section === 'studio' ? ['/api/media/jobs', '/api/media/assets'] : ['/api/media/assets'];
      const requestVersion = dataCache.beginUpdate();
      Promise.all(routes.map(route => api(route, {signal:controller.signal}))).then(rows => {
        if (controller.signal.aborted) return;
        dataCache.applyCollections(section === 'studio' ? [['mediaJobs', rows[0]], ['mediaAssets', rows[1]]] : [['mediaAssets', rows[0]]], requestVersion);
      }).catch(() => {});
    }, 15000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [personalAccess, section]);

  function reloadMediaAssets() {
    const requestVersion = dataCache.beginUpdate();
    return api("/api/media/assets").then((rows) => { dataCache.applyCollections([['mediaAssets', rows]], requestVersion); return rows; });
  }
  function reloadMediaJobs() {
    const requestVersion = dataCache.beginUpdate();
    return api("/api/media/jobs").then((rows) => { dataCache.applyCollections([['mediaJobs', rows]], requestVersion); return rows; });
  }
  function openStudio(next = {}) {
    if (studioDraftHasContent(readStudioDraft(user?.id)) && !confirm('创作台还有一份草稿。用这次内容替换它吗？')) return;
    setStudioDraft({ ...next, key: crypto.randomUUID() });
    setModal(null);
    setSection("studio");
    setQuery("", "studio");
  }
  function createFromPrompt(prompt) {
    if (!prompt.templateFilled && promptTemplateNames(prompt.text).length) { setModal({type:'prompt-use',item:prompt,origin:'manual'}); return; }
    if (!promptCreationModule(prompt)) { tryRunPrompt(prompt); return; }
    openStudio({
      sourceType: "prompt", sourceId: prompt.manualAssetId || prompt.id, title: prompt.title,
      targetModule:promptCreationModule(prompt),
      prompt: prompt.promptTextClean || prompt.promptTextRaw || prompt.text || "",
      image: prompt.image, media: prompt.media, url: prompt.sourceUrl || prompt.snsUrl || "",
    });
  }
  function createFromLibraryPrompt(item) {
    if (!item.templateFilled && promptTemplateNames(item.text).length) { setModal({type:'prompt-use',item,origin:'library'}); return; }
    if (item.manualAssetId) { createFromPrompt(item); return; }
    const sourceId = Number(item.sourceInboxId);
    const linked = canUseFullApp && Number.isSafeInteger(sourceId) && sourceId > 0;
    openStudio({
      sourceType: linked ? 'inbox' : '', sourceId: linked ? sourceId : null,
      title: item.title, prompt: item.text || '', media: item.media,
      url: item.sourceUrl || '', targetModule: canUseFullApp && item.category === '视频生成' ? 'seedance' : 'image',
    });
  }
  function createFromInbox(item) {
    openStudio({
      sourceType: "inbox", sourceId: item.id, title: item.title,
      prompt: item.content || "", media: item.media, url: item.url || "",
    });
  }
  function continueFromMedia(asset, targetModule = "seedance", job = null) {
    const reuseJob = Boolean(job && job.module === targetModule);
    const args = reuseJob && job?.args && typeof job.args === 'object' ? job.args : {};
    const module = targetModule || job?.module || "image";
    const mode = (reuseJob && (job?.mode || args.mode)) || (module === "image" ? "image" : asset.kind === "image" ? "first_last_frame" : "reference_images");
    openStudio({
      title: asset.title, prompt: asset.prompt || "",
      sourceType: asset.sourceType, sourceId: asset.sourceId,
      parentAssetId: asset.id, referenceAssetId: asset.id,
      targetModule: module, targetMode: mode, model: reuseJob ? (job?.model || asset.model || '') : '',
      generationArgs: args, sourceJobId: job?.id || null,
    });
  }
  function showMediaAsset(id) {
    setOpenMediaAssetId(id);
    setSection("works");
    setQuery("", "works");
  }

  useAppEffect(() => {
    const accountParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
    if (personalAccess && accountParams.get('account') === 'x') {
      // X OAuth returns here: land on 数据同步 (keeping `result`) without a new history entry.
      accountParams.delete('account'); accountParams.set('category', 'sync');
      window.location.replace(`#settings?${accountParams}`);
      return;
    }
    if (!canUseFullApp && !["repositories", "knowledgeLibrary", "promptLibrary", "feed", "topics", "tools", "settings", ...(personalAccess ? ["inbox", "studio", "works", "chat"] : [])].includes(section)) {
      setSection("repositories");
      setQuery("", "repositories");
    }
  }, [canUseFullApp, personalAccess, section]);

  function handleRepositoryUpdated(updated) {
    setRepositories((items) => items.map((item) => item.key === updated.key
      ? { ...item, personalStatus: updated.personalStatus } : item));
  }

  function openKnowledgeArticle(id) {
    setRequestedKnowledgeId(id);
    setSection("knowledgeLibrary");
    setQuery("", "knowledgeLibrary");
  }

  useAppEffect(() => {
    // 不再显示时分，每 10 分钟刷新一次足够跨过日期与问候语的变化点
    const timer = setInterval(() => setNow(new Date()), 600000);
    return () => clearInterval(timer);
  }, []);

  /** 取一句好话（首次进入与木鱼每敲 10 次时换句；侧边栏一言卡片展示） */
  function pickQuote() {
    fetch("https://v1.hitokoto.cn/?c=d&c=i&c=k")
      .then((r) => r.json())
      .then((j) => setQuote({ text: j.hitokoto, from: j.from || "一言" }))
      .catch(() => setQuote(FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)]));
  }
  useAppEffect(() => { pickQuote(); }, []);

  /** 敲木鱼：功德 +1（本地累计持久化）；每 10 次换一句好话 */
  function knockWoodFish() {
    setMerit((m) => {
      const next = m + 1;
      try { localStorage.setItem("omnihub_merit", String(next)); } catch (err) { /* 忽略 */ }
      if (next % 10 === 0) pickQuote();
      return next;
    });
  }

  function copyPrompt(text) {
    navigator.clipboard.writeText(text)
      .then(() => showToast("提示词已复制"))
      .catch(() => showToast("复制失败，请手动选择"));
  }

  function addPendingInboxItem(item) {
    if (!item || item.status !== "pending") return;
    setInboxItems((prev) => prev.some((row) => row.id === item.id) ? prev : [item, ...prev]);
  }

  function captureInbox(value) {
    return api("/api/inbox", { method: "POST", body: { content: value, source: "manual" } })
      .then((item) => {
        addPendingInboxItem(item);
        showToast(item.created
          ? (item.analysisUnavailable ? "已收录，TypeSafe 暂未完成判断" : "已放进收件箱")
          : "这条内容已经收录过了");
        return item;
      })
      .catch((err) => { showToast(err.message); throw err; });
  }

  async function importXBookmarks(text) {
    let records = null;
    let coverage = "";
    try {
      const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      const coverages = new Set(rows.map((row) => row?.organization?.coverage));
      if (rows.length && coverages.size === 1 && rows.every((row) => row && row.externalId)) {
        coverage = rows[0].organization.coverage;
        if (["complete", "partial_ui_scan", "partial_xarchive_scan"].includes(coverage)) records = rows;
      }
    } catch { /* Only the organizer's one-record-per-line result is accepted here. */ }
    if (!records) throw new Error("请选择已分类的 X 收藏文件；历史快照不能导入");
    const result = { imported: 0, updated: 0, skipped: 0, total: 0, coverage };
    const batches = [];
    {
      let current = [];
      for (const row of records) {
        const line = JSON.stringify(row);
        if (new TextEncoder().encode(JSON.stringify({ text: line })).length > 4 * 1024 * 1024) {
          throw new Error("单条 X 收藏过大，无法导入");
        }
        const next = [...current, line];
        const payload = next.join("\n");
        if (current.length && (current.length >= 200 || new TextEncoder().encode(JSON.stringify({ text: payload })).length > 4 * 1024 * 1024)) {
          batches.push(current.join("\n"));
          current = [line];
        } else current = next;
      }
      if (current.length) batches.push(current.join("\n"));
    }
    for (const batch of batches) {
      let part;
      try { part = await api("/api/inbox/import/x", { method: "POST", body: {
        text: batch, allowPartial: coverage !== "complete",
      } }); }
      catch (error) {
        if (result.total > 0) {
          setInboxItems(await api("/api/inbox/list"));
          throw new Error(`导入中断，已处理 ${result.total} 条；重传会跳过重复内容并补全已有记录。${error.message}`);
        }
        throw error;
      }
      result.imported += part.imported;
      result.updated += part.updated || 0;
      result.skipped += part.skipped;
      result.total += part.total;
    }
    setInboxItems(await api("/api/inbox/list"));
    return result;
  }

  function analyzeInbox(id) {
    return api(`/api/inbox/${id}/analyze`, { method: "POST" })
      .then((item) => {
        setInboxItems((prev) => prev.map((row) => row.id === id ? item : row));
        showToast(item.aiType ? `TypeSafe 建议存为${INBOX_TYPE_LABELS[item.aiType]}` : "TypeSafe 未能明确判断，请手动选择");
        return item;
      })
      .catch((err) => { showToast(err.message); throw err; });
  }

  function setInboxVisibility(id, visibility) {
    return api(`/api/inbox/${id}/visibility`, { method: "PUT", body: { visibility } })
      .then((item) => {
        setInboxItems((prev) => prev.map((row) => row.id === id ? item : row));
        showToast(visibility === "public" ? "已公开这条收藏" : "已设为仅 zane 可见");
        return item;
      })
      .catch((err) => { showToast(err.message); throw err; });
  }

  function saveFeedToInbox(item) {
    return api("/api/inbox", {
      method: "POST",
      body: {
        source: "feed",
        externalId: item.url || `${item.title}:${item.publishedAt || ""}`,
        title: item.title,
        url: item.url,
        content: item.summary || item.reason || item.title,
        author: item.origin || "",
        media: item.images || [],
        links: item.url ? [item.url] : [],
        metrics: { score: item.score, duplicateCount: item.duplicateCount || 0 },
      },
    }).then((created) => {
      addPendingInboxItem(created);
      showToast(created.created
        ? (created.analysisUnavailable ? "已收录，TypeSafe 暂未完成判断" : "已存入收件箱")
        : "这条资讯已经收录过了");
      return created;
    }).catch((err) => showToast(err.message));
  }

  function ignoreInbox(id) {
    return api(`/api/inbox/${id}/ignore`, { method: "POST", body: {} })
      .then(() => {
        setInboxItems((prev) => prev.filter((item) => item.id !== id));
        showToast("已忽略，原始记录仍然保留");
      })
      .catch((err) => { showToast(err.message); throw err; });
  }

  function jumpToAsset(targetType, targetId) {
    if (targetType === 'prompt' || targetType === 'knowledge') {
      const nextSection = targetType === 'prompt' ? 'promptLibrary' : 'knowledgeLibrary';
      const id = `manual-${targetType}-${targetId}`;
      const switchScope = window.omnihubCatalogueScope() !== 'mine';
      setPendingLibraryTarget({type:targetType,id});
      // Push a new entry (never replace) so Back returns to the conversation that
      // saved it. Forced: the save itself already closed the editing drawer.
      setSection(nextSection, { force: true, ...(switchScope ? { params: { space: 'mine' } } : {}) });
      if (switchScope) { dataCache.invalidate(); setKnowledgeLibrary([]); setPromptLibrary([]); setDataLoads({}); }
      setQuery('',nextSection); setPublicRetryKey(key => key + 1);
      return;
    }
    if (targetType === 'resource') {
      setSection('resources');
      setQuery('', 'resources');
      setPendingAssetTarget(`asset-resource-${targetId}`);
    }
  }

  useAppEffect(() => {
    if (section !== 'resources' || !sectionDataReady || !pendingAssetTarget) return;
    document.getElementById(pendingAssetTarget)?.scrollIntoView({behavior:'smooth', block:'center'});
    setPendingAssetTarget(null);
  }, [section, sectionDataReady, pendingAssetTarget, assetTab]);

  useAppEffect(() => {
    if (!pendingLibraryTarget) return;
    const {type,id} = pendingLibraryTarget;
    const rows = type === 'prompt' ? promptLibrary : knowledgeLibrary;
    if (!rows.some(item => item.id === id)) return;
    if (type === 'prompt') setRequestedPromptId(id); else setRequestedKnowledgeId(id);
    setPendingLibraryTarget(null);
  }, [pendingLibraryTarget,promptLibrary,knowledgeLibrary]);

  async function editLibraryPrompt(item) {
    try {
      const rows = await api('/api/prompts');
      const prompt = rows.find(row => row.id === item.manualAssetId);
      if (!prompt) throw new Error('这条提示词已不存在，请刷新列表。');
      setModal({type:'drawer',prompt,mode:'edit',returnLibrary:true});
    } catch(error) { showToast(error.message); }
  }
  async function editLibraryKnowledge(item) {
    try { setModal({type:'knowledge',item:await api(`/api/knowledge/${item.manualAssetId}`),returnLibrary:true}); }
    catch(error) { showToast(error.message); }
  }
  function saveChatResult(message, index, targetType) {
    const title = message.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0,80) || '提炼结果';
    const rawSaved = message.save?.existingAsset ?? message.savedAssets?.[targetType];
    const savedId = rawSaved && typeof rawSaved === 'object' ? rawSaved.id : rawSaved;
    const sourceUrl = message.source?.url || '';
    const provenance = {sourceUrl,sourceAuthor:message.source?.author || '',sourceContent:message.source?.content || ''};
    const tags = Array.isArray(message.classification?.tags) ? message.classification.tags.join(',') : '';
    const fallbackSnapshot = {content:message.content,source:message.source ? {id:message.source.id || null,url:sourceUrl} : null,
      classification:{category:message.classification?.category || '',tags}};
    const snapshot = message.saveSnapshot || fallbackSnapshot;
    const previous = message.save?.previous || message.savedSnapshots?.[targetType];
    if (savedId && previous && JSON.stringify(previous) === JSON.stringify(snapshot)) { jumpToAsset(targetType,savedId); return; }
    const existing = targetType === 'prompt' ? prompts.find(item => item.id === savedId) : knowledge.find(item => item.id === savedId);
    if (savedId && !existing) { showToast('原保存记录已不存在，请刷新后重试。'); return; }
    setModal(targetType === 'prompt'
      ? {type:'drawer',prompt:existing || null,initialForm:{title,text:message.content,category:message.classification?.category || existing?.category || '学习',tags,...provenance,snsUrl:sourceUrl,...(message.source?.id ? {sourceInboxId:message.source.id} : {}),note:'AI 提炼结果，需结合原文核对。'},mode:existing ? 'edit' : 'create',chatIndex:index,chatSaveSnapshot:snapshot,returnLibrary:true}
      : {type:'knowledge',item:existing || null,initialForm:{title,body:message.content,summary:existing?.summary || '',tags,...provenance},chatIndex:index,chatSaveSnapshot:snapshot,returnLibrary:true});
  }
  function recordChatSave(targetType,id,snapshot) {
    if (modal?.chatIndex == null) return;
    setChatMessages(rows => rows.map((row,index) => index === modal.chatIndex ? {...row,savedAssets:{...row.savedAssets,[targetType]:{id}},savedSnapshots:{...row.savedSnapshots,[targetType]:snapshot || row.savedSnapshots?.[targetType]}} : row));
  }
  useAppEffect(() => {
    if (section === 'chat' && personalAccess) { setChatVisited(true); dataCache.load('inbox'); }
  }, [section,personalAccess,dataCache]);

  function dispatchInbox(id, targetType, data) {
    return api(`/api/inbox/${id}/dispatch`, { method: "POST", body: { targetType, data } })
      .then((result) => {
        setInboxItems((prev) => prev.filter((item) => item.id !== id));
        if (targetType === "prompt") setPrompts((prev) => [result.target, ...prev.filter(item => item.id !== result.targetId)]);
        else if (targetType === "resource") setFavorites((prev) => [result.target, ...prev.filter(item => item.id !== result.targetId)]);
        else setKnowledge((prev) => [result.target, ...prev.filter(item => item.id !== result.targetId)]);
        showToast(`已存为${INBOX_TYPE_LABELS[targetType]}`);
        jumpToAsset(targetType, result.targetId);
        return result;
      })
      .catch((err) => { showToast(err.message); throw err; });
  }

  function saveKnowledge(form, id) {
    const request = id
      ? api(`/api/knowledge/${id}`, { method: "PUT", body: form })
      : api("/api/knowledge", { method: "POST", body: form });
    return request.then((saved) => {
      setKnowledge((prev) => id
        ? prev.map((item) => item.id === id ? saved : item)
        : [saved, ...prev]);
      setModal(null);
      recordChatSave('knowledge',saved.id,modal?.chatSaveSnapshot);
      showToast(id ? "知识库文章已更新" : "已保存到知识库");
      jumpToAsset('knowledge',saved.id);
      return saved;
    });
  }

  function deleteKnowledgeAsset(id) {
    const target = knowledge.find((item) => item.id === id);
    return api(`/api/knowledge/${id}`, { method: "DELETE" })
      .then(() => {
        setKnowledge((prev) => prev.filter((item) => item.id !== id));
        setModal(null);
        showToast(target ? `已删除「${target.title}」` : "已删除知识资产");
      })
      .catch((err) => showToast(err.message));
  }

  /** 新建或编辑收藏（id 为空表示新建） */
  function saveFavorite(data, id) {
    if (id) {
      api(`/api/favorites/${id}`, { method: "PUT", body: data })
        .then((saved) => {
          setFavorites((prev) => prev.map((f) => f.id === id ? saved : f));
          setModal(null);
          showToast("已保存修改");
        })
        .catch((err) => showToast(err.message));
      return;
    }
    api("/api/favorites", { method: "POST", body: data })
      .then((saved) => {
        setFavorites((prev) => [saved, ...prev]);
        setModal(null);
        showToast(`已收藏「${data.name}」`);
      })
      .catch((err) => showToast(err.message));
  }

  function deleteFavorite(id) {
    const target = favorites.find((f) => f.id === id);
    api(`/api/favorites/${id}`, { method: "DELETE" })
      .then(() => {
        setFavorites(favorites.filter((f) => f.id !== id));
        if (target) showToast(`已删除「${target.name}」`);
      })
      .catch((err) => showToast(err.message));
  }

  /** 新建或编辑保存（抽屉调用，错误抛回抽屉内显示） */
  function savePrompt(form, id) {
    if (id) {
      return api(`/api/prompts/${id}`, { method: "PUT", body: form }).then((result) => {
        setPrompts((prev) => prev.map((p) => p.id === id
          ? { ...p, ...form, snsUrlNormalized: result.snsUrlNormalized || "", snsType: result.snsType || "" }
          : p));
        setModal(null);
        showToast("提示词已更新");
        recordChatSave('prompt',id,modal?.chatSaveSnapshot);
        jumpToAsset('prompt',id);
        return result;
      });
    }
    return api("/api/prompts", { method: "POST", body: form }).then((result) => {
      setPrompts((prev) => [
        { ...form, id: result.id, favorite: 0, archived: 0, snsUrlNormalized: result.snsUrlNormalized, snsType: result.snsType },
        ...prev,
      ]);
      setModal(null);
      recordChatSave('prompt',result.id,modal?.chatSaveSnapshot);
      showToast(`已保存到提示词库：${form.title}`);
      jumpToAsset('prompt',result.id);
      return result;
    });
  }

  /** 局部更新（收藏 / 归档切换） */
  function patchPrompt(target, patch, toastText) {
    api(`/api/prompts/${target.id}`, { method: "PUT", body: patch })
      .then(() => {
        setPrompts((prev) => prev.map((p) => p.id === target.id ? { ...p, ...patch } : p));
        setModal((m) => m && m.type === "drawer" && m.prompt && m.prompt.id === target.id
          ? { ...m, prompt: { ...m.prompt, ...patch } }
          : m);
        if (toastText) showToast(toastText);
      })
      .catch((err) => showToast(err.message));
  }

  function togglePromptFavorite(p) {
    patchPrompt(p, { favorite: p.favorite ? 0 : 1 });
  }

  function togglePromptArchive(p) {
    patchPrompt(p, { archived: p.archived ? 0 : 1 }, p.archived ? "已恢复" : "已归档");
    setModal(null);
  }

  function deletePrompt(id) {
    const target = prompts.find((p) => p.id === id);
    api(`/api/prompts/${id}`, { method: "DELETE" })
      .then(() => {
        setPrompts(prompts.filter((p) => p.id !== id));
        if (target) showToast(`已删除「${target.title}」`);
      })
      .catch((err) => showToast(err.message));
  }

  /** Prefill only; sending always requires an explicit action in the chat. */
  function tryRunPrompt(prompt) {
    if (!prompt.templateFilled && promptTemplateNames(prompt.text).length) { setModal({type:'prompt-use',item:prompt,origin:'manual'}); return; }
    setChatPrefill(prompt.text);
    setModal(null);
    setSection("chat");
  }

  function handleLogout() {
    api("/api/logout", { method: "POST" }).finally(() => {
      const raw = window.location.hash.slice(1);
      const [section, query = ''] = raw.split('?');
      const params = new URLSearchParams(query);
      params.set('space', 'public');
      history.replaceState(null, '', `#${section || 'repositories'}?${params.toString()}`);
      onUserChange(null);
    });
  }

  return (
    <div>
      <Header query={query} onQueryChange={setQuery}
        showSearch={!["repositories", "knowledgeLibrary", "studio", "chat", "tools", "topics", "settings"].includes(section) && !(section === "feed" && canUseFullApp && feedMode === "accounts")}
        searchPlaceholder={SEARCH_PLACEHOLDERS[section]}
        greeting={user ? `${getGreeting(now.getHours())}，${user.username}` : getGreeting(now.getHours())}
        dateText={formatToday(now)}
        user={user} onLogin={() => setAuthOpen(true)} onLogout={handleLogout}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        moduleLabels={moduleLabels}
        onToggleModuleLabels={() => setModuleLabels((visible) => !visible)} />
      <div className="layout">
        <SideNav section={section}
          onSectionChange={(s) => {
            // 专题 always opens its catalogue, even from inside a topic.
            if (s==='knowledgeLibrary' && section==='knowledgeLibrary' && knowledgeNavigation) knowledgeNavigation.onBack();
            else setSection(s, ['topics', 'tools'].includes(s) ? { base: true } : undefined);
            if (window.matchMedia("(max-width: 860px)").matches) setSidebarCollapsed(true);
          }}
          moduleCounts={visibleModuleCounts}
          knowledgeNavigation={section==='knowledgeLibrary' ? knowledgeNavigation : null}
          onKnowledgeNavigate={id=>{
            if (id == null) knowledgeNavigation?.onBack(); else knowledgeNavigation?.onHeading(id);
            if (window.matchMedia('(max-width: 860px)').matches) setSidebarCollapsed(true);
          }}
          categories={null} activeCategory={null}
          feedNavigation={section === "feed" && canUseFullApp ? {current:feedMode,items:[
            {id:"aihot",title:"AIHOT 资讯"},
            {id:"following",title:"监听动态"},
            {id:"hot",title:"关注热点"},
            {id:"accounts",title:"监听账号"},
          ]} : null}
          onFeedNavigate={(mode) => {
            setFeedMode(mode);
            writeFeedMode(mode);
            if (window.matchMedia("(max-width: 860px)").matches) setSidebarCollapsed(true);
          }}
          onCategoryChange={null} counts={{}}
          user={user} quote={quote} merit={merit}
          skin={skin} onSkinChange={setSkin}
          theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")}
          woodFishEnabled={woodFishEnabled}
          onWoodFishToggle={() => setWoodFishEnabled((enabled) => !enabled)}
          onOpenAiSettings={() => setModal("ai-settings")}
          onOpenAccountSettings={() => {
            setModal("account-settings");
            if (window.matchMedia("(max-width: 860px)").matches) setSidebarCollapsed(true);
          }}
          collapsed={sidebarCollapsed}
          moduleLabels={moduleLabels} />
        <main className="main">
          <RepositoryExplorerTab key={`${user?.id || 'guest'}-${classificationRevision}`} query={sectionQueries[`${user?.id || 'guest'}:repositories`] || ''}
            onQueryChange={(value) => setSectionQueries(previous => ({...previous, [`${user?.id || 'guest'}:repositories`]:value}))}
            userKey={user?.id || "guest"} active={section === "repositories"}
            onRepositoriesLoaded={rows => {setRepositories(rows); setModuleCounts(previous => ({...previous,repositories:rows.length}));}}
            onCorrectClassification={onCorrectClassification} />
          {sectionNeedsData && !sectionDataReady && <div className="knowledge-loading" role="status">
            {dataLoad.status === 'error'
              ? <><p>{dataLoad.error || '内容加载失败，请重试'}</p><button className="btn" onClick={retryPublicInbox}>重新加载</button></>
              : '正在读取内容…'}
          </div>}
          {sectionDataReady && dataLoad.error && <p role="status" className="muted">更新失败，仍显示上次内容。<button className="btn btn-ghost" onClick={retryPublicInbox}>重试</button></p>}
          <WorkspacePanel active={section === 'knowledgeLibrary'} name="knowledgeLibrary">
          {dataLoads.knowledgeLibrary?.hasData && (
            <KnowledgeLibraryView key={`${user?.id || 'guest'}:${catalogueScope}`} personalAccess={personalAccess} catalogueScope={catalogueScope}
              onReadingNavigationChange={updateKnowledgeNavigation} onShowNavigation={()=>setSidebarCollapsed(false)}
              onCatalogueChange={scope=>{window.location.hash=`knowledgeLibrary?space=${scope}`;window.location.reload();}}
              items={knowledgeLibrary} query={queryFor('knowledgeLibrary')} active={section === 'knowledgeLibrary'}
              onQueryChange={value => setQuery(value, 'knowledgeLibrary')} requestedId={requestedKnowledgeId} onCorrectClassification={onCorrectClassification}
              onOpenPrompt={id => {setSectionQueries(previous => ({...previous,[`${user?.id || 'guest'}:promptLibrary`]:''})); setRequestedPromptSourceId(id); setSection('promptLibrary');}}
              onEdit={personalCatalogue && canUseFullApp ? editLibraryKnowledge : undefined}
              onAdd={personalCatalogue && canUseFullApp ? () => setModal({type:'knowledge',item:null}) : undefined}
              onRequestedIdHandled={() => setRequestedKnowledgeId(null)} />
          )}
          </WorkspacePanel>
          <WorkspacePanel active={section === 'promptLibrary'} name="promptLibrary">
          {dataLoads.promptLibrary?.hasData && <PromptLibraryView active={section === 'promptLibrary'} items={promptLibrary} query={queryFor('promptLibrary')} onCorrectClassification={onCorrectClassification} onOpenMethod={openMethod}
            onQueryChange={value => setQuery(value, 'promptLibrary')}
            onCreateMedia={personalAccess ? createFromLibraryPrompt : undefined}
            onUsePrompt={item => setModal({type:'prompt-use',item,origin:'library'})}
            onEdit={personalCatalogue && canUseFullApp ? editLibraryPrompt : undefined}
            onAdd={personalCatalogue && canUseFullApp ? () => setModal({type:'drawer',prompt:null,mode:'create'}) : undefined}
            requestedId={requestedPromptId} onRequestedIdHandled={() => setRequestedPromptId(null)}
            requestedSourceId={requestedPromptSourceId} onRequestedSourceHandled={() => setRequestedPromptSourceId(null)} />}
          </WorkspacePanel>
          <WorkspacePanel active={section === 'inbox'} name="inbox">
          {!personalAccess && <div className="knowledge-loading"><h2>登录后查看你的收藏</h2><p>每个人的 X 收藏、媒体和收件箱彼此隔离；公开成果仍可浏览。</p><button className="btn" onClick={() => setAuthOpen(true)}>登录 / 注册</button></div>}
          {personalAccess && dataLoads.inbox?.hasData && (
            <>
            {section === 'inbox' && canUseFullApp && <ContentPipelineStatus onCorrectClassification={onCorrectClassification} onOpenSettings={() => setModal({type:"settings",tab:"automation"})} />}
            <InboxView active={section === 'inbox'} items={inboxItems} query={queryFor('inbox')} readOnly={!personalAccess} onCorrectClassification={onCorrectClassification}
              onOpenConnections={() => setModal('account-settings')}
              loadState={dataLoads.inbox.status} loadError={dataLoads.inbox.error}
              onRetry={retryPublicInbox}
              onCapture={personalAccess ? captureInbox : undefined}
              onImportX={personalAccess ? importXBookmarks : undefined}
              onAnalyze={canUseFullApp ? analyzeInbox : undefined}
              onSetVisibility={canUseFullApp ? setInboxVisibility : undefined}
              onIgnore={personalAccess ? ignoreInbox : undefined}
              onDispatch={canUseFullApp ? dispatchInbox : undefined}
              onCreateMedia={canUseFullApp ? createFromInbox : undefined}
              onClassificationChanged={() => setClassificationRevision(value => value + 1)}
              onOpenLibraryItem={link => {
                if (link.href.startsWith('#promptLibrary')) {
                  if (link.sourceId) setRequestedPromptSourceId(link.sourceId); else setRequestedPromptId(link.id);
                  setSection('promptLibrary', {params:{space:'mine'}});
                }
                else if (link.href.startsWith('#knowledgeLibrary')) { setRequestedKnowledgeId(link.id); setSection('knowledgeLibrary', {params:{space:'mine'}}); }
                else if (link.href.startsWith('#resources')) { setPendingAssetTarget(link.id); setSection('resources'); }
              }} />
            </>
          )}
          </WorkspacePanel>
          <WorkspacePanel active={section === 'resources'} name="resources">
            {section === 'resources' && canUseFullApp && sectionDataReady && <div className="workspace-library resources-library">
              <div className="workspace-library-head"><div><h1>资料</h1><p>手工新增和整理的网站、工具与参考资料。</p></div><button className="btn btn-primary" onClick={() => setModal({ type: 'fav', fav: null })}><IconPlus />新增资料</button></div>
              <FavoritesView favorites={favorites} query={queryFor('resources')} category={favCategory}
                onAdd={() => setModal({ type: 'fav', fav: null })} onEdit={fav => setModal({ type: 'fav', fav })} onDelete={deleteFavorite} />
            </div>}
          </WorkspacePanel>
          <WorkspacePanel active={section === 'works'} name="works">
            {section === 'works' && personalAccess && sectionDataReady && <div className="workspace-library works-library"><div className="workspace-library-head"><div><h1>作品</h1><p>保留生成提示词、参数、版本关系和可继续创作的结果。</p></div><button className="btn btn-primary" onClick={() => openStudio()}><IconPlus />新建作品</button></div><MediaAssetsView allowExternal={canUseFullApp} assets={mediaAssets} query={queryFor('works')} onCreate={() => openStudio()} onContinue={continueFromMedia} onUpdated={reloadMediaAssets} openAssetId={openMediaAssetId} onOpenAssetHandled={() => setOpenMediaAssetId('')} showToast={showToast} /></div>}
          </WorkspacePanel>
          {section === "studio" && personalAccess && sectionDataReady && (
            <MediaStudioView userId={user?.id} draft={studioDraft} assets={mediaAssets} jobs={mediaJobs}
              allowExternal={canUseFullApp}
              configVersion={mediaConfigVersion}
              onAssetsChanged={reloadMediaAssets} onJobsChanged={reloadMediaJobs}
              onOpenSettings={(tab) => setModal({type:"settings", tab:tab === "devices" ? "devices" : "ai", aiTab:"media"})} onShowAsset={showMediaAsset}
              showToast={showToast} />
          )}
          <WorkspacePanel active={section === 'chat'} name="chat">
          {(section === 'chat' || chatVisited) && personalAccess && (
            <ChatView active={section === 'chat'} messages={chatMessages} onMessagesChange={setChatMessages}
              prefill={chatPrefill} onPrefillUsed={() => setChatPrefill("")} sources={inboxItems}
              onLoadSource={(id, options) => api(`/api/inbox/${id}`, options)}
              onSearchSources={(query, options) => api(`/api/inbox/search?q=${encodeURIComponent(query)}&mode=terms`, options)}
              onSaveResult={canUseFullApp ? saveChatResult : undefined}
              hasAiConfig={hasAiConfig}
              onOpenAiSettings={() => setModal("ai-settings")}
              showToast={showToast} />
          )}
          </WorkspacePanel>
          <WorkspacePanel active={section === 'feed'} name="feed">
            <FeedView active={section === 'feed'} mode={feedMode} onModeChange={setFeedMode} query={queryFor('feed')} canUseMonitoring={canUseFullApp} onSaveToInbox={personalAccess ? saveFeedToInbox : null} onCorrectClassification={onCorrectClassification} />
          </WorkspacePanel>
          <WorkspacePanel active={section === "tools"} name="tools"><VideoToolsWorkspace active={section === 'tools'} userKey={user?.id || 'guest'} showToast={showToast}
            referenceAccess={user?.username === 'zane'} onCreateReference={async (asset, reference) => { await reloadMediaAssets(); openStudio({ referenceAssetId: asset.id, title: reference.title, targetModule: 'image', prompt: `请以提供的参考图为依据，保留${reference.title}的关键特征。` }); }} /></WorkspacePanel>
          <WorkspacePanel active={section === 'topics'} name="topics"><TopicsCatalog active={section === 'topics'} /></WorkspacePanel>
          <WorkspacePanel active={section === 'settings'} name="settings">
            {section === 'settings' && <SettingsCenter user={user} canUseFullApp={canUseFullApp}
              onClose={() => setSection(settingsReturn.current && settingsReturn.current !== 'settings' ? settingsReturn.current : 'repositories')}
              onDirtyChange={value => { settingsDirty.current = Boolean(value); }}
              theme={theme} onThemeToggle={() => setTheme(theme === "dark" ? "light" : "dark")} skin={skin} onSkinChange={setSkin}
              woodFishEnabled={woodFishEnabled} onWoodFishToggle={() => setWoodFishEnabled(value => !value)}
              showToast={showToast} onSaved={(kind) => { if (kind === "chat") api("/api/ai-config").then(c=>setHasAiConfig(Boolean(c.hasKey))).catch(()=>setHasAiConfig(false)); else setMediaConfigVersion(value => value + 1); }} />}
          </WorkspacePanel>
        </main>
      </div>
      {classificationTarget && onCorrectClassification && <ClassificationEditor target={classificationTarget} onClose={() => setClassificationTarget(null)}
        onSaved={() => {setClassificationTarget(null); setClassificationRevision(v => v + 1); showToast('归类已保存，原始收藏未修改');}} />}
      {modal && modal.type === "fav" && (
        <AddFavModalV2 key={modal.fav ? modal.fav.id : "new"} editing={modal.fav}
          onClose={() => setModal(null)} onSubmit={saveFavorite} />
      )}
      {modal && modal.type === "drawer" && (
        <PromptDrawer key={modal.prompt ? modal.prompt.id : "new"}
          prompt={modal.prompt} initialMode={modal.mode} initialForm={modal.initialForm}
          onClose={() => setModal(null)} onSave={savePrompt}
          onCopy={copyPrompt} onTryRun={tryRunPrompt} onCreateMedia={createFromPrompt}
          onToggleFavorite={togglePromptFavorite}
          onToggleArchive={togglePromptArchive}
          showToast={showToast} />
      )}
      {modal && modal.type === "knowledge" && (
        <KnowledgeDrawer key={modal.item ? modal.item.id : "new"} item={modal.item} initialForm={modal.initialForm}
          onClose={() => setModal(null)} onSave={saveKnowledge} onDelete={deleteKnowledgeAsset} />
      )}
      {modal?.type === 'prompt-use' && <PromptUseDialog item={modal.item} onClose={() => setModal(null)} canChat={canUseFullApp} canCreateMedia={personalAccess}
        onUse={(item,action) => {
          if (action === 'chat') { setChatPrefill(item.text); setModal(null); setSection('chat'); }
          else if (modal.origin === 'library') createFromLibraryPrompt({...item,templateFilled:true});
          else createFromPrompt({...item,templateFilled:true});
        }} />}
      {authOpen && (
        <AuthView onClose={() => setAuthOpen(false)}
          onLoggedIn={(u) => { onUserChange(u); setAuthOpen(false); }} />
      )}
      {woodFishEnabled && <FloatingWoodFish onKnock={knockWoodFish} hidden={sidebarCollapsed} />}
      <BackToTop />
      <ToastV2 message={toast} />
    </div>
  );
}

/** 应用根：检查登录态；登录与游客都进入主界面（不强制登录） */
function App() {
  const [user, setUser] = useAppState(null);
  const [checking, setChecking] = useAppState(true);
  const [toast, setToast] = useAppState("");

  function showToast(message) {
    setToast(message);
    setTimeout(() => setToast(""), 2600);
  }

  useAppEffect(() => {
    // 登录页也应用本机皮肤偏好
    document.documentElement.setAttribute("data-skin", loadStored("skin", "minimal"));
    document.documentElement.setAttribute("data-theme", loadStored("theme", "dark"));
    api("/api/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  // 不强制登录：游客（user 为 null）也进入主界面，仅个人相关功能需要登录
  return <Workspace key={user ? `${user.id}:${Boolean(user.fullAccess)}` : "guest"} user={user} onUserChange={setUser} showToast={showToast} toast={toast} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
