import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, findUserByName } from "../lib/db.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
const username = option("--username");
const outputPath = option("--out");
if (!username || !outputPath || username.startsWith("--") || outputPath.startsWith("--")) {
  console.error("用法: node scripts/export-x-visibility-review.mjs --username <账号> --out <绝对路径.md>");
  process.exit(2);
}
if (!path.isAbsolute(outputPath) || path.extname(outputPath) !== ".md") {
  throw new Error("输出路径必须是绝对路径，扩展名为 .md");
}
const user = findUserByName(username);
if (!user) throw new Error("账号不存在");

const rows = db.prepare(`
  SELECT id, source, external_id AS externalId, title, url, author, content, media, links, metrics,
    ai_type AS aiType, ai_summary AS aiSummary, ai_extract AS aiExtract, status, visibility
  FROM inbox WHERE user_id = ? AND source = 'x' ORDER BY id DESC
`).all(user.id);
const active = rows.filter((row) => row.status === "pending");
const archived = rows.filter((row) => row.status !== "pending");

const labels = {
  software: "开发与 AI", video: "视频与短剧", crypto: "加密领域", product: "产品设计",
  workflow: "效率方法", business: "商业", image: "图像创作", other: "其他",
};
function topic(row) {
  try { return JSON.parse(row.aiExtract || "{}").xOrganization?.topic || "other"; }
  catch { return "other"; }
}
function markdown(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
    .replace(/\\/g, "\\\\").replace(/([\[\]()*_`~|])/g, "\\$1")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sourceLink(row) {
  try {
    const url = new URL(row.url);
    if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) return "";
    const match = url.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/);
    return match?.[1] === String(row.externalId) ? `https://x.com${url.pathname.replace(/\/$/, "")}` : "";
  } catch { return ""; }
}
function line(row, reviewable) {
  const title = markdown(row.title) || "（无标题）";
  const link = sourceLink(row);
  const label = link ? `[${title}](${link})` : title;
  const author = row.author ? ` · ${markdown(row.author)}` : "";
  return `${reviewable ? `- [${row.visibility !== "public" ? "x" : " "}]` : "-"} #${row.id} ${label}${author}`;
}
const lines = [
  "# X 收藏标题筛选清单",
  "",
  `当前可浏览 ${active.length} 条，已归档 ${archived.length} 条，合计 ${rows.length} 条。`,
  "",
  `勾选框反映当前仅 ${username} 可见的设置，未勾选表示已公开。原帖链接可用来查看图片；如需再次调整，修改勾选并保留每行的 #编号。`,
  "",
  "以下仅列标题、作者和原帖链接，不复制正文或图片。已归档记录不在当前列表，也不会公开，集中列在文末。",
  "",
];
const groups = new Map();
for (const row of active) {
  const key = topic(row);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
for (const key of Object.keys(labels)) {
  const items = groups.get(key) || [];
  if (!items.length) continue;
  lines.push(`## ${labels[key]}（${items.length}）`, "");
  for (const row of items) lines.push(line(row, true));
  lines.push("");
}
for (const [key, items] of groups) {
  if (key in labels) continue;
  lines.push(`## ${markdown(key)}（${items.length}）`, "");
  for (const row of items) lines.push(line(row, true));
  lines.push("");
}
lines.push(`## 已归档（${archived.length}）`, "", "这些记录不参与公开筛选。", "");
for (const row of archived) lines.push(line(row, false));
lines.push("");

const outputDir = path.dirname(outputPath);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
chmodSync(outputDir, 0o700);
const tempPath = `${outputPath}.tmp-${process.pid}`;
writeFileSync(tempPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
renameSync(tempPath, outputPath);
chmodSync(outputPath, 0o600);
console.log(JSON.stringify({ path: outputPath, active: active.length, archived: archived.length,
  ownerOnly: active.filter((row) => row.visibility !== "public").length }));
