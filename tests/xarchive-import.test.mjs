import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { convertXarchiveSnapshot, saveXarchiveSnapshot } from "../lib/xarchive-import.js";
import { parseXBookmarksExport } from "../lib/x-bookmarks.js";

const archive = {
  export_metadata: {
    user_id: "42", kind: "snapshot", exported_at: "2026-09-19T00:00:00Z",
    collection: { mode: "full", bookmarks: "complete", folders: "partial" },
  },
  bookmarks: [{
    tweet_id: "1234567890123456789", status: "available", full_text: "Make a scene with this prompt",
    created_at: "2026-09-18T00:00:00Z", lang: "en",
    author: { user_id: "72", screen_name: "creator" },
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/effect.jpg", alt_text: "example effect" }],
    entities: { urls: [{ expanded_url: "https://example.org/prompt" }] },
    quoted_tweet: { tweet_id: "987", full_text: "An extended camera prompt", author: { screen_name: "source" } },
    folders: ["AI images"],
  }],
};

test("converts a full free browser snapshot while preserving quote, image and account identity", async () => {
  const { posts, manifest } = convertXarchiveSnapshot(archive, "42");
  assert.equal(manifest.complete, true);
  assert.equal(manifest.foldersComplete, false);
  assert.equal(posts[0].author, "@creator");
  assert.equal(posts[0].media[0].url, "https://pbs.twimg.com/media/effect.jpg");
  assert.equal(posts[0].metrics.quotedTweet.full_text, "An extended camera prompt");
  assert.deepEqual(posts[0].metrics.folders, ["AI images"]);
  assert.equal(parseXBookmarksExport(`${JSON.stringify(posts[0])}\n`)[0].metrics.quotedTweet.full_text,
    "An extended camera prompt");

  const parent = await mkdtemp(path.join(os.tmpdir(), "omnihub-xarchive-"));
  try {
    const archiveFile = path.join(parent, "snapshot.json");
    await writeFile(archiveFile, JSON.stringify(archive));
    await saveXarchiveSnapshot({ archiveFile, expectedUserId: "42", outDir: path.join(parent, "converted") });
    const raw = await readFile(path.join(parent, "converted", "bookmarks.raw.jsonl"), "utf8");
    assert.equal(parseXBookmarksExport(raw).length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects another account, partial scans and cumulative archives", () => {
  assert.throws(() => convertXarchiveSnapshot(archive, "43"), /账号不一致/);
  assert.throws(() => convertXarchiveSnapshot({ ...archive, export_metadata: {
    ...archive.export_metadata, collection: { ...archive.export_metadata.collection, bookmarks: "partial" },
  } }, "42"), /Full refresh/);
  assert.throws(() => convertXarchiveSnapshot({ ...archive, export_metadata: {
    ...archive.export_metadata, kind: "cumulative",
  } }, "42"), /Full refresh/);
});

test("explicitly preserves a pagination-guarded scan as partial", () => {
  const partial = { ...archive, export_metadata: {
    ...archive.export_metadata,
    screen_name: "owner",
    collection: { mode: "full", bookmarks: "partial", folders: "complete", reason: "pagination_guard" },
  } };
  assert.throws(() => convertXarchiveSnapshot(partial, "42"), /不能证明当前收藏完整/);
  const { posts, manifest } = convertXarchiveSnapshot(partial, "42", { allowPartial: true });
  assert.equal(posts.length, 1);
  assert.equal(manifest.coverage, "partial_xarchive_scan");
  assert.equal(manifest.complete, false);
  assert.equal(manifest.partialReason, "pagination_guard");
  assert.equal(manifest.screenName, "owner");
});
