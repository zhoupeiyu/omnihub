import { backup } from "node:sqlite";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrganizedXImport } from "../lib/x-bookmarks.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const sourceFile = option("--file");
const username = option("--username");
const account = option("--account");
const scanManifestFile = option("--scan-manifest");
const allowPartial = process.argv.includes("--allow-partial");
const dryRun = process.argv.includes("--dry-run");
if (!path.isAbsolute(sourceFile) || !username || (scanManifestFile && !path.isAbsolute(scanManifestFile))) {
  console.error("用法: node scripts/import-x-organized-local.mjs --file <整理后绝对路径> --username <OmniHub 账号> [--allow-partial --scan-manifest <绝对路径> --account <X 用户名>] [--dry-run]");
  process.exit(2);
}

try {
  const { items, coverage } = parseOrganizedXImport(await readFile(sourceFile, "utf8"), {
    allowPartial, maxBookmarks: 100000,
  });
  if (coverage === "partial_ui_scan") {
    if (!scanManifestFile || !account) throw new Error("部分采集入库需要快照清单和 X 账号");
    const manifest = JSON.parse(await readFile(scanManifestFile, "utf8"));
    if (manifest.coverage !== coverage || manifest.account !== account || manifest.observed !== items.length) {
      throw new Error("快照清单与导入批次的账号、范围或条数不一致");
    }
  } else if (coverage === "partial_xarchive_scan") {
    if (!scanManifestFile || !account) throw new Error("xarchive 部分快照入库需要快照清单和 X 账号");
    const manifest = JSON.parse(await readFile(scanManifestFile, "utf8"));
    if (manifest.coverage !== coverage || manifest.complete ||
      manifest.partialReason !== "pagination_guard" ||
      manifest.screenName?.toLowerCase() !== account.toLowerCase() ||
      manifest.uniquePosts !== items.length) {
      throw new Error("xarchive 快照清单与账号、范围或条数不一致");
    }
  }
  const summary = {
    username, coverage, posts: items.length,
    incomplete: items.filter((item) => item.aiExtract.xOrganization.contentIncomplete).length,
  };
  if (dryRun) {
    console.log(JSON.stringify({ ...summary, dryRun: true }));
    process.exit(0);
  }

  const { db, findUserByName, importInboxItems } = await import("../lib/db.js");
  const { hasFullAccess, normalizeInboxInput } = await import("../lib/api.js");
  const user = findUserByName(username);
  if (!user) throw new Error("目标 OmniHub 账号不存在，请先在网站登录或注册");
  if (!hasFullAccess(user)) throw new Error("目标账号没有收件箱权限，不能导入后却无法在网站查看");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(root, "data"));
  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupFile = path.join(backupDir, `app-before-x-import-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await backup(db, backupFile);
  await chmod(backupFile, 0o600);
  const result = importInboxItems(user.id, items.map(normalizeInboxInput));
  console.log(JSON.stringify({ ...summary, ...result, backupFile }));
  db.close();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
