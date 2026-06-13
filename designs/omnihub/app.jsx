/// 主应用 —— 全局状态（皮肤/主题/收藏/导航）、三大分区与持久化
const { useState: useAppState, useEffect: useAppEffect, useMemo: useAppMemo } = React;

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

/** 收藏分区 */
function FavoritesSection({ favorites, onAdd, onDelete }) {
  const [category, setCategory] = useAppState("全部");
  const [keyword, setKeyword] = useAppState("");

  const visible = favorites.filter((fav) => {
    const inCategory = category === "全部" || fav.category === category;
    const inKeyword = !keyword || fav.name.toLowerCase().includes(keyword.toLowerCase())
      || fav.url.toLowerCase().includes(keyword.toLowerCase());
    return inCategory && inKeyword;
  });

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title"><IconBookmark />网站收藏</h2>
        <div style={{ position: "relative", width: 220 }}>
          <IconSearch style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--text-3)", pointerEvents: "none" }} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder="搜索收藏……"
            value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
      </div>
      <div className="chip-row" style={{ marginBottom: 16 }}>
        {["全部", ...FAV_CATEGORIES].map((c) => (
          <button key={c} className={"chip" + (category === c ? " active" : "")} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <div className="fav-grid">
        {visible.map((fav) => <FavoriteCard key={fav.id} fav={fav} onDelete={onDelete} />)}
        <button className="fav-add" onClick={onAdd}><IconPlus />添加网站</button>
      </div>
      {visible.length === 0 && <div className="empty-state">没有匹配的收藏，换个关键词试试？</div>}
    </section>
  );
}

/** 信息流分区 */
function FeedSection() {
  const [category, setCategory] = useAppState("全部");
  const [shuffleSeed, setShuffleSeed] = useAppState(0);

  const items = useAppMemo(() => {
    const filtered = SAMPLE_FEED.filter((item) => category === "全部" || item.category === category);
    if (shuffleSeed === 0) return filtered;
    return [...filtered].sort(() => Math.random() - 0.5);
  }, [category, shuffleSeed]);

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title"><IconRss />信息流</h2>
        <button className="btn" onClick={() => setShuffleSeed(Date.now())}><IconRefresh />刷新</button>
      </div>
      <div className="chip-row" style={{ marginBottom: 16 }}>
        {FEED_CATEGORIES.map((c) => (
          <button key={c} className={"chip" + (category === c ? " active" : "")} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <div className="feed-layout">
        <div className="feed-list">
          {items.map((item, idx) => <FeedCard key={item.id} item={item} rank={idx + 1} />)}
        </div>
        <QuoteCard />
      </div>
    </section>
  );
}

/** 工具箱分区 */
function ToolsSection({ showToast }) {
  return (
    <section>
      <div className="section-head">
        <h2 className="section-title"><IconWrench />工具箱</h2>
      </div>
      <div className="tool-grid">
        <PasswordTool showToast={showToast} />
        <TimestampTool showToast={showToast} />
        <WordCountTool />
        <ColorTool showToast={showToast} />
        <DiceTool />
        <FocusTimerTool showToast={showToast} />
      </div>
    </section>
  );
}

/** 应用根组件 */
function App() {
  const [skin, setSkin] = useAppState(() => loadStored("skin", "minimal"));
  const [theme, setTheme] = useAppState(() => loadStored("theme", "light"));
  const [section, setSection] = useAppState(() => loadStored("section", "favorites"));
  const [favorites, setFavorites] = useAppState(() => loadStored("favorites", DEFAULT_FAVORITES));
  const [modalOpen, setModalOpen] = useAppState(false);
  const [toast, setToast] = useAppState("");
  const [now, setNow] = useAppState(() => new Date());

  useAppEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    document.documentElement.setAttribute("data-theme", theme);
    saveStored("skin", skin);
    saveStored("theme", theme);
  }, [skin, theme]);

  useAppEffect(() => { saveStored("section", section); }, [section]);
  useAppEffect(() => { saveStored("favorites", favorites); }, [favorites]);

  useAppEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  function showToast(message) {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  }

  function handleAddFavorite(data) {
    const newFav = { id: "f" + Date.now(), ...data };
    setFavorites([...favorites, newFav]);
    setModalOpen(false);
    showToast(`已收藏「${data.name}」`);
  }

  function handleDeleteFavorite(id) {
    const target = favorites.find((f) => f.id === id);
    setFavorites(favorites.filter((f) => f.id !== id));
    if (target) showToast(`已删除「${target.name}」`);
  }

  return (
    <div className="app-shell">
      <Sidebar
        section={section} onSectionChange={setSection}
        skin={skin} onSkinChange={setSkin}
        theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")}
      />
      <main className="main">
        <div className="main-inner">
          <div className="topbar">
            <div className="greeting">
              <h1>{getGreeting(now.getHours())}，欢迎回到万象台</h1>
              <p>{formatToday(now)}</p>
            </div>
          </div>
          {section === "favorites" && (
            <FavoritesSection favorites={favorites} onAdd={() => setModalOpen(true)} onDelete={handleDeleteFavorite} />
          )}
          {section === "feed" && <FeedSection />}
          {section === "tools" && <ToolsSection showToast={showToast} />}
        </div>
      </main>
      {modalOpen && <AddFavoriteModal onClose={() => setModalOpen(false)} onSubmit={handleAddFavorite} />}
      <Toast message={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
