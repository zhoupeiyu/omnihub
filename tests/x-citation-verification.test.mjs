import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { X_CITATION_SUPPORT_VERSION } from "../lib/typesafe.js";
import { extractCitedClaims, verifyKnowledgeDraft } from "../lib/x-citation-verification.js";

test("extracts claim sentences and ignores the source index", () => {
  const markdown = `# Draft\n\n## 方法\n第一项事实。[S:100][S:200] 第二项事实。[S:200]\n\n## 来源索引\n- [S:100] source`;
  assert.deepEqual(extractCitedClaims(markdown), [
    { id: "claim-001", section: "方法", line: 4, text: "第一项事实。", sourceIds: ["100", "200"] },
    { id: "claim-002", section: "方法", line: 4, text: "第二项事实。", sourceIds: ["200"] },
  ]);
});

test("verifies cited claims and writes a review queue", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-citation-check-"));
  const markdown = "# Draft\n\n## 方法\n第一项事实。[S:100] 第二项推断。[S:100]";
  const sourceEntries = [{ externalId: "100", source: { title: "source", content: "evidence" } }];
  try {
    const summary = await verifyKnowledgeDraft({ markdown, sourceEntries, outDir, concurrency: 2,
      verifyImpl: async (claim) => ({
        version: X_CITATION_SUPPORT_VERSION, model: "jev-test",
        verdict: { value: claim.id === "claim-001" ? "supported" : "partial",
          answer: { type: "choice", choice: claim.id === "claim-001" ? "supported" : "partial",
            confidence: 0.9, probabilities: {} } },
        needsReview: claim.id !== "claim-001", usage: { inputTokens: 50, outputTokens: 10 },
      }) });
    assert.equal(summary.claims, 2);
    assert.deepEqual(summary.verdicts, { supported: 1, partial: 1, unsupported: 0, conflict: 0 });
    const reviews = (await readFile(path.join(outDir, "needs-review.jsonl"), "utf8")).trim();
    assert.ok(reviews.includes("claim-002"));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
