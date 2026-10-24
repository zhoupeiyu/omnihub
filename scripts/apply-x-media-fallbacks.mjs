import { backup } from "node:sqlite";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const manifestFile = option("--manifest");
const username = option("--username");
const dryRun = process.argv.includes("--dry-run");
if (!path.isAbsolute(manifestFile) || !username) {
  console.error("用法: node scripts/apply-x-media-fallbacks.mjs --manifest <媒体清单绝对路径> --username <OmniHub 账号> [--dry-run]");
  process.exit(2);
}

function validFallback(entry) {
  if (entry.status !== "saved" || !entry.downloadUrl || entry.downloadUrl === entry.url) return false;
  const original = new URL(entry.url);
  const downloaded = new URL(entry.downloadUrl);
  if (original.protocol !== "https:" || original.hostname !== "pbs.twimg.com" ||
    downloaded.protocol !== "https:" || downloaded.hostname !== original.hostname ||
    downloaded.pathname !== original.pathname ||
    original.searchParams.get("name") !== "orig" || downloaded.searchParams.get("name") !== "large") {
    throw new Error("媒体清单包含无效的图片规格回退");
  }
  original.searchParams.set("name", "large");
  if (original.toString() !== downloaded.toString()) throw new Error("媒体回退修改了图片地址的其他参数");
  return true;
}

try {
  const records = JSON.parse(await readFile(manifestFile, "utf8"));
  const fallbacksByPost = new Map();
  for (const entry of Object.values(records)) {
    if (!validFallback(entry)) continue;
    const rows = fallbacksByPost.get(String(entry.postId)) || [];
    rows.push(entry);
    fallbacksByPost.set(String(entry.postId), rows);
  }
  const { db, findUserByName } = await import("../lib/db.js");
  const { hasFullAccess } = await import("../lib/api.js");
  const user = findUserByName(username);
  if (!user || !hasFullAccess(user)) throw new Error("目标账号不存在或没有收件箱权限");
  const query = db.prepare("SELECT id, media FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?");
  const changes = [];
  let mediaCount = 0;
  for (const [postId, fallbacks] of fallbacksByPost) {
    const row = query.get(user.id, postId);
    if (!row) throw new Error(`站内缺少媒体所属帖子 ${postId}`);
    const media = JSON.parse(row.media || "[]");
    for (const entry of fallbacks) {
      const item = media.find((value) => value.type === "photo" && value.url === entry.url);
      if (item) {
        item.original_url = item.url;
        item.url = entry.downloadUrl;
        mediaCount++;
      } else if (!media.some((value) => value.type === "photo" &&
        value.original_url === entry.url && value.url === entry.downloadUrl)) {
        throw new Error(`站内媒体与快照不匹配：${postId}`);
      }
    }
    if (media.some((value) => value.original_url)) changes.push({ id: row.id, media: JSON.stringify(media) });
  }
  if (dryRun || !mediaCount) {
    console.log(JSON.stringify({ username, posts: changes.length, media: mediaCount, dryRun }));
    db.close();
    process.exit(0);
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(root, "data"));
  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupFile = path.join(backupDir, `app-before-x-media-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await backup(db, backupFile);
  await chmod(backupFile, 0o600);
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE inbox SET media = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?");
    for (const row of changes) update.run(row.media, row.id, user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ username, posts: changes.length, media: mediaCount, backupFile }));
  db.close();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
