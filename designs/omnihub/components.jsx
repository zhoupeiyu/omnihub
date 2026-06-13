/// 展示组件层 —— 侧边栏、收藏卡片、信息流卡片、弹窗、皮肤面板、Toast
const { useState, useEffect } = React;

/** 左侧导航栏（含皮肤切换与明暗切换） */
function Sidebar({ section, onSectionChange, skin, onSkinChange, theme, onThemeToggle }) {
  const [skinPanelOpen, setSkinPanelOpen] = useState(false);

  const navItems = [
    { id: "favorites", label: "网站收藏", icon: <IconBookmark /> },
    { id: "feed", label: "信息流", icon: <IconRss /> },
    { id: "tools", label: "工具箱", icon: <IconWrench /> },
  ];

  return (
    <aside className="sidebar" style={{ position: "relative" }}>
      <div className="brand">
        <div className="brand-logo">万</div>
        <div>
          <div className="brand-name">万象台</div>
          <div className="brand-sub">OMNIHUB</div>
        </div>
      </div>

      <nav className="nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={"nav-item" + (section === item.id ? " active" : "")}
            onClick={() => onSectionChange(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {skinPanelOpen && (
        <div className="skin-panel">
          {SKIN_LIST.map((s) => (
            <button
              key={s.id}
              className={"skin-option" + (skin === s.id ? " active" : "")}
              onClick={() => { onSkinChange(s.id); setSkinPanelOpen(false); }}
            >
              <span className="skin-dot" style={{ background: s.dot }}></span>
              {s.name}
              {skin === s.id && <IconCheck style={{ width: 14, height: 14, marginLeft: "auto" }} />}
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-foot">
        <div className="foot-row">
          <button className="btn" style={{ flex: 1 }} onClick={() => setSkinPanelOpen(!skinPanelOpen)}>
            <IconPalette />
            <span className="foot-label">皮肤</span>
          </button>
          <button className="btn btn-icon" onClick={onThemeToggle} title="切换明暗">
            {theme === "light" ? <IconMoon /> : <IconSun />}
          </button>
        </div>
      </div>
    </aside>
  );
}

/** 单个网站收藏卡片 */
function FavoriteCard({ fav, onDelete }) {
  const domain = getDomain(fav.url);
  return (
    <a className="fav-card" href={fav.url} target="_blank" rel="noopener noreferrer">
      <div className="fav-avatar" style={{ background: getAvatarColor(fav.name) }}>
        {fav.name.charAt(0).toUpperCase()}
      </div>
      <div>
        <div className="fav-name">{fav.name}</div>
        <div className="fav-domain">{domain}</div>
      </div>
      <button
        className="fav-del"
        title="删除收藏"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(fav.id); }}
      >
        <IconTrash />
      </button>
    </a>
  );
}

/** 添加收藏弹窗 */
function AddFavoriteModal({ onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
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
    onSubmit({ name: trimmedName, url: trimmedUrl, category });
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
            onChange={(e) => { setUrl(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }} />
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

/** 信息流条目卡片 */
function FeedCard({ item, rank }) {
  return (
    <article className="feed-card">
      <div className={"feed-rank" + (rank <= 3 ? " hot" : "")}>{rank}</div>
      <div className="feed-body">
        <h3 className="feed-title">{item.title}</h3>
        <div className="feed-meta">
          <span className="feed-tag">{item.category}</span>
          <span>{item.source}</span>
          <span>{item.time}</span>
        </div>
      </div>
      <div className="feed-heat">{item.heat}</div>
    </article>
  );
}

/** 每日一言卡片（在线获取，失败时使用本地语录） */
function QuoteCard() {
  const [quote, setQuote] = useState(null);

  function pickFallback() {
    const idx = Math.floor(Math.random() * FALLBACK_QUOTES.length);
    setQuote(FALLBACK_QUOTES[idx]);
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
      <div style={{ marginTop: 14, textAlign: "right" }}>
        <button className="btn btn-ghost" onClick={fetchQuote}><IconRefresh />换一句</button>
      </div>
    </aside>
  );
}

/** 底部提示气泡 */
function Toast({ message }) {
  if (!message) return null;
  return <div className="toast"><IconCheck />{message}</div>;
}

Object.assign(window, {
  Sidebar, FavoriteCard, AddFavoriteModal, FeedCard, QuoteCard, Toast,
});
