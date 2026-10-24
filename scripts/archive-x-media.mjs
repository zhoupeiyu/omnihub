import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseXBookmarksExport } from "../lib/x-bookmarks.js";
import { archiveXMedia } from "../lib/x-media-archive.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const organizedFile = option("--organized");
const outDir = option("--out");
if (![organizedFile, outDir].every((value) => value && path.isAbsolute(value))) {
  console.error("用法: node scripts/archive-x-media.mjs --organized <整理后 JSONL> --out <绝对目录>");
  process.exit(2);
}

try {
  const posts = parseXBookmarksExport(await readFile(organizedFile, "utf8"), { maxBookmarks: 100000 });
  const result = await archiveXMedia({ posts, outDir });
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 3;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
