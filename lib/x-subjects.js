import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeXSubjectMembers } from "./typesafe.js";

// Generic formats, platforms, and ordinary words are not useful collection names.
const GENERIC = new Set(`
  about agents agent ai and app apps are best bot bots browser can chat chatgpt
  api any chrome cli code codex coding content context control course css
  design developer docs engineering english example for free from full
  git github google gpt gui guide harness have here how html image images
  introducing ios javascript json just key like llm loop mac macos markdown
  mcp meet model models native new node not now open openai pdf post posts
  pro prompt prompts python react setup skills skill source star stars step
  studio system team that the this tool tools top tutorial twitter use using
  vibe video web what when why with without workflow x you your
  apple windows reddit discord telegram token tokens
`.trim().split(/\s+/));

function titleTerms(value) {
  const matches = String(value || "").match(/\b[A-Za-z][A-Za-z0-9]{2,}(?:[-.][A-Za-z0-9]+)*\b/g) || [];
  return [...new Map(matches.map((term) => [term.toLowerCase(), term])).entries()];
}

/** Candidate retrieval is lexical; Jev decides which actual posts belong. */
export function discoverXSubjectCandidates(items, { minPosts = 3, maxSubjects = 80 } = {}) {
  const byTerm = new Map();
  for (const item of items) {
    if (item.source !== "x") continue;
    for (const [key, title] of titleTerms(item.title)) {
      if (GENERIC.has(key) || key.length > 40 || /^\d/.test(key)) continue;
      if (!byTerm.has(key)) byTerm.set(key, { id: key, title, posts: [] });
      byTerm.get(key).posts.push(item);
    }
  }
  return [...byTerm.values()]
    .filter((entry) => entry.posts.length >= minPosts && entry.posts.length <= 60)
    .sort((a, b) => b.posts.length - a.posts.length || a.id.localeCompare(b.id))
    .slice(0, maxSubjects);
}

function fingerprint(candidate) {
  return createHash("sha256").update(JSON.stringify({
    title: candidate.title,
    posts: candidate.posts.map(({ externalId, title, content }) => [externalId, title, content]),
  })).digest("hex");
}

/** A collection is a reading view; every original post remains independent. */
export async function buildXSubjectCollections(candidates, {
  cacheDir, judgeImpl = judgeXSubjectMembers,
} = {}) {
  if (!cacheDir) throw new Error("缺少合集判断缓存目录");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const collections = [];
  for (const candidate of candidates) {
    const hash = fingerprint(candidate);
    const file = path.join(cacheDir, candidate.id + ".json");
    let decisions;
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      if (cached.fingerprint === hash) decisions = cached.decisions;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!decisions) {
      decisions = [];
      for (let index = 0; index < candidate.posts.length; index += 12) {
        decisions.push(...await judgeImpl(candidate.title, candidate.posts.slice(index, index + 12)));
      }
      if (decisions.length !== candidate.posts.length) throw new Error("TypeSafe 合集判断条数不匹配");
      const temp = file + ".tmp-" + process.pid;
      await writeFile(temp, JSON.stringify({ fingerprint: hash, decisions }) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    }
    const members = candidate.posts.flatMap((post, index) => decisions[index]?.included
      ? [{ externalId: post.externalId, confidence: decisions[index].confidence,
        relationship: decisions[index].relationship, model: decisions[index].model }] : []);
    if (members.length >= 2 && new Set(candidate.posts.filter((post, index) => decisions[index]?.included)
      .map((post) => post.author)).size >= 2) {
      collections.push({ id: candidate.id, title: candidate.title, members });
    }
  }
  const unique = new Map();
  for (const collection of collections) {
    const memberKey = collection.members.map((member) => member.externalId).sort().join(",");
    const existing = unique.get(memberKey);
    if (!existing) {
      unique.set(memberKey, collection);
      continue;
    }
    // Exact duplicate memberships often come from both words of a product name.
    const example = candidates.flatMap((candidate) => candidate.posts)
      .find((post) => collection.members.some((member) => member.externalId === post.externalId) &&
        new RegExp("\\b" + existing.id + "\\s+" + collection.id + "\\b", "i").test(post.title));
    const reverse = candidates.flatMap((candidate) => candidate.posts)
      .find((post) => collection.members.some((member) => member.externalId === post.externalId) &&
        new RegExp("\\b" + collection.id + "\\s+" + existing.id + "\\b", "i").test(post.title));
    const phrase = example ? existing.title + " " + collection.title
      : reverse ? collection.title + " " + existing.title : "";
    if (phrase) {
      existing.id = phrase.toLowerCase().replace(/\s+/g, "-");
      existing.title = phrase;
    } else unique.set(memberKey + ":" + collection.id, collection);
  }
  return [...unique.values()];
}
