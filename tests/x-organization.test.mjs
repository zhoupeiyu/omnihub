import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyXBookmark, chooseXBookmarkGroup } from "../lib/typesafe.js";
import { organizeXBookmarks } from "../lib/x-organization.js";
import { parseXBookmarksExport } from "../lib/x-bookmarks.js";

const previousKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = "synthetic-test-key";
test.after(() => {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousKey;
});

function choice(choice, confidence, probabilities) {
  return { type: "choice", choice, confidence, probabilities };
}

test("classifies a prompt while keeping visual claims out of text-only judgment", async () => {
  let sent;
  const result = await classifyXBookmark({
    title: "Video prompt", content: "Generate a tracking shot with this prompt...",
    links: [], media: [{ type: "photo", alt_text: "example frame", url: "https://example.com/image.jpg" }],
  }, async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: "jev-test", answers: {
      asset: choice("prompt", 0.8, { prompt: 0.8, resource: 0.05, knowledge: 0.05, idea: 0.05, unknown: 0.05 }),
      topic: choice("video", 0.7, { video: 0.7, image: 0.1, software: 0.05, crypto: 0.05, product: 0.05, workflow: 0.025, business: 0.025, other: 0 }),
    } }) };
  });
  assert.equal(result.assetType, "prompt");
  assert.equal(result.topic, "video");
  assert.equal(sent.state.media[0].altText, "example frame");
  assert.equal(sent.state.media[0].url, undefined);
  assert.match(sent.questions.asset.instructions, /Image contents are not visible/);
});

test("same-author grouping requires a confident same-subject choice", async () => {
  const groups = [{ id: "post-1", representative: "A series about camera motion" }];
  const response = (confidence) => async () => ({ ok: true, json: async () => ({
    answers: { sameTopic: choice("group_0", confidence, { group_0: 0.8, new_topic: 0.2 }) },
  }) });
  assert.equal((await chooseXBookmarkGroup({ content: "Part two of camera motion" }, groups, response(0.8))).groupId, "post-1");
  assert.equal((await chooseXBookmarkGroup({ content: "Different subject" }, groups, response(0.4))).groupId, "");
});

test("organizer groups a series but preserves each source post and effect image", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-organized-"));
  const posts = ["first prompt", "follow-up prompt", "different topic"].map((content, index) => ({
    source: "x", externalId: String(index + 1), title: content,
    url: `https://x.com/i/status/${index + 1}`, author: "@writer", content,
    media: index === 0 ? [{ type: "photo", url: "https://example.com/effect.jpg" }] : [],
    links: [], metrics: { authorId: "42" },
  }));
  let classificationCalls = 0;
  const classifyImpl = async () => {
    classificationCalls += 1;
    return {
      model: "jev-test", assetType: "prompt", topic: "image",
      asset: choice("prompt", 0.9, { prompt: 0.9 }),
      topicAnswer: choice("image", 0.8, { image: 0.8 }),
    };
  };
  const chooseGroupImpl = async (item, groups) => ({
    groupId: item.externalId === "2" ? groups[0].id : "",
    answer: item.externalId === "1" ? null : choice("group_0", 0.8, { group_0: 0.8 }),
  });
  try {
    const first = await organizeXBookmarks({ posts, outDir, sourceHash: "sample", classifyImpl, chooseGroupImpl });
    assert.equal(first.posts, 3);
    assert.equal(first.groups, 2);
    assert.equal(first.mediaCount, 1);
    const organized = await readFile(path.join(outDir, "bookmarks.organized.jsonl"), "utf8");
    const parsed = parseXBookmarksExport(organized);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].media[0].url, "https://example.com/effect.jpg");
    assert.equal(parsed[0].aiType, "prompt");
    assert.equal(parsed[1].aiExtract.xOrganization.groupId, "1");
    assert.equal(parsed[2].aiExtract.xOrganization.groupId, "3");
    await organizeXBookmarks({ posts, outDir, sourceHash: "sample", classifyImpl, chooseGroupImpl });
    assert.equal(classificationCalls, 3);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a prolific author can have more than twelve distinct topics", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-many-groups-"));
  const posts = Array.from({ length: 14 }, (_, index) => ({
    source: "x", externalId: String(index + 1), title: `topic ${index + 1}`,
    url: `https://x.com/i/status/${index + 1}`, author: "@writer", content: `topic ${index + 1}`,
    media: [], links: [], metrics: { authorId: "42" },
  }));
  const classifyImpl = async () => ({
    model: "jev-test", assetType: "knowledge", topic: "software",
    asset: choice("knowledge", 0.9, { knowledge: 0.9 }),
    topicAnswer: choice("software", 0.9, { software: 0.9 }),
  });
  let largestBatch = 0;
  const chooseGroupImpl = async (_item, candidates) => {
    largestBatch = Math.max(largestBatch, candidates.length);
    return { groupId: "", answer: choice("new_topic", 0.9, { new_topic: 0.9 }) };
  };
  try {
    const result = await organizeXBookmarks({ posts, outDir, sourceHash: "many", classifyImpl, chooseGroupImpl });
    assert.equal(result.posts, 14);
    assert.equal(result.groups, 14);
    assert.equal(largestBatch, 12);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("partial UI scan keeps folded posts in review even when classified confidently", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-partial-"));
  const post = {
    source: "x", externalId: "123", title: "Folded prompt", url: "https://x.com/writer/status/123",
    author: "@writer", content: "A partial prompt", media: [], links: [],
    metrics: { uiTextTruncated: true },
  };
  const classifyImpl = async () => ({
    model: "jev-test", assetType: "prompt", topic: "image",
    asset: choice("prompt", 0.95, { prompt: 0.95 }),
    topicAnswer: choice("image", 0.95, { image: 0.95 }),
  });
  try {
    const result = await organizeXBookmarks({ posts: [post], outDir, sourceHash: "partial",
      coverage: "partial_ui_scan", classifyImpl });
    assert.equal(result.coverage, "partial_ui_scan");
    assert.equal(result.textTruncated, 1);
    assert.equal(result.needsReview, 1);
    const row = JSON.parse((await readFile(path.join(outDir, "bookmarks.organized.jsonl"), "utf8")).trim());
    assert.equal(row.organization.contentIncomplete, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("a later complete export reuses only unchanged TypeSafe classifications", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-reuse-"));
  const oldDir = path.join(parent, "old");
  const nextDir = path.join(parent, "next");
  const posts = ["one", "two"].map((content, index) => ({
    source: "x", externalId: String(index + 1), title: content,
    url: `https://x.com/writer/status/${index + 1}`,
    author: `@writer${index}`, content, media: [], links: [], metrics: {},
  }));
  let calls = 0;
  const classifyImpl = async () => {
    calls += 1;
    return { model: "jev-test", assetType: "knowledge", topic: "software",
      asset: choice("knowledge", 0.9, { knowledge: 0.9 }),
      topicAnswer: choice("software", 0.9, { software: 0.9 }) };
  };
  try {
    await organizeXBookmarks({ posts, outDir: oldDir, sourceHash: "old", classifyImpl });
    assert.equal(calls, 2);
    await organizeXBookmarks({ posts: [{ ...posts[0] }, { ...posts[1], content: "two expanded" }],
      outDir: nextDir, sourceHash: "next", classifyImpl,
      previousClassificationsDir: path.join(oldDir, "classifications") });
    assert.equal(calls, 3);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
