/// 数据库层 —— 使用 Node 内置 SQLite（node:sqlite），零依赖
/// 表：users / sessions / inbox / favorites / prompts / knowledge / ai_config
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isContentlessXBookmark } from "./x-content.js";
import { createContentStore } from './content-store.js';
import { compactInboxListRow, inboxSearchMatches } from './inbox-list.js';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.resolve(process.env.OMNIHUB_DATA_DIR || path.join(ROOT_DIR, "data"));
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
chmodSync(DATA_DIR, 0o700);

const DB_PATH = path.join(DATA_DIR, "app.db");
export const db = new DatabaseSync(DB_PATH);
chmodSync(DB_PATH, 0o600);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(table, column, definition) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

/** 兼容旧数据库的增量迁移。 */
function runMigrations() {
  ensureColumn("prompts", "negative_text", "negative_text TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "model", "model TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "tags", "tags TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "sns_url", "sns_url TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "sns_url_normalized", "sns_url_normalized TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "sns_type", "sns_type TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "note", "note TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "success_notes", "success_notes TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "failure_notes", "failure_notes TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "repro_tips", "repro_tips TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "favorite", "favorite INTEGER NOT NULL DEFAULT 0");
  ensureColumn("prompts", "archived", "archived INTEGER NOT NULL DEFAULT 0");
  ensureColumn("prompts", "updated_at", "updated_at TEXT NOT NULL DEFAULT ''");

  ensureColumn("favorites", "type", "type TEXT NOT NULL DEFAULT 'site'");
  ensureColumn("favorites", "tags", "tags TEXT NOT NULL DEFAULT ''");
  ensureColumn("favorites", "source_url", "source_url TEXT NOT NULL DEFAULT ''");
  ensureColumn("favorites", "note", "note TEXT NOT NULL DEFAULT ''");
  ensureColumn("favorites", "starred", "starred INTEGER NOT NULL DEFAULT 0");

  ensureColumn("prompts", "kind", "kind TEXT NOT NULL DEFAULT 'creative'");
  ensureColumn("prompts", "summary", "summary TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "prompt_text_raw", "prompt_text_raw TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "prompt_text_clean", "prompt_text_clean TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "variables", "variables TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("prompts", "media", "media TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("prompts", "source_url", "source_url TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "source_author", "source_author TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "source_content", "source_content TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompts", "status", "status TEXT NOT NULL DEFAULT 'untested'");
  ensureColumn("prompts", "rating", "rating INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      media TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '{}',
      ai_type TEXT NOT NULL DEFAULT '',
      ai_confidence REAL NOT NULL DEFAULT 0,
      ai_summary TEXT NOT NULL DEFAULT '',
      ai_extract TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      dispatched_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_source_id
      ON inbox(user_id, source, external_id) WHERE external_id <> '';

    CREATE TABLE IF NOT EXISTS inbox_subjects (
      user_id INTEGER NOT NULL REFERENCES users(id),
      inbox_id INTEGER NOT NULL REFERENCES inbox(id),
      subject_id TEXT NOT NULL,
      subject_title TEXT NOT NULL,
      confidence REAL NOT NULL,
      relationship TEXT NOT NULL,
      model TEXT NOT NULL,
      PRIMARY KEY (user_id, inbox_id, subject_id)
    );
    CREATE INDEX IF NOT EXISTS inbox_subjects_user ON inbox_subjects(user_id, subject_id);

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_author TEXT NOT NULL DEFAULT '',
      source_content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_config (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      base_url TEXT NOT NULL DEFAULT '',
      authentication TEXT NOT NULL DEFAULT '',
      sys_token TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      request_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      module TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      args TEXT NOT NULL,
      reference_asset_ids TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL DEFAULT '',
      source_id INTEGER,
      parent_asset_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitting',
      remote_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      result_url TEXT NOT NULL DEFAULT '',
      asset_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS media_jobs_user_time ON media_jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS media_jobs_status ON media_jobs(status);

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      job_id TEXT REFERENCES media_jobs(id),
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT '',
      source_id INTEGER,
      source_url TEXT NOT NULL DEFAULT '',
      prompt_id INTEGER,
      parent_asset_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS media_assets_user_time ON media_assets(user_id, created_at DESC);

    INSERT OR IGNORE INTO schema_migrations (name) VALUES ('prompts_v2');
    INSERT OR IGNORE INTO schema_migrations (name) VALUES ('second_brain_p1');
  `);
  ensureColumn("inbox", "visibility", "visibility TEXT NOT NULL DEFAULT 'unreviewed'");
  ensureColumn("prompts", "source_inbox_id", "source_inbox_id INTEGER REFERENCES inbox(id)");
  ensureColumn("prompts", "facet_data", "facet_data TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("knowledge", "status", "status TEXT NOT NULL DEFAULT 'draft'");
  ensureColumn("knowledge", "subject_id", "subject_id TEXT NOT NULL DEFAULT ''");
  ensureColumn("knowledge", "verification_status", "verification_status TEXT NOT NULL DEFAULT 'unverified'");
  ensureColumn("knowledge", "version", "version INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS prompts_source_inbox
      ON prompts(user_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_subject
      ON knowledge(user_id, subject_id) WHERE subject_id <> '';
  `);

  db.prepare(`
    UPDATE prompts SET prompt_text_raw = text
    WHERE prompt_text_raw = '' AND text <> ''
  `).run();
}
runMigrations();
// Every importer uses the same capture triggers, including future source adapters.
createContentStore(db);

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
const FAVORITE_COLUMNS = `
  id, name, url, desc, category, type, tags,
  source_url AS sourceUrl, note, starred,
  created_at AS createdAt
`;

export function listFavorites(userId) {
  return db.prepare(`SELECT ${FAVORITE_COLUMNS} FROM favorites WHERE user_id = ? ORDER BY starred DESC, id DESC`).all(userId);
}
export function getFavorite(userId, id) {
  return db.prepare(`SELECT ${FAVORITE_COLUMNS} FROM favorites WHERE id = ? AND user_id = ?`).get(id, userId);
}
export function addFavorite(userId, { name, url, desc, category, type, tags, sourceUrl, note, starred }) {
  const result = db.prepare(
    `INSERT INTO favorites
      (user_id, name, url, desc, category, type, tags, source_url, note, starred)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, name, url, desc || "", category || "常用", type || "site", tags || "",
    sourceUrl || "", note || "", starred ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}
export function updateFavorite(userId, id, { name, url, desc, category, type, tags, sourceUrl, note, starred }) {
  return db.prepare(
    `UPDATE favorites SET name = ?, url = ?, desc = ?, category = ?, type = ?, tags = ?,
      source_url = ?, note = ?, starred = ? WHERE id = ? AND user_id = ?`
  ).run(
    name, url, desc || "", category || "常用", type || "site", tags || "",
    sourceUrl || "", note || "", starred ? 1 : 0, id, userId,
  ).changes > 0;
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
  favorite, archived, kind, summary,
  prompt_text_raw AS promptTextRaw, prompt_text_clean AS promptTextClean,
  variables, media, source_url AS sourceUrl, source_author AS sourceAuthor,
  source_content AS sourceContent, status, rating,
  source_inbox_id AS sourceInboxId, facet_data AS facetData,
  created_at AS createdAt, updated_at AS updatedAt
`;

/** 可由前端编辑的字段 → 数据库列名映射 */
const PROMPT_EDITABLE = {
  title: "title", text: "text", category: "category", image: "image",
  negativeText: "negative_text", model: "model", tags: "tags",
  snsUrl: "sns_url", snsUrlNormalized: "sns_url_normalized", snsType: "sns_type",
  note: "note", successNotes: "success_notes", failureNotes: "failure_notes", reproTips: "repro_tips",
  favorite: "favorite", archived: "archived",
  kind: "kind", summary: "summary", promptTextRaw: "prompt_text_raw", promptTextClean: "prompt_text_clean",
  variables: "variables", media: "media", sourceUrl: "source_url", sourceAuthor: "source_author",
  sourceContent: "source_content", status: "status", rating: "rating", facetData: "facet_data",
};

export function listPrompts(userId) {
  return db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompts WHERE user_id = ? ORDER BY favorite DESC, id DESC`).all(userId);
}

export function getPrompt(userId, id) {
  return db.prepare(`SELECT ${PROMPT_COLUMNS} FROM prompts WHERE id = ? AND user_id = ?`).get(id, userId);
}

export function addPrompt(userId, data) {
  const result = db.prepare(`
    INSERT INTO prompts (user_id, title, text, category, image,
      negative_text, model, tags, sns_url, sns_url_normalized, sns_type,
      note, success_notes, failure_notes, repro_tips, favorite, archived,
      kind, summary, prompt_text_raw, prompt_text_clean, variables, media,
      source_url, source_author, source_content, status, rating,
      source_inbox_id, facet_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    userId, data.title, data.text, data.category || "其他", data.image || "",
    data.negativeText || "", data.model || "", data.tags || "",
    data.snsUrl || "", data.snsUrlNormalized || "", data.snsType || "",
    data.note || "", data.successNotes || "", data.failureNotes || "", data.reproTips || "",
    data.favorite ? 1 : 0,
    data.kind || "creative", data.summary || "", data.promptTextRaw || data.text || "",
    data.promptTextClean || "", data.variables || "{}", data.media || "[]",
    data.sourceUrl || "", data.sourceAuthor || "", data.sourceContent || "",
    data.status || "untested", Number(data.rating || 0),
    data.sourceInboxId == null ? null : Number(data.sourceInboxId), data.facetData || "{}",
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

/* ---------- 知识资产 ---------- */
const KNOWLEDGE_COLUMNS = `
  id, title, summary, body, tags,
  source_url AS sourceUrl, source_author AS sourceAuthor, source_content AS sourceContent,
  status, subject_id AS subjectId, verification_status AS verificationStatus, version,
  created_at AS createdAt, updated_at AS updatedAt
`;

export function listKnowledge(userId) {
  return db.prepare(`SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge WHERE user_id = ? ORDER BY id DESC`).all(userId);
}

export function getKnowledge(userId, id) {
  return db.prepare(`SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge WHERE id = ? AND user_id = ?`).get(id, userId);
}

export function addKnowledge(userId, data) {
  const result = db.prepare(`
    INSERT INTO knowledge (user_id, title, summary, body, tags, source_url, source_author, source_content,
      status, subject_id, verification_status, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, data.title, data.summary || "", data.body || "", data.tags || "",
    data.sourceUrl || "", data.sourceAuthor || "", data.sourceContent || "",
    data.status || "draft", data.subjectId || "", data.verificationStatus || "unverified",
    Number(data.version || 1),
  );
  return Number(result.lastInsertRowid);
}

export function updateKnowledge(userId, id, data) {
  return db.prepare(`
    UPDATE knowledge SET title = ?, summary = ?, body = ?, tags = ?, source_url = ?,
      source_author = ?, source_content = ?, status = ?, subject_id = ?,
      verification_status = ?, version = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    data.title, data.summary || "", data.body || "", data.tags || "",
    data.sourceUrl || "", data.sourceAuthor || "", data.sourceContent || "",
    data.status || "draft", data.subjectId || "", data.verificationStatus || "unverified",
    Number(data.version || 1), id, userId,
  ).changes > 0;
}

export function deleteKnowledge(userId, id) {
  return db.prepare("DELETE FROM knowledge WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/* ---------- 收件箱 ---------- */
const INBOX_COLUMNS = `
  id, source, external_id AS externalId, title, url, author, content,
  media, links, metrics, ai_type AS aiType, ai_confidence AS aiConfidence,
  ai_summary AS aiSummary, ai_extract AS aiExtract, status, visibility,
  dispatched_to AS dispatchedTo, created_at AS createdAt, updated_at AS updatedAt
`;

export function listInbox(userId, { status = "pending", type = "", source = "", visibility = "" } = {}) {
  const where = ["user_id = ?"];
  const params = [userId];
  if (status && status !== "all") { where.push("status = ?"); params.push(status); }
  if (type) { where.push("ai_type = ?"); params.push(type); }
  if (source) { where.push("source = ?"); params.push(source); }
  if (visibility) { where.push("visibility = ?"); params.push(visibility); }
  const rows = db.prepare(`
    SELECT ${INBOX_COLUMNS} FROM inbox
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC
  `).all(...params);
  const withDates = rows.filter((row) => status !== "pending" ||
    !isContentlessXBookmark(row)).map((row) => {
    let postCreatedAt = "";
    if (row.source === "x") {
      try { postCreatedAt = JSON.parse(row.metrics || "{}").postCreatedAt || ""; }
      catch { /* Use the import date for malformed legacy metrics. */ }
    }
    const parsed = Date.parse(postCreatedAt);
    return { row, time: Number.isFinite(parsed) ? parsed
      : row.source === "x" ? 0 : Date.parse(row.createdAt) || 0 };
  });
  withDates.sort((a, b) => b.time - a.time || b.row.id - a.row.id);
  const subjects = new Map();
  for (const row of db.prepare(`
    SELECT inbox_id AS inboxId, subject_id AS id, subject_title AS title,
      confidence, relationship, model FROM inbox_subjects WHERE user_id = ?
  `).all(userId)) {
    if (!subjects.has(row.inboxId)) subjects.set(row.inboxId, []);
    subjects.get(row.inboxId).push({
      id: row.id, title: row.title, confidence: row.confidence,
      relationship: row.relationship, model: row.model,
    });
  }
  return withDates.map(({ row }) => ({ ...row, subjectCollections: subjects.get(row.id) || [] }));
}


/** Full coverage, compact index for list UIs. It deliberately omits source bodies and raw supplements. */
export function listInboxIndex(userId, filters = {}) {
  return listInbox(userId, filters).map(compactInboxListRow);
}

/** Search source bodies on the server; only stable IDs leave the process. */
export function searchInboxIds(userId, query, filters = {}) {
  const normalized = String(query || '').trim();
  if (!normalized) return { ids: [], total: 0 };
  const { terms = false, ...listFilters } = filters;
  const rows = listInbox(userId, listFilters);
  const ids = rows.filter(row => inboxSearchMatches(row, normalized, { terms })).map(row => row.id);
  return { ids, total: ids.length };
}

/** Replace inferred memberships atomically; source posts and their classifications are untouched. */
export function replaceInboxSubjectCollections(userId, collections) {
  const find = db.prepare("SELECT id FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?");
  const insert = db.prepare(`
    INSERT INTO inbox_subjects (user_id, inbox_id, subject_id, subject_title, confidence, relationship, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    const resolved = collections.map((collection) => ({
      ...collection,
      members: collection.members.map((member) => {
        const row = find.get(userId, member.externalId);
        if (!row) throw new Error("合集引用了未入库的 X 收藏");
        return { ...member, inboxId: row.id };
      }),
    }));
    db.prepare("DELETE FROM inbox_subjects WHERE user_id = ?").run(userId);
    let memberships = 0;
    for (const collection of resolved) {
      for (const member of collection.members) {
        insert.run(userId, member.inboxId, collection.id, collection.title,
          member.confidence, member.relationship, member.model);
        memberships += 1;
      }
    }
    db.exec("COMMIT");
    return { collections: resolved.length, memberships };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getInboxItem(userId, id) {
  return db.prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE id = ? AND user_id = ?`).get(id, userId);
}

export function setInboxVisibility(userId, id, visibility) {
  if (!["public", "private"].includes(visibility)) return false;
  return db.prepare(`
    UPDATE inbox SET visibility = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND source = 'x' AND status = 'pending'
  `).run(visibility, id, userId).changes > 0;
}

export function addInboxItem(userId, data) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO inbox
      (user_id, source, external_id, title, url, author, content, media, links, metrics,
       ai_type, ai_confidence, ai_summary, ai_extract)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, data.source || "manual", data.externalId || "", data.title || "", data.url || "",
    data.author || "", data.content || "", data.media || "[]", data.links || "[]",
    data.metrics || "{}", data.aiType || "", Number(data.aiConfidence || 0),
    data.aiSummary || "", data.aiExtract || "{}",
  );
  if (result.changes > 0) return { id: Number(result.lastInsertRowid), created: true };
  const existing = db.prepare(`
    SELECT id FROM inbox WHERE user_id = ? AND source = ? AND external_id = ?
  `).get(userId, data.source || "manual", data.externalId || "");
  return { id: existing ? existing.id : 0, created: false };
}

export function importInboxItems(userId, items) {
  db.exec("BEGIN IMMEDIATE");
  try {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const existingQuery = db.prepare(`
      SELECT id, content, status, ai_extract AS aiExtract FROM inbox
      WHERE user_id = ? AND source = 'x' AND external_id = ?
    `);
    const updateQuery = db.prepare(`
      UPDATE inbox SET title = ?, url = ?, author = ?, content = ?, media = ?, links = ?,
        metrics = ?, ai_type = ?, ai_confidence = ?, ai_summary = ?, ai_extract = ?, status = ?,
        visibility = 'unreviewed',
        updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `);
    for (const item of items) {
      if (isContentlessXBookmark(item)) { skipped += 1; continue; }
      if (addInboxItem(userId, item).created) imported += 1;
      else {
        const existing = existingQuery.get(userId, item.externalId);
        let oldExtract = {};
        let newExtract = {};
        let oldOrganization = {};
        let newOrganization = {};
        try { oldExtract = JSON.parse(existing?.aiExtract || "{}"); oldOrganization = oldExtract.xOrganization || {}; }
        catch { /* keep old row */ }
        try { newExtract = JSON.parse(item.aiExtract || "{}"); newOrganization = newExtract.xOrganization || {}; }
        catch { /* skip update */ }
        const rank = { partial_ui_scan: 1, partial_xarchive_scan: 2, complete: 3 };
        const improvedCoverage = (rank[newOrganization.coverage] || 0) >
          (rank[oldOrganization.coverage] || 0);
        const gainedFullText = oldOrganization.coverage === newOrganization.coverage &&
          oldOrganization.contentIncomplete && !newOrganization.contentIncomplete;
        const recoveredContent = existing?.status === "ignored" &&
          oldExtract.xOmission?.reason === "no_readable_content";
        const preservesText = !existing?.content || Boolean(item.content);
        if (existing && preservesText && (improvedCoverage || gainedFullText || recoveredContent)) {
          if (recoveredContent) delete newExtract.xOmission;
          updateQuery.run(item.title, item.url, item.author, item.content, item.media, item.links,
            item.metrics, item.aiType, item.aiConfidence, item.aiSummary,
            recoveredContent ? JSON.stringify(newExtract) : item.aiExtract,
            recoveredContent ? "pending" : existing.status,
            existing.id, userId);
          updated += 1;
        } else skipped += 1;
      }
    }
    db.exec("COMMIT");
    return { imported, updated, skipped, total: items.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Hide old link-only captures without deleting their source or manual review history. */
export function archiveContentlessXInboxItems(userId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`
      SELECT id, source, content, media, ai_extract AS aiExtract
      FROM inbox WHERE user_id = ? AND source = 'x' AND status = 'pending'
    `).all(userId);
    const update = db.prepare(`
      UPDATE inbox SET status = 'ignored', ai_extract = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'pending'
    `);
    let archived = 0;
    for (const row of rows) {
      if (!isContentlessXBookmark(row)) continue;
      let extract = {};
      try { extract = JSON.parse(row.aiExtract || "{}"); } catch { /* retain the row */ }
      extract.xOmission = { reason: "no_readable_content" };
      archived += update.run(JSON.stringify(extract), row.id, userId).changes;
    }
    db.exec("COMMIT");
    return { scanned: rows.length, archived };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateInboxAnalysis(userId, id, analysis) {
  const current = getInboxItem(userId, id);
  if (!current || current.status !== "pending") return false;
  let previousExtract = {};
  try { previousExtract = JSON.parse(current.aiExtract || "{}"); } catch { /* keep new analysis */ }
  return db.prepare(`
    UPDATE inbox
    SET ai_type = ?, ai_confidence = ?, ai_extract = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND status = 'pending'
  `).run(
    analysis.aiType,
    analysis.aiConfidence,
    JSON.stringify({ ...previousExtract, ...analysis.aiExtract }),
    id, userId,
  ).changes > 0;
}

export function ignoreInboxItem(userId, id) {
  return db.prepare(`
    UPDATE inbox SET status = 'ignored', updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND status = 'pending'
  `).run(id, userId).changes > 0;
}

export function dispatchInboxItem(userId, id, targetType, data) {
  const item = getInboxItem(userId, id);
  if (!item) throw { status: 404, message: "收件箱内容不存在" };
  if (item.status !== "pending") throw { status: 409, message: "这条内容已经处理过了" };

  db.exec("BEGIN IMMEDIATE");
  try {
    let targetId;
    let target;
    if (targetType === "prompt") {
      targetId = addPrompt(userId, data);
      target = getPrompt(userId, targetId);
    } else if (targetType === "resource") {
      targetId = addFavorite(userId, data);
      target = getFavorite(userId, targetId);
    } else if (targetType === "knowledge") {
      targetId = addKnowledge(userId, data);
      target = getKnowledge(userId, targetId);
    } else {
      throw { status: 400, message: "不支持的资产类型" };
    }

    const dispatchedTo = `${targetType}:${targetId}`;
    db.prepare(`
      UPDATE inbox SET status = 'dispatched', dispatched_to = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(dispatchedTo, id, userId);
    db.exec("COMMIT");
    return { id, status: "dispatched", dispatchedTo, targetType, targetId, target };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
