import assert from "node:assert/strict";
import test from "node:test";
import { parseOrganizedXImport, parseXBookmarksExport } from "../lib/x-bookmarks.js";

test("imports a raw X page with author, link, and media context", () => {
  const page = {
    data: [{
      id: "1234567890", author_id: "42", text: "Short text",
      note_tweet: { text: "A useful method\nwith detail" },
      entities: { urls: [{ expanded_url: "https://example.com/guide" }] },
      attachments: { media_keys: ["photo-1"] },
      public_metrics: { like_count: 12 }, created_at: "2026-07-01T00:00:00Z",
    }],
    includes: {
      users: [{ id: "42", username: "example_user" }],
      media: [{ media_key: "photo-1", url: "https://example.com/image.jpg" }],
    },
  };
  const [item] = parseXBookmarksExport(JSON.stringify(page, null, 2));
  assert.equal(item.externalId, "1234567890");
  assert.equal(item.url, "https://x.com/example_user/status/1234567890");
  assert.equal(item.content, "A useful method\nwith detail");
  assert.equal(item.author, "@example_user");
  assert.deepEqual(item.links, ["https://example.com/guide"]);
  assert.equal(item.media[0].media_key, "photo-1");
  assert.equal(item.metrics.like_count, 12);
});

test("joins wrapped normalized records and deduplicates by post ID", () => {
  const row = JSON.stringify({ id: "9876543210", text: "A bookmark", author: { username: "writer" } });
  const split = row.indexOf("bookmark") + 4;
  const input = `${row.slice(0, split)}\n${row.slice(split)}\n${row}`;
  const items = parseXBookmarksExport(input);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, "A bookmark");
});

test("rejects incomplete exports and invalid post IDs before import", () => {
  assert.throws(() => parseXBookmarksExport('{"id":"123","text":"unfinished'), /不是完整/);
  assert.throws(() => parseXBookmarksExport('{"id":"not-an-id","text":"hi"}'), /无效的帖子 ID/);
});

test("partial organized batches require an explicit partial import", () => {
  const row = (id, coverage) => JSON.stringify({
    externalId: id, content: `Post ${id}`, url: `https://x.com/writer/status/${id}`,
    organization: { coverage, groupId: id, assetType: "knowledge", topic: "software" },
  });
  const partial = row("123", "partial_ui_scan");
  assert.throws(() => parseOrganizedXImport(partial), /部分数据导入/);
  assert.equal(parseOrganizedXImport(partial, { allowPartial: true }).coverage, "partial_ui_scan");
  assert.throws(() => parseOrganizedXImport(row("123", "partial_xarchive_scan")), /部分数据导入/);
  assert.equal(parseOrganizedXImport(row("123", "partial_xarchive_scan"), { allowPartial: true }).coverage,
    "partial_xarchive_scan");
  assert.equal(parseOrganizedXImport(row("123", "complete")).coverage, "complete");
  assert.throws(() => parseOrganizedXImport(row("123", "historical_snapshot")), /历史快照/);
  assert.throws(() => parseOrganizedXImport(`${partial}\n${row("456", "complete")}`, { allowPartial: true }),
    /采集范围不一致/);
});
