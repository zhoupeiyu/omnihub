// The catalogue can be viewed either as the signed-in person's workspace or as
// the public collection. Keep this decision in the URL so a browser cache (or
// a stale async request) can never silently mix two people's results.
const OMNIHUB_CATALOGUE_PATHS = new Set([
  '/api/repositories', '/api/knowledge-library', '/api/prompt-library',
]);

function isOmnihubCataloguePath(pathname) {
  if (OMNIHUB_CATALOGUE_PATHS.has(pathname)) return true;
  return (pathname.startsWith('/api/repositories/') && !pathname.endsWith('/status'))
    || pathname.startsWith('/api/knowledge-library/')
    || pathname.startsWith('/api/prompt-library/');
}

function omnihubCatalogueScope() {
  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return 'public';
  const value = new URLSearchParams(hash.slice(queryIndex + 1)).get('space');
  return value === 'mine' ? 'mine' : 'public';
}

function omnihubScopedCataloguePath(path) {
  const [beforeHash, hash = ''] = String(path).split('#', 2);
  const [pathname, search = ''] = beforeHash.split('?', 2);
  if (!isOmnihubCataloguePath(pathname)) return path;
  const params = search.split('&').filter(Boolean).filter(pair => !pair.startsWith('scope='));
  params.push(`scope=${encodeURIComponent(omnihubCatalogueScope())}`);
  return `${pathname}?${params.join('&')}${hash ? `#${hash}` : ''}`;
}

window.omnihubCatalogueScope = omnihubCatalogueScope;
window.omnihubScopedCataloguePath = omnihubScopedCataloguePath;

/// 前端请求封装 —— 统一 JSON、错误抛出 { status, message }
async function api(path, options = {}) {
  const response = await fetch(omnihubScopedCataloguePath(path), {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
    signal: options.signal,
  });
  let payload = null;
  try { payload = await response.json(); } catch (err) { /* 空响应 */ }
  if (!response.ok) {
    const error = new Error((payload && payload.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  // Invalidate synchronously before callers apply the successful local edit.
  // Old background reads must not overwrite that edit or populate another tab.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(options.method || 'GET').toUpperCase()) &&
      /^\/api\/(?:inbox|favorites|prompts|knowledge|media)(?:\/|$)/.test(path)) {
    window.dispatchEvent(new Event('omnihub:collection-updated'));
  }
  return payload;
}

window.api = api;
