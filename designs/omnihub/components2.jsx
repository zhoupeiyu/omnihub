/// v2 展示组件 —— 顶栏（搜索/皮肤/明暗）、侧边栏（模块+分类计数）、
/// 收藏卡片（favicon 自动获取+描述）、弹窗、信息流、回到顶部
const { useState, useEffect } = React;

/* 补充图标（沿用 1.8px 描边规范） */
const dIcon2Base = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" };
const IconArrowUpRight = (props) => (<svg {...dIcon2Base} {...props}><path d="M7 17L17 7M17 7H8M17 7v9" /></svg>);
const IconArrowUp = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 19V5M5 12l7-7 7 7" /></svg>);
const IconSparkle = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></svg>);
const IconUpload = (props) => (<svg {...dIcon2Base} {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>);

/** 网站图标：优先在线 favicon，加载失败时退回首字母 */
function Favicon({ url, name, onStatusChange }) {
  const [failed, setFailed] = useState(false);
  const domain = getDomain(url);
  useEffect(() => { if (onStatusChange) onStatusChange(failed); }, [failed]);
  if (failed) return <span>{name.charAt(0).toUpperCase()}</span>;
  return (
    <img
      src={"https://favicon.im/" + domain}
      alt="" loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 顶栏：品牌 + 全局搜索 + 皮肤切换 + 明暗切换 */
function Header({ query, onQueryChange, skin, onSkinChange, theme, onThemeToggle, searchPlaceholder }) {
  const [skinPanelOpen, setSkinPanelOpen] = useState(false);
  return (
    <header className="header-bar">
      <div className="header-inner">
        <div className="logo-mark">万</div>
        <div>
          <div className="brand-title">万象台</div>
          <div className="brand-sub">OMNIHUB</div>
        </div>
        <div className="search-wrap">
          <IconSearch />
          <input className="search-input" placeholder={searchPlaceholder}
            value={query} onChange={(e) => onQueryChange(e.target.value)} />
        </div>
        <div className="header-actions">
          <button className="btn btn-icon" title="切换皮肤" onClick={() => setSkinPanelOpen(!skinPanelOpen)}>
            <IconPalette />
          </button>
          <button className="btn btn-icon" title="切换明暗" onClick={onThemeToggle}>
            {theme === "light" ? <IconMoon /> : <IconSun />}
          </button>
          {skinPanelOpen && (
            <div className="skin-panel">
              {SKIN_LIST.map((s) => (
                <button key={s.id} className={"skin-option" + (skin === s.id ? " active" : "")}
                  onClick={() => { onSkinChange(s.id); setSkinPanelOpen(false); }}>
                  <span className="skin-dot" style={{ background: s.dot }}></span>
                  {s.name}
                  {skin === s.id && <IconCheck style={{ width: 14, height: 14, marginLeft: "auto" }} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/** 侧边栏：模块导航 + 当前模块分类（带计数） */
function SideNav({ section, onSectionChange, categories, activeCategory, onCategoryChange, counts }) {
  const modules = [
    { id: "favorites", label: "网站收藏", icon: <IconBookmark /> },
    { id: "prompts", label: "提示词", icon: <IconSparkle /> },
    { id: "feed", label: "信息流", icon: <IconRss /> },
    { id: "tools", label: "工具箱", icon: <IconWrench /> },
  ];
  return (
    <aside className="sidebar">
      <p className="side-label">模块</p>
      <nav>
        {modules.map((m) => (
          <button key={m.id} className={"nav-item" + (section === m.id ? " active" : "")}
            onClick={() => onSectionChange(m.id)}>
            {m.icon}{m.label}
          </button>
        ))}
      </nav>
      {categories && categories.length > 0 && (
        <React.Fragment>
          <p className="side-label">分类</p>
          <nav>
            {categories.map((c) => (
              <button key={c} className={"nav-item" + (activeCategory === c ? " active" : "")}
                onClick={() => onCategoryChange(c)}>
                <span className="nav-dot"></span>
                {c}
                <span className="nav-count">{counts[c] != null ? counts[c] : ""}</span>
              </button>
            ))}
          </nav>
        </React.Fragment>
      )}
    </aside>
  );
}

/** 区块标题：图标 + 标题 + 计数徽章 + 右侧操作 */
function SectionHead({ icon, title, count, children }) {
  return (
    <div className="section-head">
      <h2 className="section-title">{icon}{title}</h2>
      {count != null && <span className="badge-count">{count}</span>}
      <div className="section-actions">{children}</div>
    </div>
  );
}

/** 收藏卡片：favicon 头像 + 名称 + 一句话描述 */
function FavCardV2({ fav, onDelete }) {
  const [iconFailed, setIconFailed] = useState(false);
  const domain = getDomain(fav.url);
  return (
    <a className="fav-card" href={fav.url} target="_blank" rel="noopener noreferrer">
      <div className="fav-avatar"
        style={{ background: iconFailed ? getAvatarColor(fav.name) : "var(--bg-sunken)" }}>
        <Favicon url={fav.url} name={fav.name} onStatusChange={setIconFailed} />
      </div>
      <div className="fav-body">
        <div className="fav-name-row">
          <span className="fav-name">{fav.name}</span>
          <IconArrowUpRight className="fav-arrow" />
        </div>
        <p className="fav-desc">{fav.desc || domain}</p>
      </div>
      <button className="card-del" title="删除收藏"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(fav.id); }}>
        <IconTrash />
      </button>
    </a>
  );
}

/** 添加收藏弹窗（含一句话描述） */
function AddFavModalV2({ onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState(FAV_CATEGORIES[0]);
  const [error, setError] = useState("");

  function handleSubmit() {
    const trimmedName = name.trim();
    let trimmedUrl = url.trim();
    if (!trimmedName) { setError("请填写网站名称"); return; }
    if (!trimmedUrl) { setError("请填写网址"); return; }
    if (!/^https?:\/\//i.test(trimmedUrl)) trimmedUrl = "https://" + trimmedUrl;
    try { new URL(trimmedUrl); }
    catch (err) { setError("网址格式不正确"); return; }
    onSubmit({ name: trimmedName, url: trimmedUrl, desc: desc.trim(), category });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>添加网站收藏</h2>
        <div className="form-field">
          <label>网站名称</label>
          <input className="input" placeholder="例如：哔哩哔哩" value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }} autoFocus />
        </div>
        <div className="form-field">
          <label>网址</label>
          <input className="input" placeholder="例如：bilibili.com" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label>一句话描述（可选）</label>
          <input className="input" placeholder="这个网站是做什么的" value={desc}
            onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="form-field">
          <label>分类</label>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {FAV_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {error && <p style={{ color: "oklch(58% 0.2 25)", fontSize: 13, fontWeight: 600 }}>{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}><IconPlus />添加</button>
        </div>
      </div>
    </div>
  );
}

/** 信息流卡片 */
function FeedCardV2({ item, rank }) {
  return (
    <article className="feed-card">
      <div className={"feed-rank" + (rank <= 3 ? " hot" : "")}>{rank}</div>
      <div className="feed-body">
        <h3 className="feed-title">{item.title}</h3>
        <div className="feed-meta">
          <span className="tag-chip">{item.category}</span>
          <span>{item.source}</span>
          <span>{item.time}</span>
        </div>
      </div>
      <div className="feed-heat">{item.heat}</div>
    </article>
  );
}

/** 每日一言卡片 */
function QuoteCardV2() {
  const [quote, setQuote] = useState(null);

  function pickFallback() {
    setQuote(FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)]);
  }

  function fetchQuote() {
    setQuote(null);
    fetch("https://v1.hitokoto.cn/?c=d&c=i&c=k")
      .then((res) => res.json())
      .then((json) => setQuote({ text: json.hitokoto, from: json.from || "一言" }))
      .catch(pickFallback);
  }

  useEffect(fetchQuote, []);

  return (
    <aside className="quote-card">
      <span className="quote-mark">“</span>
      <p className="quote-text">{quote ? quote.text : "正在取一句好话……"}</p>
      <p className="quote-from">—— {quote ? quote.from : ""}</p>
      <div style={{ marginTop: 12, textAlign: "right" }}>
        <button className="btn btn-ghost" onClick={fetchQuote}><IconRefresh />换一句</button>
      </div>
    </aside>
  );
}

/** 空状态 */
function EmptyState({ message, hint }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><IconSearch /></div>
      <p style={{ fontWeight: 600, color: "var(--text-2)" }}>{message}</p>
      {hint && <p style={{ marginTop: 4, fontSize: 12.5 }}>{hint}</p>}
    </div>
  );
}

/** 回到顶部按钮 */
function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button className={"back-top" + (visible ? "" : " hidden")} title="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
      <IconArrowUp />
    </button>
  );
}

/** 提示气泡 */
function ToastV2({ message }) {
  if (!message) return null;
  return <div className="toast"><IconCheck />{message}</div>;
}

Object.assign(window, {
  IconArrowUpRight, IconArrowUp, IconSparkle, IconUpload,
  Favicon, Header, SideNav, SectionHead,
  FavCardV2, AddFavModalV2, FeedCardV2, QuoteCardV2,
  EmptyState, BackToTop, ToastV2,
});
