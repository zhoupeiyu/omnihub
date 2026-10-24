import { REPOSITORY_TOPICS as topics, REPOSITORY_FORMS, SUBTOPICS, isValidClassification } from './repository-taxonomy.js';
import { readRepositoryLocation, repositoryLocation } from './repository-navigation.js';
import { getRepositoryDescription, getRepositorySummary } from './repository-localization.js';
import { getRepositoryGuide, loadRepositoryGuide, renderRepositoryGuide, renderGuideInstallation } from './repository-guides.js';

// Optional reading notes; repository classifications always come from the database.
const notes = [
  ['obra/superpowers', ['agent'], 'Skill', '开发工作流', '给编程 Agent 一套从需求澄清到开发的工作方法，让它先理解任务，再开始写代码。', '选一个小功能，观察 Agent 是否会先澄清需求，再安排实现步骤。'],
  ['nousresearch/hermes-agent', ['agent'], '应用', '长期协作', '带有学习循环的 AI Agent：从使用经验形成技能，保留知识，并检索过去的对话。', '用同一个小项目做两轮任务，观察第二轮是否能找回前一轮的上下文。'],
  ['anthropics/skills', ['agent'], 'Skill', '能力扩展', 'Anthropic 的 Agent Skills 仓库，以指令、脚本和资源组成可按需加载的专项能力。', '从一个与你当前任务相关的 Skill 开始，先读它的输入、输出和运行要求。'],
  ['openai/skills', ['agent'], 'Skill', '能力扩展', '面向 Codex 的技能目录，同时提供技能使用、自定义技能与开放标准的文档入口。'],
  ['msitarzewski/agency-agents', ['agent'], '资料集', '角色协作', '按专业角色组织的 Agent 集合，每个角色带有职责、工作方式与交付物说明。'],
  ['garrytan/gstack', ['agent', 'development'], '工具', '开发工作流', '把设计、工程管理、发布、文档与 QA 等角色工作组织成 Claude Code 工具集。'],
  ['eternityspring/shuohao-skills', ['video'], 'Skill', '剧本与分镜', '把短剧制作拆成可复用的技能：角色设定、改编大纲、美术设定、剧本和分镜。', '拿一段已有故事，先尝试生成角色设定和分镜清单，再检查信息是否一致。'],
  ['hbai-ltd/toonflow-app', ['video', 'design'], '应用', '创作工作台', '把无限画布、AI Agent 和可视化工作流放在一起，用于图像、视频、分镜与短剧创作。', '先在项目 README 看部署和模型接入要求，再用一个镜头测试创作流程。'],
  ['harry0703/moneyprinterturbo', ['video'], '应用', '短视频生成', '输入主题或关键词，利用大模型与自动化工作流生成短视频，适合研究批量内容制作。', '选择一个短主题，先核对素材来源、模型费用和视频输出设置，再做最小样片。'],
  ['forget-c/jellyfish', ['video'], '应用', '短剧制作', '覆盖剧本输入、结构化分镜、一致性管理、镜头准备、视频生成与导出的制作工作台。'],
  ['browser-use/video-use', ['video'], '工具', '视频编辑', '让编程 Agent 参与视频编辑，把视频处理放进熟悉的代码工作方式中。'],
  ['narratorai-studio/narrator-ai-cli-skill', ['video'], 'Skill', '视频解说', '封装 narrator-ai-cli 的 Agent Skill，让支持技能的工具参与自动化视频解说制作。'],
  ['leonxlnx/taste-skill', ['design'], 'Skill', '界面审美', '面向 AI 生成界面的审美指导，目标是减少千篇一律的视觉结果。'],
  ['carmahhawwari/ui-design-brain', ['design'], 'Skill', '界面组件', '为 AI 提供界面组件知识，包括布局模式、最佳实践和设计系统约定。'],
  ['liyue-aigc/female-portrait-director', ['design'], 'Skill', '女性人像', '用于构建与扩展女性人像提示词的模块化 Codex Skill，聚焦细节丰富的画面指导。'],
  ['better-auth/better-icons', ['design', 'development'], '工具', '图标检索', '提供图标搜索与获取能力，包含 Skill、MCP 服务和命令行工具。'],
  ['kepano/obsidian-skills', ['knowledge', 'agent'], 'Skill', 'Obsidian', '让 Agent 理解 Obsidian 的工作方式，处理 Markdown、Bases、JSON Canvas，并使用 Obsidian CLI。', '在测试用的笔记目录里，让 Agent 整理一篇 Markdown 笔记，检查链接与格式是否保留。'],
  ['joeseesun/qiaomu-anything-to-notebooklm', ['knowledge'], 'Skill', '内容转化', '把网页、公众号、YouTube、PDF 和 Markdown 等内容交给 NotebookLM，衔接播客、PPT 与思维导图。'],
  ['czlonkowski/n8n-mcp', ['knowledge'], 'MCP', '工作流自动化', '通过 MCP 把 AI 编程工具与 n8n 工作流构建连接起来。'],
  ['freestylefly/wechatbridge', ['knowledge'], '应用', '信息收集', '将微信聊天记录转发到 AI Agent 与 Obsidian 的原生 macOS 工具，连接聊天与知识整理。'],
  ['thysrael/horizon', ['knowledge'], '工具', '信息追踪', '用 AI 建立个人新闻雷达，并生成中英文每日简报。'],
  ['op7418/codepilot', ['development', 'agent'], '应用', '桌面客户端', '多模型 AI Agent 桌面客户端，可接入不同供应商，并通过 MCP 与 Skills 扩展能力。'],
  ['bytebytegohq/system-design-101', ['development'], '资料集', '系统设计', '用图解与简明语言解释复杂系统，作为系统设计学习与面试准备的参考。'],
  ['mattpocock/skills', ['development', 'agent'], 'Skill', '工程实践', '面向实际应用开发的工程技能集合，强调开发者对过程的控制。'],
  ['coreyhaines31/marketingskills', ['business'], 'Skill', '营销增长', '覆盖转化优化、文案、SEO、分析与增长工程的营销技能集合。'],
  ['fincept-corporation/finceptterminal', ['business'], '应用', '金融数据', '金融分析应用，提供市场分析、投资研究和经济数据工具，用于交互式研究。'],
  ['brokermr810/quantdinger', ['business'], '应用', '量化研究', '把策略研究、Python 策略构建、回测与模拟交易等环节放在一起的开源交易工作台。', '仅从历史数据和模拟环境开始；先理解数据、策略与风险限制，不接入真实交易账户。'],
];
const editorial = new Map(notes.map(([key, groups, form, subject, summary, idea], rank) => [key, { groups, form, subject, summary, idea, rank }]));
const topicById = new Map(topics.map(topic => [topic.id, topic]));
export function mountRepositoryExplorer(root, { query = '', onQueryChange = () => {}, onNavigationChange = () => {}, repositories = null, active = true, onCorrectClassification = null, onPreviewMedia = null } = {}) {
const lifetime = new AbortController();
const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: lifetime.signal });
const state = { repositories: [], section: query ? 'all' : 'overview', query, form: 'all', use: 'all', sort: 'default', detail:'', limit: 36, ...readRepositoryLocation(window.location.hash) };
let currentLocation = window.location.hash;
let savedScroll = 0;
let restoringPosition = false;
const positions = new Map();
function rememberPosition() {
  if (!restoringPosition && active && readRepositoryLocation(window.location.hash)) {
    savedScroll = window.scrollY;
    positions.set(currentLocation, { scroll:savedScroll, limit:state.limit });
  }
}
function restorePosition(top) {
  savedScroll = top;
  restoringPosition = true;
  requestAnimationFrame(() => {
    if (active) window.scrollTo({top,behavior:'instant'});
    requestAnimationFrame(() => { restoringPosition = false; });
  });
}
function writeLocation(mode = 'push', historyState = null) {
  const hash = repositoryLocation(state, window.location.hash);
  if (hash === window.location.hash) return;
  currentLocation = hash;
  window.history[mode === 'replace' ? 'replaceState' : 'pushState'](historyState, '', hash);
  window.dispatchEvent(new Event('hashchange'));
}
listen(window, 'scroll', rememberPosition, { passive:true });
const $ = id => root.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? escapeHtml(u.href) : ''; } catch { return ''; } };
const styleFor = id => { const t = topicById.get(id); return t ? `--topic-color:${t.color};--topic-bg:${t.background}` : ''; };
const getNote = repo => {
  const classification = repo.metadata?.classification;
  if (!isValidClassification(classification)) return null;
  const note = editorial.get(repo.key.toLowerCase());
  return {
    ...note,
    groups:[...new Set(classification.uses.map(use => SUBTOPICS.get(use).topic))],
    uses:classification.uses,
    forms:classification.forms,
    form:classification.forms.map(form => REPOSITORY_FORMS[form]).join(' · '),
    subject:classification.uses.map(use => SUBTOPICS.get(use).label).join(' · '),
    summary:getRepositorySummary(repo, classification.summary || note?.summary),
  };
};
const groupsFor = id => state.repositories.filter(repo => getNote(repo)?.groups.includes(id));
const curated = () => state.repositories.filter(getNote);
const unfiled = () => state.repositories.filter(repo => !getNote(repo));
const link = (url, label, className = '') => { const href = safeUrl(url); return href ? `<a class="${className}" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label); };
const icon = name => {
  // Reused paths from the existing public/icons.jsx system, not a new icon set.
  const paths = { search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>', book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>', bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', inbox: '<path d="M4 4h16l2 9v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/><path d="M2 13h5l2 3h6l2-3h5"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
};
const avatar = repo => `<span class="avatar" aria-hidden="true">${escapeHtml(repo.owner.slice(0,1).toUpperCase())}<img loading="lazy" referrerpolicy="no-referrer" src="https://github.com/${encodeURIComponent(repo.owner)}.png?size=80" alt=""></span>`;
listen(root, 'error', event => { if (event.target instanceof HTMLImageElement && event.target.closest('.avatar')) event.target.remove(); }, { capture: true });
$('search-icon').innerHTML = icon('search');
$('form-filter').innerHTML = '<option value="all">全部形态</option>' + Object.entries(REPOSITORY_FORMS).map(([id,label])=>`<option value="${id}">${label}</option>`).join('');

function renderUseFilter() {
  const topic = topicById.get(state.section);
  const pool = topic ? groupsFor(topic.id) : state.section === 'unfiled' ? unfiled() : state.repositories;
  const counts = new Map();
  for (const repo of pool) for (const use of getNote(repo)?.uses || []) counts.set(use,(counts.get(use)||0)+1);
  const choices = [...SUBTOPICS.values()].filter(use => (!topic || use.topic === topic.id) && counts.has(use.id));
  if (state.use !== 'all' && !choices.some(use=>use.id===state.use)) state.use = 'all';
  $('use-filter').innerHTML = '<option value="all">全部细分用途</option>' + choices.map(use=>`<option value="${use.id}">${use.label} · ${counts.get(use.id)}</option>`).join('');
  $('use-filter').value = state.use;
  $('use-filter').hidden = Boolean(topic);
  $('use-chips').hidden = !topic;
  $('use-chips').innerHTML = topic ? [{ id:'all', label:'全部', count:pool.length }, ...choices.map(use => ({...use,count:counts.get(use.id)}))].map(use =>
    `<button class="use-chip" data-use="${use.id}" aria-pressed="${state.use === use.id}">${escapeHtml(use.label)}<span>${use.count}</span></button>`).join('') : '';
}

function renderNavigation() {
  onNavigationChange({ current:state.section, items:[
    { id:'overview', title:'专题总览' }, { id:'all', title:'全部仓库', count:state.repositories.length },
    ...topics.map(topic => ({ id:topic.id, title:topic.title, count:groupsFor(topic.id).length, color:topic.color })),
    ...(unfiled().length ? [{ id:'unfiled', title:'待整理', count:unfiled().length }] : []),
  ] });
  $('mobile-section').innerHTML = `<option value="overview">专题浏览</option><option value="all">全部仓库 · ${state.repositories.length}</option>${topics.map(t => `<option value="${t.id}">${t.title} · ${groupsFor(t.id).length}</option>`).join('')}${unfiled().length ? `<option value="unfiled">尚未归入专题 · ${unfiled().length}</option>` : ''}`;
  $('mobile-section').value = state.section;
}
function card(repo) {
  const note = getNote(repo);
  return `<button class="repo-card${state.detail === repo.key ? ' selected' : ''}" style="${styleFor(note?.groups[0])}" data-repo="${escapeHtml(repo.key)}" aria-controls="repo-dialog" aria-expanded="${state.detail === repo.key}" aria-label="查看 ${escapeHtml(repo.name)} 详情"><span class="card-top">${avatar(repo)}<span class="card-heading"><h3>${escapeHtml(repo.name)}</h3><span class="owner">${escapeHtml(repo.owner)}</span></span><span class="card-arrow" aria-hidden="true">›</span></span><p class="repo-description">${escapeHtml(getRepositorySummary(repo, note?.summary))}</p><span class="card-bottom">${note ? `<span class="tag form">${note.form}</span><span class="tag">${note.subject}</span>` : '<span class="tag">待细分用途</span>'}</span></button>`;
}
function filterRepositories(input) {
  const query = state.query.trim().toLocaleLowerCase();
  let output = input.filter(repo => {
    const note = getNote(repo);
    const matchesForm = state.form === 'all' || note?.forms.includes(state.form);
    const matchesUse = state.use === 'all' || note?.uses.includes(state.use);
    const searchText = [repo.key, repo.description, getRepositoryDescription(repo).text, note?.summary, note?.subject, note?.form, ...(note?.groups.map(id => topicById.get(id).title) || [])].join(' ').toLocaleLowerCase();
    return matchesForm && matchesUse && (!query || searchText.includes(query));
  });
  if (state.sort === 'name') output = [...output].sort((a,b) => a.name.localeCompare(b.name));
  else output = [...output].sort((a,b) => (getNote(a)?.rank ?? Infinity) - (getNote(b)?.rank ?? Infinity));
  return output;
}
function render() {
  renderNavigation();
  renderUseFilter();
  const isOverview = state.section === 'overview' && !state.query && state.form === 'all' && state.use === 'all';
  const topic = topicById.get(state.section);
  $('repository-breadcrumb').innerHTML = `<button data-section="overview">仓库库</button><span aria-hidden="true">/</span><span aria-current="page">${topic?.title || (state.section === 'all' ? '全部仓库' : state.section === 'unfiled' ? '待整理' : '专题总览')}</span>`;
  const searchLabel = topic ? `在${topic.title}中搜索` : '搜索全部仓库';
  $('search').placeholder = `${searchLabel}：名称、用途、关键词`;
  $('search').setAttribute('aria-label', searchLabel);
  $('search-all').hidden = !topic || !state.query;
  $('page-title').textContent = isOverview ? '把收藏，变成手边的工具。' : topic?.title || (state.section === 'unfiled' ? '给这些收藏，找个位置。' : '全部仓库');
  $('page-description').textContent = isOverview ? '按用途、细分类别和工具形态，找到这次用得上的收藏。' : topic?.description || (state.section === 'unfiled' ? '这些新仓库还需要核对用途，原有介绍和来源都在。' : '所有可见仓库都在这里；可以搜索名称，也可以组合用途与形态筛选。');
  $('total-count').textContent = topic ? groupsFor(topic.id).length : state.repositories.length;
  $('total-count').nextElementSibling.textContent = topic ? '个专题仓库' : '个已收藏仓库';
  $('overview').hidden = !isOverview;
  $('overview').innerHTML = isOverview ? `<h2 class="topics-heading">今天，想做点什么？<span>${topics.length} 个用途专题 · 可交叉查找</span></h2><div class="topic-grid">${topics.map(t => `<button class="topic-tile" style="${styleFor(t.id)}" data-section="${t.id}"><div class="topic-tile-head"><span class="dot"></span><h3>${t.title}</h3><span class="topic-count">${groupsFor(t.id).length}</span><span class="topic-arrow" aria-hidden="true">›</span></div><p>${t.description}</p></button>`).join('')}</div>` : '';
  $('results-title').textContent = isOverview ? '从这些工具开始' : state.query ? '搜索结果' : '专题里的仓库';
  if (!isOverview && !topic && !state.query) $('results-title').textContent = '浏览仓库';
  $('form-filter').value = state.form;
  $('sort').value = state.sort;
  $('clear').hidden = !state.query && state.form === 'all' && state.use === 'all';
  $('results').classList.toggle('overview-results', isOverview);
  if (isOverview) {
    $('result-count').textContent = `${curated().length} 个已分类`;
    $('results').innerHTML = topics.map(t => {
      const repos = filterRepositories(groupsFor(t.id));
      return `<section class="repository-section"><div class="section-title"><span class="dot" style="${styleFor(t.id)}"></span><h3>${t.title}</h3><span class="section-line"></span><button data-section="${t.id}">查看 ${repos.length} 个 →</button></div><div class="repo-grid">${repos.slice(0,3).map(card).join('')}</div></section>`;
    }).join('');
  } else {
    const pool = state.section === 'unfiled' ? unfiled() : topic ? groupsFor(topic.id) : state.repositories;
    const repos = filterRepositories(pool);
    $('result-count').textContent = `${repos.length} 个仓库`;
    $('results').innerHTML = repos.length ? `<div class="repo-grid">${repos.slice(0,state.limit).map(card).join('')}</div>${repos.length > state.limit ? `<button class="load-more" data-more>再看 ${Math.min(36,repos.length-state.limit)} 个 · 已显示 ${state.limit} / ${repos.length}</button>` : ''}` : '<div class="empty-state"><h2>这次没有找到匹配的仓库</h2><p>试试更短的关键词，或清除形态筛选。</p><button class="text-button" data-reset>清除搜索与筛选</button></div>';
  }
  $('results').setAttribute('aria-busy', 'false');
  $('coverage').textContent = `已分类 ${curated().length} / ${state.repositories.length} 个可见仓库${unfiled().length ? `，${unfiled().length} 个待整理` : ''}。分类已保存到知识库；同一仓库可属于多个用途，专题数量不相加。原始收藏、介绍与链接均保留。分类不代表已实测或链接全部有效。`;
}
function changeSection(section) {
  if (!['overview','all','unfiled',...topicById.keys()].includes(section)) return;
  rememberPosition();
  state.section = section; state.query = ''; state.form = 'all'; state.use = 'all'; state.limit = 36;
  hideDetail();
  $('search').value = '';
  onQueryChange('');
  render();
  writeLocation();
  root.host?.scrollIntoView({block:'start'});
}
function clearFilters() { rememberPosition(); state.query = ''; state.form = 'all'; state.use = 'all'; state.limit = 36; $('search').value = ''; onQueryChange(''); render(); writeLocation(); }
listen(root, 'click', event => {
  const target = event.target.closest('[data-section],[data-use],[data-repo],[data-more],[data-reset],[data-retry-detail],[data-retry],[data-correct-classification],[data-repo-media],[data-guide-copy]');
  if (!target) return;
  if (target.hasAttribute('data-repo-media')) {
    const media = getRepositoryGuide(state.detail)?.media || [];
    const index = Number(target.dataset.repoMedia);
    if (onPreviewMedia && Number.isInteger(index) && media[index]) {
      event.preventDefault();
      onPreviewMedia({media,index,returnFocus:target,label:'仓库效果图'});
    }
    return;
  }
  if (target.hasAttribute('data-guide-copy')) {
    const block = target.closest('.guide-code');
    const status = block.querySelector('.guide-copy-status');
    const content = block.querySelector('code').textContent;
    (async () => {
      try { await navigator.clipboard.writeText(content); status.textContent = '已复制'; }
      catch { status.textContent = '复制失败，请手动选择上方文字'; }
    })();
    return;
  }
  rememberPosition();
  if (target.hasAttribute('data-section')) changeSection(target.dataset.section);
  if (target.hasAttribute('data-use')) { state.use = target.dataset.use; state.limit = 36; render(); writeLocation(); root.querySelector(`[data-use="${state.use}"]`)?.focus({preventScroll:true}); }
  if (target.hasAttribute('data-repo')) openDetail(target.dataset.repo);
  if (target.hasAttribute('data-more')) { state.limit += 36; render(); rememberPosition(); }
  if (target.hasAttribute('data-reset')) clearFilters();
  if (target.hasAttribute('data-retry')) load();
  if (target.hasAttribute('data-retry-detail')) openDetail(target.dataset.retryDetail);
  if (target.hasAttribute('data-correct-classification')) onCorrectClassification?.(state.detail);
});
listen(root, 'change', event => {
  if (!event.target.matches('[data-guide-platform]')) return;
  const guide = getRepositoryGuide(state.detail);
  if (guide) root.querySelector('[data-guide-installation]').innerHTML = renderGuideInstallation(guide, Number(event.target.value));
});
listen(root, 'error', event => {
  const image = event.target;
  if (!image.matches?.('.guide-image img')) return;
  image.hidden = true;
  image.parentElement.classList.add('image-unavailable');
  image.parentElement.querySelector('span').textContent = `${image.alt} · 图片暂时无法加载`;
}, {capture:true});
listen($('mobile-section'), 'change', event => changeSection(event.target.value));
let searchHistoryStarted = false;
listen($('search'), 'focus', () => { searchHistoryStarted = false; });
listen($('search'), 'input', event => { rememberPosition(); state.query = event.target.value; if (state.section === 'overview') state.section = 'all'; state.limit = 36; onQueryChange(state.query); render(); writeLocation(searchHistoryStarted ? 'replace' : 'push'); searchHistoryStarted = true; });
listen($('search-all'), 'click', () => { rememberPosition(); state.section = 'all'; state.use = 'all'; state.limit = 36; render(); writeLocation(); });
listen($('form-filter'), 'change', event => { rememberPosition(); state.form = event.target.value; state.limit = 36; if (state.section === 'overview') state.section = 'all'; render(); writeLocation(); });
listen($('use-filter'), 'change', event => { rememberPosition(); state.use = event.target.value; state.limit = 36; if (state.section === 'overview') state.section = 'all'; render(); writeLocation(); });
listen($('sort'), 'change', event => { rememberPosition(); state.sort = event.target.value; state.limit = 36; render(); writeLocation(); });
listen($('clear'), 'click', clearFilters);

let detailRequest;
const detailCache = new Map();
const dialog = $('repo-dialog');
const detailLayer = $('repo-detail-layer');
let releaseDrawer;
let returnFocusKey = '';
function releaseDetailShell() { releaseDrawer?.(); releaseDrawer = null; }
function showDetailShell() {
  detailLayer.hidden = !active;
  if (active && !releaseDrawer) releaseDrawer = window.OmniDetailDrawer.mount(dialog, closeDetail);
  else if (active && !dialog.contains(window.OmniDetailDrawer.activeElement())) dialog.focus({preventScroll:true});
}
function markSelectedCard() {
  root.querySelectorAll('[data-repo]').forEach(card => { const selected = card.dataset.repo === state.detail; card.classList.toggle('selected',selected); card.setAttribute('aria-expanded',String(selected)); });
}
function hideDetail() {
  onPreviewMedia?.(null);
  state.detail = '';
  dialog.hidden = true;
  detailLayer.hidden = true;
  releaseDetailShell();
  detailRequest?.abort();
  markSelectedCard();
}
function closeDetail() {
  rememberPosition();
  const key = state.detail;
  const parent = window.history.state?.repositoryDetailParent;
  hideDetail();
  if (parent === repositoryLocation(state, window.location.hash)) { returnFocusKey = key; window.history.back(); }
  else {
    writeLocation('replace');
    [...root.querySelectorAll('[data-repo]')].find(card => card.dataset.repo === key)?.focus({preventScroll:true});
  }
}
listen($('close-detail'), 'click', closeDetail);
listen($('repo-detail-backdrop'), 'click', closeDetail);
function detailMarkup(repo) {
  const note = getNote(repo);
  const guide = getRepositoryGuide(repo.key);
  const description = getRepositoryDescription(repo);
  const summary = guide?.summary || getRepositorySummary(repo, note?.summary);
  const official = ['github_description','github_readme'].includes(repo.metadata?.descriptionProvenance);
  const readmeUrl = `${repo.repositoryUrl.replace(/\/$/,'')}#readme`;
  return `<div class="detail-head">
    <div class="detail-identity">${avatar(repo)}<div>
      <h2 id="detail-title">${escapeHtml(repo.name)}${link(repo.repositoryUrl,'↗','repository-link').replace('class="repository-link"','class="repository-link" aria-label="在 GitHub 打开仓库（新标签页）" title="在 GitHub 打开仓库"')}</h2>
      <span class="owner">${escapeHtml(repo.owner)} / ${escapeHtml(repo.name)}</span>
    </div></div>
    <p class="detail-summary" id="detail-summary" ${summary === description.text ? 'hidden' : ''}>${escapeHtml(summary)}</p>
    <div class="detail-tags">${note ? `<span class="tag">${escapeHtml(note.form)}</span><span class="tag">${escapeHtml(note.subject)}</span>` : '<span class="tag">用途尚未细分</span>'}</div>
    ${onCorrectClassification ? '<button class="inline-link" data-correct-classification>调整归类</button>' : ''}
  </div>
  <div class="detail-body">
    ${repo.metadata?.classification?.linkStatus ? `<section class="detail-section"><h3>原链接需核对</h3><p class="detail-hint">${repo.metadata.classification.linkStatus === 'truncated' ? '原收藏中的仓库路径被截断，已保留原始入口。' : '整理时未能读取该仓库，可能已改名、转为私有或失效。'} 用途已依据可用资料归类，不代表当前可以直接使用。</p>${repo.metadata.classification.candidateUrl ? link(repo.metadata.classification.candidateUrl,'核对相关官方仓库 ↗','inline-link') : ''}</section>` : ''}
    <div id="detail-guide">${guide ? renderRepositoryGuide(guide,{introFallback:description.text}) : `<section class="detail-section">
      <h3>仓库介绍<span class="section-kicker">${description.translated ? '中文整理 · ' : ''}${official ? '依据已收录的 GitHub 内容' : '依据已保存的收藏介绍，尚待核对'}</span></h3>
      <p class="official-description" lang="zh-CN">${escapeHtml(description.text)}</p>
      ${description.translated || description.status === 'pending' ? `<details class="description-original"><summary>查看原文</summary><p class="original-description" dir="auto">${escapeHtml(description.original)}</p></details>` : ''}
      <p class="detail-hint" data-guide-message role="status">正在加载中文使用指南，先展示已保存的仓库介绍。</p>
      ${link(readmeUrl,'查看官方使用说明 ↗','inline-link')}
    </section>`}</div>
    ${repo.personalNote ? `<section class="detail-section"><h3>我的笔记</h3><p>${escapeHtml(repo.personalNote)}</p></section>` : ''}
    <div id="detail-evidence"><p class="detail-loading" role="status">正在读取关联知识与原始来源…</p></div>
  </div>`;
}
function evidenceMarkup(detail) {
  const sources = Array.isArray(detail.sources) ? detail.sources : [];
  const knowledge = Array.isArray(detail.relatedKnowledge) ? detail.relatedKnowledge : [];
  const links = Array.isArray(detail.targetLinks) ? detail.targetLinks : [];
  return `${knowledge.length ? `<section class="detail-section"><h3>已整理成的知识</h3>${knowledge.map(article => `<article class="related-knowledge"><h4>${escapeHtml(article.title)}</h4><p>${escapeHtml(article.summary)}</p></article>`).join('')}</section>` : ''}<section class="detail-section"><details><summary>原始收藏与引用 · ${sources.length} 条来源${links.length ? ` · ${links.length} 个保存入口` : ''}</summary><div class="source-list">${sources.map(source => `<article class="source-item"><div class="source-author">${escapeHtml(source.author)}</div>${link(source.url,`${source.title || '查看原始收藏'} ↗`)}<p>${escapeHtml(source.excerpt)}</p></article>`).join('') || '<p class="detail-hint">没有可展示的来源。</p>'}${links.map(item => `<div class="source-item">${link(item.url,`${item.url} ↗`)}</div>`).join('')}</div></details></section>`;
}
async function openDetail(key, fromHistory = false) {
  const repo = state.repositories.find(item => item.key === key);
  if (!repo) return;
  onPreviewMedia?.(null);
  if (!fromHistory) rememberPosition();
  const wasOpen = Boolean(state.detail);
  const parent = window.history.state?.repositoryDetailParent || repositoryLocation({...state,detail:''}, window.location.hash);
  state.detail = key;
  if (!fromHistory) writeLocation(wasOpen ? 'replace' : 'push', {repositoryDetailParent:parent});
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  $('detail-content').innerHTML = detailMarkup(repo);
  dialog.hidden = false;
  showDetailShell();
  markSelectedCard();
  $('detail-content').scrollTop = 0;
  if (!fromHistory) dialog.focus({preventScroll:true});
  // Guide JSON and the private-reference API are intentionally independent:
  // an unavailable citation request must not hide a public README guide, and
  // vice versa. The controller and key guard prevent a slow old request from
  // writing into a newly opened drawer.
  void loadRepositoryGuide(key, {signal:controller.signal}).then(guide => {
    if (controller.signal.aborted || state.detail !== key || dialog.hidden) return;
    if (!guide) {
      const message = root.querySelector('[data-guide-message]');
      if (message) message.textContent = '暂时无法加载这份指南。可以先查看官方说明，或稍后重新打开详情。';
      return;
    }
    const guideContainer = $('detail-guide');
    if (guideContainer) guideContainer.innerHTML = renderRepositoryGuide(guide,{introFallback:getRepositoryDescription(repo).text});
    const summaryNode = $('detail-summary');
    const description = getRepositoryDescription(repo);
    if (summaryNode && guide.summary) {
      summaryNode.textContent = guide.summary;
      summaryNode.hidden = guide.summary === description.text;
    }
  });
  void (async () => {
    try {
      let detail = detailCache.get(key);
      if (!detail) {
        const detailPath = `/api/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
        const scoped = typeof window.omnihubScopedCataloguePath === 'function' ? window.omnihubScopedCataloguePath(detailPath) : detailPath;
        const response = await fetch(scoped, {signal:controller.signal});
        if (!response.ok) throw new Error('Repository details unavailable');
        detail = await response.json();
        if (!detail || typeof detail !== 'object' || !detail.key) throw new Error('Invalid repository details');
        detailCache.set(key,detail);
      }
      if (!controller.signal.aborted && state.detail === key && !dialog.hidden) $('detail-evidence').innerHTML = evidenceMarkup(detail);
    } catch (error) {
      if (error.name !== 'AbortError' && !controller.signal.aborted && state.detail === key && !dialog.hidden) $('detail-evidence').innerHTML = `<section class="detail-section"><p class="detail-hint">关联信息暂时没有加载成功，当前介绍仍可阅读。</p><button class="text-button" data-retry-detail="${escapeHtml(key)}">重新读取引用</button></section>`;
    }
  })();
}
async function load() {
  $('results').setAttribute('aria-busy','true');
  try {
    const cataloguePath = typeof window.omnihubScopedCataloguePath === 'function' ? window.omnihubScopedCataloguePath('/api/repositories') : '/api/repositories';
    const response = await fetch(cataloguePath, { signal: lifetime.signal });
    if (!response.ok) throw new Error('Repository library unavailable');
    const repositories = await response.json();
    if (!Array.isArray(repositories)) throw new Error('Invalid repository library');
    state.repositories = repositories.filter(repo => typeof repo.key === 'string' && typeof repo.name === 'string' && typeof repo.owner === 'string' && typeof repo.repositoryUrl === 'string');
    render();
  } catch (error) {
    if (lifetime.signal.aborted) return;
    $('results').setAttribute('aria-busy','false');
    $('results').innerHTML = '<div class="empty-state"><h2>仓库数据暂时没有加载成功</h2><p>服务暂时未响应，请稍后重试。原始数据没有改动。</p><button class="text-button" data-retry>重新加载</button></div>';
  }
}
$('search').value = state.query;
onQueryChange(state.query);
if (Array.isArray(repositories)) {
  state.repositories = repositories.filter(repo => typeof repo.key === 'string' && typeof repo.name === 'string' && typeof repo.owner === 'string' && typeof repo.repositoryUrl === 'string');
  render();
  if (state.detail) openDetail(state.detail, true);
} else load();
listen(window, 'hashchange', () => {
  if (window.location.hash === currentLocation) return;
  currentLocation = window.location.hash;
  const next = readRepositoryLocation(currentLocation);
  if (!next) return;
  const position = positions.get(currentLocation);
  const previousDetail = state.detail;
  Object.assign(state, next, {limit:position?.limit || 36});
  $('search').value = state.query;
  onQueryChange(state.query);
  render();
  if (state.detail) {
    openDetail(state.detail, true);
    if (active) dialog.focus({preventScroll:true});
  } else {
    hideDetail();
    const focusKey = previousDetail || returnFocusKey;
    returnFocusKey = '';
    if (focusKey && active) [...root.querySelectorAll('[data-repo]')].find(card => card.dataset.repo === focusKey)?.focus({preventScroll:true});
  }
  restorePosition(position?.scroll || 0);
});
return {
  navigate: changeSection,
  setActive(value) {
    active = value;
    if (!active) { onPreviewMedia?.(null); detailLayer.hidden = true; releaseDetailShell(); }
    else if (state.detail) showDetailShell();
    if (active) restorePosition(savedScroll);
  },
  setQuery(value) {
    if (state.query === value) return;
    rememberPosition();
    state.query = value; if (state.section === 'overview') state.section = 'all'; state.limit = 36;
    $('search').value = value;
    render();
    writeLocation('replace');
  },
  destroy() {
    lifetime.abort();
    detailRequest?.abort();
    hideDetail();
    detailCache.clear();
  },
};
}
