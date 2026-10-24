import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createPinnedLookup, isPublicAddress, downloadMediaResult } from '../lib/media-download.js';

async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}

test('result downloader permits only the configured same-origin local test endpoint', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/image' }); res.end(); return; }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'image/png' }); res.write('p'); return; }
    if (req.url === '/streamoversize') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('png'); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '3' }); res.end('png');
  });
  const listen = await port(); await new Promise(resolve => server.listen(listen, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${listen}`;
  const result = await downloadMediaResult(`${origin}/image`, { localOrigin: origin });
  const chunks = []; for await (const chunk of result.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'png');
  await assert.rejects(() => downloadMediaResult(`${origin}/image`), /不安全/);
  await assert.rejects(() => downloadMediaResult(`${origin}/redirect`, { localOrigin: origin }), /跳转/);
  const slow = await downloadMediaResult(`${origin}/slow`, { localOrigin: origin, timeoutMs: 40 });
  await assert.rejects(async () => { for await (const _chunk of slow.stream) { /* consume until total deadline */ } }, /超时/);
  const oversized = await downloadMediaResult(`${origin}/streamoversize`, { localOrigin: origin, maxBytes: 2 });
  await assert.rejects(async () => { for await (const _chunk of oversized.stream) { /* stream limit */ } }, /大小上限/);
});

test('result downloader resolves every address and refuses private or mixed DNS answers before a request', async () => {
  const lookupPrivate = async () => [{ address: '127.0.0.1', family: 4 }];
  const lookupMixed = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
  await assert.rejects(() => downloadMediaResult('https://cdn.example.test/result.png', { lookupImpl: lookupPrivate }), /不安全/);
  await assert.rejects(() => downloadMediaResult('https://cdn.example.test/result.png', { lookupImpl: lookupMixed }), /不安全/);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2001::1', '2002::1']) {
    assert.equal(isPublicAddress(value), false, value);
  }
});

test('pinned lookup follows Node all-address callback contract', async () => {
  const lookup = createPinnedLookup({ address: '8.8.8.8', family: 4 });
  await new Promise((resolve, reject) => lookup('cdn.example.test', { all: true }, (error, records) => {
    try { assert.equal(error, null); assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]); resolve(); } catch (failure) { reject(failure); }
  }));
  await new Promise((resolve, reject) => lookup('cdn.example.test', {}, (error, address, family) => {
    try { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); resolve(); } catch (failure) { reject(failure); }
  }));
});
