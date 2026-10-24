import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let moduleId = 0;
async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnihub-feed-'));
  const previousDirectory = process.env.OMNIHUB_DATA_DIR;
  process.env.OMNIHUB_DATA_DIR = directory;
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.OMNIHUB_DATA_DIR;
    else process.env.OMNIHUB_DATA_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  const feed = await import(`../lib/feed.js?test=${++moduleId}`);
  return { ...feed, cacheFile: path.join(directory, 'feed-cache/aihot.json') };
}

const item = {
  id: 'example', title: '新资讯', originalTitle: 'Original headline', summary: '上游摘要',
  links: { original: 'https://example.com/news', aihot: 'https://aihot.news/items/example' },
  source: { name: '原始来源' }, category: 'ai-models', score: 87, selected: true, reason: '上游推荐理由',
  publishedAt: '2026-10-24T02:00:00.000Z', discoveredAt: '2026-10-24T02:01:00.000Z',
  attribution: { name: 'AIHOT', url: 'https://aihot.news/items/example' },
};
const response = (items, headers = {}) => new Response(JSON.stringify({ schemaVersion: 1, items }), { headers });

test('v1 feed preserves links, editorial fields and provenance using the supported query', async t => {
  const { fetchFeed, listFeedSources } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://aihot.news');
    assert.equal(url.pathname, '/api/v1/items');
    assert.deepEqual(Object.fromEntries(url.searchParams), { mode: 'selected', window: '7d', by: 'published', limit: '40' });
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['User-Agent'], 'OmniHub/1.0');
    return response([item]);
  });
  const [actual] = await fetchFeed('aihot');
  assert.equal(actual.title, item.title);
  assert.equal(actual.titleEn, item.originalTitle);
  assert.equal(actual.url, item.links.original);
  assert.equal(actual.summary, item.summary);
  assert.equal(actual.origin, item.source.name);
  assert.deepEqual(actual.tags, ['AI 模型']);
  assert.equal(actual.score, 87);
  assert.equal(actual.selected, true);
  assert.equal(actual.reason, item.reason);
  assert.equal(actual.publishedAt, item.publishedAt);
  assert.deepEqual(actual.attribution, item.attribution);
  assert.deepEqual(actual.images, []);
  assert.equal(listFeedSources()[0].home, 'https://aihot.news/');
});

test('nullable v1 fields and future categories remain renderable', async t => {
  const { fetchFeed } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => response([
    { ...item, category: null, score: null, selected: false, reason: null, summary: null, originalTitle: null, publishedAt: null },
    { ...item, category: 'future-category', score: 0, links: { aihot: item.links.aihot } },
    ...['ai-products', 'industry', 'paper', 'tip', 'opinion'].map(category => ({ ...item, category })),
    ...['constructor', '__proto__'].map(category => ({ ...item, category })),
  ]));
  const items = await fetchFeed('aihot');
  assert.equal(items[0].publishedAt, item.discoveredAt);
  assert.equal(items[0].summary, '');
  assert.equal(items[0].reason, '');
  assert.equal(items[0].score, null);
  assert.equal(items[0].selected, false);
  assert.deepEqual(items[0].tags, []);
  assert.deepEqual(items[1].tags, ['future-category']);
  assert.equal(items[1].score, 0);
  assert.equal(items[1].url, item.links.aihot);
  assert.deepEqual(items.slice(2).map(entry => entry.tags[0]), ['AI 产品', '行业动态', '论文', '教程', '观点', 'constructor', '__proto__']);
});

test('cache waits five minutes, revalidates with ETag and handles bodyless 304', async t => {
  const { fetchFeed } = await fixture(t);
  let now = Date.parse(item.publishedAt);
  t.mock.method(Date, 'now', () => now);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    requests++;
    if (requests === 1) return response([item], { etag: '"v1-example"' });
    assert.equal(options.headers['If-None-Match'], '"v1-example"');
    return new Response(null, { status: 304 });
  });
  assert.equal((await fetchFeed('aihot'))[0].time, '刚刚');
  now += 4 * 60_000;
  assert.equal((await fetchFeed('aihot'))[0].time, '4 分钟前');
  assert.equal(requests, 1);
  now += 60_000;
  assert.equal((await fetchFeed('aihot'))[0].time, '5 分钟前');
  await fetchFeed('aihot');
  assert.equal(requests, 2);
});

test('a valid empty seven-day window replaces stale articles', async t => {
  const { fetchFeed, cacheFile } = await fixture(t);
  writeFileSync(cacheFile, JSON.stringify([{ title: '旧缓存', publishedAt: item.publishedAt }]));
  t.mock.method(globalThis, 'fetch', async () => response([]));
  assert.deepEqual(await fetchFeed('aihot'), []);
  assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')), []);
});

test('invalid schema or upstream failure keeps the last successful disk cache', async t => {
  const { fetchFeed, cacheFile } = await fixture(t);
  writeFileSync(cacheFile, JSON.stringify([{ title: '上次成功内容', publishedAt: item.publishedAt, time: '刚刚' }]));
  t.mock.method(Date, 'now', () => Date.parse(item.publishedAt) + 26 * 24 * 60 * 60_000);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ items: [] })));
  const [cached] = await fetchFeed('aihot');
  assert.equal(cached.title, '上次成功内容');
  assert.equal(cached.time, '26 天前');
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).length, 1);
});

test('unavailable upstream without cache reports an error and unknown sources never fetch', async t => {
  const { fetchFeed } = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await assert.rejects(fetchFeed('aihot'), error => error.status === 502);
  await assert.rejects(fetchFeed('unknown'), error => error.status === 404);
  assert.equal(fetch.mock.calls.length, 1);
});

for (const status of [429, 503]) {
  test(`HTTP ${status} respects Retry-After and serves cached items during the wait`, async t => {
    const { fetchFeed, cacheFile } = await fixture(t);
    let now = Date.parse(item.publishedAt);
    t.mock.method(Date, 'now', () => now);
    writeFileSync(cacheFile, JSON.stringify([{ title: '上次成功内容', publishedAt: item.publishedAt }]));
    const resumeAt = now + 15 * 60_000;
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (requests === 1) return new Response(null, {
        status, headers: { 'Retry-After': status === 429 ? '900' : new Date(resumeAt).toUTCString() },
      });
      return response([item]);
    });
    assert.equal((await fetchFeed('aihot'))[0].title, '上次成功内容');
    now += 14 * 60_000;
    assert.equal((await fetchFeed('aihot'))[0].title, '上次成功内容');
    assert.equal(requests, 1);
    now = resumeAt;
    assert.equal((await fetchFeed('aihot'))[0].title, item.title);
    assert.equal(requests, 2);
  });
}
