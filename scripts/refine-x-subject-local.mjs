import path from "node:path";
import { findUserByName, listInbox } from "../lib/db.js";
import { refineXSubjectGroup, X_GROUP_TAXONOMIES } from "../lib/x-group-refinement.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const taxonomyId = option("--taxonomy");
const outDir = option("--out");
const concurrency = Number(option("--concurrency") || 3);
const taxonomy = X_GROUP_TAXONOMIES[taxonomyId];
if (!username || !taxonomy || !path.isAbsolute(outDir) || !Number.isInteger(concurrency) ||
    concurrency < 1 || concurrency > 8) {
  console.error("用法: node scripts/refine-x-subject-local.mjs --username <账号> --taxonomy obsidian --out <绝对目录> [--concurrency 3]");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("OmniHub 账号不存在");
  const rows = listInbox(user.id, { status: "all", source: "x" });
  const result = await refineXSubjectGroup({ rows, taxonomy, outDir, concurrency });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
