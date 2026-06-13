/// 数据库层 —— 使用 Node 内置 SQLite（node:sqlite），零依赖
/// 表：users / sessions / favorites / prompts / ai_config
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT_DIR, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '常用',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '写作',
    image TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS ai_config (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT ''
  );
`);

/** 提示词表 v2 迁移：补充灵感库字段（已执行过则跳过） */
function runMigrations() {
  const done = db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("prompts_v2");
  if (done) return;
  db.exec(`
    ALTER TABLE prompts ADD COLUMN negative_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN model TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN tags TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN sns_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN sns_url_normalized TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN sns_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN note TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN success_notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN failure_notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN repro_tips TEXT NOT NULL DEFAULT '';
    ALTER TABLE prompts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE prompts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE prompts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
    INSERT INTO schema_migrations (name) VALUES ('prompts_v2');
  `);
}
runMigrations();

/** 新注册用户的演示数据，让首页不至于空空荡荡 */
const SEED_FAVORITES = [
  { name: "哔哩哔哩", url: "https://www.bilibili.com", desc: "年轻人的视频社区，学习娱乐都在这", category: "娱乐" },
  { name: "知乎", url: "https://www.zhihu.com", desc: "有问题，就会有答案", category: "常用" },
  { name: "GitHub", url: "https://github.com", desc: "全球最大的开源代码托管平台", category: "开发" },
  { name: "百度", url: "https://www.baidu.com", desc: "中文搜索引擎", category: "常用" },
  { name: "中国大学 MOOC", url: "https://www.icourse163.org", desc: "名校公开课，免费在线学习", category: "学习" },
  { name: "掘金", url: "https://juejin.cn", desc: "开发者技术内容分享社区", category: "开发" },
];

const SEED_PROMPTS = [
  {
    title: "周报润色助手",
    text: "你是一名资深职场写作教练。请把我粘贴的流水账周报改写成结构化周报：1) 本周成果（量化）2) 进行中事项与风险 3) 下周计划。语气专业简洁，每条不超过两行，保留事实不要编造。",
    category: "写作", image: "",
  },
  {
    title: "代码审查助手",
    text: "请作为严格的代码审查者检查下面的代码：指出潜在 bug、性能问题、命名与可读性问题，按严重程度排序；每个问题给出修改建议和示例代码；最后总结 3 条最值得先改的点。",
    category: "编程", image: "",
  },
  {
    title: "费曼学习法讲解",
    text: "请用费曼学习法向一个初中生解释「{概念}」：先用一个生活类比开场，再分三步讲清原理，每步配一个例子，最后出 3 道由浅入深的小测验并附答案。",
    category: "学习", image: "",
  },
];

/** 创建用户并写入演示数据，返回新用户 id */
export function createUser({ username, passwordHash, salt }) {
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)"
  ).run(username, passwordHash, salt);
  const userId = Number(result.lastInsertRowid);

  const insertFav = db.prepare(
    "INSERT INTO favorites (user_id, name, url, desc, category) VALUES (?, ?, ?, ?, ?)"
  );
  for (const f of SEED_FAVORITES) insertFav.run(userId, f.name, f.url, f.desc, f.category);

  const insertPrompt = db.prepare(
    "INSERT INTO prompts (user_id, title, text, category, image) VALUES (?, ?, ?, ?, ?)"
  );
  for (const p of SEED_PROMPTS) insertPrompt.run(userId, p.title, p.text, p.category, p.image);

  return userId;
}

export function findUserByName(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function findUserById(id) {
  return db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(id);
}

/* ---------- 收藏 ---------- */
export function listFavorites(userId) {
  return db.prepare("SELECT id, name, url, desc, category FROM favorites WHERE user_id = ? ORDER BY id").all(userId);
}
export function addFavorite(userId, { name, url, desc, category }) {
  const result = db.prepare(
    "INSERT INTO favorites (user_id, name, url, desc, category) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, name, url, desc || "", category);
  return Number(result.lastInsertRowid);
}
export function updateFavorite(userId, id, { name, url, desc, category }) {
  return db.prepare(
    "UPDATE favorites SET name = ?, url = ?, desc = ?, category = ? WHERE id = ? AND user_id = ?"
  ).run(name, url, desc || "", category, id, userId).changes > 0;
}
export function deleteFavorite(userId, id) {
  return db.prepare("DELETE FROM favorites WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/* ---------- 提示词（灵感库） ---------- */
const PROMPT_COLUMNS = `
  id, title, text, category, image,
  negative_text AS negativeText, model, tags,
  sns_url AS snsUrl, sns_url_normalized AS snsUrlNormalized, sns_type AS snsType,
  note, success_notes AS successNotes, failure_notes AS failureNotes, repro_tips AS reproTips,
  favorite, archived, created_at AS createdAt, updated_at AS updatedAt
`;

/** 可由前端编辑的字段 → 数据库列名映射 */
const PROMPT_EDITABLE = {
  title: "title", text: "text", category: "category", image: "image",
  negativeText: "negative_text", model: "model", tags: "tags",
  snsUrl: "sns_url", snsUrlNormalized: "sns_url_normalized", snsType: "sns_type",
  note: "note", successNotes: "success_notes", failureNotes: "failure_notes", reproTips: "repro_tips",
  favorite: "favorite", archived: "archived",
};

export function listPrompts(userId) {
  return db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompts WHERE user_id = ? ORDER BY favorite DESC, id DESC`).all(userId);
}

export function addPrompt(userId, data) {
  const result = db.prepare(`
    INSERT INTO prompts (user_id, title, text, category, image,
      negative_text, model, tags, sns_url, sns_url_normalized, sns_type,
      note, success_notes, failure_notes, repro_tips, favorite, archived, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(
    userId, data.title, data.text, data.category || "其他", data.image || "",
    data.negativeText || "", data.model || "", data.tags || "",
    data.snsUrl || "", data.snsUrlNormalized || "", data.snsType || "",
    data.note || "", data.successNotes || "", data.failureNotes || "", data.reproTips || "",
    data.favorite ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}

/** 部分更新：只改传入的字段，返回是否命中记录 */
export function updatePrompt(userId, id, patch) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(PROMPT_EDITABLE)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    const value = (key === "favorite" || key === "archived") ? (patch[key] ? 1 : 0) : patch[key];
    values.push(value);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id, userId);
  return db.prepare(`UPDATE prompts SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...values).changes > 0;
}

export function deletePrompt(userId, id) {
  return db.prepare("DELETE FROM prompts WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/* ---------- AI 配置 ---------- */
export function getAiConfig(userId) {
  return db.prepare("SELECT base_url, api_key, model FROM ai_config WHERE user_id = ?").get(userId);
}
export function saveAiConfig(userId, { baseUrl, apiKey, model }) {
  db.prepare(`
    INSERT INTO ai_config (user_id, base_url, api_key, model) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model
  `).run(userId, baseUrl, apiKey, model);
}
