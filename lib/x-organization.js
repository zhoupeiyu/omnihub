import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { classifyXBookmark, chooseXBookmarkGroup } from "./typesafe.js";

function fingerprint(item) {
  return createHash("sha256").update(JSON.stringify({
    id: item.externalId, content: item.content, authorId: item.metrics?.authorId,
    media: item.media, links: item.links,
  })).digest("hex");
}

async function atomicWrite(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

async function cachedDecision(dir, item, decide, reuseDir = "") {
  const file = path.join(dir, `${item.externalId}.json`);
  const hash = fingerprint(item);
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved.fingerprint !== hash) throw new Error("X 原文已变化，不能复用旧分类");
    return saved.decision;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (reuseDir) {
    try {
      const previous = JSON.parse(await readFile(path.join(reuseDir, `${item.externalId}.json`), "utf8"));
      if (previous.fingerprint === hash) {
        await atomicWrite(file, previous);
        return previous.decision;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const decision = await decide();
  await atomicWrite(file, { fingerprint: hash, decision });
  return decision;
}

async function selectGroup(item, candidates, chooseGroupImpl) {
  if (!candidates.length) return { groupId: "", answer: null };
  let best = { groupId: "", answer: null };
  for (let start = 0; start < candidates.length; start += 12) {
    const choice = await chooseGroupImpl(item, candidates.slice(start, start + 12));
    if (choice.groupId && (!best.groupId || (choice.answer?.confidence || 0) > (best.answer?.confidence || 0))) {
      best = choice;
    } else if (!best.groupId && choice.answer &&
      (!best.answer || choice.answer.confidence > best.answer.confidence)) {
      best = choice;
    }
  }
  return best;
}

/** Keep every source post, even when several posts belong to one author-topic group. */
export async function organizeXBookmarks({ posts, outDir, sourceHash, classifyImpl = classifyXBookmark,
  chooseGroupImpl = chooseXBookmarkGroup, coverage = "complete", previousClassificationsDir = "" }) {
  if (!Array.isArray(posts) || !posts.length) throw new Error("没有可整理的 X 收藏");
  if (!["complete", "historical_snapshot", "partial_ui_scan", "partial_xarchive_scan"].includes(coverage)) {
    throw new Error("X 导出覆盖范围无效");
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const classDir = path.join(outDir, "classifications");
  const groupDir = path.join(outDir, "groupings");
  await mkdir(classDir, { recursive: true, mode: 0o700 });
  await mkdir(groupDir, { recursive: true, mode: 0o700 });

  const sourceFile = path.join(outDir, "source.json");
  try {
    const saved = JSON.parse(await readFile(sourceFile, "utf8"));
    if (saved.sourceHash !== sourceHash || saved.count !== posts.length || saved.coverage !== coverage) {
      throw new Error("整理目录属于另一次导出，不能混用");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await atomicWrite(sourceFile, { sourceHash, count: posts.length, coverage });
  }

  const classifications = new Map();
  for (const item of posts) {
    const decision = await cachedDecision(classDir, item, () => classifyImpl(item), previousClassificationsDir);
    classifications.set(item.externalId, decision);
  }

  const groupsByAuthor = new Map();
  const groups = new Map();
  const organized = [];
  for (const item of posts) {
    const decision = classifications.get(item.externalId);
    const authorKey = item.metrics?.authorId || item.author || `unknown:${item.externalId}`;
    const authorGroups = groupsByAuthor.get(authorKey) || [];
    const candidates = authorGroups.filter((group) => group.topic === decision.topic);
    const grouping = await cachedDecision(groupDir, item, () => selectGroup(item, candidates, chooseGroupImpl));
    let group = grouping.groupId ? groups.get(grouping.groupId) : null;
    if (grouping.groupId && !group) throw new Error("TypeSafe 指向了不存在的主题组");
    if (!group) {
      group = {
        id: item.externalId,
        title: item.title.slice(0, 100),
        authorId: authorKey,
        author: item.author,
        topic: decision.topic,
        representative: item.content,
        postIds: [],
      };
      groups.set(group.id, group);
      authorGroups.push(group);
      groupsByAuthor.set(authorKey, authorGroups);
    }
    group.postIds.push(item.externalId);
    organized.push({
      ...item,
      organization: {
        assetType: decision.assetType,
        topic: decision.topic,
        groupId: group.id,
        groupTitle: group.title,
        assetConfidence: decision.asset.confidence,
        topicConfidence: decision.topicAnswer.confidence,
        sameTopicConfidence: grouping.answer?.confidence ?? null,
        coverage,
        contentIncomplete: Boolean(item.metrics?.uiTextTruncated ||
          item.metrics?.status === "unavailable" || !item.content),
        typeSafe: {
          model: decision.model,
          asset: decision.asset,
          topic: decision.topicAnswer,
          sameTopic: grouping.answer,
        },
      },
    });
  }

  const review = organized.filter((item) => item.organization.contentIncomplete ||
    item.organization.assetType === "unknown" ||
    item.organization.assetConfidence < 0.5 || item.organization.topicConfidence < 0.5);
  const summary = {
    sourceHash,
    coverage,
    posts: organized.length,
    groups: groups.size,
    withMedia: organized.filter((item) => item.media.length).length,
    mediaCount: organized.reduce((total, item) => total + item.media.length, 0),
    textTruncated: organized.filter((item) => item.organization.contentIncomplete).length,
    needsReview: review.length,
    assetTypes: Object.fromEntries([...new Set(organized.map((item) => item.organization.assetType))]
      .map((kind) => [kind, organized.filter((item) => item.organization.assetType === kind).length])),
    completedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(outDir, "bookmarks.organized.jsonl"),
    `${organized.map((item) => JSON.stringify(item)).join("\n")}\n`);
  await atomicWrite(path.join(outDir, "groups.json"), [...groups.values()].map(({ representative, ...group }) => group));
  await atomicWrite(path.join(outDir, "needs-review.jsonl"),
    review.map((item) => JSON.stringify({ id: item.externalId, url: item.url,
      assetType: item.organization.assetType, topic: item.organization.topic })).join("\n") + (review.length ? "\n" : ""));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  return summary;
}
