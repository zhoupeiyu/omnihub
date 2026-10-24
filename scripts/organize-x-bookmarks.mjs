import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseXBookmarksExport } from "../lib/x-bookmarks.js";
import { organizeXBookmarks } from "../lib/x-organization.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const rawFile = option("--raw");
const outDir = option("--out");
const previousFile = option("--previous");
const reuseClassifications = option("--reuse-classifications");
const snapshot = process.argv.includes("--snapshot");
const coverage = option("--coverage") || (snapshot ? "historical_snapshot" : "complete");
if (![rawFile, outDir].every((value) => value && path.isAbsolute(value)) ||
  (reuseClassifications && !path.isAbsolute(reuseClassifications))) {
  console.error("用法: node scripts/organize-x-bookmarks.mjs --raw <raw.jsonl> --out <绝对目录> [--previous <旧 raw.jsonl>] [--reuse-classifications <旧 classifications 绝对目录>] [--snapshot | --coverage partial_ui_scan|partial_xarchive_scan]");
  process.exit(2);
}

try {
  const raw = await readFile(rawFile, "utf8");
  const exportManifest = ["complete", "partial_xarchive_scan"].includes(coverage)
    ? JSON.parse(await readFile(path.join(path.dirname(rawFile), "manifest.json"), "utf8")) : null;
  if (coverage === "complete" && !exportManifest.complete) throw new Error("X 导出尚未完成，不能开始全量分类");
  if (coverage === "partial_xarchive_scan" &&
    (exportManifest.coverage !== coverage || exportManifest.complete ||
      exportManifest.partialReason !== "pagination_guard")) {
    throw new Error("xarchive 部分快照清单不匹配");
  }
  const scanManifest = coverage === "partial_ui_scan"
    ? JSON.parse(await readFile(path.join(path.dirname(rawFile), "scan-manifest.json"), "utf8")) : null;
  if (scanManifest && scanManifest.coverage !== coverage) throw new Error("页面快照标记不匹配");
  let posts = parseXBookmarksExport(raw, { maxBookmarks: 100000 });
  if (exportManifest && exportManifest.uniquePosts !== posts.length) throw new Error("导出数量与源文件不一致");
  if (scanManifest && scanManifest.observed !== posts.length) throw new Error("页面快照数量与源文件不一致");
  if (previousFile) {
    const previous = new Map(parseXBookmarksExport(await readFile(previousFile, "utf8"),
      { maxBookmarks: 100000 }).map((item) => [item.externalId, item]));
    posts = posts.map((item) => {
      const old = previous.get(item.externalId);
      return !old ? item : {
        ...item,
        author: item.author || old.author,
        media: item.media.length ? item.media : old.media,
        links: item.links.length ? item.links : old.links,
      };
    });
  }
  const sourceHash = createHash("sha256").update(raw).digest("hex");
  const result = await organizeXBookmarks({ posts, outDir, sourceHash,
    coverage, previousClassificationsDir: reuseClassifications });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
