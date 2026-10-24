import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { X_GROUP_MEMBER_VERSION } from "../lib/typesafe.js";
import { refineXSubjectGroup, selectXSubjectMembers,
  X_GROUP_TAXONOMIES } from "../lib/x-group-refinement.js";

const taxonomy = X_GROUP_TAXONOMIES.obsidian;
const OPTIONS = {
  subgroup: Object.keys(taxonomy.subgroups),
  role: ["method", "tool_resource", "fact_update", "implementation_case", "viewpoint", "question",
    "background", "exclude"],
  evidenceKind: ["official_source", "direct_experience", "worked_example", "secondary_explanation",
    "recommendation", "question_request", "social_reaction", "unknown"],
  contentSufficiency: ["self_contained", "needs_external_link", "needs_media",
    "missing_referenced_content", "unavailable"],
};

function answer(value, choices, confidence = 0.9) {
  return { type: "choice", choice: value, confidence,
    probabilities: Object.fromEntries(choices.map((choice) => [choice, choice === value ? confidence :
      (1 - confidence) / (choices.length - 1)])) };
}

function decision(overrides = {}) {
  const wrapped = (name, value) => ({ value, answer: answer(value, OPTIONS[name]) });
  return {
    version: `${X_GROUP_MEMBER_VERSION}:${taxonomy.version}`,
    model: "jev-test",
    group: { id: taxonomy.id, title: taxonomy.title, taxonomyVersion: taxonomy.version },
    subgroup: wrapped("subgroup", overrides.subgroup || "ai_context_memory"),
    role: wrapped("role", overrides.role || "method"),
    evidenceKind: wrapped("evidenceKind", overrides.evidenceKind || "direct_experience"),
    contentSufficiency: wrapped("contentSufficiency", overrides.contentSufficiency || "self_contained"),
    independentContribution: { value: overrides.independentContribution ?? true,
      probability: overrides.independentContribution === false ? 0.2 : 0.9,
      answer: { type: "noul", noul: overrides.independentContribution === false ? 0.2 : 0.9 } },
    synthesisValue: { value: overrides.synthesisValue ?? 2.5,
      answer: { type: "score", score: overrides.synthesisValue ?? 2.5, confidence: 0.5,
        legend: { 0: "none", 1: "background", 2: "useful", 3: "strong" },
        probabilities: { 0: 0, 1: 0.1, 2: 0.3, 3: 0.6 } } },
    needsReview: false,
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

function row(id, subject = true) {
  return { id, externalId: `x${id}`, source: "x", title: `source ${id}`, content: "details",
    media: "[]", links: "[]", metrics: "{}", aiExtract: "{}",
    subjectCollections: subject ? [{ id: "obsidian", title: "Obsidian", confidence: 1 }] : [] };
}

test("selects only members from the requested existing Jev subject group", () => {
  assert.deepEqual(selectXSubjectMembers([row(1), row(2, false)], "obsidian")
    .map((item) => item.externalId), ["x1"]);
});

test("refines group members, keeps sources, and exposes synthesis candidates", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-group-refinement-"));
  const rows = [row(1), row(2)];
  try {
    const summary = await refineXSubjectGroup({ rows, taxonomy, outDir, concurrency: 2,
      classifyImpl: async (item) => item.externalId === "x1" ? decision() :
        decision({ subgroup: "capture_ingestion", role: "question", independentContribution: false,
          synthesisValue: 0.8 }) });
    assert.equal(summary.members, 2);
    assert.equal(summary.processed, 2);
    assert.equal(summary.synthesisCandidates, 1);
    const candidates = (await readFile(path.join(outDir, "synthesis-candidates.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(candidates[0].externalId, "x1");
    assert.equal(candidates[0].source.content, "details");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("does not send link-dependent sources to synthesis before recovery", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-group-incomplete-"));
  try {
    const summary = await refineXSubjectGroup({ rows: [row(1)], taxonomy, outDir,
      classifyImpl: async () => decision({ contentSufficiency: "needs_external_link" }) });
    assert.equal(summary.synthesisCandidates, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
