import path from "node:path";
import { classifyXAssetFacets, X_ASSET_FACET_VERSION } from "./typesafe.js";
import { parseGitHubRepositoryLink } from "./x-github-assets.js";
import { atomicWrite, buildViews, cachedRefinement, jsonl, mapConcurrent,
  normalizeXInboxRow, sourceRecord, stableRank } from "./x-refinement-common.js";

function bucketNames(item) {
  const asset = item.organization.assetType || "missing";
  const topic = item.organization.topic || "missing";
  const names = [`asset:${asset}`, `pair:${asset}:${topic}`];
  if (Number(item.organization.assetConfidence || 0) < 0.5) names.push("low-asset-confidence");
  if (Number(item.organization.topicConfidence || 0) < 0.5) names.push("low-topic-confidence");
  if (item.media.length) names.push("has-media");
  if (item.links.length) names.push("has-links");
  if (item.links.some(parseGitHubRepositoryLink)) names.push("github-repository");
  if (String(item.content || "").length > 1200) names.push("long-text");
  if (String(item.content || "").length < 120) names.push("short-text");
  return names;
}

/** Select broad coverage from the existing Jev groups without treating them as final truth. */
export function selectXAssetSample(rows, { size = 100 } = {}) {
  const items = rows.map(normalizeXInboxRow)
    .filter((item) => item.source === "x" && item.externalId && item.organization.assetType)
    .sort((a, b) => stableRank(a.externalId).localeCompare(stableRank(b.externalId)));
  const requested = Number(size);
  const target = requested === 0 ? items.length
    : Math.min(items.length, Math.max(1, requested || 100));
  const buckets = new Map();
  for (const item of items) {
    for (const name of bucketNames(item)) {
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name).push(item);
    }
  }
  const order = [...buckets.keys()].sort((a, b) => {
    const priority = (name) => name.startsWith("asset:") ? 0 : name.startsWith("pair:") ? 1 : 2;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
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
  for (const item of items) {
    if (selected.size >= target) break;
    selected.set(item.externalId, item);
  }
  return [...selected.values()].sort((a, b) => stableRank(a.externalId).localeCompare(stableRank(b.externalId)));
}

function reviewReasons(decision) {
  const reasons = [];
  const choiceConfidence = [decision.sourceForm, decision.primaryRoute, decision.contentSufficiency]
    .map((entry) => Number(entry?.answer?.confidence ?? 0));
  if (Math.min(...choiceConfidence) < 0.5) reasons.push("low_confidence");
  if (decision.primaryRoute.value === "review") reasons.push("route_review");
  if (decision.contentSufficiency.value !== "self_contained") reasons.push(decision.contentSufficiency.value);
  if (!decision.derivedAssets.length) reasons.push("no_derived_asset");
  return [...new Set(reasons)];
}

export async function refineXAssetSample({ rows, outDir, sampleSize = 100, concurrency = 3,
  classifyImpl = classifyXAssetFacets }) {
  if (!path.isAbsolute(outDir)) throw new Error("资产细分输出目录必须是绝对路径");
  const sample = selectXAssetSample(rows, { size: sampleSize });
  if (!sample.length) throw new Error("没有可用于资产细分的 X 收藏");
  const cacheRoot = path.join(outDir, "decisions");
  const results = await mapConcurrent(sample, concurrency, (item) =>
    cachedRefinement(cacheRoot, X_ASSET_FACET_VERSION, item, classifyImpl));
  const refined = [];
  const failures = [];
  results.forEach((result, index) => {
    const item = sample[index];
    if (!result.ok) {
      failures.push({ externalId: item.externalId, title: item.title,
        error: String(result.error?.message || "未知错误") });
      return;
    }
    refined.push({
      externalId: item.externalId,
      source: sourceRecord(item),
      facets: result.value,
    });
  });
  const reviews = refined.flatMap((entry) => {
    const reasons = reviewReasons(entry.facets);
    return reasons.length ? [{ externalId: entry.externalId, title: entry.source.title, reasons }] : [];
  });
  const views = {
    sourceForms: buildViews(refined, (entry) => [entry.facets.sourceForm.value]),
    primaryRoutes: buildViews(refined, (entry) => [entry.facets.primaryRoute.value]),
    derivedAssets: buildViews(refined, (entry) => entry.facets.derivedAssets),
    existingAssets: buildViews(refined, (entry) => [entry.source.existingClassification.assetType]),
    existingTopics: buildViews(refined, (entry) => [entry.source.existingClassification.topic]),
  };
  const summary = {
    version: X_ASSET_FACET_VERSION,
    availableRows: rows.length,
    sampled: sample.length,
    processed: refined.length,
    failed: failures.length,
    needsReview: reviews.length,
    needsReviewBreakdown: {
      lowConfidence: reviews.filter((entry) => entry.reasons.includes("low_confidence")).length,
      ambiguousRoute: reviews.filter((entry) => entry.reasons.includes("route_review")).length,
      contentRecovery: reviews.filter((entry) => entry.reasons.some((reason) =>
        ["needs_external_link", "needs_media", "missing_referenced_content", "unavailable"].includes(reason))).length,
      noDerivedAsset: reviews.filter((entry) => entry.reasons.includes("no_derived_asset")).length,
    },
    usage: refined.reduce((total, entry) => ({
      inputTokens: total.inputTokens + entry.facets.usage.inputTokens,
      outputTokens: total.outputTokens + entry.facets.usage.outputTokens,
    }), { inputTokens: 0, outputTokens: 0 }),
    completedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(outDir, "assets.refined.jsonl"), jsonl(refined));
  await atomicWrite(path.join(outDir, "asset-views.json"), views);
  await atomicWrite(path.join(outDir, "needs-review.jsonl"), jsonl(reviews));
  await atomicWrite(path.join(outDir, "failures.jsonl"), jsonl(failures));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  return summary;
}
