const { useState: useRefineryState, useEffect: useRefineryEffect, useMemo: useRefineryMemo, useRef: useRefineryRef } = React;

const REPOSITORY_STATUS = {
  to_review: { label: "待评估", tone: "muted" },
  ready_to_try: { label: "准备试用", tone: "blue" },
  using: { label: "使用中", tone: "green" },
  deprecated: { label: "已弃用", tone: "red" },
  later: { label: "以后再看", tone: "amber" },
};

const REPOSITORY_TOPICS = {
  software: "软件开发", workflow: "工作流", video: "视频", image: "图像",
  crypto: "加密", business: "商业", product: "产品", other: "其他",
};

const PROMPT_TAG_LABELS = {
  female_character: "女性角色", male_character: "男性角色", multiple_people: "多人",
  agent_or_software: "Agent 与软件", short_drama_character: "短剧角色",
  image_generation: "图像生成", video_generation: "视频生成", agent_system: "Agent 系统",
  cinematic: "电影感", photorealistic: "写实", chinese_traditional: "中式传统",
  portrait: "人像", short_drama: "短剧", storyboard: "分镜", coding_workflow: "编程工作流",
  social_media: "社媒", system_configuration: "系统配置", character_sheet: "角色设定",
  femaleSubject: "女性", cinematicStyle: "电影感", photorealisticStyle: "写实",
  shortDramaUse: "短剧", oneShotCamera: "一镜到底", agentInstruction: "Agent 指令",
  poster_key_visual: "海报主视觉", illustration: "插画", other: "其他", not_applicable: "通用",
  general_content: "通用内容", architecture_space: "建筑空间", ui_design: "界面设计",
  animal_creature: "动物生物", product: "产品", anime_cg: "动漫与 CG", minimal: "极简",
  documentary: "纪实", infographic: "信息图",
  tutorial: "教程图解", research: "研究分析",
};

function repoStatusMeta(value) {
  return REPOSITORY_STATUS[value] || REPOSITORY_STATUS.to_review;
}

function compactDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "时间待补";
  return new Date(time).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function RepositoryAvatar({ owner, size = 30 }) {
  return <img className="repo-avatar" src={`https://github.com/${encodeURIComponent(owner)}.png?size=${size * 2}`}
    width={size} height={size} alt="" loading="lazy" referrerPolicy="no-referrer"
    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />;
}

function RepositoryStatusSelect({ value, editable, onChange }) {
  const meta = repoStatusMeta(value);
  if (!editable) return <span className={`repo-status repo-status-${meta.tone}`}>{meta.label}</span>;
  return (
    <select className={`repo-status-select repo-status-${meta.tone}`} value={value}
      aria-label="仓库使用状态" onChange={(event) => onChange(event.target.value)}>
      {Object.entries(REPOSITORY_STATUS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
    </select>
  );
}

function compactText(value, limit = 110) {
  const text = String(value || "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
}

function repositorySourceClaims(detail, limit = 2) {
  const claimPattern = /(支持|用于|提供|教|避免|可以|能够|能把|让\s|变成|转成|生成|整理|集成|保留)/i;
  const noisePattern = /(收藏|建议|推荐|star|stars|最强|起飞|含金量|必装|感谢|没想到|很多人|最后得到|一堆普通|断了|乱了|错了|不能打开)/i;
  const claims = [];
  for (const source of detail?.sources || []) {
    const sentences = String(source.excerpt || source.title || "")
      .replace(/https?:\/\/\S+/gi, " ")
      .split(/[。！？；\n]+/)
      .map((sentence) => sentence.replace(/^\s*[\d一二三四五六七八九十]+[.、）)]?\s*/, "").trim())
      .filter((sentence) => sentence.length >= 9 && sentence.length <= 72);
    for (const sentence of sentences) {
      if (!claimPattern.test(sentence) || noisePattern.test(sentence)) continue;
      const text = compactText(sentence.replace(/^[：:，,\s]+/, ""), 52);
      if (!text || claims.some((item) => item.text === text)) continue;
      claims.push({ text, author: source.author || "收藏来源", url: source.url });
      if (claims.length >= limit) return claims;
    }
  }
  return claims;
}

function repositoryUsageHint(detail) {
  const commandPattern = /(?:\/plugin\s+install|npm\s+(?:i|install)|pnpm\s+(?:i|add)|yarn\s+add|pipx?\s+install|uv\s+(?:add|tool install)|brew\s+install|git\s+clone|docker\s+(?:run|compose)|npx\s+)[^。！？；\n]{1,96}/i;
  const instructionPattern = /(使用方法|如何使用|运行方式|快速开始|安装方式|配置方法|setup|quick ?start|usage)/i;
  for (const source of detail?.sources || []) {
    const text = String(source.excerpt || "").replace(/https?:\/\/\S+/gi, " ");
    const command = text.match(commandPattern)?.[0];
    if (command) return { text: compactText(command, 86), author: source.author || "收藏来源", url: source.url };
    const sentence = text.split(/[。！？；\n]+/).find((item) => instructionPattern.test(item) && item.trim().length >= 10);
    if (sentence) return { text: compactText(sentence, 86), author: source.author || "收藏来源", url: source.url };
  }
  return null;
}

function repositoryTrialScenario(detail) {
  const context = `${detail?.key || ""} ${(detail?.relatedKnowledge || []).map((item) => `${item.title} ${item.summary}`).join(" ")}`.toLowerCase();
  const topics = detail?.topics || [];
  if (context.includes("obsidian")) return "复制一份小型 Vault，用一个真实任务验证它是否能读取背景且不破坏笔记结构";
  if (context.includes("skill") || context.includes("agent")) return "只启用一个 Skill，用一项真实但可回退的任务验证输入与输出";
  if (topics.includes("video") || topics.includes("image")) return "用一份非正式素材跑通输入到输出，记录质量、耗时和可复用性";
  if (topics.includes("crypto")) return "只在隔离数据或模拟环境中验证，不接入密钥和真实资金";
  if (topics.includes("workflow")) return "选一段重复工作做最小试用，比较接入前后的步骤和结果";
  return "选择一个真实、范围小、可以撤回的场景完成一次试用";
}

function repositoryTrialSignal(detail) {
  const explicit = {
    using: ["状态：使用中", "已经进入你的实际工作流", "green"],
    deprecated: ["状态：已弃用", "此前已判断它不再适用", "red"],
    ready_to_try: ["状态：准备试用", "下一步是完成一次最小验证", "blue"],
    later: ["状态：以后再看", "当前不占用你的试用时间", "amber"],
  }[detail?.personalStatus];
  if (explicit) return { label: explicit[0], reason: explicit[1], tone: explicit[2] };
  const claims = repositorySourceClaims(detail, 1);
  if (detail?.relatedKnowledge?.length && claims.length) {
    return { label: "建议：值得优先试用", reason: "实际用途已经整理，安装方式仍待核验", tone: "blue" };
  }
  if (detail?.relatedKnowledge?.length || claims.length || (detail?.sources || []).length >= 3) {
    return { label: "建议：可以安排试用", reason: "已有用途线索，先核对 README 再做最小验证", tone: "blue" };
  }
  return { label: "建议：先观察", reason: "具体用途信息不足，暂不投入试用时间", tone: "muted" };
}

function repositoryHeadline(detail) {
  return detail?.description || detail?.relatedKnowledge?.[0]?.title || repositorySourceClaims(detail, 1)[0]?.text;
}

function RepositorySourceStack({ sources, limit = 8 }) {
  return <div className="repo-source-stack">{(sources || []).slice(0, limit).map((source) => (
    <a className="repo-source-card" key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">
      <div className="repo-source-top"><strong>{source.author || "X 来源"}</strong><time>{compactDate(source.metrics?.postCreatedAt)}</time></div>
      <p>{source.excerpt || source.title}</p>
      <span>在 X 中查看 ↗</span>
    </a>
  ))}</div>;
}

function RepositoryLinkList({ links }) {
  return <div className="repo-link-list">{(links || []).map((link, index) => (
    <a href={link.url} target="_blank" rel="noopener noreferrer" key={`${link.url}-${index}`}>
      <IconBookmark /><span><strong>{link.kind === "repository" ? (index ? "Repository mirror" : "Repository root") : link.kind}</strong><small>{link.url}</small></span>
    </a>
  ))}</div>;
}

function RepositoryKnowledgeLinks({ items, onOpenKnowledge }) {
  return <div className="repo-knowledge-list">{(items || []).map((item) => (
    <button className="repo-related-knowledge" key={item.id} onClick={() => onOpenKnowledge(item.id)}>
      <IconBookOpen /><span><strong>{item.title}</strong><small>{item.summary}</small></span>
    </button>
  ))}</div>;
}

function RepositoryInspector({ detail, loading, onOpenDossier, onOpenKnowledge }) {
  if (loading) return <aside className="repo-inspector"><div className="repo-inspector-empty">正在读取仓库档案…</div></aside>;
  if (!detail) return <aside className="repo-inspector"><div className="repo-inspector-empty">选择一个仓库，查看完整档案。</div></aside>;
  const topics = detail.topics || [];
  const firstKnowledge = detail.relatedKnowledge?.[0];
  const sourceClaims = repositorySourceClaims(detail);
  const usageHint = repositoryUsageHint(detail);
  const trialSignal = repositoryTrialSignal(detail);
  const outcomeSummary = firstKnowledge?.summary || sourceClaims[0]?.text || detail.description || "暂无更具体的用途说明。";
  return (
    <aside className="repo-inspector">
      <div className="repo-inspector-head">
        <div className="repo-title-line"><div><h2>{detail.owner}/{detail.name} <a href={detail.repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="打开仓库">↗</a></h2><p>{repositoryHeadline(detail)}</p></div></div>
        <div className="repo-chip-row">{topics.map((topic) => <span key={topic}>{REPOSITORY_TOPICS[topic] || topic}</span>)}</div>
      </div>
      <div className={`repo-verdict-strip repo-verdict-${trialSignal.tone}`}>
        <strong>{trialSignal.label}</strong><span>{trialSignal.reason}</span>
      </div>
      <div className="repo-inspector-scroll">
        <section className="repo-inspector-outcome">
          <span className="repo-section-eyebrow">实际用途</span>
          <h3>它能帮你做什么</h3>
          <p className="repo-outcome-summary">{compactText(outcomeSummary, 150)}</p>
          {sourceClaims.length > 0 && <ul className="repo-outcome-list">{sourceClaims.map((claim) => <li key={`${claim.url}-${claim.text}`}>
            <span>来源观点</span><a href={claim.url} target="_blank" rel="noopener noreferrer">{claim.text}</a>
          </li>)}</ul>}
          {firstKnowledge && <button className="repo-knowledge-jump" type="button" onClick={() => onOpenKnowledge(firstKnowledge.id)}>阅读整理后的知识文章 <span>→</span></button>}
          <p className="repo-verification-note"><strong>待核验</strong> 用途来自收藏内容与知识整理，尚未对照 README 和代码。</p>
        </section>
        <section className="repo-inspector-trial">
          <span className="repo-section-eyebrow">试用路径</span>
          <h3>怎么开始</h3>
          {usageHint && <a className="repo-usage-hint" href={usageHint.url} target="_blank" rel="noopener noreferrer">
            <span>来源提到的用法 · 未核实</span><strong>{usageHint.text}</strong><em>{usageHint.author} ↗</em>
          </a>}
          <ol className="repo-trial-steps">
            <li><span>1</span><p><strong>先看 README</strong><small>确认支持的环境、安装方式和权限要求；本页目前没有这些资料。</small></p></li>
            <li><span>2</span><p><strong>只做一个最小试用</strong><small>{repositoryTrialScenario(detail)}</small></p></li>
            <li><span>3</span><p><strong>记录真实结果</strong><small>把效果、问题和是否继续使用写回档案，再更新使用状态。</small></p></li>
          </ol>
          <button className="repo-inspector-provenance" type="button" onClick={onOpenDossier}>
            来源与完整档案（{detail.sources.length}）<span>→</span>
          </button>
        </section>
      </div>
    </aside>
  );
}

function RepositoryDossier({ detail, selectedKey, loading, error, repositories, canEdit, onRetry, onBack, onSelectRepository, onStatusChange, onOpenKnowledge }) {
  const [evidenceTab, setEvidenceTab] = useRefineryState("sources");
  const [indexQuery, setIndexQuery] = useRefineryState("");
  const mainRef = React.useRef(null);
  const evidenceRef = React.useRef(null);
  const matching = useRefineryMemo(() => repositories.filter((item) => {
    const needle = indexQuery.trim().toLowerCase();
    return !needle || `${item.key} ${item.description}`.toLowerCase().includes(needle);
  }), [repositories, indexQuery]);
  const selected = detail || repositories.find((item) => item.key === selectedKey);
  const sources = detail?.sources || [];
  const knowledge = detail?.relatedKnowledge || [];
  const links = detail?.targetLinks || [];
  const usageHint = repositoryUsageHint(detail);
  const provenance = {
    github_description: "GitHub 官方简介", github_readme: "GitHub README 摘录",
    sources: "根据收藏来源整理", topics_fallback: "介绍待补充",
  }[selected?.metadata?.descriptionProvenance] || "收藏时的介绍";

  useRefineryEffect(() => {
    setEvidenceTab("sources");
    mainRef.current?.scrollTo(0, 0);
    evidenceRef.current?.scrollTo(0, 0);
  }, [selectedKey]);

  return (
    <div className="repo-dossier">
      <aside className="repo-dossier-index">
        <div className="repo-dossier-index-head"><h2>仓库库</h2><p>搜索或选择仓库，直接切换详情。</p></div>
        <label className="repo-index-search"><IconSearch /><input aria-label="搜索仓库" placeholder="搜索仓库…" value={indexQuery} onChange={(event) => setIndexQuery(event.target.value)} /></label>
        <button className="repo-back" onClick={onBack}>← 返回全部仓库</button>
        <h3>{indexQuery.trim() ? "搜索结果" : "全部仓库"} · {matching.length}</h3>
        <nav className="repo-recent-list" aria-label="切换仓库">{matching.map((item) => <button key={item.key} className={item.key === selectedKey ? "active" : ""}
          aria-current={item.key === selectedKey ? "page" : undefined}
          onClick={() => onSelectRepository(item.key)}><span className="repo-recent-dot"></span><span><strong>{item.owner}/{item.name}</strong><small>{item.description}</small></span></button>)}
          {!matching.length && <p className="repo-empty-note">没有匹配的仓库，试试其他关键词。</p>}
        </nav>
      </aside>
      <div className="repo-dossier-main" ref={mainRef} aria-busy={loading}>
        <div className="repo-dossier-breadcrumb">仓库库&nbsp; / &nbsp;仓库详情</div>
        <div className="repo-dossier-heading">
          {selected && <RepositoryAvatar owner={selected.owner} size={40} />}
          <div><h1>{selectedKey} {selected && <a href={selected.repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="打开仓库">↗</a>}</h1>
            <span className="repo-description-origin">{provenance}</span><p>{selected?.description || "暂无仓库介绍。"}</p></div>
        </div>
        <div className="repo-chip-row">{(selected?.topics || []).map((topic) => <span key={topic}>{REPOSITORY_TOPICS[topic] || topic}</span>)}</div>
        {loading ? <p className="repo-detail-state" role="status">正在读取 {selectedKey} 的详情…</p> : error ?
          <div className="repo-detail-state" role="alert"><p>仓库详情读取失败，可以重试或选择其他仓库。</p><button className="btn" onClick={onRetry}>重新加载</button></div> : detail && <React.Fragment>
          <div className="repo-dossier-meta"><span>整理于 {compactDate(detail.organizedAt || detail.updatedAt)}</span>
            {canEdit && <RepositoryStatusSelect value={detail.personalStatus} editable onChange={onStatusChange} />}</div>
          <section className="repo-dossier-section"><h2>怎么使用</h2>
            <p>安装、配置和使用示例以仓库当前的 README 为准。</p>
            <a className="repo-readme-link" href={`${detail.repositoryUrl}#readme`} target="_blank" rel="noopener noreferrer">阅读 README 与使用示例 ↗</a>
            {usageHint && <a className="repo-usage-hint" href={usageHint.url} target="_blank" rel="noopener noreferrer">
              <span>收藏中提到的用法 · 尚未实测</span><strong>{usageHint.text}</strong><em>{usageHint.author} ↗</em>
            </a>}
          </section>
          <section className="repo-dossier-section"><h2>最小试用建议</h2><p>{repositoryTrialScenario(detail)}。</p>
            <p className="repo-verification-note">这是一条试用建议，不是实测结论；当前档案尚未收录操作演示或效果验证。</p></section>
          {knowledge.length > 0 && <section className="repo-dossier-section"><h2>已整理的知识</h2><RepositoryKnowledgeLinks items={knowledge} onOpenKnowledge={onOpenKnowledge} /></section>}
          {detail.personalNote && <section className="repo-dossier-section"><h2>我的笔记</h2><p>{detail.personalNote}</p></section>}
        </React.Fragment>}
      </div>
      <aside className="repo-dossier-evidence" aria-busy={loading}><div className="dossier-evidence-head"><h2>原始来源</h2>
        <nav aria-label="仓库依据">{[{ id: "sources", label: "来源", count: sources.length }, { id: "knowledge", label: "知识", count: knowledge.length }, { id: "links", label: "入口", count: links.length }].map((item) =>
          <button key={item.id} className={evidenceTab === item.id ? "active" : ""} aria-pressed={evidenceTab === item.id} onClick={() => setEvidenceTab(item.id)}>{item.label} {!loading && !error && <em>{item.count}</em>}</button>)}</nav></div>
        <div className="repo-dossier-evidence-body" ref={evidenceRef}>
          {loading || error ? <p className="repo-empty-note">{loading ? "正在读取来源…" : "详情加载后显示来源。"}</p> : <React.Fragment>
            {evidenceTab === "sources" && <section className="repo-evidence-section">{sources.length ? <RepositorySourceStack sources={sources} limit={sources.length} /> : <p className="repo-empty-note">暂无公开来源。</p>}</section>}
            {evidenceTab === "knowledge" && <section className="repo-evidence-section">{knowledge.length ? <RepositoryKnowledgeLinks items={knowledge} onOpenKnowledge={onOpenKnowledge} /> : <p className="repo-empty-note">暂时还没有知识文章与它建立关联。</p>}</section>}
            {evidenceTab === "links" && <section className="repo-evidence-section">{links.length ? <RepositoryLinkList links={links} /> : <p className="repo-empty-note">暂无保存的入口。</p>}</section>}
          </React.Fragment>}
        </div>
      </aside>
    </div>
  );
}

function RepositoryLibraryView({ repositories, query, canEdit, onRepositoryUpdated, onOpenKnowledge }) {
  const PAGE_SIZE = 60;
  const [statusFilter, setStatusFilter] = useRefineryState("all");
  const [topicFilter, setTopicFilter] = useRefineryState("all");
  const [technologyFilter, setTechnologyFilter] = useRefineryState("all");
  const [activityFilter, setActivityFilter] = useRefineryState("all");
  const [localQuery, setLocalQuery] = useRefineryState("");
  const [sortMode, setSortMode] = useRefineryState("recent");
  const [density, setDensity] = useRefineryState("comfortable");
  const [displayLimit, setDisplayLimit] = useRefineryState(PAGE_SIZE);
  const [selectedKey, setSelectedKey] = useRefineryState("");
  const [detail, setDetail] = useRefineryState(null);
  const [detailRequest, setDetailRequest] = useRefineryState({ key: "", loading: false, error: false });
  const [retryVersion, setRetryVersion] = useRefineryState(0);
  const [dossierOpen, setDossierOpen] = useRefineryState(false);
  const detailLoading = !!selectedKey && (detailRequest.key !== selectedKey || detailRequest.loading);
  const detailError = detailRequest.key === selectedKey && detailRequest.error;
  const selectedDetail = detail?.key === selectedKey ? detail : null;

  const topics = useRefineryMemo(() => [...new Set(repositories.flatMap((item) => item.topics || []))]
    .sort((a, b) => (REPOSITORY_TOPICS[a] || a).localeCompare(REPOSITORY_TOPICS[b] || b, "zh-CN")), [repositories]);
  const visible = useRefineryMemo(() => repositories.filter((item) => {
    if (statusFilter !== "all" && item.personalStatus !== statusFilter) return false;
    if (topicFilter !== "all" && !(item.topics || []).includes(topicFilter)) return false;
    const sourceCount = Number(item.sourcePostCount || 0);
    if (activityFilter === "high" && sourceCount < 5) return false;
    if (activityFilter === "medium" && (sourceCount < 2 || sourceCount > 4)) return false;
    if (activityFilter === "single" && sourceCount !== 1) return false;
    const haystack = `${item.owner}/${item.name} ${item.description} ${(item.topics || []).join(" ")}`.toLowerCase();
    if (technologyFilter !== "all" && !haystack.includes(technologyFilter)) return false;
    const needles = [query, localQuery].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    return needles.every((needle) => haystack.includes(needle));
  }).sort((a, b) => {
    if (sortMode === "curated") {
      if (a.key === "kepano/obsidian-skills") return -1;
      if (b.key === "kepano/obsidian-skills") return 1;
    }
    if (sortMode === "name") return a.key.localeCompare(b.key);
    if (sortMode === "recent") return globalThis.OmniHubLibraryOrder.compare(a, b);
    return Number(b.sourcePostCount || 0) - Number(a.sourcePostCount || 0) || a.key.localeCompare(b.key);
  }), [repositories, query, localQuery, statusFilter, topicFilter, technologyFilter, activityFilter, sortMode]);
  const displayed = visible.slice(0, displayLimit);

  useRefineryEffect(() => {
    setDisplayLimit(PAGE_SIZE);
  }, [query, localQuery, statusFilter, topicFilter, technologyFilter, activityFilter, sortMode]);

  useRefineryEffect(() => {
    // Dossier navigation covers all repositories, independently of table filters.
    if (dossierOpen) return;
    const preferred = visible.find((item) => item.key === "kepano/obsidian-skills") || visible[0];
    const next = selectedKey && visible.some((item) => item.key === selectedKey) ? selectedKey : preferred?.key || "";
    if (next !== selectedKey) setSelectedKey(next);
  }, [visible, selectedKey, dossierOpen]);

  useRefineryEffect(() => {
    if (!selectedKey) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null);
    setDetailRequest({ key: selectedKey, loading: true, error: false });
    const [owner, name] = selectedKey.split("/");
    api(`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
      .then((value) => { if (!cancelled) {
        setDetail(value);
        setDetailRequest({ key: selectedKey, loading: false, error: false });
      } })
      .catch(() => { if (!cancelled) setDetailRequest({ key: selectedKey, loading: false, error: true }); });
    return () => { cancelled = true; };
  }, [selectedKey, retryVersion]);

  async function changeStatus(status) {
    if (!detail || !canEdit) return;
    const [owner, name] = detail.key.split("/");
    const updated = await api(`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/status`, {
      method: "PUT", body: { status },
    });
    setDetail((current) => current?.key === updated.key ? updated : current);
    onRepositoryUpdated(updated);
  }

  if (dossierOpen) return <RepositoryDossier detail={selectedDetail} selectedKey={selectedKey} loading={detailLoading} error={detailError}
    onRetry={() => setRetryVersion((value) => value + 1)} repositories={repositories} canEdit={canEdit}
    onBack={() => setDossierOpen(false)} onSelectRepository={setSelectedKey}
    onStatusChange={changeStatus} onOpenKnowledge={onOpenKnowledge} />;

  const statusItems = [{ id: "all", label: "全部", count: repositories.length },
    ...Object.entries(REPOSITORY_STATUS).map(([id, item]) => ({ id, label: item.label,
      count: repositories.filter((repo) => repo.personalStatus === id).length }))];

  return (
    <div className="repository-page">
      <div className="repository-main">
        <div className="repository-head"><div><h1>仓库库</h1><p>从收藏变成可评估、可试用、可关联知识的资产 · {repositories.length} 个仓库</p></div></div>
        <label className="repository-search"><IconSearch /><input value={localQuery} onChange={(event) => setLocalQuery(event.target.value)}
          placeholder="搜索仓库名称、描述或主题（如：AI、Agent、工具…）" /></label>
        <div className="repository-filterbar">
          <select className="select" value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} aria-label="按用途筛选">
            <option value="all">全部用途</option>{topics.map((topic) => <option key={topic} value={topic}>{REPOSITORY_TOPICS[topic] || topic}</option>)}
          </select>
          <select className="select" value={technologyFilter} onChange={(event) => setTechnologyFilter(event.target.value)} aria-label="按技术关键词筛选">
            <option value="all">技术栈</option><option value="ai">AI / Agent</option><option value="python">Python</option><option value="typescript">TypeScript</option><option value="javascript">JavaScript</option><option value="obsidian">Obsidian</option>
          </select>
          <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="按使用状态筛选">
            <option value="all">使用状态</option>{Object.entries(REPOSITORY_STATUS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
          </select>
          <select className="select" value={activityFilter} onChange={(event) => setActivityFilter(event.target.value)} aria-label="按来源活跃度筛选">
            <option value="all">来源活跃度</option><option value="high">5 条以上</option><option value="medium">2–4 条</option><option value="single">仅 1 条</option>
          </select>
          <div className="repository-status-tabs">{statusItems.slice(1, 5).map((item) => <button key={item.id}
            className={statusFilter === item.id ? "active" : ""} onClick={() => setStatusFilter(statusFilter === item.id ? "all" : item.id)}>
            {item.label}<em>{item.count}</em></button>)}</div>
        </div>
        <div className="repository-list-toolbar"><span>共 {visible.length} 个仓库</span><div><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="仓库排序">
          <option value="curated">收藏推荐</option><option value="sources">来源最多</option><option value="recent">最近整理</option><option value="name">名称排序</option></select>
          <button className={density === "comfortable" ? "active" : ""} onClick={() => setDensity("comfortable")}>表格</button>
          <button className={density === "compact" ? "active" : ""} onClick={() => setDensity("compact")}>紧凑</button></div></div>
        <div className="repository-table-head"><span>仓库 / 介绍</span><span>主题</span><span>来源</span><span>整理时间</span><span>我的状态</span></div>
        <div className={`repository-list repository-list-${density}`} role="list">
          {displayed.map((item) => {
            const status = repoStatusMeta(item.personalStatus);
            return <div role="listitem" tabIndex="0" key={item.key}
              className={`repository-row${selectedKey === item.key ? " active" : ""}`} onClick={() => setSelectedKey(item.key)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedKey(item.key); }}>
              <span className="repository-identity"><RepositoryAvatar owner={item.owner} /><span><strong>{item.owner}/{item.name}</strong><small>{item.description}</small></span></span>
              <span className="repository-topic-cell">{(item.topics || []).slice(0, 3).map((topic) => <em key={topic}>{REPOSITORY_TOPICS[topic] || topic}</em>)}</span>
              <span className="repository-source-count">{item.sourcePostCount}</span>
              <time className="repository-updated">{compactDate(item.organizedAt || item.updatedAt).replaceAll("/", "-")}</time>
              <span className={`repo-status repo-status-${status.tone}`}>{status.label}</span>
            </div>;
          })}
          {displayed.length < visible.length && <button className="repository-load-more" type="button"
            onClick={() => setDisplayLimit((value) => value + PAGE_SIZE)}>
            再显示 {Math.min(PAGE_SIZE, visible.length - displayed.length)} 个
            <span>已显示 {displayed.length} / {visible.length}</span>
          </button>}
          {visible.length === 0 && <div className="repository-empty"><IconSearch /><p>没有匹配的仓库</p><span>换一个筛选条件或搜索词。</span></div>}
        </div>
      </div>
      <RepositoryInspector detail={selectedDetail} loading={detailLoading}
        onOpenDossier={() => setDossierOpen(true)} onOpenKnowledge={onOpenKnowledge} />
    </div>
  );
}

function knowledgeSourceUrl(source) {
  if (source?.private) {
    try { const url = new URL(source.url); return url.protocol === 'https:' && url.hostname === 'x.com' ? url.href : ''; } catch { return ''; }
  }
  const id = String(source?.id || '');
  return /^[1-9]\d*$/.test(id) ? `#inbox?source=${id}` : '';
}

function knowledgeCitationHtml(id, sources) {
  const source = sources.find(item => String(item.externalId) === id || item.citationKey === `S:${id}`);
  const url = knowledgeSourceUrl(source);
  if (!source || !url) return '<span class="knowledge-citation-missing" title="当前文章没有关联到站内原文">来源待补全</span>';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const title = String(source.title || '').trim() || (source.author ? `${source.author} 的原帖` : '查看原文');
  const preview = [title, source.author, source.excerpt && `原文摘录：${source.excerpt}`].filter(Boolean).join('\n');
  const action = source.private ? '在 X 查看公开原帖' : '查看站内原文';
  return `<a class="knowledge-citation" href="${escape(url)}" title="${escape(preview)}" aria-label="${escape(`${action}：${title}`)}">[${sources.indexOf(source) + 1}]</a>`;
}

function markdownWithCitationLinks(body, sources = []) {
  const tokens = marked.lexer(String(body || ''));
  const visit = items => {
    for (const token of items || []) {
      // Literal examples and existing links must not turn into nested anchors.
      if (['code', 'codespan', 'link', 'image', 'html'].includes(token.type)) continue;
      if (token.type === 'text' && !token.tokens && /\[S:[A-Za-z0-9_-]+\]/.test(token.text)) {
        token.type = 'html';
        token.text = token.text.replace(/\[S:([A-Za-z0-9_-]+)\]/g, (_match, id) => knowledgeCitationHtml(id, sources));
      }
      visit(token.tokens);
      for (const item of token.items || []) visit(item.tokens);
      if (token.type === 'table') for (const cell of [...token.header, ...token.rows.flat()]) visit(cell.tokens);
    }
  };
  visit(tokens);
  return DOMPurify.sanitize(marked.parser(tokens));
}

function knowledgeMethodTools(item) {
  if (item.type !== 'method') return [];
  return String(item.tags?.[0] || '').split(/\s*\+\s*/).filter(Boolean);
}

function knowledgePlainText(value) {
  return String(value || '').replace(/\[S:[A-Za-z0-9_-]+\]/g, '').replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\s)[#>]+\s/g, '$1').replace(/(\*\*|__|`{1,3})/g, '').replace(/\s+/g, ' ').trim();
}

function knowledgeSearchMatch(item, detail, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return {snippet:item.summary || ''};
  const fields = [item.title, item.summary, ...(item.tags || []), knowledgePlainText(detail?.body), detail?.promptText];
  for (const field of fields) {
    const text = String(field || '').replace(/\s+/g, ' ').trim();
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 32), end = Math.min(text.length, index + needle.length + 72);
    return {snippet:`${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`};
  }
  return null;
}

function knowledgeSummaryIsRepeated(detail) {
  const summary = knowledgePlainText(detail?.summary);
  return Boolean(summary && knowledgePlainText(detail?.body).startsWith(summary));
}

function createKnowledgeDetailStore(load) {
  const data = new Map(), pending = new Map(), controller = new AbortController();
  return {
    peek: id => data.get(String(id)),
    load(id) {
      const key = String(id);
      if (controller.signal.aborted) return Promise.reject(new Error('Knowledge view disposed'));
      if (data.has(key)) return Promise.resolve(data.get(key));
      if (!pending.has(key)) {
        const request = Promise.resolve().then(() => load(id, controller.signal)).then(value => {
          if (!controller.signal.aborted) data.set(key, value);
          return value;
        }).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return pending.get(key);
    },
    dispose() { controller.abort(); data.clear(); pending.clear(); },
  };
}

function KnowledgeHighlight({text, query}) {
  const value = String(text || ''), needle = String(query || '').trim();
  const index = needle ? value.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  return index < 0 ? value : <React.Fragment>{value.slice(0,index)}<mark>{value.slice(index,index + needle.length)}</mark>{value.slice(index + needle.length)}</React.Fragment>;
}

function KnowledgeLibraryView({ items, query, onQueryChange, active = true, requestedId, onRequestedIdHandled, onCorrectClassification, onOpenPrompt, scopeSwitch }) {
  const [kind, setKind] = useRefineryState('all');
  const [tool, setTool] = useRefineryState('all');
  const [copyResult, setCopyResult] = useRefineryState('');
  const [selectedId, setSelectedId] = useRefineryState(null);
  const [mobileReading, setMobileReading] = useRefineryState(false);
  const [revision, setRevision] = useRefineryState(0);
  const [retry, setRetry] = useRefineryState(0);
  const [detailError, setDetailError] = useRefineryState(null);
  const [searchState, setSearchState] = useRefineryState(null);
  const [headings, setHeadings] = useRefineryState([]);
  const readerRef = useRefineryRef(null), indexRef = useRefineryRef(null), searchRef = useRefineryRef(null);
  const focusReader = useRefineryRef(null);
  // Cache only records from this exact catalogue snapshot, never across accounts/scopes.
  const store = useRefineryMemo(() => createKnowledgeDetailStore((id, signal) => api(`/api/knowledge-library/${id}`, {signal})), [items]);
  const positions = useRefineryRef(new Map()).current;
  const needle = String(query || '').trim();
  const methodTools = [...new Set(items.flatMap(knowledgeMethodTools))];
  const visible = useRefineryMemo(() => [...items].sort(globalThis.OmniHubLibraryOrder.compare).flatMap(item => {
    if (kind !== 'all' && (item.type === 'method' ? 'method' : 'article') !== kind) return [];
    if (tool !== 'all' && !knowledgeMethodTools(item).includes(tool)) return [];
    const match = knowledgeSearchMatch(item, store.peek(item.id), needle);
    return match ? [{item, snippet:match.snippet}] : [];
  }), [items, kind, tool, needle, store, revision]);
  const detail = store.peek(selectedId);
  const searching = Boolean(needle && (searchState?.store !== store || searchState?.query !== needle || searchState.loading));
  const failedSearch = needle && searchState?.store === store && searchState?.query === needle && searchState.failed;

  useRefineryEffect(() => () => store.dispose(), [store]);
  useRefineryEffect(() => {
    if (!needle || !active) return;
    let cancelled = false;
    // Debounce input, then build a bounded index from the existing scoped detail API.
    const timer = setTimeout(async () => {
      setSearchState({store, query:needle, loading:true, failed:0});
      let next = 0, failed = 0;
      await Promise.all(Array.from({length:Math.min(3,items.length)}, async () => {
        while (!cancelled && next < items.length) {
          const item = items[next++];
          try { await store.load(item.id); }
          catch { failed++; }
          if (!cancelled) setRevision(value => value + 1);
        }
      }));
      if (!cancelled) setSearchState({store, query:needle, loading:false, failed});
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [needle, active, items, store, retry]);

  useRefineryEffect(() => {
    if (requestedId != null) {
      setKind('all'); setTool('all'); onQueryChange(''); setSelectedId(requestedId); setMobileReading(true);
      focusReader.current = String(requestedId); onRequestedIdHandled?.(); return;
    }
    if (!visible.some(({item}) => String(item.id) === String(selectedId))) {
      focusReader.current = null;
      setSelectedId(visible[0]?.item.id ?? null);
    }
  }, [requestedId, visible, selectedId]);
  useRefineryEffect(() => {
    if (selectedId == null) return;
    let cancelled = false;
    setCopyResult(''); setDetailError(null);
    store.load(selectedId).then(() => { if (!cancelled) setRevision(value => value + 1); })
      .catch(() => { if (!cancelled) { focusReader.current = null; setDetailError({store,id:selectedId}); } });
    return () => { cancelled = true; };
  }, [selectedId, store, retry]);

  React.useLayoutEffect(() => {
    const reader = readerRef.current;
    if (!detail || !reader) { setHeadings([]); return; }
    const sections = [...reader.querySelectorAll('.knowledge-article h2, .knowledge-article h3, .knowledge-method-prompt h2')];
    setHeadings(sections.map((element,index) => {
      element.id = `knowledge-section-${index}`; element.tabIndex = -1;
      return {id:element.id, title:element.textContent, level:element.tagName === 'H3' ? 3 : 2};
    }));
    reader.scrollTop = positions.get(String(selectedId)) || 0;
    if (focusReader.current === String(selectedId)) { reader.querySelector('h1')?.focus({preventScroll:true}); focusReader.current = null; }
  }, [detail, selectedId, mobileReading, positions]);

  const openArticle = id => {
    const reader = readerRef.current;
    const readerVisible = reader.getClientRects().length > 0;
    if (detail && readerVisible) positions.set(String(selectedId), reader.scrollTop);
    focusReader.current = String(id);
    if (String(id) === String(selectedId) && detail && readerVisible) {
      reader.querySelector('h1')?.focus({preventScroll:true}); focusReader.current = null;
    }
    setSelectedId(id); setMobileReading(true);
  };
  const backToList = () => {
    if (detail) positions.set(String(selectedId), readerRef.current.scrollTop);
    setMobileReading(false);
    requestAnimationFrame(() => [...indexRef.current.querySelectorAll('[data-knowledge-id]')]
      .find(element => element.dataset.knowledgeId === String(selectedId))?.focus({preventScroll:true}));
  };
  const resetFilters = () => { setKind('all'); setTool('all'); onQueryChange(''); searchRef.current?.focus(); };
  const jumpToHeading = id => {
    const reader = readerRef.current, heading = document.getElementById(id);
    if (!heading || !reader.contains(heading)) return;
    reader.scrollTo({top:reader.scrollTop + heading.getBoundingClientRect().top - reader.getBoundingClientRect().top - 24, behavior:'instant'});
    heading.focus({preventScroll:true});
  };
  const failedDetail = detailError?.store === store && String(detailError.id) === String(selectedId);

  return <div className="knowledge-workspace" data-reading={mobileReading}>
    <header className="knowledge-workspace-bar">
      <div className="knowledge-workspace-title"><button className="knowledge-back" onClick={backToList}>返回文章列表</button><strong>知识库</strong><span>{items.length} 篇文章</span></div>
      <div className="knowledge-workspace-actions">{scopeSwitch}</div>
    </header>
    <aside ref={indexRef} className="knowledge-index" aria-label="知识文章目录">
      <div className="knowledge-index-head">
        <div className="knowledge-search"><IconSearch aria-hidden="true" /><input ref={searchRef} type="search" value={query || ''} onChange={event => onQueryChange(event.target.value)} placeholder="搜索标题与正文" aria-label="搜索知识标题与正文" />{needle && <button aria-label="清除搜索" onClick={() => {onQueryChange(''); searchRef.current.focus();}}><IconX /></button>}</div>
        <div className="knowledge-type-filter">{[['all','全部'],['article','综合知识'],['method','方法技巧']].map(([id,label]) => <button key={id} aria-pressed={kind === id} onClick={() => {setKind(id); setTool('all');}}>{label}</button>)}</div>
        <div className="knowledge-index-options">{kind !== 'article' && methodTools.length > 0 && <select className="knowledge-tool-filter" aria-label="按适用工具筛选方法" value={tool} onChange={event => setTool(event.target.value)}><option value="all">全部适用工具</option>{methodTools.map(value => <option key={value}>{value}</option>)}</select>}<span role="status">{searching ? '正在搜索正文…' : `${visible.length} 篇`}</span></div>
        {failedSearch > 0 && <p className="knowledge-search-error" role="status">{failedSearch} 篇正文暂未读取，结果可能不完整。<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      </div>
      <div className="knowledge-index-list">{visible.map(({item,snippet}) => <button key={item.id} data-knowledge-id={item.id} className={String(selectedId) === String(item.id) ? 'active' : ''} aria-current={String(selectedId) === String(item.id) ? 'true' : undefined} onClick={() => openArticle(item.id)}>
        <span className="knowledge-item-meta">{item.type === 'source_archive' ? '原文归档' : item.type === 'method' ? item.tags?.[0] || '方法技巧' : '综合知识'}</span>
        <strong><KnowledgeHighlight text={item.title} query={needle} /></strong><small><KnowledgeHighlight text={needle ? snippet : item.summary} query={needle} /></small>
      </button>)}
        {!visible.length && <div className="knowledge-empty" role="status"><strong>{searching ? '正在搜索全文' : failedSearch ? '暂未找到匹配内容' : '没有匹配的文章'}</strong><p>{searching ? '标题结果会先显示，正文结果随后补齐。' : '试试其他关键词，或清除当前筛选。'}</p>{!searching && <button className="btn" onClick={resetFilters}>清除搜索与筛选</button>}</div>}
      </div>
    </aside>
    <article ref={readerRef} className="knowledge-reader" aria-label="知识文章" onScroll={event => {if (detail && event.currentTarget.getClientRects().length) positions.set(String(selectedId),event.currentTarget.scrollTop);}}>
      {!detail ? <div className="knowledge-loading" role="status"><p>{failedDetail ? '文章暂时无法读取' : visible.length ? '正在读取文章…' : searching ? '正在搜索正文…' : '选择文章开始阅读'}</p>{failedDetail && <button className="btn" onClick={() => setRetry(value => value + 1)}>重新加载</button>}</div> : <div className={`knowledge-reading-layout${headings.length ? ' has-toc' : ''}`}>
        <header className="knowledge-reader-head"><div className="knowledge-breadcrumb">{detail.type === 'source_archive' ? '原文归档' : `${detail.type === 'method' ? '方法技巧' : '综合知识'} · ${detail.tags?.[0] || '专题'}`}</div>
          <h1 tabIndex={-1}>{detail.title}</h1>{detail.type !== 'source_archive' && !knowledgeSummaryIsRepeated(detail) && <p>{detail.summary}</p>}
          <div className="knowledge-reader-meta"><span className="knowledge-state">{detail.type === 'source_archive' ? '保留原文' : detail.type === 'method' ? '来源整理 · 未实测' : '来源核验'}</span><span>{detail.sources.length} 个来源</span>
            {detail.sourceInboxId && onCorrectClassification && <button className="btn btn-ghost" onClick={() => onCorrectClassification({sourceInboxId:detail.sourceInboxId})}>调整归类</button>}
            {detail.hasPrompt && <button className="btn btn-ghost" onClick={() => onOpenPrompt(detail.sourceInboxId)}>查看提取的提示词 →</button>}
          </div>
        </header>
        {headings.length > 0 && <aside className="knowledge-toc" key={String(selectedId)}><div className="knowledge-toc-title">本文目录 <span>{headings.length} 节</span></div><nav aria-label="本文章节">{headings.map(heading => <button key={heading.id} data-level={heading.level} onClick={() => jumpToHeading(heading.id)}>{heading.title}</button>)}</nav></aside>}
        <div className="knowledge-reading-content">
        {detail.type === 'method' && <div className="knowledge-method-context"><span>适用对象 <strong>{detail.tags?.[0] || '待补充'}</strong></span><span>具体用途 <strong>{detail.tags?.[1] || '见下方步骤'}</strong></span></div>}
        <div className="knowledge-article markdown-body" dangerouslySetInnerHTML={{__html:markdownWithCitationLinks(detail.body, detail.sources)}} />
        {detail.promptText && <section className="knowledge-method-prompt"><div><h2>原帖中的指令片段</h2><button className="btn btn-ghost" onClick={async () => {
          setCopyResult('');
          try { await navigator.clipboard.writeText(detail.promptText); setCopyResult('已复制'); } catch { setCopyResult('复制失败，请手动选择文字'); }
        }}>复制指令</button></div><p>原文示例；请结合上面的适用条件和限制使用。</p><span role="status">{copyResult}</span><pre>{detail.promptText}</pre></section>}
        </div>
      </div>}
    </article>
  </div>;
}

function PromptExampleImage({ media, thumbnail = false, unavailableText = "图片暂时无法加载，可查看原帖" }) {
  const [failed, setFailed] = useRefineryState(false);
  return failed
    ? <span className="prompt-example-unavailable">{unavailableText}</span>
    : <img src={thumbnail ? inboxThumbnailUrl(media.url) : media.url} alt={media.alt}
        loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function promptMediaIndex(index, length) {
  return Math.max(0, Math.min(Number.isInteger(index) ? index : 0, length - 1));
}

function promptSwipeDirection(start, end) {
  if (!start || !end) return 0;
  const dx = end.clientX - start.clientX;
  const dy = end.clientY - start.clientY;
  return Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;
}

function promptDisplayTags(tags) {
  return [...new Set((tags || []).map(tag => PROMPT_TAG_LABELS[tag] || tag))];
}

function promptReadingContent(value, curated = false) {
  const text = String(value || '');
  if (curated) return { text, links: [] };
  // Move trailing X shortlinks to the source row. Keep the exact original text for copying.
  const trailing = text.match(/(?:\s+https:\/\/t\.co\/[A-Za-z0-9]+)+\s*$/);
  if (!trailing) return { text, links: [] };
  const body = text.slice(0, trailing.index).trimEnd();
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
  }
  if (!body || fence) return { text, links: [] };
  return { text: body, links: trailing[0].match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) || [] };
}

function PromptMediaViewer({ media, index, onSelect, onClose, label = "原帖配图", returnFocus }) {
  const root = useRefineryRef(null);
  const stage = useRefineryRef(null);
  const touch = useRefineryRef(null);
  const [zoomed, setZoomed] = useRefineryState(false);
  const current = media[index];
  useRefineryEffect(() => {
    // Repository thumbnails live inside a shadow root; keep their actual trigger.
    const trigger = returnFocus || document.activeElement;
    root.current?.focus({ preventScroll: true });
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  useRefineryEffect(() => { setZoomed(false); }, [index]);
  useRefineryEffect(() => {
    if (zoomed && stage.current) {
      stage.current.scrollLeft = (stage.current.scrollWidth - stage.current.clientWidth) / 2;
      stage.current.scrollTop = (stage.current.scrollHeight - stage.current.clientHeight) / 2;
    }
  }, [zoomed]);
  const change = (delta) => onSelect(promptMediaIndex(index + delta, media.length));
  const onKeyDown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (!zoomed && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); change(event.key === "ArrowRight" ? 1 : -1);
    }
    if (event.key === "Tab") {
      const buttons = [...root.current.querySelectorAll('button:not(:disabled)')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && [root.current, first].includes(document.activeElement)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  };
  return ReactDOM.createPortal(<div className="lightbox prompt-media-viewer" role="dialog" aria-modal="true"
    aria-label={`${label}预览`} tabIndex={-1} ref={root} onKeyDown={onKeyDown}>
    <div className="prompt-viewer-toolbar"><span aria-live="polite">{current.video ? "视频封面" : label} · {index + 1} / {media.length}</span>
      <div><button onClick={() => setZoomed(value => !value)} aria-pressed={zoomed}>{zoomed ? "适应窗口" : "查看原尺寸"}</button>
        <button onClick={onClose} aria-label="关闭图片预览">关闭 ×</button></div></div>
    <div ref={stage} className={`prompt-viewer-stage${zoomed ? " is-zoomed" : ""}`}
      onTouchStart={event => { touch.current = event.touches.length === 1 ? { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY } : null; }}
      onTouchEnd={event => { if (!zoomed) change(promptSwipeDirection(touch.current, event.changedTouches[0])); touch.current = null; }}>
      <PromptExampleImage key={current.url} media={current} unavailableText={label === "原帖配图" ? undefined : "图片暂时无法加载，请关闭预览后重试"} />
    </div>
    {media.length > 1 && <nav className="prompt-viewer-navigation" aria-label={`切换${label}`}>
      <button disabled={index === 0} onClick={() => change(-1)}>← 上一张</button>
      <span>方向键切换 · 手机左右滑动</span>
      <button disabled={index === media.length - 1} onClick={() => change(1)}>下一张 →</button>
    </nav>}
  </div>, document.body);
}

function PromptExampleGallery({ item, initialIndex = 0 }) {
  const media = inboxMedia(item);
  const [index, setIndex] = useRefineryState(() => promptMediaIndex(initialIndex, media.length));
  const [preview, setPreview] = useRefineryState(false);
  const [videoFailed, setVideoFailed] = useRefineryState(false);
  const touch = useRefineryRef(null);
  const current = media[index] || media[0];
  if (!current) return null;
  const select = (next) => { setIndex(promptMediaIndex(next, media.length)); setVideoFailed(false); };
  return <section className="prompt-example-gallery" aria-label="原帖配图"
    onKeyDown={event => {
      if (preview || event.target.tagName === "VIDEO") return;
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); select(index + (event.key === "ArrowRight" ? 1 : -1));
      }
    }}>
    <div className="prompt-example-heading"><strong>{media.some(entry => entry.video) ? '原帖媒体' : '原帖配图'}</strong><span aria-live="polite">{index + 1} / {media.length}</span></div>
    {current.video && current.videoUrl && !videoFailed
      ? <video key={current.videoUrl} className="prompt-example-video" src={current.videoUrl} poster={current.url}
          controls playsInline preload="none" aria-label="原帖效果视频" onError={() => setVideoFailed(true)} />
      : <button className="prompt-example-hero" onClick={() => {
          if (touch.current?.swiped) { touch.current = null; return; }
          setPreview(true);
        }}
          onTouchStart={event => { touch.current = event.touches.length === 1 ? { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY } : null; }}
          onTouchEnd={event => {
            const direction = promptSwipeDirection(touch.current, event.changedTouches[0]);
            if (direction) { event.preventDefault(); select(index + direction); }
            touch.current = { swiped: Boolean(direction) };
          }}
          aria-label={`放大第 ${index + 1} 张${current.video ? '视频封面' : '配图'}`}>
          <PromptExampleImage key={current.url} media={current} />
          <span className="prompt-example-badge">{current.video ? '视频封面' : '点击放大'}</span>
        </button>}
    {current.video && (!current.videoUrl || videoFailed) && <p className="prompt-example-note">
      {videoFailed ? '视频暂时无法播放。' : '当前仅保存了视频封面。'}
      {(current.sourceUrl || item.sourceUrl) && <a href={current.sourceUrl || item.sourceUrl} target="_blank" rel="noopener noreferrer">到原帖观看 ↗</a>}
    </p>}
    {current.sourceUrl && current.sourceRelation !== 'original' && <a className="prompt-media-source" href={current.sourceUrl} target="_blank" rel="noopener noreferrer">
      {current.sourceRelation === 'quoted' ? '来自引用帖' : '来自同一讨论串'} <span aria-hidden="true">↗</span></a>}
    {media.length > 1 && <div className="prompt-example-thumbnails" aria-label="选择原帖配图">
      {media.map((entry, i) => <button key={`${entry.url}-${i}`} aria-label={`查看第 ${i + 1} ${entry.video ? '个视频' : '张配图'}`}
        aria-pressed={i === index} onClick={() => select(i)}>
        <PromptExampleImage media={entry} thumbnail />{entry.video && <span aria-hidden="true">▶</span>}
      </button>)}
    </div>}
    {preview && <PromptMediaViewer media={media} index={index} onSelect={select} onClose={() => setPreview(false)} />}
  </section>;
}

function PromptLibraryCard({ item, selected, onOpen, onPreview }) {
  const media = inboxMedia(item);
  const [index, setIndex] = useRefineryState(() => item.category === '视频生成' ? Math.max(0, media.findIndex(entry => entry.video)) : 0);
  const [coverHeight, setCoverHeight] = useRefineryState(null);
  const cover = useRefineryRef(null);
  const current = media[index] || media[0];
  const selectCover = (next) => {
    setCoverHeight(cover.current?.getBoundingClientRect().height || null);
    setIndex(next);
  };
  return <article className={`prompt-refinery-card${selected ? " is-selected" : ""}`} aria-label={item.title}>
    {current && <button className={`prompt-example-cover${coverHeight ? " has-fixed-height" : ""}`} ref={cover}
      style={coverHeight ? { height: coverHeight } : undefined} onClick={() => onPreview(item, index)}
      aria-label={`${current.video ? '查看提示词视频' : '放大提示词配图'}：${item.title}`} aria-haspopup="dialog">
      <PromptExampleImage key={current.url} media={current} />
      <span className="prompt-example-badge">{media.some(entry => entry.video) ? `共 ${media.length} 项` : `共 ${media.length} 张`}</span>
      {current.video && <span className="prompt-cover-video">视频</span>}
    </button>}
    {media.length > 1 && <div className="prompt-card-thumbnails" aria-label="切换封面">
      {media.slice(0, 4).map((entry, i) => <button key={`${entry.url}-${i}`} aria-label={`封面第 ${i + 1} 张`}
        aria-pressed={i === index} onClick={() => selectCover(i)}>
        <PromptExampleImage media={entry} thumbnail />{entry.video && <span className="prompt-thumbnail-video" aria-hidden="true">▶</span>}
      </button>)}
      {media.length > 4 && <button className="prompt-more-images" onClick={() => onPreview(item, 4)} aria-label={`查看全部 ${media.length} 张配图`}>+{media.length - 4}</button>}
    </div>}
    <button className="prompt-card-content" onClick={() => onOpen(item, index)} aria-label={`查看提示词：${item.title}`}
      aria-expanded={selected} aria-controls={selected ? "prompt-detail" : undefined}>
      <span className="prompt-detail-kind">{item.category}</span><h2>{item.title}</h2>
      {!current && <p>{compactText(item.text, 150)}</p>}
      <span className="prompt-card-tags">{promptDisplayTags(item.tags).slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</span>
    </button>
  </article>;
}

function PromptDetail({ item, initialIndex, onClose, onCorrectClassification, onOpenMethod, onCreateMedia, widthPreference }) {
  const [copyState, setCopyState] = useRefineryState("");
  const content = promptReadingContent(item.text, item.curated);
  const copyTimer = useRefineryRef(null);
  useRefineryEffect(() => {
    return () => clearTimeout(copyTimer.current);
  }, []);
  const copy = async () => {
    setCopyState('');
    try { await navigator.clipboard.writeText(item.text); setCopyState("已复制"); }
    catch { setCopyState("复制失败，请选择下方文字复制"); }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState(""), 2200);
  };
  return <DetailDrawer id="prompt-detail" className="prompt-refinery-detail" title="提示词详情" onClose={onClose} resizable widthPreference={widthPreference}>
    <div className="detail-drawer-body prompt-detail-body"><span className="prompt-detail-kind">{item.category}</span><h2>{item.title}</h2>
      {onCreateMedia && ['图像生成', '视频生成'].includes(item.category) && <div className="prompt-detail-actions"><button className="btn btn-primary" onClick={() => onCreateMedia(item)}>
          {item.category === '视频生成' ? '用此提示词创作视频' : '用此提示词生图'}
        </button></div>}
      {item.methodId && <button className="btn btn-ghost" onClick={() => onOpenMethod(item.methodId)}>阅读相关方法技巧 →</button>}
      <div className="prompt-detail-tags">{promptDisplayTags(item.tags).map(tag => <span key={tag}>{tag}</span>)}</div>
      <PromptExampleGallery item={item} initialIndex={initialIndex} />
      <section className="prompt-detail-copy" aria-label="提示词正文"><div className="prompt-copy-heading"><h3>{item.curated ? '提取的提示词' : '原始提示词'}</h3>
        <button className="btn" onClick={copy} title={item.curated ? '复制完整提示词' : '复制完整原文，包含原文链接'}>{copyState === '已复制' ? copyState : item.curated ? '复制提示词' : '复制原文'}</button></div>
        <span className="prompt-copy-status" role="status">{copyState}</span><pre>{content.text}</pre>
        {content.links.length > 0 && <div className="prompt-attached-links"><span>原文链接</span>{content.links.map((url, index) =>
          <a key={`${url}-${index}`} href={url} target="_blank" rel="noopener noreferrer" title={url}>t.co{content.links.length > 1 ? ` · ${index + 1}` : ''} <span aria-hidden="true">↗</span></a>)}</div>}
      </section>
      {(item.sourceUrl || onCorrectClassification) && <footer className="prompt-detail-source">
        {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">查看 X 原帖 <span aria-hidden="true">↗</span></a>}
        {onCorrectClassification && <button className="btn btn-ghost" onClick={() => onCorrectClassification({sourceInboxId:item.sourceInboxId})}>调整归类</button>}</footer>}
    </div>
  </DetailDrawer>;
}

function observePromptMasonry(grid) {
  const cards = Array.from(grid.children);
  let frame = 0;
  const layout = () => {
    frame = 0;
    if (!grid.isConnected || !grid.getBoundingClientRect().width) return;
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean);
    const gap = parseFloat(style.columnGap) || 0;
    grid.style.setProperty('--prompt-card-width', columns[0]);
    grid.classList.add('is-masonry');
    // Preserve chronological DOM order while filling the shortest column.
    const heights = cards.map(card => card.getBoundingClientRect().height);
    const bottoms = columns.map(() => 0);
    const width = parseFloat(columns[0]);
    cards.forEach((card, index) => {
      const column = bottoms.indexOf(Math.min(...bottoms));
      card.style.left = `${column * (width + gap)}px`;
      card.style.top = `${bottoms[column]}px`;
      bottoms[column] += heights[index] + gap;
    });
    grid.style.height = `${Math.max(0, ...bottoms) - (cards.length ? gap : 0)}px`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(layout);
  };
  const observer = window.ResizeObserver ? new ResizeObserver(schedule) : null;
  observer?.observe(grid);
  cards.forEach(card => observer?.observe(card));
  grid.addEventListener('load', schedule, true);
  window.addEventListener('resize', schedule);
  layout();
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    grid.removeEventListener('load', schedule, true);
    window.removeEventListener('resize', schedule);
    grid.classList.remove('is-masonry');
    grid.style.removeProperty('--prompt-card-width');
    grid.style.removeProperty('height');
    cards.forEach(card => { card.style.removeProperty('left'); card.style.removeProperty('top'); });
  };
}

function PromptLibraryView({ active = true, items, query, onQueryChange, onCorrectClassification, onOpenMethod, onCreateMedia, requestedSourceId, onRequestedSourceHandled }) {
  const [category, setCategory] = useRefineryState("all");
  const [subject, setSubject] = useRefineryState("all");
  const [style, setStyle] = useRefineryState("all");
  const [selected, setSelected] = useRefineryState(null);
  const [preview, setPreview] = useRefineryState(null);
  const [navigationNotice, setNavigationNotice] = useRefineryState('');
  const trigger = useRefineryRef(null);
  const detailWidth = useRefineryRef(null);
  const grid = useRefineryRef(null);
  useRefineryEffect(() => { if (!active) { setSelected(null); setPreview(null); } }, [active]);
  useRefineryEffect(() => {
    setSelected(current => { if (!current) return null; const item = items.find(x => x.id === current.item.id); return item ? {...current,item} : null; });
    setPreview(current => { if (!current) return null; const item = items.find(x => x.id === current.item.id); return item ? {...current,item} : null; });
  }, [items]);
  const openDetail = (item, index) => { trigger.current = document.activeElement; setPreview(null); setSelected({ item, index }); };
  const openPreview = (item, index) => {
    const media = inboxMedia(item);
    const nextIndex = promptMediaIndex(index, media.length);
    if (!media.length) return;
    if (media[nextIndex].video) { openDetail(item, nextIndex); return; }
    setSelected(null);
    setPreview({ item, index: nextIndex });
  };
  const previewMedia = preview ? inboxMedia(preview.item) : [];
  useRefineryEffect(() => {
    if (!requestedSourceId) return;
    const item = items.find(x => x.sourceInboxId === requestedSourceId);
    if (item) {setNavigationNotice(''); setCategory('all'); setSubject('all'); setStyle('all'); openDetail(item,0);}
    else setNavigationNotice('当前浏览范围内没有这条提示词，可能尚未整理成可复用版本，或属于另一个空间。');
    onRequestedSourceHandled?.();
  }, [requestedSourceId,items]);
  const closeDetail = () => { setSelected(null); if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); };
  const categoryOrder = ['图像生成', '视频生成', '编程', '自动化', '研究', '社媒内容', '其他'];
  const categories = [...new Set(items.map(item => item.category).filter(Boolean))].sort((a, b) => {
    const order = value => categoryOrder.includes(value) ? categoryOrder.indexOf(value) : categoryOrder.length;
    return order(a) - order(b) || a.localeCompare(b, 'zh-CN');
  });
  const selectedCategory = categories.includes(category) ? category : 'all';
  const categoryItems = items.filter(item => selectedCategory === 'all' || item.category === selectedCategory);
  const subjects = [...new Set(categoryItems.map(item => item.facets?.subject?.value).filter(Boolean))];
  const styles = [...new Set(categoryItems.map(item => item.facets?.style?.value).filter(value => value && value !== 'not_applicable'))];
  const needle = String(query || '').trim().toLowerCase();
  const matched = items.filter(item => !needle || `${item.title} ${item.text} ${promptDisplayTags(item.tags).join(' ')}`.toLowerCase().includes(needle));
  const visible = [...matched].sort(globalThis.OmniHubLibraryOrder.compare).filter((item) => {
    if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
    if (subject !== "all" && item.facets?.subject?.value !== subject) return false;
    if (style !== "all" && item.facets?.style?.value !== style) return false;
    return true;
  });
  const visibleKey = visible.map(item => item.id).join(',');
  useRefineryEffect(() => {
    if (active && grid.current) return observePromptMasonry(grid.current);
  }, [active, visibleKey]);
  const tabs = [{value:'all', label:'全部'}, ...categories.map(value => ({value, label:value}))];
  const chooseCategory = value => {setCategory(value); setSubject('all'); setStyle('all');};
  const resetFilters = () => {chooseCategory('all'); onQueryChange?.('');};
  const onTabKey = (event, index) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    chooseCategory(tabs[next].value);
    const tab = event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next];
    tab.focus({preventScroll:true}); tab.scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});
  };
  return (
    <div className="prompt-refinery-page"><div className="prompt-refinery-main">
      <div className="repository-head"><div><h1>提示词库</h1><p>{items.length} 条提示词 · 找效果、看原文、直接复用</p></div></div>
      {navigationNotice && <p className="prompt-navigation-notice" role="status">{navigationNotice}<button className="btn btn-ghost" onClick={() => setNavigationNotice('')}>知道了</button></p>}
      <div className="prompt-category-tabs" role="tablist" aria-label="提示词用途">
        {tabs.map((tab, index) => <button key={tab.value} id={`prompt-tab-${index}`} role="tab" aria-controls="prompt-results"
          aria-selected={selectedCategory === tab.value} tabIndex={selectedCategory === tab.value ? 0 : -1}
          onClick={() => chooseCategory(tab.value)} onKeyDown={event => onTabKey(event, index)}>{tab.label}
          <span>{tab.value === 'all' ? matched.length : matched.filter(item => item.category === tab.value).length}</span></button>)}
      </div>
      <div id="prompt-results" role="tabpanel" aria-labelledby={`prompt-tab-${tabs.findIndex(tab => tab.value === selectedCategory)}`}>
      <div className="prompt-facet-toolbar">
        <label className="prompt-facet"><span aria-hidden="true">{subject === 'all' ? '全部主体' : PROMPT_TAG_LABELS[subject] || subject}</span>
          <select aria-label="按主体筛选提示词" value={subject} onChange={e => setSubject(e.target.value)}><option value="all">全部主体</option>{subjects.map(value => <option key={value} value={value}>{PROMPT_TAG_LABELS[value] || value}</option>)}</select></label>
        <label className="prompt-facet"><span aria-hidden="true">{style === 'all' ? '全部风格' : PROMPT_TAG_LABELS[style] || style}</span>
          <select aria-label="按风格筛选提示词" value={style} onChange={e => setStyle(e.target.value)}><option value="all">全部风格</option>{styles.map(value => <option key={value} value={value}>{PROMPT_TAG_LABELS[value] || value}</option>)}</select></label>
        {(subject !== 'all' || style !== 'all') && <button className="prompt-clear-facets" onClick={() => {setSubject('all'); setStyle('all');}}>清除筛选</button>}
        <span role="status">{visible.length} 条提示词</span>
      </div>
      <div className="prompt-refinery-grid" ref={grid}>{visible.map(item => <PromptLibraryCard key={item.id} item={item}
        selected={selected?.item.id === item.id} onOpen={openDetail} onPreview={openPreview} />)}</div>
      {!visible.length && <div className="prompt-empty"><p>没有匹配的提示词</p><button className="btn" onClick={resetFilters}>查看全部提示词</button></div>}
      </div>
    </div>
    {active && selected && <PromptDetail key={`${selected.item.id}-${selected.index}`} item={selected.item} initialIndex={selected.index} onClose={closeDetail} onCorrectClassification={onCorrectClassification} onOpenMethod={onOpenMethod} onCreateMedia={onCreateMedia} widthPreference={detailWidth} />}
    {active && preview && previewMedia.length > 0 && <PromptMediaViewer media={previewMedia}
      index={promptMediaIndex(preview.index, previewMedia.length)}
      onSelect={index => setPreview(current => current ? {...current, index} : null)} onClose={() => setPreview(null)} />}
    </div>
  );
}
