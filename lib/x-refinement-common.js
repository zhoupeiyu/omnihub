import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function parsed(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); }
  catch { return fallback; }
}

export function normalizeXInboxRow(row) {
  const aiExtract = parsed(row.aiExtract, {});
  return {
    ...row,
    externalId: String(row.externalId || ""),
    media: Array.isArray(row.media) ? row.media : parsed(row.media, []),
    links: Array.isArray(row.links) ? row.links : parsed(row.links, []),
    metrics: parsed(row.metrics, {}),
    aiExtract,
    organization: aiExtract.xOrganization || {},
  };
}

export function stableRank(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function refinementFingerprint(item) {
  return createHash("sha256").update(JSON.stringify({
    externalId: item.externalId,
    title: item.title,
    content: item.content,
    media: item.media,
    links: item.links,
    metrics: item.metrics,
    organization: item.organization,
  })).digest("hex");
}

export async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, body, { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

function isTransientRefinementError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return [408, 425, 429, 500, 502, 503, 504, 529].includes(status) ||
    /fetch failed|network|timeout|timed out|socket|ECONNRESET|ETIMEDOUT/i.test(message);
}

export async function cachedRefinement(cacheRoot, version, item, classifyImpl,
  { maxAttempts = 3, retryDelayMs = 250 } = {}) {
  const fingerprint = refinementFingerprint(item);
  const file = path.join(cacheRoot, version, `${item.externalId}-${fingerprint.slice(0, 16)}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (cached.version === version && cached.fingerprint === fingerprint &&
        cached.externalId === item.externalId) return cached.decision;
    throw new Error("炼化缓存内容不匹配");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let decision;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      decision = await classifyImpl(item);
      break;
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientRefinementError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  if (decision?.version !== version) throw new Error("炼化结果版本不匹配");
  await atomicWrite(file, {
    version,
    fingerprint,
    externalId: item.externalId,
    completedAt: new Date().toISOString(),
    decision,
  });
  return decision;
}

export async function mapConcurrent(items, concurrency, worker) {
  const size = Math.max(1, Math.min(8, Number(concurrency) || 1));
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

export function sourceRecord(item) {
  return {
    id: item.id,
    source: item.source,
    externalId: item.externalId,
    title: item.title,
    url: item.url,
    author: item.author,
    content: item.content,
    media: item.media,
    links: item.links,
    metrics: item.metrics,
    existingClassification: item.organization,
    visibility: item.visibility,
    status: item.status,
  };
}

export function buildViews(entries, valueOf) {
  const groups = new Map();
  for (const entry of entries) {
    const values = valueOf(entry).filter(Boolean);
    for (const value of new Set(values)) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(entry.externalId);
    }
  }
  return [...groups.entries()].map(([id, memberIds]) => ({
    id,
    count: memberIds.length,
    memberIds: memberIds.sort(),
  })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export function jsonl(entries) {
  return entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
}
