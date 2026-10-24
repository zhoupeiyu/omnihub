import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseXBookmarksExport } from "../lib/x-bookmarks.js";
import { convertXUiScan } from "../lib/x-ui-scan.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const scanFile = option("--scan");
const historicalFile = option("--historical");
const outDir = option("--out");
const expectedAccount = option("--account");
if (![scanFile, historicalFile, outDir].every((value) => value && path.isAbsolute(value)) || !expectedAccount) {
  console.error("用法: node scripts/convert-x-ui-scan.mjs --scan <页面快照 JSON> --historical <旧 raw.jsonl> --account <X 用户名> --out <新绝对目录>");
  process.exit(2);
}

try {
  const scanText = await readFile(scanFile, "utf8");
  const scan = JSON.parse(scanText);
  const historical = parseXBookmarksExport(await readFile(historicalFile, "utf8"), { maxBookmarks: 100000 });
  const converted = convertXUiScan(scan, historical, { expectedAccount });
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  const raw = `${converted.posts.map((post) => JSON.stringify(post)).join("\n")}\n`;
  await writeFile(path.join(outDir, "bookmarks.raw.jsonl"), raw, { mode: 0o600, flag: "wx" });
  await writeFile(path.join(outDir, "scan-manifest.json"), `${JSON.stringify({
    ...converted.summary,
    sourceHash: createHash("sha256").update(scanText).digest("hex"),
    historicalOnlyIds: converted.historicalOnly.map((post) => post.externalId),
  })}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ outDir, ...converted.summary }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
