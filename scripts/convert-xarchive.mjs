import { saveXarchiveSnapshot } from "../lib/xarchive-import.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const archiveFile = option("--archive");
const expectedUserId = option("--user-id");
const outDir = option("--out");
const allowPartial = process.argv.includes("--allow-partial");
if (!archiveFile || !expectedUserId || !outDir) {
  console.error("用法: node scripts/convert-xarchive.mjs --archive <latest snapshot JSON> --user-id <X ID> --out <新的绝对目录> [--allow-partial]");
  process.exit(2);
}

try {
  console.log(JSON.stringify(await saveXarchiveSnapshot({ archiveFile, expectedUserId, outDir, allowPartial })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
