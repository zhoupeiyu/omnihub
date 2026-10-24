import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyXAssetFacets, X_ASSET_FACET_VERSION } from "../lib/typesafe.js";
import { refineXAssetSample, selectXAssetSample } from "../lib/x-asset-refinement.js";

const previousKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = "synthetic-test-key";
test.after(() => {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousKey;
});

function choice(value, confidence, options) {
  const rest = (1 - confidence) / Math.max(1, options.length - 1);
  return { type: "choice", choice: value, confidence,
    probabilities: Object.fromEntries(options.map((option) => [option, option === value ? confidence : rest])) };
}

function score(value = 2.4, confidence = 0.8) {
  return { type: "score", score: value, confidence,
    legend: { 0: "No reusable value", 1: "Weak or incomplete", 2: "Useful after editing", 3: "Directly reusable" },
    probabilities: { 0: 0.02, 1: 0.08, 2: 0.38, 3: 0.52 } };
}

const FORMS = ["prompt", "tutorial", "code_config", "template_checklist", "repository", "tool_product",
  "article_reference", "research_report", "curated_list", "case_study", "opinion", "news_update",
  "showcase", "conversation", "unavailable", "other"];
const ROUTES = ["prompt_library", "code_library", "repository_library", "template_library", "playbook_library",
  "knowledge_candidate", "research_library", "resource_library", "idea_backlog", "inspiration_gallery",
  "follow_up", "archive_only", "review"];
const SUFFICIENCY = ["self_contained", "needs_external_link", "needs_media", "missing_referenced_content",
  "unavailable"];
const SIGNALS = ["extractPrompt", "extractMethod", "extractTemplate", "extractCode", "extractRepository", "extractResource",
  "extractData", "extractResearch", "extractKnowledge", "extractWorkflow", "extractIdea", "extractCase",
  "extractReference", "extractInspiration", "trackUpdate"];

function fakeDecision(overrides = {}) {
  const signalValues = { extractPrompt: 0.1, extractMethod: 0.9, extractResource: 0.2,
    extractKnowledge: 0.85, extractWorkflow: 0.1, extractIdea: 0.1, extractCase: 0.1,
    extractReference: 0.2, extractInspiration: 0.1, trackUpdate: 0.1, ...overrides.signals };
  return {
    version: X_ASSET_FACET_VERSION,
    model: "jev-test",
    sourceForm: { value: overrides.sourceForm || "tutorial",
      answer: choice(overrides.sourceForm || "tutorial", 0.9, FORMS) },
    primaryRoute: { value: overrides.primaryRoute || "knowledge_candidate",
      answer: choice(overrides.primaryRoute || "knowledge_candidate", 0.85, ROUTES) },
    contentSufficiency: { value: overrides.contentSufficiency || "self_contained",
      answer: choice(overrides.contentSufficiency || "self_contained", 0.88, SUFFICIENCY) },
    reuseValue: { value: 2.4, answer: score() },
    signals: Object.fromEntries(SIGNALS.map((name) => [name, {
      value: signalValues[name] >= 0.65,
      probability: signalValues[name],
      answer: { type: "noul", noul: signalValues[name] },
    }])),
    derivedAssets: SIGNALS.filter((name) => signalValues[name] >= 0.65),
    needsReview: Boolean(overrides.needsReview),
    usage: { inputTokens: 100, outputTokens: 30 },
  };
}

test("classifies source form, route, sufficiency, value, and multiple derived assets", async () => {
  let sent;
  const result = await classifyXAssetFacets({
    externalId: "42", title: "提示词与教程",
    content: "这里有完整提示词和使用方法。".repeat(500),
    links: ["https://example.com"], media: [], metrics: { status: "available", lang: "zh" },
    organization: { assetType: "prompt", topic: "image", assetConfidence: 0.7, topicConfidence: 0.8 },
  }, async (_url, options) => {
    sent = JSON.parse(options.body);
    const answers = {
      sourceForm: choice("prompt", 0.88, FORMS),
      primaryRoute: choice("prompt_library", 0.81, ROUTES),
      contentSufficiency: choice("self_contained", 0.9, SUFFICIENCY),
      reuseValue: score(2.7, 0.83),
    };
    for (const name of SIGNALS) answers[name] = { type: "noul",
      noul: ["extractPrompt", "extractMethod"].includes(name) ? 0.92 : 0.08 };
    return { ok: true, json: async () => ({ model: "jev-1.13.0", answers,
      usage: { input_tokens: 321, output_tokens: 90 } }) };
  });

  assert.equal(sent.state.text.length, 7000);
  assert.equal(sent.state.existingClassification.assetType, "prompt");
  assert.equal(sent.questions.extractPrompt.type, "noul");
  assert.ok(Object.hasOwn(sent.questions.primaryRoute.criteria, "review"));
  assert.equal(result.version, X_ASSET_FACET_VERSION);
  assert.deepEqual(result.derivedAssets, ["extractPrompt", "extractMethod"]);
  assert.equal(result.sourceForm.answer.probabilities.prompt, 0.88);
  assert.equal(result.needsReview, false);
});

test("sample is deterministic and covers existing coarse asset groups", () => {
  const coarse = ["prompt", "resource", "knowledge", "idea", "unknown"];
  const rows = Array.from({ length: 50 }, (_, index) => {
    const assetType = coarse[index % coarse.length];
    return { id: index + 1, externalId: String(1000 + index), source: "x", title: `${assetType} ${index}`,
      content: "content ".repeat(index + 1), media: index % 4 ? "[]" : "[{\"type\":\"photo\"}]",
      links: index % 3 ? "[]" : "[\"https://example.com\"]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType, topic: index % 2 ? "software" : "other",
        assetConfidence: index % 7 ? 0.8 : 0.3, topicConfidence: 0.8 } }) };
  });
  const first = selectXAssetSample(rows, { size: 15 });
  const second = selectXAssetSample([...rows].reverse(), { size: 15 });
  assert.deepEqual(first.map((row) => row.externalId), second.map((row) => row.externalId));
  assert.deepEqual(new Set(first.map((row) => row.organization.assetType)), new Set(coarse));
  assert.ok(first.some((row) => row.organization.assetConfidence < 0.5));
});

test("sample refinement preserves sources, exposes multi-asset views, and reuses cache", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-asset-refinement-"));
  const rows = [
    { id: 1, externalId: "x1", source: "x", title: "Prompt tutorial", url: "https://x.com/a/status/x1",
      author: "@a", content: "prompt and method", media: "[]", links: "[]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "prompt", topic: "image",
        assetConfidence: 0.9, topicConfidence: 0.9 } }) },
    { id: 2, externalId: "x2", source: "x", title: "Unknown tool", url: "https://x.com/b/status/x2",
      author: "@b", content: "a useful repository", media: "[]", links: "[\"https://github.com/test/repo\"]",
      metrics: "{}", aiExtract: JSON.stringify({ xOrganization: { assetType: "unknown", topic: "software",
        assetConfidence: 0.3, topicConfidence: 0.8 } }) },
  ];
  let calls = 0;
  const classifyImpl = async (item) => {
    calls += 1;
    return item.externalId === "x1"
      ? fakeDecision({ sourceForm: "prompt", primaryRoute: "prompt_library",
        signals: { extractPrompt: 0.95, extractMethod: 0.9, extractKnowledge: 0.2 } })
      : fakeDecision({ sourceForm: "tool_product", primaryRoute: "resource_library",
        signals: { extractMethod: 0.1, extractKnowledge: 0.1, extractResource: 0.96 } });
  };
  try {
    const first = await refineXAssetSample({ rows, outDir, sampleSize: 2, classifyImpl, concurrency: 2 });
    assert.equal(first.sampled, 2);
    assert.equal(first.processed, 2);
    assert.equal(first.failed, 0);
    assert.equal(calls, 2);

    const refined = (await readFile(path.join(outDir, "assets.refined.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(refined.find((item) => item.externalId === "x1").source.content, "prompt and method");

    const views = JSON.parse(await readFile(path.join(outDir, "asset-views.json"), "utf8"));
    assert.ok(views.derivedAssets.find((view) => view.id === "extractPrompt").memberIds.includes("x1"));
    assert.ok(views.derivedAssets.find((view) => view.id === "extractMethod").memberIds.includes("x1"));
    assert.ok(views.derivedAssets.find((view) => view.id === "extractResource").memberIds.includes("x2"));

    await refineXAssetSample({ rows, outDir, sampleSize: 2, classifyImpl, concurrency: 2 });
    assert.equal(calls, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
