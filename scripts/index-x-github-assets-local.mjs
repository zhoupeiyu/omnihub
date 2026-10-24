import path from "node:path";
import { findUserByName, listInbox } from "../lib/db.js";
import { atomicWrite, jsonl } from "../lib/x-refinement-common.js";
import { extractXGitHubAssets, summarizeXGitHubAssets } from "../lib/x-github-assets.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const outDir = option("--out");
if (!username || !path.isAbsolute(outDir)) {
  console.error("用法: node scripts/index-x-github-assets-local.mjs --username <账号> --out <绝对目录>");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("OmniHub 账号不存在");
  const rows = listInbox(user.id, { status: "all", source: "x" });
  const assets = extractXGitHubAssets(rows);
  const summary = { ...summarizeXGitHubAssets(assets), completedAt: new Date().toISOString() };
  await atomicWrite(path.join(outDir, "repositories.jsonl"), jsonl(assets));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
