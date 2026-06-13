/// v2 主应用 —— 四大模块（收藏 / 提示词 / 信息流 / 工具箱）+ 全局搜索 + 皮肤/主题 + 持久化
const { useState: useAppState, useEffect: useAppEffect, useMemo: useAppMemo } = React;

const SEARCH_PLACEHOLDERS = {
  favorites: "搜索收藏的网站……",
  prompts: "搜索提示词……",
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

function formatToday(now) {
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${week} · ${time}`;
}

/** 收藏模块：按分类分区展示（区块标题 + 计数徽章） */
function FavoritesView({ favorites, query, category, onAdd, onDelete }) {
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
        <section key={group.cat} id={"fav-" + group.cat}>
          <SectionHead icon={<IconBookmark />} title={group.cat} count={group.items.length}>
            {gi === 0 && <button className="btn btn-primary" onClick={onAdd}><IconPlus />添加网站</button>}
          </SectionHead>
          <div className="fav-grid">
            {group.items.map((fav) => (
              <FavCardV2 key={fav.id} fav={fav} onDelete={onDelete} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 提示词模块 */
function PromptsView({ prompts, query, category, onAdd, onDelete, onCopy, onOpen }) {
  const visible = prompts.filter((p) => {
    const inCategory = category === "全部" || p.category === category;
    const q = query.toLowerCase();
    const inQuery = !q || p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q);
    return inCategory && inQuery;
  });

  return (
    <div>
      <SectionHead icon={<IconSparkle />} title="提示词库" count={visible.length}>
        <button className="btn btn-primary" onClick={onAdd}><IconPlus />收藏提示词</button>
      </SectionHead>
      {visible.length === 0 ? (
        <EmptyState message="还没有匹配的提示词" hint="点击右上角「收藏提示词」，可以配上效果图" />
      ) : (
        <div className="prompt-grid">
          {visible.map((p) => (
            <PromptCard key={p.id} prompt={p}
              onCopy={onCopy} onDelete={onDelete} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 信息流模块 */
function FeedView({ query }) {
  const [shuffleSeed, setShuffleSeed] = useAppState(0);
  const items = useAppMemo(() => {
    const q = query.toLowerCase();
    const filtered = SAMPLE_FEED.filter((item) => !q || item.title.toLowerCase().includes(q));
    if (shuffleSeed === 0) return filtered;
    return [...filtered].sort(() => Math.random() - 0.5);
  }, [query, shuffleSeed]);

  return (
    <div>
      <SectionHead icon={<IconRss />} title="信息流" count={items.length}>
        <button className="btn" onClick={() => setShuffleSeed(Date.now())}><IconRefresh />刷新</button>
      </SectionHead>
      <div className="feed-layout">
        <div className="feed-list">
          {items.length === 0
            ? <EmptyState message="没有匹配的资讯" />
            : items.map((item, idx) => <FeedCardV2 key={item.id} item={item} rank={idx + 1} />)}
        </div>
        <QuoteCardV2 />
      </div>
    </div>
  );
}

/** 工具箱模块 */
function ToolsView({ showToast }) {
  return (
    <div>
      <SectionHead icon={<IconWrench />} title="工具箱" count={6} />
      <div className="tool-grid">
        <PasswordTool showToast={showToast} />
        <TimestampTool showToast={showToast} />
        <WordCountTool />
        <ColorTool showToast={showToast} />
        <DiceTool />
        <FocusTimerTool showToast={showToast} />
      </div>
    </div>
  );
}

/** 应用根组件 */
function App() {
  const [skin, setSkin] = useAppState(() => loadStored("skin", "minimal"));
  const [theme, setTheme] = useAppState(() => loadStored("theme", "light"));
  const [section, setSection] = useAppState(() => loadStored("section2", "favorites"));
  const [favorites, setFavorites] = useAppState(() => {
    // 旧版收藏没有描述字段，按 id 从 v2 默认数据补齐
    const stored = loadStored("favorites", DEFAULT_FAVORITES_V2);
    return stored.map((fav) => {
      if (fav.desc) return fav;
      const fallback = DEFAULT_FAVORITES_V2.find((d) => d.id === fav.id);
      return fallback ? { ...fav, desc: fallback.desc } : fav;
    });
  });
  const [prompts, setPrompts] = useAppState(() => loadStored("prompts", DEFAULT_PROMPTS));
  const [query, setQuery] = useAppState("");
  const [favCategory, setFavCategory] = useAppState("全部");
  const [promptCategory, setPromptCategory] = useAppState("全部");
  const [modal, setModal] = useAppState(null); // null | "add-fav" | "add-prompt" | {type:"detail", prompt}
  const [toast, setToast] = useAppState("");
  const [now, setNow] = useAppState(() => new Date());

  useAppEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    document.documentElement.setAttribute("data-theme", theme);
    saveStored("skin", skin);
    saveStored("theme", theme);
  }, [skin, theme]);
  useAppEffect(() => { saveStored("section2", section); }, [section]);
  useAppEffect(() => { saveStored("favorites", favorites); }, [favorites]);
  useAppEffect(() => { saveStored("prompts", prompts); }, [prompts]);

  useAppEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  function showToast(message) {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  }

  function copyPrompt(text) {
    navigator.clipboard.writeText(text)
      .then(() => showToast("提示词已复制"))
      .catch(() => showToast("复制失败，请手动选择"));
  }

  function addFavorite(data) {
    setFavorites([...favorites, { id: "f" + Date.now(), ...data }]);
    setModal(null);
    showToast(`已收藏「${data.name}」`);
  }

  function deleteFavorite(id) {
    const target = favorites.find((f) => f.id === id);
    setFavorites(favorites.filter((f) => f.id !== id));
    if (target) showToast(`已删除「${target.name}」`);
  }

  function addPrompt(data) {
    setPrompts([{ id: "p" + Date.now(), ...data }, ...prompts]);
    setModal(null);
    showToast(`已收藏提示词「${data.title}」`);
  }

  function deletePrompt(id) {
    const target = prompts.find((p) => p.id === id);
    setPrompts(prompts.filter((p) => p.id !== id));
    if (target) showToast(`已删除「${target.title}」`);
  }

  // 侧边栏分类配置随模块切换
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
        skin={skin} onSkinChange={setSkin}
        theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")}
        searchPlaceholder={SEARCH_PLACEHOLDERS[section]} />
      <div className="layout">
        <SideNav section={section}
          onSectionChange={(s) => { setSection(s); setQuery(""); }}
          categories={sideCategories} activeCategory={activeCategory}
          onCategoryChange={onCategoryChange} counts={counts} />
        <main className="main">
          <div className="topbar">
            <h1>{getGreeting(now.getHours())}，欢迎回到万象台</h1>
            <p>{formatToday(now)}</p>
          </div>
          {section === "favorites" && (
            <FavoritesView favorites={favorites} query={query} category={favCategory}
              onAdd={() => setModal("add-fav")} onDelete={deleteFavorite} />
          )}
          {section === "prompts" && (
            <PromptsView prompts={prompts} query={query} category={promptCategory}
              onAdd={() => setModal("add-prompt")} onDelete={deletePrompt}
              onCopy={copyPrompt} onOpen={(p) => setModal({ type: "detail", prompt: p })} />
          )}
          {section === "feed" && <FeedView query={query} />}
          {section === "tools" && <ToolsView showToast={showToast} />}
        </main>
      </div>
      {modal === "add-fav" && <AddFavModalV2 onClose={() => setModal(null)} onSubmit={addFavorite} />}
      {modal === "add-prompt" && <AddPromptModal onClose={() => setModal(null)} onSubmit={addPrompt} />}
      {modal && modal.type === "detail" && (
        <PromptDetailModal prompt={modal.prompt} onClose={() => setModal(null)} onCopy={copyPrompt} />
      )}
      <BackToTop />
      <ToastV2 message={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
