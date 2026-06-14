/// 展示组件 —— 顶栏（搜索/AI设置/皮肤/明暗/退出）、侧边栏、收藏卡片、弹窗、信息流等
const { useState, useEffect } = React;

/* 补充图标（沿用 1.8px 描边规范） */
const dIcon2Base = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" };
const IconArrowUpRight = (props) => (<svg {...dIcon2Base} {...props}><path d="M7 17L17 7M17 7H8M17 7v9" /></svg>);
const IconArrowUp = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 19V5M5 12l7-7 7 7" /></svg>);
const IconSparkle = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></svg>);
const IconWoodFish = (props) => (
  <svg viewBox="0 0 64 64" fill="none" {...props}>
    <defs>
      <linearGradient id="wf-body" x1="10" y1="24" x2="40" y2="58" gradientUnits="userSpaceOnUse">
        <stop stopColor="#e0ad6a" /><stop offset="1" stopColor="#965f24" />
      </linearGradient>
    </defs>
    <ellipse cx="27" cy="41" rx="24" ry="18" fill="url(#wf-body)" />
    <path d="M8 37c9-6 29-6 40 5-9-8-31-8-40-5Z" fill="#43290f" />
    <path d="M11 43c8 3 22 3 32-1" stroke="#7a4f25" strokeWidth="2" opacity=".45" />
    <line x1="44" y1="27" x2="59" y2="36" stroke="#caa06e" strokeWidth="4.8" strokeLinecap="round" />
    <circle cx="44" cy="27" r="5" fill="#e2c197" />
  </svg>
);
const IconUpload = (props) => (<svg {...dIcon2Base} {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>);
const IconUser = (props) => (<svg {...dIcon2Base} {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></svg>);
const IconLogout = (props) => (<svg {...dIcon2Base} {...props}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>);
const IconSend = (props) => (<svg {...dIcon2Base} {...props}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>);
const IconSettings = (props) => (<svg {...dIcon2Base} {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);

/** 网站图标：优先在线 favicon，加载失败时退回首字母 */
function Favicon({ url, name, onStatusChange }) {
  const [failed, setFailed] = useState(false);
  const domain = getDomain(url);
  useEffect(() => { if (onStatusChange) onStatusChange(failed); }, [failed]);
  if (failed) return <span>{name.charAt(0).toUpperCase()}</span>;
  return (
    <img src={"https://favicon.im/" + domain} alt="" loading="lazy"
      onError={() => setFailed(true)} />
  );
}

/** 顶栏：品牌 + 问候/时间 + 全局搜索（操作按钮都在侧边栏左下角） */
function Header({ query, onQueryChange, searchPlaceholder, greeting, dateText }) {
  return (
    <header className="header-bar">
      <div className="header-inner">
        <div className="logo-mark">万</div>
        <div>
          <div className="brand-title">万象台</div>
          <div className="brand-sub">OMNIHUB</div>
        </div>
        <div className="header-greet">
          <span className="greet-main">{greeting}</span>
          <span className="greet-sub">{dateText}</span>
        </div>
        <div className="search-wrap">
          <IconSearch />
          <input className="search-input" placeholder={searchPlaceholder}
            value={query} onChange={(e) => onQueryChange(e.target.value)} />
        </div>
      </div>
    </header>
  );
}

/** 侧边栏：模块导航 + 分类（带计数）+ 左下角「用户信息 + 设置」 */
function SideNav({ section, onSectionChange, categories, activeCategory, onCategoryChange, counts,
                   user, quote, skin, onSkinChange, theme, onThemeToggle, onOpenAiSettings, onLogin, onLogout }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState(null);
  const gearRef = React.useRef(null);
  function toggleSettings() {
    if (!settingsOpen && gearRef.current) {
      const r = gearRef.current.getBoundingClientRect();
      const sidebar = gearRef.current.closest(".sidebar");
      const rightEdge = sidebar ? sidebar.getBoundingClientRect().right : r.right;
      setPanelStyle({ left: (rightEdge + 8) + "px", bottom: (window.innerHeight - r.bottom) + "px" });
    }
    setSettingsOpen((v) => !v);
  }

  // 点击弹窗与设置按钮以外的区域时收起设置弹窗
  useEffect(() => {
    if (!settingsOpen) return;
    function onDocMouseDown(e) {
      if (gearRef.current && gearRef.current.contains(e.target)) return;
      const panel = document.querySelector(".skin-panel");
      if (panel && panel.contains(e.target)) return;
      setSettingsOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [settingsOpen]);
  const allModules = [
    { id: "feed", label: "信息流", icon: <IconRss /> },
    { id: "prompts", label: "提示词", icon: <IconSparkle /> },
    { id: "favorites", label: "网站收藏", icon: <IconBookmark /> },
    { id: "chat", label: "AI 对话", icon: <IconSend /> },
    { id: "tools", label: "工具箱", icon: <IconWrench /> },
  ];
  // 游客仅可见无需账号的模块（信息流 / 工具箱）
  const modules = user ? allModules : allModules.filter((m) => m.id === "feed" || m.id === "tools");
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
      <div className="sidebar-foot">
        {ReactDOM.createPortal((
          <div className={"skin-panel" + (settingsOpen ? " open" : "")} style={panelStyle || undefined}>
            {user && (
              <button className="skin-option" onClick={() => { setSettingsOpen(false); onOpenAiSettings(); }}>
                <IconSettings style={{ width: 15, height: 15 }} />AI 设置
              </button>
            )}
            <button className="skin-option" onClick={onThemeToggle}>
              <IconMoon style={{ width: 15, height: 15 }} />深色模式
              <span className="menu-right">
                <span className={"mini-switch" + (theme === "dark" ? " on" : "")}></span>
              </span>
            </button>
            <div className="skin-row">
              <IconPalette />皮肤
              <span className="menu-right">
                {SKIN_LIST.map((s) => (
                  <button key={s.id} title={s.name}
                    className={"skin-dot-btn" + (skin === s.id ? " active" : "")}
                    style={{ background: s.dot }}
                    onClick={() => onSkinChange(s.id)}>
                  </button>
                ))}
              </span>
            </div>
            <div className="menu-divider"></div>
            {user ? (
              <button className="skin-option" onClick={onLogout}>
                <IconLogout style={{ width: 15, height: 15 }} />退出登录
              </button>
            ) : (
              <button className="skin-option" onClick={() => { setSettingsOpen(false); onLogin(); }}>
                <IconUser style={{ width: 15, height: 15 }} />登录 / 注册
              </button>
            )}
          </div>
        ), document.body)}
        <QuoteCard quote={quote} />
        {user ? (
          <div className="user-strip">
            <span className="user-avatar">{user.username.charAt(0).toUpperCase()}</span>
            <span className="user-name" title={user.username}>{user.username}</span>
            <button ref={gearRef} className={"strip-btn" + (settingsOpen ? " open" : "")} title="设置"
              onClick={toggleSettings}>
              <IconSettings />
            </button>
          </div>
        ) : (
          <div className="user-strip">
            <span className="user-avatar user-avatar-guest" onClick={onLogin} title="登录 / 注册"><IconUser /></span>
            <span className="user-name guest-name" onClick={onLogin}>请登录</span>
            <button ref={gearRef} className={"strip-btn" + (settingsOpen ? " open" : "")} title="设置"
              onClick={toggleSettings}>
              <IconSettings />
            </button>
          </div>
        )}
      </div>
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

/** 收藏卡片：favicon 头像 + 名称 + 一句话描述 + 编辑/删除 */
function FavCardV2({ fav, onEdit, onDelete }) {
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
      <button className="card-edit" title="编辑收藏"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(fav); }}>
        <IconEdit />
      </button>
      <button className="card-del" title="删除收藏"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(fav.id); }}>
        <IconTrash />
      </button>
    </a>
  );
}

/** 添加 / 编辑收藏弹窗（editing 传入收藏对象时为编辑模式） */
function AddFavModalV2({ editing, onClose, onSubmit }) {
  const [name, setName] = useState(editing ? editing.name : "");
  const [url, setUrl] = useState(editing ? editing.url : "");
  const [desc, setDesc] = useState(editing ? (editing.desc || "") : "");
  const [category, setCategory] = useState(editing ? editing.category : FAV_CATEGORIES[0]);
  const [error, setError] = useState("");

  function handleSubmit() {
    const trimmedName = name.trim();
    let trimmedUrl = url.trim();
    if (!trimmedName) { setError("请填写网站名称"); return; }
    if (!trimmedUrl) { setError("请填写网址"); return; }
    if (!/^https?:\/\//i.test(trimmedUrl)) trimmedUrl = "https://" + trimmedUrl;
    try { new URL(trimmedUrl); }
    catch (err) { setError("网址格式不正确"); return; }
    onSubmit({ name: trimmedName, url: trimmedUrl, desc: desc.trim(), category }, editing ? editing.id : null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? "编辑收藏" : "添加网站收藏"}</h2>
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
        {error && <p className="auth-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {editing ? <IconCheck /> : <IconPlus />}{editing ? "保存" : "添加"}
          </button>
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

/** 信息流条目（标题点击打开原文）；富源额外显示精选分与分类 */
/** 信息流头像：仅当有真实头像且加载成功时显示，否则不渲染 */
function FeedAvatar({ avatar }) {
  const [failed, setFailed] = useState(false);
  if (!avatar || failed) return null;
  return <img className="feed-avatar" src={avatar} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** 图片放大悬浮层：点击遮罩、关闭按钮或按 Esc 关闭 */
function ImageLightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <img className="lightbox-img" src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={onClose} title="关闭">✕</button>
    </div>
  );
}

function FeedItem({ item, rank, showRank, onPreview }) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const images = Array.isArray(item.images) ? item.images : [];
  return (
    <a className="feed-card" href={item.url || "#"} target="_blank" rel="noopener noreferrer">
      {showRank && <div className={"feed-rank" + (rank <= 3 ? " hot" : "")}>{rank}</div>}
      {typeof item.score === "number" && (
        <div className="feed-corner">
          <span className="feed-score" title="评分">{item.score}</span>
        </div>
      )}
      <div className="feed-body">
        <div className="feed-title-row">
          <h3 className="feed-title">{item.title}</h3>
        </div>
        {item.summary && <p className="feed-summary">{item.summary}</p>}
        {images.length > 0 && (
          <div className="feed-imgs">
            {images.slice(0, 4).map((src, i) => (
              <img className="feed-img" key={i} src={src} alt="" loading="lazy"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (onPreview) onPreview(src); }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ))}
          </div>
        )}
        {(tags.length > 0 || item.duplicateCount > 0 || item.origin) && (
          <div className="feed-tags">
            {tags.map((t, i) => <span className="tag-chip" key={i}>{t}</span>)}
            {item.duplicateCount > 0 && <span className="feed-related">关联讨论 {item.duplicateCount} 条</span>}
            {item.origin && (
              <span className="feed-origin">
                <FeedAvatar avatar={item.avatar} />
                {item.origin}
              </span>
            )}
          </div>
        )}
        {item.reason && (
          <div className="feed-reason"><span className="feed-reason-label">推荐理由</span>{item.reason}</div>
        )}
      </div>
    </a>
  );
}

/** 木鱼敲击音效：用 Web Audio 合成一声短促的「笃」（无需音频文件） */
function playWoodFishSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = playWoodFishSound._ctx || (playWoodFishSound._ctx = new Ctx());
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(640, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.32, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.start(t); osc.stop(t + 0.24);
  } catch (err) { /* 音频不可用时静默 */ }
}

/** 侧边栏底部·每日一言卡片（仅展示句子，换句由悬浮木鱼触发） */
function QuoteCard({ quote }) {
  return (
    <div className="woodfish-box">
      <span className="wf-quote-mark">“</span>
      <p className="woodfish-quote">{quote ? quote.text : "正在取一句好话……"}</p>
      {quote && <p className="woodfish-from">{quote.from}</p>}
    </div>
  );
}

/** 悬浮木鱼：可拖动、吸附屏幕左右边，点击敲响（功德 +1 + 波纹 + 音效 + 换句） */
function FloatingWoodFish({ onKnock }) {
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("omnihub_wf_pos2") || "null");
      if (saved && (saved.side === "left" || saved.side === "right")) return saved;
    } catch (err) { /* 忽略 */ }
    return { side: "left", top: 0.82 };
  });
  const [knocking, setKnocking] = useState(false);
  const [pops, setPops] = useState([]);
  const [ripples, setRipples] = useState([]);

  // 首次（无保存位置）默认定位到侧边栏「每日一言」卡片的正上方
  useEffect(() => {
    let saved = null;
    try { saved = localStorage.getItem("omnihub_wf_pos2"); } catch (err) { /* 忽略 */ }
    if (saved) return;
    const card = document.querySelector(".woodfish-box");
    if (!card) return;
    const top = Math.max(0.04, (card.getBoundingClientRect().top - 66 - 10) / window.innerHeight);
    setPos({ side: "left", top });
  }, []);

  function knock() {
    setKnocking(true);
    setTimeout(() => setKnocking(false), 160);
    playWoodFishSound();
    const id = Date.now() + Math.random();
    setPops((list) => [...list, id]);
    const rids = [0, 1, 2, 3].map((i) => ({ id: id + "_" + i, delay: i * 0.11 }));
    setRipples((list) => [...list, ...rids]);
    setTimeout(() => setPops((list) => list.filter((x) => x !== id)), 850);
    setTimeout(() => setRipples((list) => list.filter((r) => !rids.some((x) => x.id === r.id))), 1100);
    if (onKnock) onKnock();
  }

  function onPointerDown(e) {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const el = e.currentTarget;
    let moved = false;
    function onMove(ev) {
      if (!moved && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) moved = true;
      if (moved) {
        el.style.left = (ev.clientX - 26) + "px";
        el.style.top = (ev.clientY - 26) + "px";
        el.style.right = "auto"; el.style.bottom = "auto";
      }
    }
    function onUp(ev) {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!moved) { knock(); return; }
      const side = ev.clientX < window.innerWidth / 2 ? "left" : "right";
      const top = Math.min(0.9, Math.max(0.05, (ev.clientY - 26) / window.innerHeight));
      const next = { side, top };
      setPos(next);
      try { localStorage.setItem("omnihub_wf_pos2", JSON.stringify(next)); } catch (err) { /* 忽略 */ }
      el.style.left = ""; el.style.top = ""; el.style.right = ""; el.style.bottom = "";
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  const style = pos.side === "left"
    ? { left: "12px", top: (pos.top * 100) + "%" }
    : { right: "12px", top: (pos.top * 100) + "%" };

  return (
    <div className={"wf-float" + (knocking ? " knock" : "")} style={style}
      onPointerDown={onPointerDown} title="敲木鱼（可拖动）">
      {ripples.map((r) => <span className="wf-ripple" key={r.id} style={{ animationDelay: r.delay + "s" }} />)}
      <span className="woodfish-icon"><IconWoodFish /></span>
      {pops.map((id) => <span className="merit-pop" key={id}>功德 +1</span>)}
    </div>
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
  IconArrowUpRight, IconArrowUp, IconSparkle, IconUpload, IconUser, IconLogout, IconSend, IconSettings,
  Favicon, Header, SideNav, SectionHead,
  FavCardV2, AddFavModalV2, FeedCardV2, FeedItem, ImageLightbox, FloatingWoodFish,
  EmptyState, BackToTop, ToastV2,
});
