/// 展示组件 —— 顶栏（搜索/AI设置/皮肤/明暗/退出）、侧边栏、收藏卡片、弹窗、信息流等
const { useState, useEffect, useRef: useCmpRef, useLayoutEffect: useCmpLayoutEffect, useMemo: useCmpMemo } = React;

/* 全局滚动锁：任意 modal/drawer/lightbox 出现时锁 body 滚动，避免背后页面被滚动 */
(function setupScrollLock() {
  if (typeof window === "undefined" || window._omnihubScrollLockReady) return;
  window._omnihubScrollLockReady = true;
  const update = () => {
    const hasOverlay = document.querySelector(".modal-overlay, .drawer-overlay, .lightbox");
    if (hasOverlay) {
      if (!document.body.dataset.scrollLocked) {
        document.body.dataset.scrollLocked = "1";
        document.body.dataset.prevOverflow = document.body.style.overflow || "";
        document.body.style.overflow = "hidden";
      }
    } else if (document.body.dataset.scrollLocked) {
      document.body.style.overflow = document.body.dataset.prevOverflow || "";
      delete document.body.dataset.scrollLocked;
      delete document.body.dataset.prevOverflow;
    }
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
})();

/* ============================================================
   通用动效组件（参考 transitions.dev）
   ============================================================ */

/** 数字 pop-in：只对真正变化的位重挂载触发动画，未变的位保持静止避免连续敲击抖动 */
function AnimatedNumber({ value, className }) {
  const str = String(value == null ? "" : value);
  // 从右往左对齐：同位置上字符相同就稳定，变化时 key 含一个递增序号让它重新挂载
  const prevRef = useCmpRef("");
  const seqRef = useCmpRef([]);
  const prev = prevRef.current;
  const prevLen = prev.length;
  const len = str.length;
  const nextSeq = [];
  for (let i = 0; i < len; i++) {
    const fromRight = len - 1 - i;
    const ch = str[i];
    const prevIndex = prevLen - 1 - fromRight;
    const oldCh = prevIndex >= 0 ? prev[prevIndex] : null;
    const oldSeq = prevIndex >= 0 ? (seqRef.current[prevIndex] || 0) : 0;
    nextSeq.push(oldCh === ch ? oldSeq : (oldSeq + 1));
  }
  prevRef.current = str;
  seqRef.current = nextSeq;
  return (
    <span className={"anim-num" + (className ? " " + className : "")}>
      {str.split("").map((ch, i) => {
        const seq = nextSeq[i];
        return (
          <span key={i + ":" + ch + ":" + seq} className="anim-num-digit">{ch}</span>
        );
      })}
    </span>
  );
}

/** 文字 blur swap：value 变化时旧文先 blur 出，新文 blur 入 */
function BlurText({ value, as, className, style }) {
  const Tag = as || "span";
  const [display, setDisplay] = useState(value);
  const [phase, setPhase] = useState("idle"); // idle | leaving | entering
  const pendingRef = useCmpRef(value);
  useEffect(() => {
    if (value === display) return;
    pendingRef.current = value;
    setPhase("leaving");
    const t1 = setTimeout(() => {
      setDisplay(pendingRef.current);
      setPhase("entering");
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
    }, 220);
    return () => clearTimeout(t1);
  }, [value]);
  const cls = "blur-text"
    + (phase === "leaving" ? " is-leaving" : "")
    + (phase === "entering" ? " is-entering" : "")
    + (className ? " " + className : "");
  return <Tag className={cls} style={style}>{display}</Tag>;
}

/** 折叠面板：grid-rows 0fr↔1fr + chevron 旋转 */
function Collapsible({ title, defaultOpen, children }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className={"collapsible" + (open ? " open" : "")}>
      <button className="collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {title}
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      <div className="collapsible-grid">
        <div className="collapsible-inner">
          <div className="collapsible-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * 滑动 pill 容器：测量子项 active 项位置，跟随平移指示器。
 * children 由外层渲染（保留原有 .feed-source / .filter-chip 等结构）。
 * activeKey 用于触发位置重测；pillVariant: "block"|"chip" 控制圆角与配色。
 */
function PillTabs({ activeKey, pillVariant, className, children }) {
  const wrapRef = useCmpRef(null);
  const [rect, setRect] = useState(null);
  useCmpLayoutEffect(() => {
    if (!wrapRef.current) return;
    const measure = () => {
      const el = wrapRef.current && wrapRef.current.querySelector(".active");
      if (!el) { setRect(null); return; }
      const parent = wrapRef.current.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setRect({
        x: r.left - parent.left,
        y: r.top - parent.top,
        w: r.width,
        h: r.height,
      });
    };
    measure();
    const ro = window.ResizeObserver ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeKey, children]);
  const indicatorStyle = rect
    ? { transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w + "px", height: rect.h + "px" }
    : { opacity: 0 };
  const cls = "tabs-pill-wrap"
    + (pillVariant === "chip" ? " pill-chip-mode" : "")
    + (className ? " " + className : "");
  return (
    <div ref={wrapRef} className={cls}>
      <span className={"tabs-pill-indicator"
        + (rect ? " ready" : "")
        + (pillVariant === "chip" ? " pill-chip" : "")}
        style={indicatorStyle} />
      {children}
    </div>
  );
}

/** 信息流加载骨架占位（与 feed-card 同尺寸）*/
function FeedSkeleton({ count, leaving }) {
  const n = count || 6;
  return (
    <div className={"feed-skeleton-list" + (leaving ? " leaving" : "")}>
      {Array.from({ length: n }, (_, i) => (
        <div className="feed-skeleton-card" key={i}>
          <div className="feed-skeleton-rank" />
          <div className="feed-skeleton-body">
            <div className="sk-line lg" />
            <div className="sk-line" style={{ width: "92%" }} />
            <div className="sk-line sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* 补充图标（沿用 1.8px 描边规范） */
const dIcon2Base = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" };
const IconArrowUpRight = (props) => (<svg {...dIcon2Base} {...props}><path d="M7 17L17 7M17 7H8M17 7v9" /></svg>);
const IconArrowUp = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 19V5M5 12l7-7 7 7" /></svg>);
const IconSparkle = (props) => (<svg {...dIcon2Base} {...props}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></svg>);
/** 木鱼身（居中，不含木槌） */
const IconWoodFish = (props) => (
  <svg viewBox="0 0 64 64" fill="none" {...props}>
    <defs>
      <linearGradient id="wf-body" x1="12" y1="18" x2="44" y2="56" gradientUnits="userSpaceOnUse">
        <stop stopColor="#e0ad6a" /><stop offset="1" stopColor="#965f24" />
      </linearGradient>
    </defs>
    <ellipse cx="32" cy="37" rx="27" ry="20" fill="url(#wf-body)" />
    <path d="M9 33c10-7 34-7 46 6-10-9-36-9-46-6Z" fill="#43290f" />
    <path d="M13 39c9 3 25 3 37-1" stroke="#7a4f25" strokeWidth="2.2" opacity=".45" />
  </svg>
);

/** 木槌（独立图层）：锤头在左下作敲击端，柄向右上（手持端） */
const IconMallet = (props) => (
  <svg viewBox="0 0 48 48" fill="none" {...props}>
    <line x1="16" y1="32" x2="40" y2="9" stroke="#caa06e" strokeWidth="6" strokeLinecap="round" />
    <circle cx="16" cy="32" r="7.5" fill="#e2c197" />
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
function Header({ query, onQueryChange, searchPlaceholder, greeting, dateText, sidebarCollapsed, onToggleSidebar }) {
  return (
    <header className="header-bar">
      <div className="header-inner">
        <button className={"header-toggle" + (sidebarCollapsed ? " collapsed" : "")}
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <div className="logo-mark" aria-hidden="true">
          <img src="/assets/omnihub-logo.svg" alt="" />
        </div>
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
                   user, quote, merit, skin, onSkinChange, theme, onThemeToggle,
                   woodFishEnabled, onWoodFishToggle, onOpenAiSettings, onLogin, onLogout,
                   collapsed }) {
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

  // 侧栏收起时同步关闭设置面板
  useEffect(() => {
    if (collapsed) setSettingsOpen(false);
  }, [collapsed]);
  const allModules = [
    { id: "feed", label: "信息流", icon: <IconRss /> },
    { id: "prompts", label: "提示词", icon: <IconSparkle /> },
    { id: "favorites", label: "网站收藏", icon: <IconBookmark /> },
    { id: "chat", label: "AI 对话", icon: <IconSend /> },
    { id: "tools", label: "工具箱", icon: <IconWrench /> },
  ];
  // 非白名单账号按游客权限处理，仅可见公开信息流
  const canUseFullApp = Boolean(user && user.fullAccess);
  const modules = canUseFullApp ? allModules : allModules.filter((m) => m.id === "feed");
  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")} aria-hidden={collapsed}>
      <p className="side-label">模块</p>
      <nav>
        {modules.map((m) => (
          <button key={m.id} className={"nav-item" + (section === m.id ? " active" : "")}
            onClick={() => onSectionChange(m.id)} tabIndex={collapsed ? -1 : 0}>
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
                onClick={() => onCategoryChange(c)} tabIndex={collapsed ? -1 : 0}>
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
            {canUseFullApp && (
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
            <button className="skin-option" onClick={onWoodFishToggle}>
              <IconTimer style={{ width: 15, height: 15 }} />悬浮木鱼
              <span className="menu-right">
                <span className={"mini-switch" + (woodFishEnabled ? " on" : "")}></span>
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
        <QuoteCard quote={quote} merit={merit} />
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
      {count != null && (
        <span className="badge-count"><AnimatedNumber value={count} /></span>
      )}
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
      {showRank && (
        <div className={"feed-rank" + (rank <= 3 ? " hot" : "")}>
          <AnimatedNumber value={rank} />
        </div>
      )}
      {typeof item.score === "number" && (
        <div className="feed-corner">
          <span className="feed-score" title="评分"><AnimatedNumber value={item.score} /></span>
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

/** 木鱼敲击音效：使用真实木鱼采样，连点时从头重放 */
function playWoodFishSound() {
  try {
    const audio = playWoodFishSound._audio || (playWoodFishSound._audio = new Audio("assets/woodfish/sound.mp3"));
    audio.preload = "auto";
    audio.volume = 0.9;
    audio.pause();
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch (err) { /* 音频不可用时静默 */ }
}

/** 侧边栏底部·每日一言卡片（仅展示句子，换句由悬浮木鱼触发） */
function QuoteCard({ quote, merit }) {
  return (
    <div className="woodfish-box">
      <span className="wf-quote-mark">“</span>
      <p className="woodfish-quote">
        <BlurText value={quote ? quote.text : "正在取一句好话……"} />
      </p>
      <div className="wf-foot">
        <span className="wf-merit">功德 <AnimatedNumber value={merit} /></span>
        {quote && (
          <span className="woodfish-from">—— <BlurText value={quote.from} /></span>
        )}
      </div>
    </div>
  );
}

/** 悬浮木鱼：可拖动、吸附屏幕左右边，点击敲响（功德 +1 + 波纹 + 音效 + 换句） */
const WF_SIZE = 50; // 木鱼悬浮区尺寸

function FloatingWoodFish({ onKnock, hidden }) {
  const [pos, setPos] = useState(null); // {x, y} 像素；null 时等首帧计算
  const [knocking, setKnocking] = useState(false);
  const [pops, setPops] = useState([]);
  const [hover, setHover] = useState(false);            // 鼠标是否悬停在木鱼上
  const [cursor, setCursor] = useState({ x: 24, y: 24 }); // 木锤跟随的相对坐标
  const [dragging, setDragging] = useState(false);       // 拖动中：木锤暂时隐藏

  // 允许的拖动范围：仅限侧边栏宽度内，纵向在「导航下方」到「一言卡片上方」之间
  function getBounds() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return null;
    const sb = sidebar.getBoundingClientRect();
    const navs = sidebar.querySelectorAll("nav");
    const navBottom = navs.length ? navs[navs.length - 1].getBoundingClientRect().bottom : sb.top + 80;
    const card = document.querySelector(".woodfish-box");
    const cardTop = card ? card.getBoundingClientRect().top : sb.bottom - 150;
    const minY = navBottom + 10;
    return {
      minX: sb.left + 6,
      maxX: sb.right - WF_SIZE - 6,
      minY,
      maxY: Math.max(minY, cardTop - WF_SIZE - 38),
    };
  }
  function clamp(x, y) {
    const b = getBounds();
    if (!b) return { x, y };
    return { x: Math.min(b.maxX, Math.max(b.minX, x)), y: Math.min(b.maxY, Math.max(b.minY, y)) };
  }

  // 默认定位到一言卡片正上方（侧边栏内居中）；卡片高度变化时重算
  useEffect(() => {
    const relocate = () => {
      const b = getBounds();
      if (!b) return;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem("omnihub_wf_pos5") || "null"); } catch (err) { /* 忽略 */ }
      if (saved && typeof saved.x === "number") setPos(clamp(saved.x, saved.y));
      else setPos({ x: b.minX, y: b.maxY });
    };
    relocate();
    let ro = null;
    const card = document.querySelector(".woodfish-box");
    if (window.ResizeObserver && card) { ro = new ResizeObserver(relocate); ro.observe(card); }
    const stop = setTimeout(() => { if (ro) ro.disconnect(); }, 4000);
    return () => { if (ro) ro.disconnect(); clearTimeout(stop); };
  }, []);

  function knock() {
    setKnocking(true);
    setTimeout(() => setKnocking(false), 340);
    playWoodFishSound();
    const id = Date.now() + Math.random();
    setPops((list) => [...list, id]);
    setTimeout(() => setPops((list) => list.filter((x) => x !== id)), 850);
    if (onKnock) onKnock();
  }

  function onPointerDown(e) {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    function onMove(ev) {
      if (!moved && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
        moved = true;
        setDragging(true);
      }
      if (moved) setPos(clamp(ev.clientX - WF_SIZE / 2, ev.clientY - WF_SIZE / 2));
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!moved) { knock(); return; }
      setDragging(false);
      setPos((p) => {
        try { localStorage.setItem("omnihub_wf_pos5", JSON.stringify(p)); } catch (err) { /* 忽略 */ }
        return p;
      });
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function onMouseMove(e) {
    if (dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  if (!pos) return null;
  const showMallet = hover && !dragging && !hidden;
  return (
    <div className={"wf-float" + (knocking ? " knock" : "") + (showMallet ? " hover" : "") + (hidden ? " hidden" : "")}
      style={{ left: pos.x + "px", top: pos.y + "px" }}
      onPointerDown={hidden ? undefined : onPointerDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseMove={onMouseMove}
      aria-hidden={hidden}
      title="敲木鱼（可拖动）">
      <img className="wf-body" src="assets/woodfish/muyu.webp" alt="木鱼" draggable="false" />
      {showMallet && (
        <img className="wf-mallet" src="assets/woodfish/hammer.png" alt=""
          draggable="false"
          style={{ left: cursor.x + "px", top: cursor.y + "px" }} />
      )}
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
  AnimatedNumber, BlurText, Collapsible, PillTabs, FeedSkeleton,
});
