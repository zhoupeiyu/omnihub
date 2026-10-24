import { backup } from "node:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, findUserByName } from "../lib/db.js";
import { applyXDigests, digestInputFromRow } from "../lib/x-digest-store.js";
import { digestXBookmark } from "../lib/x-digest.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const dryRun = process.argv.includes("--dry-run");
if (!username) {
  console.error("用法: node scripts/summarize-x-bookmarks-local.mjs --username <本地账号> [--dry-run]");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("本地账号不存在");
  const rows = db.prepare(`
    SELECT id, title, content, media, links, ai_type AS aiType,
      ai_summary AS aiSummary, ai_extract AS aiExtract
    FROM inbox WHERE user_id = ? AND source = 'x' ORDER BY id DESC
  `).all(user.id);
  if (dryRun) {
    const counts = { total: rows.length, summaries: 0, reasons: 0, partial: 0, needsSource: 0 };
    const samples = [];
    for (const row of rows) {
      const digest = digestXBookmark(digestInputFromRow(row));
      if (digest.summary) counts.summaries += 1;
      if (digest.reason) counts.reasons += 1;
      if (digest.status === "partial_excerpt") counts.partial += 1;
      if (digest.status === "needs_source") counts.needsSource += 1;
      if (samples.length < 8 && (digest.reason || digest.status === "needs_source")) {
        samples.push({ id: row.id, title: row.title.slice(0, 48),
          summary: digest.summary.slice(0, 120), reason: digest.reason, status: digest.status });
      }
    }
    console.log(JSON.stringify({ ...counts, samples }, null, 2));
  } else {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const dataDir = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(root, "data"));
    const backupDir = path.join(dataDir, "backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupFile = path.join(backupDir, "app-before-x-digests-" +
      new Date().toISOString().replace(/[:.]/g, "-") + ".db");
    await backup(db, backupFile);
    await chmod(backupFile, 0o600);
    const result = applyXDigests(db, user.id);
    const verified = db.prepare(`
      SELECT count(*) AS total,
        sum(CASE WHEN ai_summary <> '' THEN 1 ELSE 0 END) AS summaries,
        sum(CASE WHEN json_extract(ai_extract, '$.xDigest.reason') <> '' THEN 1 ELSE 0 END) AS reasons,
        sum(CASE WHEN json_extract(ai_extract, '$.xDigest.status') = 'needs_source' THEN 1 ELSE 0 END) AS needsSource
      FROM inbox WHERE user_id = ? AND source = 'x'
    `).get(user.id);
    if (verified.total !== result.total || verified.summaries < result.summaries ||
        verified.reasons < result.reasons || verified.needsSource !== result.needsSource) {
      throw new Error("X 提要入库回读不一致，请检查备份和数据库");
    }
    console.log(JSON.stringify({ ...result, verified, backupFile }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
