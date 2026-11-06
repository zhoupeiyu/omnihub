import { cephalonError } from './cephalon.js';

const allowed = new Set(['key','secret','serviceKey','clearServiceKey']);

export function createCephalonHandler({ store, client, requireOwner, readBody, send }) {
  if (!store || !client || !requireOwner || !readBody || !send) throw new TypeError('端脑云接口依赖不完整');
  return async (req, res, pathname) => {
    const writing=!['GET','HEAD'].includes(req.method);
    const user=requireOwner(req, writing);
    if (pathname === '/api/cephalon' && req.method === 'GET') return send(res,200,store.status(user.id));
    if (pathname === '/api/cephalon/config' && req.method === 'POST') {
      const body=await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>!allowed.has(key))) throw cephalonError(400,'端脑云配置字段不正确');
      return send(res,200,store.save(user.id,body));
    }
    if (pathname === '/api/cephalon/config' && req.method === 'DELETE') return send(res,200,store.disconnect(user.id));
    if ((pathname === '/api/cephalon/dry-run' || pathname === '/api/cephalon/connection-test') && req.method === 'POST') {
      return send(res,200,await client.connectionTest(store.credentials(user.id)));
    }
    throw cephalonError(404,'端脑云接口不存在');
  };
}
