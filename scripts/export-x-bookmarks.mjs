import { execFileSync } from "node:child_process";
import { exportXBookmarks } from "../lib/x-export.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const userId = option("--user-id");
const maxUsd = Number(option("--max-usd"));
const outDir = option("--out");
const app = option("--app") || "x-bookmarks";
const resume = process.argv.includes("--resume");
if (!userId || !maxUsd || !outDir) {
  console.error("用法: node scripts/export-x-bookmarks.mjs --user-id <X ID> --max-usd <上限> --out <绝对目录> [--app <Xurl 应用>] [--resume]");
  process.exit(2);
}

try {
  const token = execFileSync("xurl", ["token", "--app", app],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const result = await exportXBookmarks({ userId, maxUsd, outDir, token, resume });
  console.log(JSON.stringify(result));
  if (!result.complete) process.exitCode = 3;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
