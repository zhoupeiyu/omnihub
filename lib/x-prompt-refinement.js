import path from "node:path";
import { classifyXPromptFacets, X_PROMPT_FACET_VERSION } from "./typesafe.js";
import { atomicWrite, buildViews, cachedRefinement, jsonl, mapConcurrent,
  normalizeXInboxRow, sourceRecord, stableRank } from "./x-refinement-common.js";

const TOOL_PATTERNS = {
  claude: /\bclaude(?:\s+code)?\b/i,
  codex: /\bcodex\b/i,
  comfyui: /\bcomfyui\b/i,
  gemini: /\bgemini\b/i,
  gpt_image: /\b(?:gpt[- ]?image|dall[- ]?e)\b/i,
  jimeng: /即梦|jimeng/i,
  kling: /可灵|\bkling\b/i,
  midjourney: /\bmidjourney\b|\bmj\b/i,
  nano_banana: /nano[- ]?banana|香蕉(?:模型)?/i,
  runway: /\brunway\b/i,
  seedance: /\bseedance\b/i,
  sora: /\bsora\b/i,
};

export function detectPromptTools(value) {
  return Object.entries(TOOL_PATTERNS).filter(([, pattern]) => pattern.test(String(value || "")))
    .map(([id]) => id).sort();
}

function reviewReasons(decision) {
  const reasons = [];
  const choiceConfidence = ["kind", "completeness", "inputMode", "subject", "scenario", "style"]
    .map((name) => Number(decision[name]?.answer?.confidence ?? 0));
  if (Math.min(...choiceConfidence) < 0.55) reasons.push("low_confidence");
  if (decision.completeness.value !== "full_prompt") reasons.push(decision.completeness.value);
  if (decision.kind.value === "not_reusable_prompt") reasons.push("not_reusable_prompt");
  if (Number(decision.reusability.value) < 1.5) reasons.push("low_reusability");
  return [...new Set(reasons)];
}

/** Select a deterministic prompt pilot while retaining coverage across existing topics and source shapes. */
export function selectXPromptSample(rows, { size = 0 } = {}) {
  const prompts = rows.map(normalizeXInboxRow)
    .filter((item) => item.source === "x" && item.externalId && item.organization.assetType === "prompt")
    .sort((a, b) => stableRank(a.externalId).localeCompare(stableRank(b.externalId)));
  const target = Number(size) > 0 ? Math.min(prompts.length, Number(size)) : prompts.length;
  if (target >= prompts.length) return prompts;
  const buckets = new Map();
  for (const item of prompts) {
    const shapes = [
      `topic:${item.organization.topic || "missing"}`,
      item.media.length ? "shape:media" : "shape:no-media",
      item.links.length ? "shape:links" : "shape:no-links",
      String(item.content || "").length >= 800 ? "shape:long" : "shape:short",
    ];
    for (const shape of shapes) {
      if (!buckets.has(shape)) buckets.set(shape, []);
      buckets.get(shape).push(item);
    }
  }
  const order = [...buckets.keys()].sort((a, b) =>
    (a.startsWith("topic:") ? 0 : 1) - (b.startsWith("topic:") ? 0 : 1) || a.localeCompare(b));
  const selected = new Map();
  const positions = new Map(order.map((name) => [name, 0]));
  while (selected.size < target) {
    let added = false;
    for (const name of order) {
      const bucket = buckets.get(name);
      let position = positions.get(name);
      while (position < bucket.length && selected.has(bucket[position].externalId)) position += 1;
      positions.set(name, position + 1);
      if (position < bucket.length) {
        selected.set(bucket[position].externalId, bucket[position]);
        added = true;
        if (selected.size >= target) break;
      }
    }
    if (!added) break;
  }
  return [...selected.values()].sort((a, b) => stableRank(a.externalId).localeCompare(stableRank(b.externalId)));
}

export async function refineExistingXPrompts({ rows, outDir, sampleSize = 0, concurrency = 3,
  classifyImpl = classifyXPromptFacets }) {
  if (!path.isAbsolute(outDir)) throw new Error("提示词细分输出目录必须是绝对路径");
  const allPrompts = rows.map(normalizeXInboxRow)
    .filter((item) => item.source === "x" && item.externalId && item.organization.assetType === "prompt");
  if (!allPrompts.length) throw new Error("现有 Jev 结果中没有提示词来源");
  const prompts = selectXPromptSample(allPrompts, { size: sampleSize });
  const cacheRoot = path.join(outDir, "decisions");
  const results = await mapConcurrent(prompts, concurrency, (item) =>
    cachedRefinement(cacheRoot, X_PROMPT_FACET_VERSION, item, classifyImpl));
  const refined = [];
  const failures = [];
  results.forEach((result, index) => {
    const item = prompts[index];
    if (!result.ok) {
      failures.push({ externalId: item.externalId, title: item.title,
        error: String(result.error?.message || "未知错误") });
      return;
    }
    refined.push({
      externalId: item.externalId,
      source: sourceRecord(item),
      facets: result.value,
      tools: detectPromptTools(`${item.title}\n${item.content}`),
    });
  });
  const reviews = refined.flatMap((entry) => {
    const reasons = reviewReasons(entry.facets);
    return reasons.length ? [{ externalId: entry.externalId, title: entry.source.title, reasons }] : [];
  });
  const views = {
    kind: buildViews(refined, (entry) => [entry.facets.kind.value]),
    completeness: buildViews(refined, (entry) => [entry.facets.completeness.value]),
    inputMode: buildViews(refined, (entry) => [entry.facets.inputMode.value]),
    subject: buildViews(refined, (entry) => [entry.facets.subject.value]),
    scenario: buildViews(refined, (entry) => [entry.facets.scenario.value]),
    style: buildViews(refined, (entry) => [entry.facets.style.value]),
    tools: buildViews(refined, (entry) => entry.tools),
    signals: buildViews(refined, (entry) => Object.entries(entry.facets.signals)
      .filter(([, signal]) => signal.value).map(([name]) => name)),
  };
  const summary = {
    version: X_PROMPT_FACET_VERSION,
    sourcePrompts: allPrompts.length,
    sampled: prompts.length,
    processed: refined.length,
    failed: failures.length,
    needsReview: reviews.length,
    needsReviewBreakdown: {
      lowConfidence: reviews.filter((entry) => entry.reasons.includes("low_confidence")).length,
      incomplete: reviews.filter((entry) => entry.reasons.some((reason) =>
        ["partial_prompt", "prompt_missing", "description_only", "not_prompt"].includes(reason))).length,
      falsePositive: reviews.filter((entry) => entry.reasons.includes("not_reusable_prompt")).length,
      lowReusability: reviews.filter((entry) => entry.reasons.includes("low_reusability")).length,
    },
    usage: refined.reduce((total, entry) => ({
      inputTokens: total.inputTokens + entry.facets.usage.inputTokens,
      outputTokens: total.outputTokens + entry.facets.usage.outputTokens,
    }), { inputTokens: 0, outputTokens: 0 }),
    completedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(outDir, "prompts.refined.jsonl"), jsonl(refined));
  await atomicWrite(path.join(outDir, "views.json"), views);
  await atomicWrite(path.join(outDir, "needs-review.jsonl"), jsonl(reviews));
  await atomicWrite(path.join(outDir, "failures.jsonl"), jsonl(failures));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  return summary;
}
