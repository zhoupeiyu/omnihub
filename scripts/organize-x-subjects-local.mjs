import { backup } from "node:sqlite";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, findUserByName, listInbox, replaceInboxSubjectCollections } from "../lib/db.js";
import { buildXSubjectCollections, discoverXSubjectCandidates } from "../lib/x-subjects.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const username = option("--username");
const firstSubject = option("--first").toLowerCase();
const dryRun = process.argv.includes("--dry-run");
const maxSubjects = Number(option("--max-subjects") || 80);
if (!username || !Number.isInteger(maxSubjects) || maxSubjects < 1 || maxSubjects > 200) {
  console.error("用法: node scripts/organize-x-subjects-local.mjs --username <本地账号> [--max-subjects 80] [--first jev] [--dry-run]");
  process.exit(2);
}

try {
  const user = findUserByName(username);
  if (!user) throw new Error("本地账号不存在");
  const rows = listInbox(user.id, { status: "all" }).filter((row) => row.source === "x");
  const posts = rows.map((row) => ({
    source: "x", externalId: row.externalId, title: row.title,
    content: row.content, author: row.author,
  }));
  const candidates = discoverXSubjectCandidates(posts, { maxSubjects });
  if (firstSubject) {
    const index = candidates.findIndex((candidate) => candidate.id === firstSubject);
    if (index < 0) throw new Error("指定的主题没有达到候选条件");
    candidates.unshift(...candidates.splice(index, 1));
  }
  if (dryRun) {
    console.log(JSON.stringify({ posts: posts.length, candidates: candidates.map(({ id, posts: members }) =>
      ({ id, count: members.length })) }));
    process.exit(0);
  }

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(root, "data"));
  const subjectDir = path.join(dataDir, "x-subjects");
  await mkdir(subjectDir, { recursive: true, mode: 0o700 });
  const collections = await buildXSubjectCollections(candidates, {
    cacheDir: path.join(subjectDir, "decisions"),
  });
  const manifest = path.join(subjectDir, "collections.json");
  const temp = manifest + ".tmp-" + process.pid;
  await writeFile(temp, JSON.stringify({ account: username, sourcePosts: posts.length,
    candidates: candidates.length, collections, completedAt: new Date().toISOString() }) + "\n",
  { mode: 0o600, flag: "wx" });
  await rename(temp, manifest);

  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupFile = path.join(backupDir, "app-before-x-subjects-" +
    new Date().toISOString().replace(/[:.]/g, "-") + ".db");
  await backup(db, backupFile);
  await chmod(backupFile, 0o600);
  const result = replaceInboxSubjectCollections(user.id, collections);
  const after = db.prepare("SELECT count(*) AS total FROM inbox_subjects WHERE user_id = ?").get(user.id).total;
  if (after !== result.memberships) throw new Error("合集入库后回读条数不符");
  console.log(JSON.stringify({ posts: posts.length, candidates: candidates.length,
    ...result, verifiedMemberships: after, manifest, backupFile,
    jev: collections.find((collection) => collection.id === "jev")?.members.length || 0 }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
