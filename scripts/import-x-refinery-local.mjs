import { readFile } from "node:fs/promises";
import path from "node:path";
import { findUserByName } from "../lib/db.js";
import {
  replaceAssetFacets,
  replacePromptRefinements,
  replaceRepositoryAssets,
  upsertKnowledgeArticle,
} from "../lib/knowledge-store.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

async function readJsonl(file) {
  if (!file) return [];
  const body = await readFile(file, "utf8");
  return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const username = option("--username") || "zane";
const repositoriesFile = option("--repositories") || path.join(root, "data/x-refinement/github-v1/repositories.jsonl");
const promptsFile = option("--prompts") || path.join(root, "data/x-refinement/prompts-v2/prompts.refined.jsonl");
const assetsFile = option("--assets");
const knowledgeFile = option("--knowledge") || path.join(root, "data/x-refinement/subjects/obsidian-v1/knowledge-draft.md");
const claimsFile = option("--claims") || path.join(root, "data/x-refinement/subjects/obsidian-v1/citation-verification/checks.jsonl");
const subjectId = option("--subject") || "obsidian-ai-context-memory";
const tags = (option("--tags") || "Obsidian,AI Agent,上下文,长期记忆")
  .split(",").map((tag) => tag.trim()).filter(Boolean);

try {
  for (const file of [repositoriesFile, promptsFile, knowledgeFile, claimsFile, ...(assetsFile ? [assetsFile] : [])]) {
    if (!path.isAbsolute(file)) throw new Error(`炼化产物路径必须是绝对路径: ${file}`);
  }
  const user = findUserByName(username);
  if (!user) throw new Error("OmniHub 账号不存在");
  const [repositories, prompts, assets, markdown, claims] = await Promise.all([
    readJsonl(repositoriesFile),
    readJsonl(promptsFile),
    readJsonl(assetsFile),
    readFile(knowledgeFile, "utf8"),
    readJsonl(claimsFile),
  ]);
  const result = {
    repositories: replaceRepositoryAssets(user.id, repositories),
    prompts: replacePromptRefinements(user.id, prompts),
    assets: assets.length ? replaceAssetFacets(user.id, assets) : { imported: 0 },
    knowledge: upsertKnowledgeArticle(user.id, {
      subjectId,
      markdown,
      tags,
      claims,
    }),
  };
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
