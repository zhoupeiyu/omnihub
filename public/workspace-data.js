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
  if (personalAccess && section === 'studio') return [['mediaAssets', '/api/media/assets'], ['mediaJobs', '/api/media/jobs']];
  if (personalAccess && !fullAccess && section === 'assets') return [['mediaAssets', '/api/media/assets']];
  if (!fullAccess) return [];
  if (section === 'assets') return [['favorites', '/api/favorites'], ['prompts', '/api/prompts'],
    ['knowledge', '/api/knowledge'], ['mediaAssets', '/api/media/assets']];
  if (section === 'studio') return [['mediaAssets', '/api/media/assets'], ['mediaJobs', '/api/media/jobs']];
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
