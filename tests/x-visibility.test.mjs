import assert from "node:assert/strict";
import test from "node:test";
import { isSafePublicXBookmark } from "../lib/x-visibility.js";

function row(overrides = {}) {
  return { source: "x", status: "pending", visibility: "unreviewed", title: "有用的开发方法",
    url: "https://x.com/writer/status/123", author: "@writer", content: "开发工具说明",
    aiSummary: "", media: "[]", links: "[]", metrics: "{}",
    aiExtract: JSON.stringify({ xOrganization: { topic: "software" } }), ...overrides };
}

test("ordinary X posts including photos are public candidates; exercise and adult content stay owner-only", () => {
  assert.equal(isSafePublicXBookmark(row()), true);
  assert.equal(isSafePublicXBookmark(row({ title: "凯格尔进阶锻炼" })), false);
  assert.equal(isSafePublicXBookmark(row({ title: "凯格尔进阶锻炼", aiType: "prompt" })), true);
  assert.equal(isSafePublicXBookmark(row({ content: "An NSFW link",
    aiExtract: JSON.stringify({ xOrganization: { topic: "image", assetType: "prompt" } }) })), true);
  assert.equal(isSafePublicXBookmark(row({ content: "An NSFW link" })), false);
  assert.equal(isSafePublicXBookmark(row({ media: '[{"type":"photo","url":"https://example.com/image"}]' })), true);
  assert.equal(isSafePublicXBookmark(row({ aiExtract: JSON.stringify({ xOrganization: { topic: "other" } }) })), true);
  assert.equal(isSafePublicXBookmark(row({ media: '[{"type":"photo","alt_text":"nude photo"}]' })), false);
  assert.equal(isSafePublicXBookmark(row({ author: "@nsfw_gallery" })), false);
  assert.equal(isSafePublicXBookmark(row({ visibility: "private" })), false);
  assert.equal(isSafePublicXBookmark(row({ aiExtract: JSON.stringify({ xOrganization: { topic: "other", contentIncomplete: true } }) })), false);
  assert.equal(isSafePublicXBookmark(row({ source: "manual" })), false);
});
