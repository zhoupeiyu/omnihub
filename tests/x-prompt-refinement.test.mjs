import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyXPromptFacets, X_PROMPT_FACET_VERSION } from "../lib/typesafe.js";
import { detectPromptTools, refineExistingXPrompts,
  selectXPromptSample } from "../lib/x-prompt-refinement.js";

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

function score(value = 2.8, confidence = 0.8) {
  return { type: "score", score: value, confidence,
    legend: { 0: "Not reusable", 1: "Missing essential context", 2: "Adaptable", 3: "Ready to use" },
    probabilities: { 0: 0.02, 1: 0.05, 2: 0.08, 3: 0.85 } };
}

const OPTIONS = {
  kind: ["image_generation", "video_generation", "writing", "research", "coding", "agent_system",
    "automation", "social_content", "not_reusable_prompt", "other"],
  completeness: ["full_prompt", "partial_prompt", "prompt_missing", "description_only", "not_prompt"],
  inputMode: ["text_only", "image_reference", "audio_reference", "multiple_references", "system_instruction",
    "workflow_steps", "not_applicable", "unknown"],
  subject: ["female_character", "male_character", "multiple_people", "product", "architecture_space",
    "landscape", "animal_creature", "ui_design", "short_drama_character", "abstract_visual",
    "agent_or_software", "general_content", "none", "other"],
  scenario: ["portrait", "ecommerce", "poster_key_visual", "character_sheet", "storyboard", "short_drama",
    "tutorial", "social_media", "system_configuration", "coding_workflow", "research", "other"],
  style: ["cinematic", "photorealistic", "chinese_traditional", "illustration", "infographic",
    "documentary", "minimal", "anime_cg", "not_applicable", "other"],
};

function fakeDecision(overrides = {}) {
  const answer = (name, value, confidence = 0.9) => ({ value,
    answer: choice(value, confidence, OPTIONS[name]) });
  return {
    version: X_PROMPT_FACET_VERSION,
    model: "jev-test",
    kind: answer("kind", overrides.kind || "image_generation"),
    completeness: answer("completeness", overrides.completeness || "full_prompt"),
    inputMode: answer("inputMode", overrides.inputMode || "text_only"),
    subject: answer("subject", overrides.subject || "female_character"),
    scenario: answer("scenario", overrides.scenario || "portrait"),
    style: answer("style", overrides.style || "cinematic"),
    reusability: { value: 2.8, answer: score() },
    signals: {
      femaleSubject: { value: true, probability: 0.95, answer: { type: "noul", noul: 0.95 } },
      cinematicStyle: { value: true, probability: 0.9, answer: { type: "noul", noul: 0.9 } },
      photorealisticStyle: { value: false, probability: 0.2, answer: { type: "noul", noul: 0.2 } },
      chineseTraditional: { value: false, probability: 0.1, answer: { type: "noul", noul: 0.1 } },
      shortDramaUse: { value: false, probability: 0.1, answer: { type: "noul", noul: 0.1 } },
      oneShotCamera: { value: false, probability: 0.1, answer: { type: "noul", noul: 0.1 } },
      ecommerceUse: { value: false, probability: 0.1, answer: { type: "noul", noul: 0.1 } },
      agentInstruction: { value: false, probability: 0.1, answer: { type: "noul", noul: 0.1 } },
    },
    needsReview: overrides.needsReview || false,
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

test("classifies prompt facets with controlled choices, nouls, and full probabilities", async () => {
  let sent;
  const result = await classifyXPromptFacets({
    externalId: "42", title: "Seedance 女性电影感提示词",
    content: "使用参考图生成电影感女性角色视频。".repeat(500),
    links: [], media: [{ type: "video", alt_text: "result" }],
    metrics: { quotedTweet: { full_text: "原始效果" } },
  }, async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: "jev-1.13.0", answers: {
      kind: choice("video_generation", 0.96, OPTIONS.kind),
      completeness: choice("full_prompt", 0.91, OPTIONS.completeness),
      inputMode: choice("image_reference", 0.88, OPTIONS.inputMode),
      subject: choice("female_character", 0.93, OPTIONS.subject),
      scenario: choice("portrait", 0.79, OPTIONS.scenario),
      style: choice("cinematic", 0.86, OPTIONS.style),
      reusability: score(2.8, 0.84),
      femaleSubject: { type: "noul", noul: 0.97 },
      cinematicStyle: { type: "noul", noul: 0.94 },
      photorealisticStyle: { type: "noul", noul: 0.31 },
      chineseTraditional: { type: "noul", noul: 0.06 },
      shortDramaUse: { type: "noul", noul: 0.12 },
      oneShotCamera: { type: "noul", noul: 0.09 },
      ecommerceUse: { type: "noul", noul: 0.03 },
      agentInstruction: { type: "noul", noul: 0.01 },
    }, usage: { input_tokens: 222, output_tokens: 88 } }) };
  });

  assert.equal(sent.state.text.length, 7000);
  assert.equal(sent.questions.kind.type, "choice");
  assert.equal(sent.questions.femaleSubject.type, "noul");
  assert.ok(Object.hasOwn(sent.questions.completeness.criteria, "prompt_missing"));
  assert.equal(result.version, X_PROMPT_FACET_VERSION);
  assert.equal(result.kind.value, "video_generation");
  assert.equal(result.kind.answer.probabilities.video_generation, 0.96);
  assert.equal(result.signals.femaleSubject.probability, 0.97);
  assert.equal(result.reusability.value, 2.8);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.usage, { inputTokens: 222, outputTokens: 88 });
});

test("detects known tools without inventing new labels", () => {
  assert.deepEqual(detectPromptTools("Seedance 2.0 配合即梦参考图，最后交给 Claude Code"),
    ["claude", "jimeng", "seedance"]);
  assert.deepEqual(detectPromptTools("没有明确工具"), []);
});

test("prompt pilot is deterministic and covers existing topics", () => {
  const topics = ["video", "image", "software", "workflow"];
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1, externalId: String(5000 + index), source: "x", title: `prompt ${index}`,
    content: "prompt ".repeat(index + 1), media: index % 3 ? "[]" : "[{\"type\":\"photo\"}]",
    links: index % 4 ? "[]" : "[\"https://example.com\"]", metrics: "{}",
    aiExtract: JSON.stringify({ xOrganization: { assetType: "prompt", topic: topics[index % topics.length] } }),
  }));
  const first = selectXPromptSample(rows, { size: 16 });
  const second = selectXPromptSample([...rows].reverse(), { size: 16 });
  assert.deepEqual(first.map((row) => row.externalId), second.map((row) => row.externalId));
  assert.deepEqual(new Set(first.map((row) => row.organization.topic)), new Set(topics));
});

test("refines only existing Jev prompt rows, preserves source text, and reuses cache", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-prompt-refinement-"));
  const rows = [
    { id: 1, externalId: "x1", source: "x", title: "电影感女性", url: "https://x.com/a/status/x1",
      author: "@a", content: "Seedance 女性电影感提示词", media: "[]", links: "[]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "prompt", topic: "video" } }) },
    { id: 2, externalId: "x2", source: "x", title: "系统指令", url: "https://x.com/b/status/x2",
      author: "@b", content: "Claude Code AGENTS.md", media: "[]", links: "[]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "prompt", topic: "software" } }) },
    { id: 3, externalId: "x3", source: "x", title: "普通资源", url: "https://x.com/c/status/x3",
      author: "@c", content: "资源", media: "[]", links: "[]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "resource", topic: "software" } }) },
  ];
  let calls = 0;
  const classifyImpl = async (item) => {
    calls += 1;
    return item.externalId === "x2"
      ? fakeDecision({ kind: "agent_system", subject: "agent_or_software", scenario: "system_configuration",
        style: "not_applicable" })
      : fakeDecision();
  };
  try {
    const first = await refineExistingXPrompts({ rows, outDir, classifyImpl, concurrency: 2 });
    assert.equal(first.sourcePrompts, 2);
    assert.equal(first.sampled, 2);
    assert.equal(first.processed, 2);
    assert.equal(first.failed, 0);
    assert.equal(calls, 2);

    const items = (await readFile(path.join(outDir, "prompts.refined.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(items[0].source.content, rows.find((row) => row.externalId === items[0].externalId).content);
    assert.equal(items.find((item) => item.externalId === "x2").facets.kind.value, "agent_system");

    const views = JSON.parse(await readFile(path.join(outDir, "views.json"), "utf8"));
    assert.ok(views.kind.find((view) => view.id === "agent_system").memberIds.includes("x2"));
    assert.ok(views.tools.find((view) => view.id === "seedance").memberIds.includes("x1"));

    const second = await refineExistingXPrompts({ rows, outDir, classifyImpl, concurrency: 2 });
    assert.equal(second.processed, 2);
    assert.equal(calls, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("puts missing or false prompts into review without dropping them", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-prompt-review-"));
  const rows = [{ id: 1, externalId: "x1", source: "x", title: "Prompt in comments", url: "",
    author: "@a", content: "完整提示词在评论区", media: "[]", links: "[]", metrics: "{}",
    aiExtract: JSON.stringify({ xOrganization: { assetType: "prompt", topic: "other" } }) }];
  try {
    const result = await refineExistingXPrompts({ rows, outDir,
      classifyImpl: async () => fakeDecision({ completeness: "prompt_missing", needsReview: true }) });
    assert.equal(result.needsReview, 1);
    const review = JSON.parse((await readFile(path.join(outDir, "needs-review.jsonl"), "utf8")).trim());
    assert.equal(review.externalId, "x1");
    assert.ok(review.reasons.includes("prompt_missing"));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
