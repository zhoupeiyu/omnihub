import { db, findUserByName } from "../lib/db.js";
import { isSafePublicXBookmark } from "../lib/x-visibility.js";

const usernameIndex = process.argv.indexOf("--username");
const username = usernameIndex >= 0 ? process.argv[usernameIndex + 1] : "";
const apply = process.argv.includes("--apply");
if (!username || username.startsWith("--")) {
  console.error("用法: node scripts/review-existing-x-visibility.mjs --username <账号> [--apply]");
  process.exit(2);
}
const user = findUserByName(username);
if (!user) throw new Error("账号不存在");

const rows = db.prepare(`
  SELECT id, source, status, visibility, title, url, author, content, media, links, metrics,
    ai_type AS aiType, ai_summary AS aiSummary, ai_extract AS aiExtract FROM inbox
  WHERE user_id = ? AND source = 'x' AND status = 'pending' AND visibility = 'unreviewed'
`).all(user.id);
const publicIds = rows.filter(isSafePublicXBookmark).map((row) => row.id);
let changed = 0;
if (apply) {
  const update = db.prepare(`
    UPDATE inbox SET visibility = 'public', updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND source = 'x' AND status = 'pending' AND visibility = 'unreviewed'
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of publicIds) changed += update.run(id, user.id).changes;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
console.log(JSON.stringify({ scanned: rows.length, publicCandidates: publicIds.length,
  ownerOnly: rows.length - publicIds.length, changed, dryRun: !apply }));
