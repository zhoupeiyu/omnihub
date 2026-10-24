import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveXMedia } from "../lib/x-media-archive.js";

test("archives each effect image with a checksum and reuses the verified local copy", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-media-"));
  const posts = [{ externalId: "123", media: [{ media_key: "photo-1", type: "photo", url: "https://pbs.twimg.com/media/example.jpg" }] }];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return new Response(Buffer.from("synthetic-image"), { headers: { "content-type": "image/jpeg" } });
  };
  try {
    const first = await archiveXMedia({ posts, outDir, fetchImpl });
    assert.equal(first.saved, 1);
    const records = JSON.parse(await readFile(first.manifestPath, "utf8"));
    assert.equal((await readFile(path.join(outDir, records["123:photo-1"].file))).toString(), "synthetic-image");
    await archiveXMedia({ posts, outDir, fetchImpl });
    assert.equal(calls, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("falls back to the large X image when the original size returns 404", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-media-large-"));
  const posts = [{ externalId: "456", media: [{ media_key: "photo-1", type: "photo",
    url: "https://pbs.twimg.com/media/example?format=jpg&name=orig" }] }];
  const calls = [];
  try {
    const result = await archiveXMedia({ posts, outDir, fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).includes("name=orig") ? new Response(null, { status: 404 })
        : new Response(Buffer.from("large-image"), { headers: { "content-type": "image/jpeg" } });
    } });
    assert.equal(result.saved, 1);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]).searchParams.get("name"), "large");
    const records = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(records["456:photo-1"].url, posts[0].media[0].url);
    assert.equal(new URL(records["456:photo-1"].downloadUrl).searchParams.get("name"), "large");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
