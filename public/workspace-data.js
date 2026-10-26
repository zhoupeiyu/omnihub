// Collections are fetched on first visit, then refreshed without hiding saved data.
// Repository data belongs to RepositoryExplorerTab.
function workspaceDataRequests(section, fullAccess, personalAccess = fullAccess) {
  const libraries = {
    knowledgeLibrary: [['knowledgeLibrary', '/api/knowledge-library']],
    promptLibrary: [['promptLibrary', '/api/prompt-library']],
    // Inbox rows are always the signed-in person's own rows. It is deliberately
    // not a public catalogue route and must never be prefetched for visitors.
    inbox: personalAccess ? [['inbox', '/api/inbox']] : [],
  };
  if (libraries[section]) return libraries[section];
  // Generated results belong to the signed-in person's own 作品 module only.
  if (section === 'works') return personalAccess ? [['mediaAssets', '/api/media/assets']] : [];
  if (personalAccess && section === 'studio') return [['mediaAssets', '/api/media/assets'], ['mediaJobs', '/api/media/jobs']];
  if (personalAccess && !fullAccess && section === 'works') return [['mediaAssets', '/api/media/assets']];
  if (!fullAccess) return [];
  // Manual records keep their original owner-only endpoints. They are loaded
  // only by the library that edits them, never by public catalogue visitors.
  if (section === 'resources') return [['favorites', '/api/favorites']];
  if (section === 'manualPrompts') return [['prompts', '/api/prompts']];
  if (section === 'manualKnowledge') return [['knowledge', '/api/knowledge']];
  // `assets` was a legacy catch-all route. New views load only their own
  // collection so navigating resources never also fetches prompt/knowledge
  // drafts or generated work.
  return [];
}

// One instance per account/access scope. No API data is persisted in browser storage.
function createWorkspaceDataCache({ request, fullAccess, personalAccess = fullAccess, onChange, now = Date.now, ttl = 60000 }) {
  const entries = new Map();
  const collectionVersions = new Map();
  let version = 0;
  let invalidatedVersion = 0;
  let disposed = false;
  const accept = (results, requestVersion) => {
    if (disposed || requestVersion <= invalidatedVersion) return [];
    return results.filter(([key]) => {
      if (requestVersion < (collectionVersions.get(key) || 0)) return false;
      collectionVersions.set(key, requestVersion);
      return true;
    });
  };
  const entryFor = section => {
    if (!entries.has(section)) entries.set(section, { hasData: false, status: 'idle', error: null, fresh: false, updatedAt: 0, pending: null });
    return entries.get(section);
  };
  const publish = (section, entry, results) => onChange(section, {
    hasData: entry.hasData, status: entry.status, error: entry.error,
  }, results);
  return {
    beginUpdate() { return ++version; },
    applyCollections(results, requestVersion) {
      const accepted = accept(results, requestVersion);
      if (accepted.length) onChange(null, null, accepted);
    },
    load(section) {
      const plan = workspaceDataRequests(section, fullAccess, personalAccess);
      if (disposed || !plan.length) return Promise.resolve();
      const entry = entryFor(section);
      if (entry.pending) return entry.pending.promise;
      if (entry.fresh && now() - entry.updatedAt < ttl) return Promise.resolve();
      const controller = new AbortController();
      const requestVersion = ++version;
      const pending = { controller, promise: null };
      entry.pending = pending;
      entry.status = entry.hasData ? 'refreshing' : 'loading';
      entry.error = null;
      publish(section, entry);
      const current = () => !disposed && entry.pending === pending && !controller.signal.aborted;
      pending.promise = Promise.all(plan.map(async ([key, route]) => {
        const rows = await request(route, { signal: controller.signal });
        if (!Array.isArray(rows)) throw new Error('内容加载失败：响应格式无效');
        return [key, rows];
      })).then(results => {
        if (!current()) return;
        entry.hasData = true;
        entry.fresh = true;
        entry.updatedAt = now();
        entry.status = 'success';
        publish(section, entry, accept(results, requestVersion));
      }).catch(error => {
        if (!current()) return;
        entry.status = 'error';
        entry.error = error.message || '内容加载失败，请重试';
        publish(section, entry);
      }).finally(() => {
        if (entry.pending === pending) entry.pending = null;
      });
      return pending.promise;
    },
    invalidate() {
      if (disposed) return;
      invalidatedVersion = ++version;
      for (const [section, entry] of entries) {
        entry.pending?.controller.abort();
        entry.pending = null;
        entry.fresh = false;
        entry.status = entry.hasData ? 'success' : 'idle';
        entry.error = null;
        publish(section, entry);
      }
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) entry.pending?.controller.abort();
      entries.clear();
    },
  };
}

// ---- Feed event identity -------------------------------------------------
// Related reports retain their original records. Specific event identifiers
// and title overlap can join different headlines within a bounded time window;
// a shared publisher, company or broad topic alone is never sufficient.
const FEED_TRACKING_PARAM = /^(utm_|spm$|from$|ref$|ref_src$|source$|share|fbclid$|gclid$|mc_|igshid$|si$)/i;
const FEED_EVENT_WINDOW_MS = 48 * 3600 * 1000;
const FEED_TITLE_MIN_LENGTH = 12;

function canonicalFeedUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  // A homepage or section root identifies a site, not an event.
  if (!path || path === '/') return '';
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !FEED_TRACKING_PARAM.test(key))
    .sort(([a, x], [b, y]) => a === b ? x.localeCompare(y) : a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  return `${host}${path}${query}`;
}

function normalizedFeedTitle(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return Array.from(text).length >= FEED_TITLE_MIN_LENGTH ? text : '';
}

function feedTime(item) {
  const time = new Date(item?.publishedAt).getTime();
  return Number.isFinite(time) ? time : null;
}

function feedEventFeatures(item) {
  const title = String(item?.title || '').normalize('NFKC').toLowerCase();
  const body = `${title} ${item?.summary || ''}`.normalize('NFKC').toLowerCase();
  const generic = new Set(['openai', 'anthropic', 'google', 'microsoft', 'claude', 'gemini', 'kimi', 'deepseek', 'model', 'agent', 'agents', 'token', 'tokens', 'api', 'php', 'pro', 'flash', 'openrouter']);
  const anchors = new Set((title.match(/[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*/g) || [])
    .filter(term => !generic.has(term) && (term.length >= 5 || /[a-z].*\d/.test(term))));
  const grams = new Set();
  for (const segment of title.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < segment.length - 1; i++) grams.add(segment.slice(i, i + 2));
  }
  const action = /漏洞|攻击|安全|红队|cve-|exploit|vulnerab/.test(body) ? 'security'
    : /合并|并购|收购|merger|acqui/.test(body) ? 'merger'
    : /融资|估值|招股|ipo|funding/.test(body) ? 'funding'
    : /发布|上线|开源|开放|推出|release|launch/.test(body) ? 'release' : '';
  return { anchors, grams, action };
}

function sameFeedEvent(a, b) {
  const ta = feedTime(a), tb = feedTime(b);
  if (ta === null || tb === null || Math.abs(ta - tb) > FEED_EVENT_WINDOW_MS) return false;
  const x = feedEventFeatures(a), y = feedEventFeatures(b);
  if (x.action && y.action && x.action !== y.action) return false;
  const shared = [...x.anchors].filter(term => y.anchors.has(term));
  const common = [...x.grams].filter(term => y.grams.has(term)).length;
  const overlap = common / Math.max(1, Math.min(x.grams.size, y.grams.size));
  // Version/vulnerability identifiers are stronger than ordinary product names.
  if (shared.some(term => /\d/.test(term)) && x.action && x.action === y.action) return true;
  return shared.length > 0 && common >= 4 && overlap >= 0.28;
}

function splitFeedSentences(text) {
  return String(text || '').split(/(?<=[。！？!?；;.])\s*|\n+/).map(part => part.trim()).filter(part => part.length >= 6);
}

/** Sentences in `other` that the primary report does not already contain. */
function feedSupplement(primary, other, limit = 2) {
  const known = String([primary?.title, primary?.summary, primary?.reason].join(' ')).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  return splitFeedSentences(other?.summary).filter(sentence => {
    const key = sentence.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    return key && !known.includes(key);
  }).slice(0, limit);
}

/**
 * Groups items (already in display order) into events. The first item of an
 * event is its primary report; every original remains in `related`.
 * Returns [{ item, related: [{ item, supplement: string[] }] }].
 */
function groupFeedEvents(items) {
  const events = [];
  const byUrl = new Map();
  const byTitle = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const url = canonicalFeedUrl(item?.url);
    const title = normalizedFeedTitle(item?.title);
    let event = url ? byUrl.get(url) : null;
    if (!event && title && byTitle.has(title)) {
      const candidate = byTitle.get(title);
      const a = feedTime(candidate.item), b = feedTime(item);
      if (a !== null && b !== null && Math.abs(a - b) <= FEED_EVENT_WINDOW_MS) event = candidate;
    }
    if (!event) event = events.find(candidate => sameFeedEvent(candidate.item, item));
    if (event) event.related.push({ item, supplement: feedSupplement(event.item, item) });
    else {
      event = { item, related: [] };
      events.push(event);
    }
    if (url && !byUrl.has(url)) byUrl.set(url, event);
    if (title && !byTitle.has(title)) byTitle.set(title, event);
  }
  return events;
}

// ---- Tool preferences ----------------------------------------------------
// Only known tool ids are stored; no tool input or output leaves the page.
const RECENT_TOOLS_KEY = 'omnihub_recent_tools';
function readRecentTools(knownIds, storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(RECENT_TOOLS_KEY) || '[]');
    const known = new Set(knownIds);
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && known.has(id)))].slice(0, 4) : [];
  } catch { return []; }
}
function rememberRecentTool(id, knownIds, storage = globalThis.localStorage) {
  const next = [id, ...readRecentTools(knownIds, storage).filter(item => item !== id)].filter(item => knownIds.includes(item)).slice(0, 4);
  try { storage?.setItem(RECENT_TOOLS_KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  return next;
}

// ---- Settings categories -------------------------------------------------
const SETTINGS_CATEGORIES = ['sync', 'ai', 'devices', 'appearance'];
// Older drawer tabs and modal names land on the matching full-page category.
function settingsCategoryFor(value) {
  if (SETTINGS_CATEGORIES.includes(value)) return value;
  return ({ account: 'sync', automation: 'sync', 'account-settings': 'sync', 'ai-settings': 'ai' })[value] || '';
}
