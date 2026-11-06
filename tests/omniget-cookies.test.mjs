import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOmnigetCookieStore, OMNIGET_COOKIE_MAX_BYTES } from '../lib/omniget-cookies.js';

const fixture = (domain = '.youtube.com', expires = '2000000000') => `# Netscape HTTP Cookie File\n#HttpOnly_${domain}\tTRUE\t/\tTRUE\t${expires}\tSID\tplaceholder-value\n`;
const create = (t, time = 1_700_000_000_000) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omniget-cookies-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); rmSync(directory, { recursive:true, force:true }); });
  return { db, directory, clock:{ value:time }, store:null };
};

test('OmniGet cookie vault encrypts one selected site and isolates owners', t => {
  const f = create(t); f.store = createOmnigetCookieStore({ db:f.db, directory:f.directory, now:() => f.clock.value });
  const saved = f.store.save(7, 'youtube', fixture(), { ttlSeconds:3600 });
  assert.deepEqual(saved, { configured:true, site:'youtube', expiresAt:f.clock.value + 3600000, cookieCount:1 });
  const row = f.db.prepare('SELECT ciphertext FROM omniget_cookie_connections WHERE owner_id=?').get('7');
  assert.equal(row.ciphertext.includes('placeholder-value'), false);
  assert.equal(readFileSync(path.join(f.directory, 'omniget-cookies.key')).length, 32);
  assert.deepEqual(f.store.status(8, 'youtube'), { configured:false, site:'youtube', expiresAt:0, cookieCount:0 });
  assert.throws(() => f.store.consumeForRunner(8, 'youtube', () => {}), /尚未配置/);
  let delivered = '';
  const used = f.store.consumeForRunner(7, 'youtube', text => { delivered = text; return text; });
  assert.equal(delivered, fixture());
  assert.deepEqual(used, { consumed:true, site:'youtube', expiresAt:saved.expiresAt, cookieCount:1 });
  assert.equal(JSON.stringify(used).includes('placeholder-value'), false);
});

test('OmniGet cookie vault expires and deletes only the owning site connection', t => {
  const f = create(t); f.store = createOmnigetCookieStore({ db:f.db, directory:f.directory, now:() => f.clock.value });
  f.store.save('owner-a', 'youtube', fixture(), { ttlSeconds:1 });
  f.store.save('owner-a', 'bilibili', fixture('.bilibili.com'), { ttlSeconds:3600 });
  f.clock.value += 1000;
  assert.deepEqual(f.store.status('owner-a', 'youtube'), { configured:false, site:'youtube', expiresAt:0, cookieCount:0 });
  assert.equal(f.store.list('owner-a').length, 1);
  assert.deepEqual(f.store.remove('owner-a', 'bilibili'), { configured:false, site:'bilibili', expiresAt:0, cookieCount:0 });
  assert.equal(f.store.list('owner-a').length, 0);
  assert.throws(() => f.store.save('owner-a', 'youtube', fixture(), { ttlSeconds:86401 }), /24 小时/);
});

test('OmniGet cookie parser rejects cross-site, suffix-domain and oversized injection attempts', t => {
  const f = create(t); f.store = createOmnigetCookieStore({ db:f.db, directory:f.directory, now:() => f.clock.value });
  assert.throws(() => f.store.save(1, 'youtube', fixture('.evil.example')), /不属于/);
  assert.throws(() => f.store.save(1, 'youtube', fixture('.youtube.com.evil.example')), /不属于/);
  assert.throws(() => f.store.save(1, 'youtube', `${fixture()}${fixture('.bilibili.com')}`), /不属于/);
  assert.throws(() => f.store.save(1, 'youtube', Buffer.alloc(OMNIGET_COOKIE_MAX_BYTES + 1, 0x61)), /256KiB/);
  assert.throws(() => f.store.save(1, 'unknown', fixture()), /暂不支持/);
  assert.throws(() => f.store.save(1, 'youtube', fixture('.youtube.com', '1')), /已过期/);
});

test('OmniGet cookie vault rejects ciphertext swapping and corruption without exposing plaintext', t => {
  const f = create(t); f.store = createOmnigetCookieStore({ db:f.db, directory:f.directory, now:() => f.clock.value });
  f.store.save('owner-a', 'youtube', fixture());
  const source = f.db.prepare('SELECT ciphertext,cookie_count,created_at,expires_at FROM omniget_cookie_connections WHERE owner_id=? AND site=?').get('owner-a', 'youtube');
  f.db.prepare('INSERT INTO omniget_cookie_connections(owner_id,site,ciphertext,cookie_count,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('owner-b', 'youtube', source.ciphertext, source.cookie_count, source.created_at, source.expires_at);
  assert.throws(() => f.store.consumeForRunner('owner-b', 'youtube', () => {}), /无法读取/);
  f.db.prepare('UPDATE omniget_cookie_connections SET ciphertext=? WHERE owner_id=? AND site=?').run('not-valid-ciphertext', 'owner-a', 'youtube');
  assert.throws(() => f.store.consumeForRunner('owner-a', 'youtube', () => {}), /无法读取/);
});
