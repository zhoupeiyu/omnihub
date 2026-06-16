/// 主应用 —— 登录态管理 + 五大模块（收藏/提示词/AI对话/信息流/工具箱），业务数据走服务器
const { useState: useAppState, useEffect: useAppEffect, useMemo: useAppMemo, useRef: useAppRef } = React;

const SEARCH_PLACEHOLDERS = {
  favorites: "搜索收藏的网站……",
  prompts: "搜索提示词……",
  chat: "搜索……",
  feed: "搜索资讯……",
  tools: "搜索……",
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
  const visible = favorites.filter((fav) => {
    const inCategory = category === "全部" || fav.category === category;
    const q = query.toLowerCase();
    const inQuery = !q || fav.name.toLowerCase().includes(q)
      || fav.url.toLowerCase().includes(q) || (fav.desc || "").toLowerCase().includes(q);
    return inCategory && inQuery;
  });

  const groups = (category === "全部" ? FAV_CATEGORIES : [category])
    .map((cat) => ({ cat, items: visible.filter((f) => f.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      {groups.length === 0 && (
        <div>
          <SectionHead icon={<IconBookmark />} title="网站收藏" count={0}>
            <button className="btn btn-primary" onClick={onAdd}><IconPlus />添加网站</button>
          </SectionHead>
          <EmptyState message="没有找到相关收藏" hint="试试其他关键词，或点右上角「添加网站」" />
        </div>
      )}
      {groups.map((group, gi) => (
        <section key={group.cat}>
          <SectionHead icon={<IconBookmark />} title={group.cat} count={group.items.length}>
            {gi === 0 && <button className="btn btn-primary" onClick={onAdd}><IconPlus />添加网站</button>}
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
function PromptsView({ prompts, query, category, onAdd, onDelete, onCopy, onOpen, onTryRun, onToggleFavorite }) {
  const [modelFilter, setModelFilter] = useAppState("");
  const [tagFilter, setTagFilter] = useAppState("");
  const [onlyFavorite, setOnlyFavorite] = useAppState(false);
  const [showArchived, setShowArchived] = useAppState(false);

  const models = useAppMemo(
    () => [...new Set(prompts.map((p) => p.model).filter(Boolean))],
    [prompts]
  );
  const tags = useAppMemo(
    () => [...new Set(prompts.flatMap((p) => (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean)))],
    [prompts]
  );

  const visible = prompts.filter((p) => {
    if (Boolean(p.archived) !== showArchived) return false;
    if (onlyFavorite && !p.favorite) return false;
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
        onTryRun={onTryRun} onToggleFavorite={onToggleFavorite} />
    );
  }

  return (
    <div>
      <div className="prompt-toolbar">
        {models.length > 0 && (
          <select className="select-mini" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
            <option value="">全部模型</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <button className={"filter-chip" + (onlyFavorite ? " active" : "")}
          onClick={() => setOnlyFavorite(!onlyFavorite)}>⭐ 只看收藏</button>
        <button className={"filter-chip" + (showArchived ? " active" : "")}
          onClick={() => setShowArchived(!showArchived)}>已归档</button>
        {tags.map((t) => (
          <button key={t} className={"filter-chip" + (tagFilter === t ? " active" : "")}
            onClick={() => setTagFilter(tagFilter === t ? "" : t)}>{t}</button>
        ))}
        <div className="toolbar-actions">
          <button className="btn" title="导出全部为 JSON"
            onClick={() => { window.location.href = "/api/prompts/export"; }}>
            <IconDownload style={{ width: 14, height: 14 }} />导出
          </button>
          <button className="btn btn-primary" onClick={onAdd}><IconPlus />新建灵感</button>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState message={showArchived ? "归档箱是空的" : "还没有匹配的灵感"}
          hint={showArchived ? "在详情抽屉里点「归档」的会出现在这里" : "点击右上角「新建灵感」开始收集"} />
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

/** 信息流模块：多来源聚合；AI 资讯（富源）复刻 AI HOT 的精选分/分类/时间线/热点 */
function FeedView({ query }) {
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
  const rich = Boolean(sourceInfo && sourceInfo.rich);
  const q = query.toLowerCase();
  let visible = items.filter((it) => !q
    || it.title.toLowerCase().includes(q) || (it.summary || "").toLowerCase().includes(q));
  if (rich && catFilter) visible = visible.filter((it) => (it.tags || []).includes(catFilter));
  if (rich) visible = sortByTimeThenScore(visible);

  const hot = rich
    ? [...items].filter((it) => typeof it.score === "number").sort((a, b) => b.score - a.score).slice(0, 10)
    : [];
  const topTags = rich ? (() => {
    const counts = {};
    items.forEach((it) => (it.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
  })() : [];
  const groups = rich ? groupByDate(visible) : null;

  function switchSource(s) {
    setActiveSource(s.id); setSourceInfo(s); setCatFilter("");
  }

  return (
    <div>
      <div className="feed-toolbar">
        <div className="filter-bar">
          {rich && topTags.length > 0 &&
            ["", ...topTags].map((t) => (
              <button key={t || "all"} className={"filter-chip" + (catFilter === t ? " active" : "")}
                onClick={() => setCatFilter(t)}>{t || "全部"}</button>
            ))}
        </div>
        <button className="btn feed-refresh" onClick={() => activeSource && load(activeSource)} disabled={isLoading}>
          <IconRefresh />{isLoading && hasCachedItems ? "刷新中" : "刷新"}
        </button>
      </div>
      {sources.length > 1 && (
        <div className="feed-sources">
          {sources.map((s) => (
            <button key={s.id} title={s.desc}
              className={"feed-source" + (activeSource === s.id ? " active" : "")}
              onClick={() => switchSource(s)}>
              {s.name}<span className="src-cat">{s.category}</span>
            </button>
          ))}
        </div>
      )}
      <div className="feed-layout">
        <div className="feed-list">
          {isLoading && !hasCachedItems && (
            <div className="feed-loading-empty"><RoseFourLoader label="正在加载" /></div>
          )}
          {isLoading && hasCachedItems && (
            <div className="feed-refresh-banner"><RoseFourLoader label="正在刷新" /></div>
          )}
          {sourceStatus === "error" && !hasCachedItems && <EmptyState message={errMsg || "加载失败"} hint="点右上角「刷新」重试" />}
          {sourceStatus === "error" && hasCachedItems && (
            <div className="feed-inline-error">刷新失败，已保留当前内容：{errMsg || "请稍后重试"}</div>
          )}
          {!isLoading && sourceStatus !== "error" && visible.length === 0 && <EmptyState message="暂无内容" />}
          {rich && groups && groups.map((g) => (
            <div className="feed-day" key={g.key}>
              <div className="feed-day-label">{g.label}</div>
              <div className="timeline">
                {g.items.map((it, i) => (
                  <div className="tl-row" key={i}>
                    <div className="tl-time">{toHHMM(it.publishedAt)}</div>
                    <div className="tl-rail"><span className="tl-dot" /></div>
                    <FeedItem item={{ ...it, time: "" }} showRank={false} onPreview={setPreview} />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!rich && visible.map((item, idx) => (
            <FeedItem key={idx} item={item} rank={idx + 1} showRank={true} onPreview={setPreview} />
          ))}
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
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** 工具箱模块 */
function ToolsView({ showToast }) {
  return (
    <div>
      <SectionHead icon={<IconWrench />} title="工具箱" count={7} />
      <div className="tools-board">
        <div className="tools-main">
          <PdfCompressTool showToast={showToast} />
          <div className="tools-quick-grid">
            <PasswordTool showToast={showToast} />
            <ColorTool showToast={showToast} />
            <DiceTool />
            <FocusTimerTool showToast={showToast} />
          </div>
        </div>
        <div className="tools-aside">
          <TimestampTool showToast={showToast} />
          <WordCountTool />
        </div>
      </div>
    </div>
  );
}

/** 主界面（登录用户与游客共用；游客 user 为 null） */
function Workspace({ user, onUserChange, showToast, toast }) {
  const [skin, setSkin] = useAppState(() => loadStored("skin", "minimal"));
  const [theme, setTheme] = useAppState(() => loadStored("theme", "light"));
  const [section, setSection] = useAppState("feed");
  const [favorites, setFavorites] = useAppState([]);
  const [prompts, setPrompts] = useAppState([]);
  const [query, setQuery] = useAppState("");
  const [favCategory, setFavCategory] = useAppState("全部");
  const [promptCategory, setPromptCategory] = useAppState("全部");
  const [modal, setModal] = useAppState(null); // null | "add-fav" | "add-prompt" | "ai-settings" | {type:"detail", prompt}
  const [authOpen, setAuthOpen] = useAppState(false); // 登录/注册弹窗
  const [chatPrefill, setChatPrefill] = useAppState("");
  const [chatMessages, setChatMessages] = useAppState([]);
  const [hasAiConfig, setHasAiConfig] = useAppState(user ? user.hasAiConfig : false);
  const [now, setNow] = useAppState(() => new Date());
  const [quote, setQuote] = useAppState(null);
  const [merit, setMerit] = useAppState(() => Number(localStorage.getItem("omnihub_merit") || 0));
  const [woodFishEnabled, setWoodFishEnabled] = useAppState(() => loadStored("woodFishEnabled", false));
  const canUseFullApp = Boolean(user && user.fullAccess);

  useAppEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    document.documentElement.setAttribute("data-theme", theme);
    saveStored("skin", skin);
    saveStored("theme", theme);
  }, [skin, theme]);

  useAppEffect(() => {
    saveStored("woodFishEnabled", woodFishEnabled);
  }, [woodFishEnabled]);

  useAppEffect(() => {
    if (!canUseFullApp) return; // 非白名单不加载内部个人数据（收藏 / 提示词）
    api("/api/favorites").then(setFavorites).catch((err) => showToast(err.message));
    api("/api/prompts").then(setPrompts).catch((err) => showToast(err.message));
  }, [canUseFullApp]);

  useAppEffect(() => {
    if (!canUseFullApp && section !== "feed") {
      setSection("feed");
      setQuery("");
    }
  }, [canUseFullApp, section]);

  useAppEffect(() => {
    // 不再显示时分，每 10 分钟刷新一次足够跨过日期与问候语的变化点
    const timer = setInterval(() => setNow(new Date()), 600000);
    return () => clearInterval(timer);
  }, []);

  /** 取一句好话（敲木鱼时调用换句；侧边栏一言卡片展示） */
  function pickQuote() {
    fetch("https://v1.hitokoto.cn/?c=d&c=i&c=k")
      .then((r) => r.json())
      .then((j) => setQuote({ text: j.hitokoto, from: j.from || "一言" }))
      .catch(() => setQuote(FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)]));
  }
  useAppEffect(() => { pickQuote(); }, []);

  /** 敲木鱼：功德 +1（本地累计持久化）并换一句好话 */
  function knockWoodFish() {
    setMerit((m) => {
      const next = m + 1;
      try { localStorage.setItem("omnihub_merit", String(next)); } catch (err) { /* 忽略 */ }
      return next;
    });
    pickQuote();
  }

  function copyPrompt(text) {
    navigator.clipboard.writeText(text)
      .then(() => showToast("提示词已复制"))
      .catch(() => showToast("复制失败，请手动选择"));
  }

  /** 新建或编辑收藏（id 为空表示新建） */
  function saveFavorite(data, id) {
    if (id) {
      api(`/api/favorites/${id}`, { method: "PUT", body: data })
        .then(() => {
          setFavorites((prev) => prev.map((f) => f.id === id ? { ...f, ...data } : f));
          setModal(null);
          showToast("已保存修改");
        })
        .catch((err) => showToast(err.message));
      return;
    }
    api("/api/favorites", { method: "POST", body: data })
      .then(({ id: newId }) => {
        setFavorites([...favorites, { id: newId, ...data }]);
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
        showToast("已保存修改");
      });
    }
    return api("/api/prompts", { method: "POST", body: form }).then((result) => {
      setPrompts((prev) => [
        { ...form, id: result.id, favorite: 0, archived: 0, snsUrlNormalized: result.snsUrlNormalized, snsType: result.snsType },
        ...prev,
      ]);
      setModal(null);
      showToast(`已收藏「${form.title}」`);
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

  /** 提示词「试跑」：带着内容跳到 AI 对话 */
  function tryRunPrompt(prompt) {
    setChatPrefill(prompt.text);
    setModal(null);
    setSection("chat");
  }

  function handleLogout() {
    api("/api/logout", { method: "POST" }).finally(() => onUserChange(null));
  }

  const favCounts = {};
  ["全部", ...FAV_CATEGORIES].forEach((c) => {
    favCounts[c] = c === "全部" ? favorites.length : favorites.filter((f) => f.category === c).length;
  });
  const promptCounts = {};
  ["全部", ...PROMPT_CATEGORIES].forEach((c) => {
    promptCounts[c] = c === "全部" ? prompts.length : prompts.filter((p) => p.category === c).length;
  });

  let sideCategories = null, activeCategory = null, onCategoryChange = null, counts = {};
  if (section === "favorites") {
    sideCategories = ["全部", ...FAV_CATEGORIES]; activeCategory = favCategory;
    onCategoryChange = setFavCategory; counts = favCounts;
  } else if (section === "prompts") {
    sideCategories = ["全部", ...PROMPT_CATEGORIES]; activeCategory = promptCategory;
    onCategoryChange = setPromptCategory; counts = promptCounts;
  }

  return (
    <div>
      <Header query={query} onQueryChange={setQuery}
        searchPlaceholder={SEARCH_PLACEHOLDERS[section]}
        greeting={user ? `${getGreeting(now.getHours())}，${user.username}` : getGreeting(now.getHours())}
        dateText={formatToday(now)} />
      <div className="layout">
        <SideNav section={section}
          onSectionChange={(s) => { setSection(s); setQuery(""); }}
          categories={sideCategories} activeCategory={activeCategory}
          onCategoryChange={onCategoryChange} counts={counts}
          user={user} quote={quote} merit={merit}
          skin={skin} onSkinChange={setSkin}
          theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")}
          woodFishEnabled={woodFishEnabled}
          onWoodFishToggle={() => setWoodFishEnabled((enabled) => !enabled)}
          onOpenAiSettings={() => setModal("ai-settings")}
          onLogin={() => setAuthOpen(true)}
          onLogout={handleLogout} />
        <main className="main">
          {section === "favorites" && canUseFullApp && (
            <FavoritesView favorites={favorites} query={query} category={favCategory}
              onAdd={() => setModal({ type: "fav", fav: null })}
              onEdit={(fav) => setModal({ type: "fav", fav })}
              onDelete={deleteFavorite} />
          )}
          {section === "prompts" && canUseFullApp && (
            <PromptsView prompts={prompts} query={query} category={promptCategory}
              onAdd={() => setModal({ type: "drawer", prompt: null, mode: "create" })}
              onDelete={deletePrompt}
              onCopy={copyPrompt}
              onOpen={(p) => setModal({ type: "drawer", prompt: p, mode: "view" })}
              onTryRun={tryRunPrompt}
              onToggleFavorite={togglePromptFavorite} />
          )}
          {section === "chat" && canUseFullApp && (
            <ChatView messages={chatMessages} onMessagesChange={setChatMessages}
              prefill={chatPrefill} onPrefillUsed={() => setChatPrefill("")}
              hasAiConfig={hasAiConfig}
              onOpenAiSettings={() => setModal("ai-settings")}
              showToast={showToast} />
          )}
          {section === "feed" && <FeedView query={query} />}
          {section === "tools" && canUseFullApp && <ToolsView showToast={showToast} />}
        </main>
      </div>
      {modal && modal.type === "fav" && (
        <AddFavModalV2 key={modal.fav ? modal.fav.id : "new"} editing={modal.fav}
          onClose={() => setModal(null)} onSubmit={saveFavorite} />
      )}
      {modal === "ai-settings" && canUseFullApp && (
        <AiSettingsModal onClose={() => setModal(null)} onSaved={() => setHasAiConfig(true)} showToast={showToast} />
      )}
      {modal && modal.type === "drawer" && (
        <PromptDrawer key={modal.prompt ? modal.prompt.id : "new"}
          prompt={modal.prompt} initialMode={modal.mode}
          onClose={() => setModal(null)} onSave={savePrompt}
          onCopy={copyPrompt} onTryRun={tryRunPrompt}
          onToggleFavorite={togglePromptFavorite}
          onToggleArchive={togglePromptArchive}
          showToast={showToast} />
      )}
      {authOpen && (
        <AuthView onClose={() => setAuthOpen(false)}
          onLoggedIn={(u) => { onUserChange(u); setAuthOpen(false); }} />
      )}
      {woodFishEnabled && <FloatingWoodFish onKnock={knockWoodFish} />}
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
    document.documentElement.setAttribute("data-theme", loadStored("theme", "light"));
    api("/api/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  // 不强制登录：游客（user 为 null）也进入主界面，仅个人相关功能需要登录
  return <Workspace key={user ? user.id : "guest"} user={user} onUserChange={setUser} showToast={showToast} toast={toast} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
