import assert from "node:assert/strict";
import test from "node:test";
import { convertXUiScan } from "../lib/x-ui-scan.js";

test("partial UI scan keeps observed IDs, enriches overlap, and marks folded text", () => {
  const result = convertXUiScan({
    account: "example", coverage: "partial_ui_scan", rows: [
      {
        permalink: "https://x.com/old_author/status/111", text: "folded", expanded: false,
        date: "2026-09-01T00:00:00Z", raw: "folded Show more",
        links: ["https://example.com"], media: ["https://pbs.twimg.com/media/old.jpg?name=medium"],
      },
      {
        permalink: "https://x.com/new_author/status/222", text: "A partial prompt", expanded: false,
        raw: "A partial prompt Show more", links: [],
        media: ["https://pbs.twimg.com/amplify_video_thumb/clip/img/frame.jpg"],
      },
    ],
  }, [
    {
      externalId: "111", author: "@old_author", content: "Full historical text",
      media: [{ media_key: "photo-1", type: "photo", url: "https://pbs.twimg.com/media/old.jpg?name=orig" }],
      links: ["https://example.com/old"], metrics: { authorId: "42" },
    },
    { externalId: "333", content: "Not observed now", media: [], links: [] },
  ], { expectedAccount: "example" });

  assert.equal(result.posts.length, 2);
  assert.equal(result.posts[0].content, "Full historical text");
  assert.equal(result.posts[0].media.length, 1);
  assert.equal(result.posts[0].metrics.uiTextTruncated, false);
  assert.equal(result.posts[1].metrics.uiTextTruncated, true);
  assert.equal(result.posts[1].media[0].type, "video");
  assert.deepEqual(result.summary, {
    coverage: "partial_ui_scan", account: "example", observed: 2,
    enrichedFromHistorical: 1, historicalOnly: 1, textTruncated: 1,
    withMedia: 2, mediaCount: 2,
  });
  assert.equal(result.historicalOnly[0].externalId, "333");
});

test("partial UI scan rejects a different account and non-X permalinks", () => {
  const scan = { account: "example", coverage: "partial_ui_scan", rows: [
    { permalink: "https://example.com/user/status/123", text: "text" },
  ] };
  assert.throws(() => convertXUiScan(scan, [], { expectedAccount: "other" }), /账号不匹配/);
  assert.throws(() => convertXUiScan(scan, [], { expectedAccount: "example" }), /不是 X 帖子/);
});

test("article cards retain the visible title and excerpt while requiring full-text review", () => {
  const { posts } = convertXUiScan({ account: "example", coverage: "partial_ui_scan", rows: [
    { permalink: "https://x.com/writer/status/123", expanded: true, text: "",
      raw: "Writer\n@writer\n·\nSep 18\n Article\nA useful article\nIts visible excerpt...\n9\n18\n2K\n13K" },
  ] }, [], { expectedAccount: "example" });
  assert.equal(posts[0].content, "A useful article\nIts visible excerpt...");
  assert.equal(posts[0].metrics.uiCardType, "article");
  assert.equal(posts[0].metrics.uiTextTruncated, true);
});
