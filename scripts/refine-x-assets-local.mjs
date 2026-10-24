import path from "node:path";
import { findUserByName, listInbox } from "../lib/db.js";
import { refineXAssetSample } from "../lib/x-asset-refinement.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const outDir = option("--out");
const all = process.argv.includes("--all");
const sampleSize = all ? 0 : Number(option("--sample-size") || 100);
const concurrency = Number(option("--concurrency") || 3);

if (!username || !path.isAbsolute(outDir) || !Number.isInteger(sampleSize) || sampleSize < 0 ||
    sampleSize > 2000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  console.error("用法: node scripts/refine-x-assets-local.mjs --username <账号> --out <绝对目录> [--sample-size 100 | --all] [--concurrency 3]");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("OmniHub 账号不存在");
  const rows = listInbox(user.id, { status: "all", source: "x" });
  const result = await refineXAssetSample({ rows, outDir, sampleSize, concurrency });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
