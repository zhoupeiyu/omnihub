import assert from "node:assert/strict";
import test from "node:test";
import { classifyInboxItem, chooseXBookmarkGroup } from "../lib/typesafe.js";

const previousKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = "synthetic-test-key";
test.after(() => {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousKey;
});

function response(choice, confidence) {
  return {
    ok: true,
    json: async () => ({
      model: "jev-test",
      answers: {
        destination: {
          type: "choice",
          choice,
          confidence,
          probabilities: { prompt: 0.8, resource: 0.1, knowledge: 0.05, unknown: 0.05 },
        },
      },
    }),
  };
}

test("sends bounded inbox state and returns a typed suggestion", async () => {
  let request;
  const item = { title: "Template", url: "", content: "Write a video prompt. ".repeat(300) };
  const result = await classifyInboxItem(item, async (_url, options) => {
    request = options;
    return response("prompt", 0.85);
  });
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.state.content.length, 4000);
  assert.deepEqual(Object.keys(sent.questions.destination.criteria), ["prompt", "resource", "knowledge", "unknown"]);
  assert.equal(result.aiType, "prompt");
  assert.equal(result.aiExtract.typeSafe.model, "jev-test");
});

test("uncertain judgment leaves destination for human choice", async () => {
  const result = await classifyInboxItem(
    { title: "Mixed notes", content: "A link and a note" },
    async () => response("resource", 0.3),
  );
  assert.equal(result.aiType, "");
  assert.equal(result.aiConfidence, 0.3);
  assert.equal(result.aiExtract.typeSafe.choice, "resource");
});

test("rejects incomplete TypeSafe responses", async () => {
  await assert.rejects(
    classifyInboxItem({ title: "Sample" }, async () => ({ ok: true, json: async () => ({ answers: {} }) })),
    /无效的分类结果/,
  );
});

test("repairs a surrogate pair cut by the group excerpt limit before sending to TypeSafe", async () => {
  let sent;
  await chooseXBookmarkGroup({ content: "same subject" }, [{
    id: "123", representative: `${"a".repeat(319)}😀 more`,
  }], async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: "jev-test", answers: {
      sameTopic: { type: "choice", choice: "new_topic", confidence: 0.9,
        probabilities: { new_topic: 0.9, group_0: 0.1 } },
    } }) };
  });
  assert.equal(sent.questions.sameTopic.criteria.group_0.includes("\uFFFD"), true);
  assert.equal(/[\uD800-\uDFFF]/u.test(sent.questions.sameTopic.criteria.group_0), false);
});
