import { REPOSITORY_TOPICS as topics, REPOSITORY_FORMS, SUBTOPICS, isValidClassification } from './repository-taxonomy.js';
import { readRepositoryLocation, repositoryLocation } from './repository-navigation.js';
import { createRepositoryFilter } from './repository-filter.js';
import './library-order.js';
import { getRepositoryDescription, getRepositorySummary } from './repository-localization.js';
import { getRepositoryGuide, loadRepositoryGuide, renderRepositoryGuide, renderGuideInstallation, renderRepositoryGuideMeta, renderRepositoryGuideSources } from './repository-guides.js';

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
export function canFocusRepositorySearch(event, { active, detailOpen, editable, overlayOpen }) {
  return active && !detailOpen && !editable && !overlayOpen && event.key === '/'
    && !event.defaultPrevented && !event.isComposing && !event.repeat
    && !event.ctrlKey && !event.metaKey && !event.altKey;
}
export function repositoryOrganizationDay(repository) {
  for (const value of [repository.organizedAt, repository.updatedAt, repository.updated_at, repository.createdAt, repository.created_at]) {
    const time = globalThis.OmniHubLibraryOrder.timestamp({organizedAt:value});
    if (!time) continue;
    const text = String(value).trim();
    // A review recorded as a date has no timezone and must retain its calendar day.
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date(time).toLocaleDateString('sv-SE');
  }
  return 'undated';
}
export function buildRepositoryTimeline(repositories, {group = 'owner', sort = 'default'} = {}) {
  const days = new Map();
  for (const repository of repositories) {
    const date = repositoryOrganizationDay(repository);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(repository);
  }
  return [...days.keys()].sort((a,b) => a === b ? 0 : a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a))
    .flatMap(date => {
      const rows = days.get(date);
      const items = group === 'owner' ? groupRepositoriesByOwner(rows, sort) : rows;
      // Each pagination unit is a complete author within one day (or one ungrouped card).
      return items.map(item => ({date, count:rows.length, item}));
    });
}
export function groupRepositoriesByOwner(repositories, sort = 'recent') {
  const groups = new Map();
  for (const repository of repositories) {
    const key = repository.owner.toLowerCase();
    if (!groups.has(key)) groups.set(key, {key, owner:repository.owner, repositories:[]});
    groups.get(key).repositories.push(repository);
  }
  if (sort === 'topic') return [...groups.values()];
  if (sort !== 'name') for (const group of groups.values()) group.repositories.sort(globalThis.OmniHubLibraryOrder.compare);
  return [...groups.values()].sort((a,b) => sort === 'name' ? a.key.localeCompare(b.key, 'en')
    : globalThis.OmniHubLibraryOrder.compare(a.repositories[0], b.repositories[0]) || a.key.localeCompare(b.key, 'en'));
}
export function mountRepositoryExplorer(root, { query = '', onQueryChange = () => {}, repositories = null, active = true, onCorrectClassification = null, onPreviewMedia = null } = {}) {
const lifetime = new AbortController();
const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: lifetime.signal });
const state = { repositories: [], section: 'all', query, form: 'all', use: 'all', sort: 'default', group:'owner', detail:'', limit: 36, ...readRepositoryLocation(window.location.hash) };
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
    requestAnimationFrame(() => { restoringPosition = false; updateContinuation(); });
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
let resultItems = [];
let renderedCount = 0;
const resultsEnd = $('results-end');
const moreObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) appendMoreResults();
}, {rootMargin:'0px 0px 160px 0px'});
function updateContinuation() {
  moreObserver.disconnect();
  const hasMore = renderedCount < resultItems.length;
  resultsEnd.hidden = resultItems.length <= 36;
  resultsEnd.textContent = hasMore ? '继续下滑，查看更多' : '已显示全部';
  if (hasMore && active && !restoringPosition && !state.detail && !document.hidden && !lifetime.signal.aborted) moreObserver.observe(resultsEnd);
}
function appendMoreResults() {
  if (!active || restoringPosition || state.detail || document.hidden || lifetime.signal.aborted || renderedCount >= resultItems.length) return;
  // Recheck the current layout: an observer entry can predate a filter or tab change.
  const bounds = resultsEnd.getBoundingClientRect();
  if (resultsEnd.hidden || !resultsEnd.getClientRects().length || bounds.top > window.innerHeight + 160 || bounds.bottom < 0) return;
  moreObserver.disconnect();
  const next = resultItems.slice(renderedCount, renderedCount + 36);
  appendTimelineItems(next, renderedCount);
  renderedCount += next.length;
  state.limit = renderedCount;
  updateContinuation();
  rememberPosition();
}
listen(document, 'visibilitychange', updateContinuation);
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
const unfiled = () => state.repositories.filter(repo => !getNote(repo));
const link = (url, label, className = '') => { const href = safeUrl(url); return href ? `<a class="${className}" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label); };

function renderRepositoryCollectionSources(detail) {
  const keyFor = value => String(value || '').replace(/\/#readme$|#readme$/i,'').replace(/\/$/,'').toLowerCase();
  const seen = new Set([keyFor(`https://github.com/${detail.key}`)]);
  const unique = items => items.filter(item => {
    const key = keyFor(item.url);
    if (!safeUrl(item.url) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sources = unique(Array.isArray(detail.sources) ? detail.sources : []);
  const links = unique(Array.isArray(detail.targetLinks) ? detail.targetLinks : []);
  if (!sources.length && !links.length) return '';
  return `<div class="collection-sources"><h4>收藏来源</h4><div class="source-list">${sources.map(source => `<article class="source-item"><div class="source-author">${escapeHtml(source.author)}</div>${link(source.url,`${source.title || '查看原始收藏'} ↗`)}${source.excerpt ? `<p>${escapeHtml(source.excerpt)}</p>` : ''}</article>`).join('')}${links.map(item => `<div class="source-item">${link(item.url,`${item.url} ↗`)}</div>`).join('')}</div></div>`;
}
const icon = name => {
  // Reused paths from the existing public/icons.jsx system, not a new icon set.
  const paths = { search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>', book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>', bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', inbox: '<path d="M4 4h16l2 9v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/><path d="M2 13h5l2 3h6l2-3h5"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
};
const avatar = repo => `<span class="avatar" aria-hidden="true">${escapeHtml(repo.owner.slice(0,1).toUpperCase())}<img loading="lazy" referrerpolicy="no-referrer" src="https://github.com/${encodeURIComponent(repo.owner)}.png?size=80" alt=""></span>`;
listen(root, 'error', event => { if (event.target instanceof HTMLImageElement && event.target.closest('.avatar')) event.target.remove(); }, { capture: true });
$('search-icon').innerHTML = icon('search');
$('results').dataset.view = 'cards';
const filterControls = [...root.querySelectorAll('.filters select')].map(createRepositoryFilter);
const topicTabs = $('topic-tabs');
function updateTopicOverflow() {
  $('topic-scroll-controls').hidden = topicTabs.scrollWidth <= topicTabs.parentElement.clientWidth + 1;
  $('topics-prev').disabled = topicTabs.scrollLeft <= 1;
  $('topics-next').disabled = topicTabs.scrollLeft + topicTabs.clientWidth >= topicTabs.scrollWidth - 1;
}
function revealTopicTab(tab) {
  const frame = topicTabs.getBoundingClientRect();
  const item = tab.getBoundingClientRect();
  if (item.left < frame.left) topicTabs.scrollLeft += item.left - frame.left;
  else if (item.right > frame.right) topicTabs.scrollLeft += item.right - frame.right;
  updateTopicOverflow();
}
const topicResize = new ResizeObserver(() => {
  updateTopicOverflow();
  const selected = topicTabs.querySelector('[aria-selected="true"]');
  if (active && selected) revealTopicTab(selected);
});
topicResize.observe(topicTabs);
listen(topicTabs, 'scroll', updateTopicOverflow, {passive:true});
for (const [id, direction] of [['topics-prev', -1], ['topics-next', 1]]) {
  listen($(id), 'click', () => topicTabs.scrollBy({left:direction * topicTabs.clientWidth * .75, behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}));
}
listen(topicTabs, 'keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const tabs = [...topicTabs.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : event.key === 'ArrowRight' ? (index + 1) % tabs.length
    : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs.forEach((button,i) => { button.tabIndex = i === next ? 0 : -1; });
  tabs[next].focus({preventScroll:true});
  revealTopicTab(tabs[next]);
});
listen(window, 'keydown', event => {
  if (event.key !== '/' || !active) return;
  const target = event.composedPath()[0];
  const editable = target?.isContentEditable || Boolean(target?.closest?.('input, textarea, select, [role="combobox"], [role="textbox"], [contenteditable]:not([contenteditable="false"])'));
  const overlayOpen = document.body.dataset.detailDrawerOpen === 'true'
    || Boolean(root.host?.closest('[inert]'))
    || [...document.querySelectorAll('[aria-modal="true"], dialog[open], .modal-overlay, .lightbox, .inbox-media-overlay')].some(element => element.getClientRects().length);
  if (!canFocusRepositorySearch(event, { active, detailOpen:Boolean(state.detail), editable, overlayOpen })) return;
  event.preventDefault();
  $('search').focus();
});
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
  const items = [
    { id:'overview', title:'专题总览' }, { id:'all', title:'全部仓库', count:state.repositories.length },
    ...topics.map(topic => ({ id:topic.id, title:topic.title, count:groupsFor(topic.id).length, color:topic.color })),
    ...(unfiled().length || state.section === 'unfiled' ? [{ id:'unfiled', title:'待整理', count:unfiled().length }] : []),
  ];
  const sections = items.map(item => item.id).join('|');
  if (topicTabs.dataset.sections !== sections) {
    topicTabs.innerHTML = items.map(item => `<button type="button" class="topic-tab" id="repository-tab-${item.id}" role="tab" aria-controls="repository-panel" aria-selected="false" tabindex="-1" data-section="${item.id}" style="${styleFor(item.id)}">${item.color ? '<span class="tab-dot" aria-hidden="true"></span>' : ''}${escapeHtml(item.title)}</button>`).join('');
    topicTabs.dataset.sections = sections;
  }
  for (const tab of topicTabs.children) {
    const selected = tab.dataset.section === state.section;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('repository-panel').setAttribute('aria-labelledby', `repository-tab-${state.section}`);
  updateTopicOverflow();
  if (topicTabs.dataset.section !== state.section) {
    topicTabs.dataset.section = state.section;
    revealTopicTab($(`repository-tab-${state.section}`));
  }
}
function card(repo) {
  const note = getNote(repo);
  const primaryUse = note?.uses[0] ? SUBTOPICS.get(note.uses[0]).label : '';
  return `<button class="repo-card${state.detail === repo.key ? ' selected' : ''}" style="${styleFor(note?.groups[0])}" data-repo="${escapeHtml(repo.key)}" aria-controls="repo-dialog" aria-expanded="${state.detail === repo.key}" aria-label="查看 ${escapeHtml(repo.name)} 详情"><span class="card-top">${avatar(repo)}<span class="card-heading"><h3><span>${escapeHtml(repo.name)}</span><svg class="card-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></h3><span class="owner">${escapeHtml(repo.owner)}</span></span></span><span class="card-tags">${note ? `<span class="tag form">${escapeHtml(note.form)}</span><span class="tag" title="${escapeHtml(note.subject)}">${escapeHtml(primaryUse)}${note.uses.length > 1 ? ` +${note.uses.length - 1}` : ''}</span>` : '<span class="tag pending">待细分用途</span>'}</span><p class="repo-description">${escapeHtml(getRepositorySummary(repo, note?.summary))}</p></button>`;
}
function ownerGroup(group, index) {
  const titleId = `owner-group-${index}`;
  return `<section class="owner-group" data-owner="${escapeHtml(group.key)}" aria-labelledby="${titleId}"><header class="owner-group-heading">${avatar(group.repositories[0])}<h3 id="${titleId}">${link(`https://github.com/${encodeURIComponent(group.owner)}`,escapeHtml(group.owner),'owner-profile')}</h3><span class="owner-count">${group.repositories.length} 个仓库</span></header><div class="repo-grid">${group.repositories.map(card).join('')}</div></section>`;
}
function appendTimelineItems(items, offset = 0) {
  const timeline = $('results').querySelector('.repository-timeline');
  const grouped = state.group === 'owner';
  for (const [index, {date, count, item}] of items.entries()) {
    let day = timeline.lastElementChild;
    if (day?.dataset.date !== date) {
      const titleId = `repository-day-${date}`;
      const label = date === 'undated' ? '整理日期待补全' : `${Number(date.slice(5,7))} 月 ${Number(date.slice(8,10))} 日`;
      timeline.insertAdjacentHTML('beforeend', `<section class="repository-day" data-date="${date}" aria-labelledby="${titleId}"><header class="repository-day-heading"><h3 id="${titleId}">${date === 'undated' ? label : `<time datetime="${date}">${label}</time>`}</h3><span class="repository-day-meta">${date === 'undated' ? '' : `${date.slice(0,4)} · `}整理 ${count} 个仓库</span></header><div class="repository-day-content ${grouped ? 'owner-groups' : 'repo-grid'}"></div></section>`);
      day = timeline.lastElementChild;
    }
    // Continue the existing day without replacing cards, focus or scroll position.
    day.lastElementChild.insertAdjacentHTML('beforeend', grouped ? ownerGroup(item, offset + index) : card(item));
  }
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
  else if (state.sort === 'topic') output = [...output].sort((a,b) => (getNote(a)?.rank ?? Infinity) - (getNote(b)?.rank ?? Infinity));
  else output = [...output].sort(globalThis.OmniHubLibraryOrder.compare);
  return output;
}
function render() {
  moreObserver.disconnect();
  resultItems = [];
  renderedCount = 0;
  renderNavigation();
  renderUseFilter();
  const isOverview = state.section === 'overview' && !state.query && state.form === 'all' && state.use === 'all';
  const topic = topicById.get(state.section);
  $('main').classList.toggle('is-overview', isOverview);
  const searchLabel = topic ? `在${topic.title}中搜索` : '搜索全部仓库';
  $('search').placeholder = topic ? '搜索当前专题' : '搜索名称、用途或关键词';
  $('search').setAttribute('aria-label', searchLabel);
  $('search-all').hidden = !topic || !state.query;
  $('total-count').textContent = state.repositories.length;
  $('results-title').textContent = state.query ? '搜索结果' : isOverview ? '工具速览' : topic?.title || (state.section === 'unfiled' ? '待整理' : '全部仓库');
  $('form-filter').value = state.form;
  $('sort').value = state.sort;
  $('group-filter').hidden = isOverview;
  $('group-filter').value = state.group;
  const grouped = !isOverview && state.group === 'owner';
  $('sort').querySelector('option[value="default"]').textContent = '最近整理';
  $('sort').querySelector('option[value="name"]').textContent = grouped ? '作者 A–Z' : '名称 A–Z';
  for (const filter of filterControls) {
    filter.update(filter.select.hidden || (isOverview && ['use-filter','form-filter'].includes(filter.select.id)));
  }
  $('clear').hidden = !state.query && state.form === 'all' && state.use === 'all';
  $('results').classList.toggle('overview-results', isOverview);
  if (isOverview) {
    $('result-count').textContent = `${topics.length} 个专题`;
    $('results').innerHTML = topics.map(t => {
      const repos = filterRepositories(groupsFor(t.id));
      return `<section class="repository-section"><div class="section-title"><span class="dot" style="${styleFor(t.id)}"></span><h3>${t.title}</h3><span class="section-line"></span><button data-section="${t.id}">查看 ${repos.length} 个 →</button></div><div class="repo-grid">${repos.slice(0,3).map(card).join('')}</div></section>`;
    }).join('');
  } else {
    const pool = state.section === 'unfiled' ? unfiled() : topic ? groupsFor(topic.id) : state.repositories;
    const repos = filterRepositories(pool);
    $('result-count').textContent = `${repos.length} 个仓库`;
    if (!repos.length) {
      $('results').innerHTML = state.section === 'unfiled' && !pool.length
        ? '<div class="empty-state"><h2>全部仓库已整理</h2><p>已按用途和工具形态归类，可以从专题中继续浏览。</p><button class="text-button" data-section="all">查看全部仓库</button></div>'
        : '<div class="empty-state"><h2>这次没有找到匹配的仓库</h2><p>试试更短的关键词，或清除形态筛选。</p><button class="text-button" data-reset>清除搜索与筛选</button></div>';
    } else {
      resultItems = buildRepositoryTimeline(repos, {group:state.group, sort:state.sort});
      renderedCount = Math.min(state.limit, resultItems.length);
      $('results').innerHTML = '<div class="repository-timeline"></div>';
      appendTimelineItems(resultItems.slice(0,renderedCount));
    }
  }
  $('results').setAttribute('aria-busy', 'false');
  updateContinuation();
}
function changeSection(section) {
  if (!['overview','all','unfiled',...topicById.keys()].includes(section)) return;
  rememberPosition();
  state.section = section; state.query = ''; state.form = 'all'; state.use = 'all'; state.sort = 'default'; state.limit = 36;
  hideDetail();
  $('search').value = '';
  onQueryChange('');
  render();
  writeLocation();
  root.host?.scrollIntoView({block:'start'});
}
function clearFilters() { rememberPosition(); state.query = ''; state.form = 'all'; state.use = 'all'; state.limit = 36; $('search').value = ''; onQueryChange(''); render(); writeLocation(); }
listen(root, 'click', event => {
  const target = event.target.closest('[data-section],[data-use],[data-repo],[data-reset],[data-retry-detail],[data-retry],[data-correct-classification],[data-repo-media],[data-guide-copy],[data-view]');
  if (!target) return;
  if (target.hasAttribute('data-view')) {
    const view = target.dataset.view;
    if (!['cards','list'].includes(view)) return;
    $('results').dataset.view = view;
    root.querySelectorAll('button[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    return;
  }
  if (target.hasAttribute('data-repo-media')) {
    const media = activeGuide?.media || [];
    const index = Number(target.dataset.repoMedia);
    if (onPreviewMedia && Number.isInteger(index) && media[index]) {
      event.preventDefault();
      onPreviewMedia({media,index,returnFocus:target,label:'仓库素材'});
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
  if (target.hasAttribute('data-reset')) clearFilters();
  if (target.hasAttribute('data-retry')) load();
  if (target.hasAttribute('data-retry-detail')) openDetail(target.dataset.retryDetail);
  if (target.hasAttribute('data-correct-classification')) onCorrectClassification?.(state.detail);
});
listen(root, 'change', event => {
  if (!event.target.matches('[data-guide-platform]')) return;
  const guide = activeGuide;
  if (guide) root.querySelector('[data-guide-installation]').innerHTML = renderGuideInstallation(guide, Number(event.target.value));
});
listen(root, 'error', event => {
  const image = event.target;
  if (!image.matches?.('.guide-image img')) return;
  image.hidden = true;
  image.parentElement.classList.add('image-unavailable');
  image.parentElement.querySelector('span').textContent = `${image.alt} · 图片暂时无法加载`;
}, {capture:true});
let searchHistoryStarted = false;
listen($('search'), 'focus', () => { searchHistoryStarted = false; });
listen($('search'), 'input', event => { rememberPosition(); state.query = event.target.value; if (state.section === 'overview') state.section = 'all'; state.limit = 36; onQueryChange(state.query); render(); writeLocation(searchHistoryStarted ? 'replace' : 'push'); searchHistoryStarted = true; });
listen($('search-all'), 'click', () => { rememberPosition(); state.section = 'all'; state.use = 'all'; state.limit = 36; render(); writeLocation(); });
listen($('form-filter'), 'change', event => { rememberPosition(); state.form = event.target.value; state.limit = 36; if (state.section === 'overview') state.section = 'all'; render(); writeLocation(); });
listen($('use-filter'), 'change', event => { rememberPosition(); state.use = event.target.value; state.limit = 36; if (state.section === 'overview') state.section = 'all'; render(); writeLocation(); });
listen($('sort'), 'change', event => { rememberPosition(); state.sort = event.target.value; state.limit = 36; render(); writeLocation(); });
listen($('group-filter'), 'change', event => {
  if (!['owner','none'].includes(event.target.value)) return;
  rememberPosition();
  state.group = event.target.value;
  state.limit = 36;
  render();
});
listen($('clear'), 'click', clearFilters);

let detailRequest;
let activeGuide = null;
const detailCache = new Map();
const dialog = $('repo-dialog');
const detailLayer = $('repo-detail-layer');
const detailResize = window.OmniDetailDrawer.resize(dialog, $('resize-detail'));
let releaseDrawer;
let returnFocusKey = '';
function releaseDetailShell() { detailResize.stop(); releaseDrawer?.(); releaseDrawer = null; }
function showDetailShell() {
  detailResize.sync();
  detailLayer.hidden = !active;
  if (active && !releaseDrawer) releaseDrawer = window.OmniDetailDrawer.mount(dialog, closeDetail);
  else if (active && !dialog.contains(window.OmniDetailDrawer.activeElement())) dialog.focus({preventScroll:true});
}
function markSelectedCard() {
  root.querySelectorAll('[data-repo]').forEach(card => { const selected = card.dataset.repo === state.detail; card.classList.toggle('selected',selected); card.setAttribute('aria-expanded',String(selected)); });
}
function hideDetail() {
  onPreviewMedia?.(null);
  activeGuide = null;
  state.detail = '';
  dialog.hidden = true;
  detailLayer.hidden = true;
  releaseDetailShell();
  detailRequest?.abort();
  markSelectedCard();
  updateContinuation();
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
  return `<div class="detail-head" style="${styleFor(note?.groups[0])}">
    <div class="detail-identity">${avatar(repo)}<div>
      <h2 id="detail-title">${escapeHtml(repo.name)}${link(repo.repositoryUrl,'↗','repository-link').replace('class="repository-link"','class="repository-link" aria-label="在 GitHub 打开仓库（新标签页）" title="在 GitHub 打开仓库"')}</h2>
      <span class="owner">${escapeHtml(repo.owner)} / ${escapeHtml(repo.name)}</span>
    </div></div>
    <p class="detail-summary" id="detail-summary" ${summary === description.text ? 'hidden' : ''}>${escapeHtml(summary)}</p>
    <div class="detail-tags">${note ? `<span class="tag">${escapeHtml(note.form)}</span><span class="tag">${escapeHtml(note.subject)}</span>` : '<span class="tag">用途尚未细分</span>'}</div>
    ${onCorrectClassification ? '<button class="inline-link" data-correct-classification>调整归类</button>' : ''}
    <div class="detail-meta">
      <div id="detail-guide-meta">${renderRepositoryGuideMeta(guide,{readmeUrl})}</div>
      <details class="detail-sources"><summary>资料来源</summary><div class="detail-sources-content">
        <div id="detail-guide-sources">${renderRepositoryGuideSources(guide)}</div>
        <div id="detail-collection-sources"><p class="detail-loading" role="status">正在读取收藏来源…</p></div>
      </div></details>
    </div>
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
    <div id="detail-evidence"></div>
  </div>`;
}
function evidenceMarkup(detail) {
  const knowledge = Array.isArray(detail.relatedKnowledge) ? detail.relatedKnowledge : [];
  return knowledge.length ? `<section class="detail-section"><h3>已整理成的知识</h3>${knowledge.map(article => `<article class="related-knowledge"><h4>${escapeHtml(article.title)}</h4><p>${escapeHtml(article.summary)}</p></article>`).join('')}</section>` : '';
}

async function openDetail(key, fromHistory = false) {
  const repo = state.repositories.find(item => item.key === key);
  if (!repo) return;
  onPreviewMedia?.(null);
  if (!fromHistory) rememberPosition();
  const wasOpen = Boolean(state.detail);
  const parent = window.history.state?.repositoryDetailParent || repositoryLocation({...state,detail:''}, window.location.hash);
  state.detail = key;
  moreObserver.disconnect();
  if (!fromHistory) writeLocation(wasOpen ? 'replace' : 'push', {repositoryDetailParent:parent});
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  activeGuide = getRepositoryGuide(key);
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
    activeGuide = guide;
    const guideContainer = $('detail-guide');
    if (guideContainer) guideContainer.innerHTML = renderRepositoryGuide(guide,{introFallback:getRepositoryDescription(repo).text});
    $('detail-guide-meta').innerHTML = renderRepositoryGuideMeta(guide);
    $('detail-guide-sources').innerHTML = renderRepositoryGuideSources(guide);
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
      if (!controller.signal.aborted && state.detail === key && !dialog.hidden) {
        $('detail-evidence').innerHTML = evidenceMarkup(detail);
        $('detail-collection-sources').innerHTML = renderRepositoryCollectionSources(detail);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && !controller.signal.aborted && state.detail === key && !dialog.hidden) $('detail-collection-sources').innerHTML = `<p class="detail-hint">收藏来源暂时无法加载。</p><button class="text-button" data-retry-detail="${escapeHtml(key)}">重试</button>`;
    }
  })();
}
async function load() {
  moreObserver.disconnect();
  resultsEnd.hidden = true;
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
  setActive(value) {
    active = value;
    if (!active) filterControls.forEach(filter => filter.close());
    if (!active) { moreObserver.disconnect(); onPreviewMedia?.(null); detailLayer.hidden = true; releaseDetailShell(); }
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
    filterControls.forEach(filter => filter.destroy());
    moreObserver.disconnect();
    topicResize.disconnect();
    detailRequest?.abort();
    hideDetail();
    detailResize.dispose();
    detailCache.clear();
  },
};
}
