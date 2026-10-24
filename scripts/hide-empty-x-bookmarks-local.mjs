import { backup } from "node:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveContentlessXInboxItems, db, findUserByName } from "../lib/db.js";
import { isContentlessXBookmark } from "../lib/x-content.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const dryRun = process.argv.includes("--dry-run");
if (!username) {
  console.error("用法: node scripts/hide-empty-x-bookmarks-local.mjs --username <本地账号> [--dry-run]");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("本地账号不存在");
  const rows = db.prepare(`
    SELECT source, content, media FROM inbox
    WHERE user_id = ? AND source = 'x' AND status = 'pending'
  `).all(user.id);
  const candidates = rows.filter(isContentlessXBookmark).length;
  if (dryRun || candidates === 0) {
    console.log(JSON.stringify({ pending: rows.length, candidates, dryRun }));
  } else {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const dataDir = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(root, "data"));
    const backupDir = path.join(dataDir, "backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupFile = path.join(backupDir, "app-before-hide-empty-x-" +
      new Date().toISOString().replace(/[:.]/g, "-") + ".db");
    await backup(db, backupFile);
    await chmod(backupFile, 0o600);
    const result = archiveContentlessXInboxItems(user.id);
    const pending = db.prepare(`
      SELECT count(*) AS count FROM inbox
      WHERE user_id = ? AND source = 'x' AND status = 'pending'
    `).get(user.id).count;
    const marked = db.prepare(`
      SELECT count(*) AS count FROM inbox
      WHERE user_id = ? AND source = 'x' AND status = 'ignored'
        AND json_extract(ai_extract, '$.xOmission.reason') = 'no_readable_content'
    `).get(user.id).count;
    if (result.archived !== candidates || pending !== rows.length - candidates || marked < candidates) {
      throw new Error("回读数量不一致，请检查数据库与备份");
    }
    console.log(JSON.stringify({ ...result, pending, marked, backupFile }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
