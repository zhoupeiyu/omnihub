import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyXKnowledgeClaim, X_CITATION_SUPPORT_VERSION } from "./typesafe.js";
import { atomicWrite, cachedRefinement, jsonl, mapConcurrent } from "./x-refinement-common.js";

const CITATION_PATTERN = /\[S:(\d+)\]/g;

export function extractCitedClaims(markdown) {
  const body = String(markdown || "").split(/^## 来源索引\s*$/m)[0];
  const claims = [];
  let section = "";
  for (const [lineIndex, line] of body.split("\n").entries()) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (!line.includes("[S:")) continue;
    const segments = line.match(/[^。！？\n]+[。！？]?(?:\[S:\d+\])+/g) || [];
    for (const segment of segments) {
      const sourceIds = [...segment.matchAll(CITATION_PATTERN)].map((match) => match[1]);
      const text = segment.replace(CITATION_PATTERN, "").trim();
      if (!text || !sourceIds.length) continue;
      claims.push({ id: `claim-${String(claims.length + 1).padStart(3, "0")}`,
        section, line: lineIndex + 1, text, sourceIds: [...new Set(sourceIds)] });
    }
  }
  return claims;
}

export async function verifyKnowledgeDraft({ markdown, sourceEntries, outDir, concurrency = 3,
  verifyImpl = verifyXKnowledgeClaim }) {
  if (!path.isAbsolute(outDir)) throw new Error("引用核验输出目录必须是绝对路径");
  const claims = extractCitedClaims(markdown);
  if (!claims.length) throw new Error("知识草稿中没有可核验引用");
  const sources = new Map(sourceEntries.map((entry) => [String(entry.externalId), entry.source]));
  const packets = claims.map((claim) => {
    const cited = claim.sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      if (!source) throw new Error(`引用来源不存在: ${sourceId}`);
      return { sourceId, title: source.title, content: source.content };
    });
    return { ...claim, sources: cited };
  });
  const cacheRoot = path.join(outDir, "decisions");
  const results = await mapConcurrent(packets, concurrency, (packet) => cachedRefinement(cacheRoot,
    X_CITATION_SUPPORT_VERSION, {
      externalId: packet.id,
      title: packet.section,
      content: packet.text,
      media: [], links: [], metrics: {}, organization: { sourceIds: packet.sourceIds },
    }, async () => verifyImpl(packet)));
  const checks = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.ok) checks.push({ ...claims[index], check: result.value });
    else failures.push({ ...claims[index], error: String(result.error?.message || "未知错误") });
  });
  const verdicts = Object.fromEntries(["supported", "partial", "unsupported", "conflict"]
    .map((value) => [value, checks.filter((entry) => entry.check.verdict.value === value).length]));
  const summary = {
    version: X_CITATION_SUPPORT_VERSION,
    claims: claims.length,
    processed: checks.length,
    failed: failures.length,
    verdicts,
    needsReview: checks.filter((entry) => entry.check.needsReview).length,
    usage: checks.reduce((total, entry) => ({
      inputTokens: total.inputTokens + entry.check.usage.inputTokens,
      outputTokens: total.outputTokens + entry.check.usage.outputTokens,
    }), { inputTokens: 0, outputTokens: 0 }),
    completedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(outDir, "claims.jsonl"), jsonl(claims));
  await atomicWrite(path.join(outDir, "checks.jsonl"), jsonl(checks));
  await atomicWrite(path.join(outDir, "needs-review.jsonl"), jsonl(checks.filter((entry) => entry.check.needsReview)));
  await atomicWrite(path.join(outDir, "failures.jsonl"), jsonl(failures));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  return summary;
}

export async function readKnowledgeVerificationInputs(articleFile, sourcesFile) {
  const markdown = await readFile(articleFile, "utf8");
  const sourceEntries = (await readFile(sourcesFile, "utf8")).trim().split("\n")
    .filter(Boolean).map(JSON.parse);
  return { markdown, sourceEntries };
}
