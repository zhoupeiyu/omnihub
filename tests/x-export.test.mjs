import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportXBookmarks } from "../lib/x-export.js";

test("paid X export stops at budget and resumes without rereading saved pages", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-export-"));
  const outDir = path.join(parent, "run");
  const requestedTokens = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("post.fields"), "created_at,entities,attachments,lang,note_post,public_metrics");
    assert.equal(parsed.searchParams.get("expansions"), "attachments.media_keys,author_id");
    assert.equal(parsed.searchParams.get("user.fields"), "username,name");
    requestedTokens.push(parsed.searchParams.get("pagination_token") || "");
    const second = requestedTokens.length === 2;
    return {
      ok: true,
      json: async () => ({
        data: Array.from({ length: second ? 2 : 100 }, (_, index) => ({ id: String(index + (second ? 101 : 1)), text: "post" })),
        meta: second ? {} : { next_token: "next-page" },
      }),
    };
  };
  try {
    const first = await exportXBookmarks({ userId: "123", maxUsd: 1.5, outDir, token: "test", fetchImpl });
    assert.equal(first.complete, false);
    assert.equal(first.uniquePosts, 100);
    assert.equal(first.reason, "budget_limit");
    const second = await exportXBookmarks({ userId: "123", maxUsd: 3, outDir, token: "test", resume: true, fetchImpl });
    assert.equal(second.complete, true);
    assert.equal(second.uniquePosts, 102);
    assert.deepEqual(requestedTokens, ["", "next-page"]);
    assert.equal((await readFile(path.join(outDir, "bookmarks.raw.jsonl"), "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
