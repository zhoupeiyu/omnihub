import { X_CALLBACK_PATH } from './x-account.js';

export function createXAccountHandler({ account, sync, requireOwner, readBody, send }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/account/x')) return false;
    const user = requireOwner(req, req.method !== 'GET');
    const snapshot = () => ({ ...account.status(user.id), sync: sync.getStatus(user.id) });
    if (req.method === 'GET' && pathname === X_CALLBACK_PATH) {
      let result = 'connected';
      try { await account.finish(user, new URL(req.url, 'http://localhost').searchParams); }
      catch (error) {
        const safeCodes = ['invalid_state', 'authorization_cancelled', 'account_mismatch', 'scope_mismatch', 'connect_budget_missing', 'connection_changed'];
        result = safeCodes.includes(error.code) ? error.code : 'failed';
      }
      // Strip all OAuth parameters before rendering any page or loading subresources.
      res.writeHead(303, { Location: `/#repositories?account=x&result=${result}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(); return true;
    }
    if (req.method === 'GET' && pathname === '/api/account/x') return send(res, 200, snapshot());
    if (req.method !== 'POST') return send(res, 405, { error: '请求方式不支持' });
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw { status: 400, message: '请求参数无效' };
    if (pathname === '/api/account/x/connect') return send(res, 200, account.start(user));
    if (pathname === '/api/account/x/disconnect') { account.disconnect(user.id); return send(res, 200, snapshot()); }
    if (pathname === '/api/account/x/sync-settings') {
      if (body.enabled && !sync.getStatus(user.id).serverReady) throw { status: 409, message: '服务器尚未启用 X 同步或配置费用上限' };
      account.setSync(user.id, body.enabled); return send(res, 200, snapshot());
    }
    if (pathname === '/api/account/x/sync') {
      // Due checks and budgets also apply to manual clicks.
      const result = await sync.runDue(user.id);
      return send(res, 200, { ...snapshot(), result });
    }
    return send(res, 404, { error: '接口不存在' });
  };
}
