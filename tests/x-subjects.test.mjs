import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { judgeXSubjectMembers } from "../lib/typesafe.js";
import { buildXSubjectCollections, discoverXSubjectCandidates } from "../lib/x-subjects.js";

const posts = [
  { source: "x", externalId: "1", author: "@a", title: "Jev 如何接入",
    content: "Jev 申请与接入" },
  { source: "x", externalId: "2", author: "@b", title: "JEV 帮助 Codex 判断",
    content: "JEV 操作判断" },
  { source: "x", externalId: "3", author: "@c", title: "Jev 链上交易应用",
    content: "这是基于 Jev 的具体应用" },
  { source: "x", externalId: "4", author: "@d", title: "本周工具清单含 Jev",
    content: "其他工具也在这份清单中" },
  { source: "x", externalId: "5", author: "@e", title: "Codex 实践",
    content: "没有谈 Jev" },
];

test("named candidates cross authors without broad Codex keyword clustering", () => {
  const candidates = discoverXSubjectCandidates(posts);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["jev"]);
  assert.deepEqual(candidates[0].posts.map((post) => post.externalId), ["1", "2", "3", "4"]);
});

test("TypeSafe membership checks each indexed post and keeps related applications", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "synthetic-test-key";
  try {
    let request;
    const results = await judgeXSubjectMembers("Jev", posts.slice(0, 3), async (_url, options) => {
      request = JSON.parse(options.body);
      const answer = (choice, probabilities) => ({ type: "choice", choice, confidence: 0.7, probabilities });
      return { ok: true, json: async () => ({ model: "jev-test", answers: {
        post_0: answer("core", { core: 0.98, related: 0, incidental: 0.02, uncertain: 0 }),
        post_1: answer("incidental", { core: 0.05, related: 0.05, incidental: 0.9, uncertain: 0 }),
        post_2: answer("related", { core: 0.4, related: 0.5, incidental: 0.1, uncertain: 0 }),
      } }) };
    });
    assert.match(request.questions.post_2.instructions, /posts\[2\]/);
    assert.equal(request.state.posts.length, 3);
    assert.deepEqual(results.map((result) => result.included), [true, false, true]);
    assert.equal(results[2].relationship, "related");
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("collections keep each source post and reuse unchanged Jev judgments", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-subject-"));
  let calls = 0;
  const judgeImpl = async (_subject, batch) => {
    calls += 1;
    return batch.map((post) => ({
      included: post.externalId !== "4", confidence: 0.95,
      relationship: post.externalId === "3" ? "related" : "core", model: "jev-test",
    }));
  };
  try {
    const candidates = discoverXSubjectCandidates(posts);
    const collections = await buildXSubjectCollections(candidates, { cacheDir, judgeImpl });
    assert.equal(calls, 1);
    assert.deepEqual(collections[0].members.map((member) => member.externalId), ["1", "2", "3"]);
    assert.equal(collections[0].members[2].relationship, "related");
    assert.equal(posts.length, 5);
    await buildXSubjectCollections(candidates, { cacheDir, judgeImpl });
    assert.equal(calls, 1);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("two words of the same product become one collection", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-subject-alias-"));
  const examples = ["Nano Banana is useful", "Nano Banana prompts", "Nano Banana Pro"]
    .map((title, index) => ({
      source: "x", externalId: String(index + 1), author: "@writer" + index,
      title, content: title,
    }));
  try {
    const groups = await buildXSubjectCollections(discoverXSubjectCandidates(examples), {
      cacheDir,
      judgeImpl: async (_subject, batch) => batch.map(() => ({
        included: true, confidence: 0.9, relationship: "core", model: "jev-test",
      })),
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, "Nano Banana");
    assert.equal(groups[0].members.length, 3);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
