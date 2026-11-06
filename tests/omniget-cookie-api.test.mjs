import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createOmnigetCookieApi } from '../lib/omniget-cookie-api.js';

const fakeCookie = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tfake-cookie-value-for-test\n';

function fixture(t) {
  const calls = [];
  const connections = new Map();
  const store = {
    list(owner) { calls.push(['list', owner]); return [...(connections.get(owner) || new Map()).values()]; },
    status(owner, site) { calls.push(['status', owner, site]); return connections.get(owner)?.get(site) || { configured:false, site, expiresAt:0, cookieCount:0 }; },
    save(owner, site, text, { ttlSeconds }) {
      calls.push(['save', owner, site, text, ttlSeconds]);
      const result = { configured:true, site, expiresAt:1_900_000_000_000, cookieCount:1 };
      if (!connections.has(owner)) connections.set(owner, new Map());
      connections.get(owner).set(site, result);
      return result;
    },
    remove(owner, site) { calls.push(['remove', owner, site]); connections.get(owner)?.delete(site); return { configured:false, site, expiresAt:0, cookieCount:0 }; },
  };
  const handler = createOmnigetCookieApi({ store, origin:'http://localhost', getUser:req => req.headers['x-user'] ? { id:req.headers['x-user'] } : null, canTool:(user, tool) => tool === 'omniget' && user?.id !== 'blocked' });
  const server = http.createServer((req, res) => void handler(req, res, new URL(req.url, 'http://localhost').pathname));
  server.listen(0, '127.0.0.1');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, connections, base:async () => { await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; } };
}

function request(base, path, { method='GET', user='owner-a', origin='http://localhost', body, headers={} } = {}) {
  return fetch(base + path, { method, headers:{ 'x-user':user, ...(origin === null ? {} : { Origin:origin }), ...headers, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) }, body:body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

test('returns only safe, owner-scoped Cookie connection metadata', async t => {
  const f = fixture(t), base = await f.base();
  const unauthorized = await request(base, '/api/omniget/cookies', { user:'' });
  assert.equal(unauthorized.status, 401);
  const saved = await request(base, '/api/omniget/cookies/youtube', { method:'POST', body:{ cookiesTxt:fakeCookie, ttlSeconds:3600 } });
  assert.equal(saved.status, 200);
  const savedPayload = await saved.json();
  assert.deepEqual(savedPayload.connection, { configured:true, site:'youtube', expiresAt:1_900_000_000_000, cookieCount:1 });
  assert.equal(JSON.stringify(savedPayload).includes('fake-cookie-value-for-test'), false);
  const ownerList = await (await request(base, '/api/omniget/cookies')).json();
  assert.deepEqual(ownerList.connections, [savedPayload.connection]);
  const otherList = await (await request(base, '/api/omniget/cookies', { user:'owner-b' })).json();
  assert.deepEqual(otherList.connections, []);
  assert.deepEqual(f.calls.map(call => call.slice(0, 3)), [['save','owner-a','youtube'], ['list','owner-a'], ['list','owner-b']]);
});

test('requires same-origin requests for save and revocation, then removes only caller data', async t => {
  const f = fixture(t), base = await f.base();
  let response = await request(base, '/api/omniget/cookies/youtube', { method:'POST', origin:'https://attacker.example', body:{ cookiesTxt:fakeCookie } });
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
  response = await request(base, '/api/omniget/cookies/youtube', { method:'POST', body:{ cookiesTxt:fakeCookie } });
  assert.equal(response.status, 200);
  response = await request(base, '/api/omniget/cookies/youtube', { method:'DELETE', origin:null });
  assert.equal(response.status, 403);
  assert.equal(f.calls.filter(call => call[0] === 'remove').length, 0);
  response = await request(base, '/api/omniget/cookies/youtube', { method:'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).connection, { configured:false, site:'youtube', expiresAt:0, cookieCount:0 });
  assert.deepEqual(f.connections.get('owner-a') ? [...f.connections.get('owner-a').values()] : [], []);
});

test('rejects oversized or non-strict uploads without exposing uploaded text', async t => {
  const f = fixture(t), base = await f.base();
  const oversized = JSON.stringify({ cookiesTxt:'x'.repeat(256 * 1024) });
  let response = await request(base, '/api/omniget/cookies/youtube', { method:'POST', body:oversized, headers:{ 'Content-Length':String(Buffer.byteLength(oversized)) } });
  assert.equal(response.status, 413);
  assert.equal(await response.text().then(text => text.includes('x'.repeat(24))), false);
  response = await request(base, '/api/omniget/cookies/youtube', { method:'POST', body:{ cookiesTxt:fakeCookie, extra:'not-allowed' } });
  assert.equal(response.status, 400);
  response = await request(base, '/api/omniget/cookies/not-a-site', { method:'GET' });
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
});

test('does not grant blocked accounts Cookie access', async t => {
  const f = fixture(t), base = await f.base();
  const response = await request(base, '/api/omniget/cookies', { user:'blocked' });
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});
