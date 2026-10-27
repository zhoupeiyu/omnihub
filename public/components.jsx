/// 展示组件 —— 顶栏（搜索/AI设置/皮肤/明暗/退出）、侧边栏、收藏卡片、弹窗、信息流等
const { useState, useEffect, useRef: useCmpRef, useLayoutEffect: useCmpLayoutEffect, useMemo: useCmpMemo } = React;

/* 全局滚动锁：任意 modal/drawer/lightbox 出现时锁 body 滚动，避免背后页面被滚动 */
(function setupScrollLock() {
  if (typeof window === "undefined" || window._omnihubScrollLockReady) return;
  window._omnihubScrollLockReady = true;
  const update = () => {
    const hasOverlay = document.body.dataset.detailDrawerOpen || document.querySelector(".modal-overlay, .drawer-overlay, .lightbox, .inbox-media-overlay");
    if (hasOverlay) {
      if (!document.body.dataset.scrollLocked) {
        document.body.dataset.scrollLocked = "1";
        document.body.dataset.prevOverflow = document.body.style.overflow || "";
        document.body.dataset.prevPaddingRight = document.body.style.paddingRight || "";
        const bodyWidth = document.body.getBoundingClientRect().width;
        const padding = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
        document.body.style.overflow = "hidden";
        // Some browsers remove the root gutter when body overflow is locked.
        const lostGutter = document.body.getBoundingClientRect().width - bodyWidth;
        if (lostGutter > 0) document.body.style.paddingRight = `${padding + lostGutter}px`;
      }
    } else if (document.body.dataset.scrollLocked) {
      document.body.style.overflow = document.body.dataset.prevOverflow || "";
      document.body.style.paddingRight = document.body.dataset.prevPaddingRight || "";
      delete document.body.dataset.scrollLocked;
      delete document.body.dataset.prevOverflow;
      delete document.body.dataset.prevPaddingRight;
    }
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-detail-drawer-open'] });
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
const IconSidebar = (props) => (<svg {...dIcon2Base} {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>);
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

/** 顶栏：品牌 + 问候/时间 + 搜索 + 登录状态操作 */
function Header({ query, onQueryChange, searchPlaceholder, greeting, dateText, sidebarCollapsed, onToggleSidebar, moduleLabels, onToggleModuleLabels, user, onLogin, onLogout, showSearch = true }) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = event => setMobile(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const navigationExpanded = mobile ? !sidebarCollapsed : moduleLabels;
  const navigationTitle = mobile
    ? (sidebarCollapsed ? "展开侧栏" : "收起侧栏")
    : (moduleLabels ? "收起模块名称" : "展开模块名称");
  return (
    <header className="header-bar">
      <div className={'header-inner' + (showSearch ? ' has-search' : '')}>
        <button className={"header-toggle" + (!navigationExpanded ? " collapsed" : "")}
          onClick={mobile ? onToggleSidebar : onToggleModuleLabels}
          aria-expanded={navigationExpanded} aria-controls="workspace-sidebar"
          aria-label={navigationTitle} title={navigationTitle}>
          <IconSidebar />
        </button>
        <div className="logo-mark" aria-hidden="true">
          <img src="/assets/omnihub-logo.svg" alt="" />
        </div>
        <div className="header-brand">
          <div className="brand-title">万象台</div>
          <div className="brand-sub">OMNIHUB</div>
        </div>
        <div className="header-greet">
          <span className="greet-main">{greeting}</span>
          <span className="greet-sub">{dateText}</span>
        </div>
        {showSearch && <div className="search-wrap">
          <IconSearch />
          <input className="search-input" placeholder={searchPlaceholder}
            value={query} onChange={(e) => onQueryChange(e.target.value)} />
        </div>}
        <div className="header-actions">
          <button className="btn btn-ghost header-auth" onClick={user ? onLogout : onLogin}>
            {user ? <IconLogout /> : <IconUser />}
            {user ? '退出登录' : '登录 / 注册'}
          </button>
        </div>
      </div>
    </header>
  );
}

function ModuleRailButton({ tooltip, tooltipEnabled = true, buttonRef, children, ...props }) {
  const [position, setPosition] = useState(null);
  const tooltipId = React.useId();
  const dismiss = () => setPosition(null);
  function show(target) {
    if (!tooltipEnabled) return;
    const rect = target.getBoundingClientRect();
    setPosition({ left: rect.right + 8, top: Math.max(24, Math.min(window.innerHeight - 24, rect.top + rect.height / 2)) });
  }
  useEffect(() => { setPosition(null); }, [tooltipEnabled, tooltip]);
  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    const onKeyDown = event => { if (event.key === "Escape") hide(); };
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [position]);
  return <>
    <button {...props} ref={buttonRef} aria-describedby={position ? tooltipId : undefined}
      onPointerEnter={event => { if (event.pointerType !== "touch") show(event.currentTarget); }}
      onPointerLeave={dismiss} onPointerDown={dismiss}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget); }}
      onBlur={dismiss} onClick={event => { dismiss(); props.onClick?.(event); }}>
      {children}
    </button>
    {position && ReactDOM.createPortal(<span id={tooltipId} role="tooltip" className="module-tooltip" style={position}>{tooltip}</span>, document.body)}
  </>;
}

/** 侧边栏：模块导航 + 分类（带计数）+ 左下角「用户信息 + 账号/设置」 */
function SideNav({ section, onSectionChange, categories, activeCategory, onCategoryChange, counts, moduleCounts = {}, feedNavigation, onFeedNavigate,
                   user, quote, merit, skin, onSkinChange, theme, onThemeToggle,
                   woodFishEnabled, onWoodFishToggle, onOpenAiSettings, onOpenAccountSettings,
                   collapsed, moduleLabels }) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  const hidden = mobile && collapsed;
  const hasContext = Boolean(feedNavigation || categories?.length);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = event => setMobile(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const allModules = [
    { id: "repositories", label: "仓库库", icon: <IconBookmark /> },
    { id: "knowledgeLibrary", label: "知识库", icon: <IconBookOpen /> },
    { id: "promptLibrary", label: "提示词库", icon: <IconSparkle /> },
    { id: "inbox", label: "X 来源", icon: <IconInbox /> },
    { id: "feed", label: "资讯与监听", icon: <IconRss /> },
    { id: "resources", label: "资料", icon: <IconBookmark /> },
    { id: "works", label: "作品", icon: <IconPalette /> },
    { id: "studio", label: "创作台", icon: <IconPalette /> },
    { id: "chat", label: "AI 提炼台", icon: <IconSend /> },
    { id: "topics", label: "专题", icon: <IconSun /> },
    { id: "tools", label: "工具箱", icon: <IconWrench /> },
  ];
  // Published work is public. A signed-in person also gets their own private
  // inbox and connections, while the shared paid/admin tools stay zane-only.
  const canUseFullApp = Boolean(user && user.fullAccess);
  const hasPersonalSpace = Boolean(user && (user.personalAccess !== false));
  const modules = canUseFullApp ? allModules : allModules
    .filter((m) => ["repositories", "knowledgeLibrary", "promptLibrary", "feed", "topics", ...(hasPersonalSpace ? ["inbox", "studio", "works", "chat"] : [])].includes(m.id));
  return (
    <aside id="workspace-sidebar" className={"sidebar workspace-navigation" + (collapsed ? " collapsed" : "") + (hasContext ? " has-context" : "") + (moduleLabels ? " module-labels-visible" : "")} aria-hidden={hidden} inert={hidden ? "" : undefined}>
      <div className="module-rail">
      <nav className="module-nav" aria-label="模块">
        {modules.map((m) => (
          <ModuleRailButton key={m.id} className={"nav-item module-button" + (section === m.id ? " active" : "") + (m.id === "tools" ? " nav-secondary" : "")}
            aria-label={m.label} tooltip={m.label + (moduleCounts[m.id] != null ? ` · ${moduleCounts[m.id]}` : "")} tooltipEnabled={!moduleLabels && !hidden}
            aria-current={section === m.id ? "page" : undefined} onClick={() => onSectionChange(m.id)} tabIndex={hidden ? -1 : 0}>
            <span className="module-icon" aria-hidden="true">{m.icon}</span><span className="module-label">{m.label}</span>
            {moduleCounts[m.id] != null && <span className="nav-count module-label">{moduleCounts[m.id]}</span>}
          </ModuleRailButton>
        ))}
      </nav>
      {hasPersonalSpace && <div className="sidebar-foot">
        <ModuleRailButton className={"nav-item module-button" + (section === 'settings' ? " active" : "")}
          aria-label={`账号与设置：${user.username}`}
          tooltip={`账号与设置：${user.username}`} tooltipEnabled={!moduleLabels && !hidden}
          aria-current={section === 'settings' ? 'page' : undefined} onClick={onOpenAccountSettings}>
          <span className="module-icon" aria-hidden="true"><span className="user-avatar">{user.username.charAt(0).toUpperCase()}</span></span>
          <span className="module-label user-name">{user.username}</span>
        </ModuleRailButton>
      </div>}
      </div>
      {hasContext && <div className="workspace-context" hidden={collapsed}>
        {feedNavigation && <div className="repository-side-group feed-side-group">
          <div className="context-heading"><strong>资讯与监听</strong></div>
          <p className="side-label">内容视图</p>
          <nav aria-label="资讯与监听">
            {feedNavigation.items.map(item => <button key={item.id}
              className={"nav-item repository-category watch-navigation-item" + (feedNavigation.current === item.id ? " active" : "")}
              aria-current={feedNavigation.current === item.id ? "page" : undefined}
              onClick={() => onFeedNavigate(item.id)}>
              <span className="nav-dot"></span>{item.title}
            </button>)}
          </nav>
        </div>}
        {categories && categories.length > 0 && <div className="repository-side-group">
          <p className="side-label">分类</p>
          <nav aria-label="分类">{categories.map(c => <button key={c} className={"nav-item" + (activeCategory === c ? " active" : "")}
            onClick={() => onCategoryChange(c)}><span className="nav-dot"></span>{c}<span className="nav-count">{counts[c] ?? ""}</span></button>)}</nav>
        </div>}
      </div>}
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
    <a id={`asset-resource-${fav.id}`} className="fav-card" href={fav.url} target="_blank" rel="noopener noreferrer">
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
        <div className="fav-asset-meta">
          <span>{({ site: "网站", tool: "工具", repo: "开源项目", article: "课程·文章" })[fav.type] || "网站"}</span>
          {(fav.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
          {fav.starred ? <span>已收藏</span> : null}
        </div>
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

/** 添加 / 编辑收藏资产弹窗（editing 传入收藏对象时为编辑模式） */
function AddFavModalV2({ editing, onClose, onSubmit }) {
  const [name, setName] = useState(editing ? editing.name : "");
  const [url, setUrl] = useState(editing ? editing.url : "");
  const [desc, setDesc] = useState(editing ? (editing.desc || "") : "");
  const [category, setCategory] = useState(editing ? editing.category : FAV_CATEGORIES[0]);
  const [type, setType] = useState(editing ? (editing.type || "site") : "site");
  const [tags, setTags] = useState(editing ? (editing.tags || "") : "");
  const [sourceUrl, setSourceUrl] = useState(editing ? (editing.sourceUrl || "") : "");
  const [note, setNote] = useState(editing ? (editing.note || "") : "");
  const [starred, setStarred] = useState(Boolean(editing && editing.starred));
  const [error, setError] = useState("");
  const baseline = useCmpMemo(() => JSON.stringify({
    name: editing?.name || '', url: editing?.url || '', desc: editing?.desc || '',
    category: editing?.category || FAV_CATEGORIES[0], type: editing?.type || 'site',
    tags: editing?.tags || '', sourceUrl: editing?.sourceUrl || '', note: editing?.note || '',
    starred: Boolean(editing?.starred),
  }), [editing]);
  const dirty = JSON.stringify({name,url,desc,category,type,tags,sourceUrl,note,starred}) !== baseline;
  const confirmDiscard = () => window.OmniNavigationGuard?.confirmDiscard
    ? window.OmniNavigationGuard.confirmDiscard(dirty, '资料编辑还有未保存的修改，确定放弃吗？')
    : !dirty || window.confirm('资料编辑还有未保存的修改，确定放弃吗？');
  const requestClose = () => { if (confirmDiscard()) onClose(); };
  useEffect(() => window.OmniNavigationGuard?.register?.(confirmDiscard), [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dirty]);

  function handleSubmit() {
    const trimmedName = name.trim();
    let trimmedUrl = url.trim();
    if (!trimmedName) { setError("请填写网站名称"); return; }
    if (!trimmedUrl) { setError("请填写网址"); return; }
    if (!/^https?:\/\//i.test(trimmedUrl)) trimmedUrl = "https://" + trimmedUrl;
    try { new URL(trimmedUrl); }
    catch (err) { setError("网址格式不正确"); return; }
    onSubmit({
      name: trimmedName, url: trimmedUrl, desc: desc.trim(), category, type,
      tags: tags.trim(), sourceUrl: sourceUrl.trim(), note: note.trim(), starred,
    }, editing ? editing.id : null);
  }

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? "编辑资产入口" : "收录资产入口"}{dirty && <span className="detail-drawer-dirty" role="status"> · 未保存</span>}</h2>
        <div className="form-field">
          <label>名称</label>
          <input className="input" placeholder="例如：Cursor Prompt Library" value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }} autoFocus />
        </div>
        <div className="form-field">
          <label>链接</label>
          <input className="input" placeholder="例如：example.com" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label>整理备注（可选）</label>
          <input className="input" placeholder="它解决什么问题，适合什么时候复用" value={desc}
            onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="form-field">
          <label>分类</label>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {FAV_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field-grid">
          <div className="form-field">
            <label>类型</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="site">网站</option><option value="tool">工具</option>
              <option value="repo">开源项目</option><option value="article">课程·文章</option>
            </select>
          </div>
          <div className="form-field">
            <label>标签</label>
            <input className="input" placeholder="逗号分隔" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
        </div>
        <div className="form-field">
          <label>原始来源（可选）</label>
          <input className="input" placeholder="来自哪条帖子或文章" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </div>
        <div className="form-field">
          <label>补充笔记（可选）</label>
          <textarea className="input" rows="3" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} />
          置顶收藏
        </label>
        {error && <p className="auth-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={requestClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {editing ? <IconCheck /> : <IconPlus />}{editing ? "保存" : "收录"}
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

function FeedItem({ item, rank, showRank, onPreview, onSave }) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const images = Array.isArray(item.images) ? item.images : [];
  return (
    <article className="feed-card">
      {showRank && (
        <div className={"feed-rank" + (rank <= 3 ? " hot" : "")}>
          <AnimatedNumber value={rank} />
        </div>
      )}
      {typeof item.score === "number" && (
        <div className="feed-corner">
          <span className="feed-score" title={item.processing?.scoreReasons ? Object.entries(item.processing.scoreReasons).map(([key,value])=>`${({substance:'实质价值',novelty:'信息增量',evidence:'证据强度',relevance:'用途相关',actionability:'可操作性'})[key]||key}：${value}`).join('\n') : '来源评分'}><AnimatedNumber value={item.score} /></span>
        </div>
      )}
      <div className="feed-body">
        <div className="feed-title-row">
          <h3 className="feed-title"><a href={item.url || "#"} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
          {onSave && (
            <button className="feed-save" title="存入收件箱"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSave(item); }}>
              <IconInbox />
            </button>
          )}
        </div>
        {item.summary && <p className="feed-summary">{item.summary}</p>}
        {item.processing && <span className="tag-chip" title={item.processing.state==='ready'?'已按网站统一流程整理':'原始来源已保留，尚未完成网站整理'}>{item.processing.label}</span>}
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
          <details className="feed-reason"><summary>推荐理由</summary><p>{item.reason}</p></details>
        )}
      </div>
    </article>
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
