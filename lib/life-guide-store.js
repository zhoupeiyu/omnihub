// Life guide store: read/query layer over guide-only tables.
//
// Factory: createLifeGuideStore(db) -> uses the supplied node:sqlite DatabaseSync.
// Creates only life_guide_* tables and never touches any other table.
//
// The corpus is the canonical output of reference/build-life-guide.mjs:
//   {
//     metadata: { repository, commit, date, generatedAt, chapterCount, entryCount, sourceHashes },
//     sections: [{ id, number, title, file, markdown, intro, entries: [
//       { id, number, title, sectionId, file, markdown, human, cost, grade, money, time, will }
//     ] }],
//     docs: [{ file, title, markdown }],
//     readme,
//     featuredDocs,
//   }
//
// Entries and docs are stored verbatim (raw JSON) so detail() returns the exact
// original object; only derived/indexed columns are extracted for querying.

export const LIFE_GUIDE_REPOSITORY = 'https://github.com/eternity4719/HowToLiveBetter';

export const GUIDE_TABLES = Object.freeze([
  'life_guide_metadata',
  'life_guide_sections',
  'life_guide_entries',
  'life_guide_docs',
]);

const COMMIT_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;
const GRADES = new Set(['A', 'B', 'C']);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 512;
const MAX_QUERY_TOKENS = 32;
const PREVIEW_LENGTH = 160;

const ENTRY_FILTERS = Object.freeze({
  grade: new Set(['A', 'B', 'C']),
  money: new Set(['0', '少', '多']),
  time: new Set(['少', '中', '多']),
  will: new Set(['否', '些', '是']),
});

const SAFE_MESSAGES = Object.freeze({
  NOT_READY: 'Life guide data is not available yet',
  VERSION_CHANGED: 'Life guide data has changed since it was read',
  INVALID_CORPUS: 'Life guide corpus failed validation',
  BAD_REQUEST: 'Invalid life guide request',
  NOT_FOUND: 'Life guide resource not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  INTERNAL: 'Life guide request failed',
});

export class LifeGuideError extends Error {
  constructor(code, status) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL);
    this.name = 'LifeGuideError';
    this.code = code;
    this.status = status;
  }
}

function invalidCorpus() {
  return new LifeGuideError('INVALID_CORPUS', 400);
}

function badRequest() {
  return new LifeGuideError('BAD_REQUEST', 400);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A required non-empty string (ids, titles, file paths, grade, sectionId).
function requireNonEmptyString(value) {
  if (typeof value !== 'string' || value.length === 0) throw invalidCorpus();
  return value;
}

// A required string, allowed to be empty (intro, readme, markdown bodies).
function requireStringValue(value) {
  if (typeof value !== 'string') throw invalidCorpus();
  return value;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function escapePreview(markdown) {
  return String(markdown).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
}

function serializeJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function deserializeJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toParams(params) {
  if (!params) return {};
  if (typeof params === 'string') {
    const raw = params.startsWith('?') ? params.slice(1) : params.replace(/^[^?]*\?/, '');
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (typeof URLSearchParams !== 'undefined' && params instanceof URLSearchParams) {
    return Object.fromEntries(params);
  }
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    const item = Array.isArray(value) ? value[value.length - 1] : value;
    if (item === undefined || item === null) continue;
    out[key] = item;
  }
  return out;
}

function normalizeView(value) {
  const view = value === undefined || value === null || value === '' ? 'entries' : String(value);
  if (view === 'entries' || view === 'docs') return view;
  throw badRequest();
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_guide_metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS life_guide_sections (
      id TEXT PRIMARY KEY,
      number INTEGER,
      title TEXT,
      file TEXT,
      intro TEXT,
      full_markdown TEXT,
      count INTEGER,
      position INTEGER
    );
    CREATE TABLE IF NOT EXISTS life_guide_entries (
      id TEXT PRIMARY KEY,
      section_id TEXT,
      number INTEGER,
      title TEXT,
      grade TEXT,
      money TEXT,
      time TEXT,
      will TEXT,
      raw TEXT,
      search_blob TEXT,
      position INTEGER
    );
    CREATE TABLE IF NOT EXISTS life_guide_docs (
      file TEXT PRIMARY KEY,
      title TEXT,
      markdown TEXT,
      preview TEXT,
      raw TEXT,
      search_blob TEXT,
      position INTEGER
    );
  `);
}

// Strict validation of the canonical builder corpus. Returns a normalized,
// fully-verified structure (with the original source metadata kept intact).
function normalizeCorpus(corpus) {
  if (!isObject(corpus)) throw invalidCorpus();

  const metadata = corpus.metadata;
  if (!isObject(metadata)) throw invalidCorpus();

  const repository = requireNonEmptyString(metadata.repository);
  if (repository !== LIFE_GUIDE_REPOSITORY) throw invalidCorpus();

  if (typeof metadata.commit !== 'string' || !COMMIT_RE.test(metadata.commit)) throw invalidCorpus();
  const commit = metadata.commit;
  const date = requireStringValue(metadata.date);
  const generatedAt = requireStringValue(metadata.generatedAt);

  const sourceHashes = metadata.sourceHashes;
  if (!isObject(sourceHashes)) throw invalidCorpus();
  const hashEntries = Object.entries(sourceHashes);
  if (hashEntries.length === 0) throw invalidCorpus();
  for (const [, value] of hashEntries) {
    if (typeof value !== 'string' || !HASH_RE.test(value)) throw invalidCorpus();
  }
  if (!Object.prototype.hasOwnProperty.call(sourceHashes, 'LICENSE')) throw invalidCorpus();

  if (!Array.isArray(corpus.sections)) throw invalidCorpus();
  if (!Array.isArray(corpus.docs)) throw invalidCorpus();
  if (!Array.isArray(corpus.featuredDocs)) throw invalidCorpus();
  for (const featured of corpus.featuredDocs) {
    if (typeof featured !== 'string') throw invalidCorpus();
  }
  const readme = requireStringValue(corpus.readme);

  // Section and entry ids share one namespace in the builder; both must be
  // globally unique so foreign/dangling references cannot slip through.
  const ids = new Set();
  const sections = [];
  const entries = [];
  let entryPosition = 0;

  for (const rawSection of corpus.sections) {
    if (!isObject(rawSection)) throw invalidCorpus();
    const id = requireNonEmptyString(rawSection.id);
    if (ids.has(id)) throw invalidCorpus();
    ids.add(id);

    if (!Number.isInteger(rawSection.number)) throw invalidCorpus();
    const title = requireNonEmptyString(rawSection.title);
    const file = requireNonEmptyString(rawSection.file);
    const markdown = requireStringValue(rawSection.markdown);
    const intro = requireStringValue(rawSection.intro);
    if (!Array.isArray(rawSection.entries)) throw invalidCorpus();

    let count = 0;
    for (const rawEntry of rawSection.entries) {
      if (!isObject(rawEntry)) throw invalidCorpus();
      const entryId = requireNonEmptyString(rawEntry.id);
      if (ids.has(entryId)) throw invalidCorpus();
      ids.add(entryId);
      if (rawEntry.sectionId !== id) throw invalidCorpus();

      if (!Number.isInteger(rawEntry.number)) throw invalidCorpus();
      const entryTitle = requireNonEmptyString(rawEntry.title);
      const entryFile = requireNonEmptyString(rawEntry.file);
      const entryMarkdown = requireStringValue(rawEntry.markdown);
      if (typeof rawEntry.grade !== 'string' || !GRADES.has(rawEntry.grade)) throw invalidCorpus();
      for (const key of ['human', 'cost', 'money', 'time', 'will']) {
        const value = rawEntry[key];
        if (value !== undefined && value !== null && typeof value !== 'string') throw invalidCorpus();
      }
      entries.push({
        id: entryId,
        section_id: id,
        number: rawEntry.number,
        title: entryTitle,
        grade: rawEntry.grade,
        money: rawEntry.money ?? null,
        time: rawEntry.time ?? null,
        will: rawEntry.will ?? null,
        raw: serializeJson(rawEntry),
        search_blob: `${entryTitle}\n${entryMarkdown}`.toLowerCase(),
        position: entryPosition,
      });
      entryPosition += 1;
      count += 1;
    }

    sections.push({ id, number: rawSection.number, title, file, markdown, intro, count, position: sections.length });
  }

  if (metadata.chapterCount !== sections.length) throw invalidCorpus();
  if (metadata.entryCount !== entries.length) throw invalidCorpus();

  const docFiles = new Set();
  const docs = [];
  for (const rawDoc of corpus.docs) {
    if (!isObject(rawDoc)) throw invalidCorpus();
    const file = requireNonEmptyString(rawDoc.file);
    if (docFiles.has(file)) throw invalidCorpus();
    docFiles.add(file);
    const title = requireNonEmptyString(rawDoc.title);
    const markdown = requireStringValue(rawDoc.markdown);
    docs.push({
      file,
      title,
      markdown,
      preview: escapePreview(markdown),
      raw: serializeJson(rawDoc),
      search_blob: `${title}\n${markdown}`.toLowerCase(),
      position: docs.length,
    });
  }

  return {
    repository,
    commit,
    date,
    generatedAt,
    sourceMetadata: metadata,
    sourceHashes: { ...sourceHashes },
    readme,
    featuredDocs: [...corpus.featuredDocs],
    sections,
    entries,
    docs,
  };
}

export function createLifeGuideStore(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('createLifeGuideStore requires an open node:sqlite database');
  }
  ensureSchema(db);

  // Every public read (metadata/list/detail) runs inside one short SQLite read
  // transaction so the readiness/version check and all of its SELECTs observe a
  // single WAL snapshot. A deferred BEGIN never takes a write lock, so an
  // already-open read cannot block a writer's importCorpus/markChecked; nested
  // calls (getCommit inside a wrap) reuse the open read instead of a new BEGIN.
  let inReadSnapshot = false;

  function readSnapshot(fn) {
    if (inReadSnapshot) return fn();
    db.exec('BEGIN');
    inReadSnapshot = true;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures; the original error is what matters.
      }
      throw error;
    } finally {
      inReadSnapshot = false;
    }
  }

  function readMeta(key) {
    const row = db.prepare('SELECT value FROM life_guide_metadata WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function writeMeta(key, value) {
    db.prepare('INSERT INTO life_guide_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value === undefined || value === null ? null : String(value));
  }

  function getCommit() {
    return readMeta('commit');
  }

  function ensureReady() {
    const commit = getCommit();
    if (!commit) throw new LifeGuideError('NOT_READY', 503);
    return commit;
  }

  function checkVersion(version) {
    const commit = ensureReady();
    if (version === undefined || version === null || version === '') return commit;
    if (String(version) !== commit) throw new LifeGuideError('VERSION_CHANGED', 409);
    return commit;
  }

  function importCorpus(corpus, options = {}) {
    // expectedCommit: the option being absent means a caller-owned
    // (unconditional) import; when present it is compared exactly, and an
    // explicit null means "the table must currently be empty".
    const opts = isObject(options) ? options : {};
    const expectedProvided = opts.expectedCommit !== undefined;
    let expected = null;
    if (expectedProvided && opts.expectedCommit !== null) {
      const value = String(opts.expectedCommit);
      if (!COMMIT_RE.test(value)) throw badRequest();
      expected = value;
    }

    const normalized = normalizeCorpus(corpus);

    let started = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      started = true;

      const current = readMeta('commit');
      if (expectedProvided && current !== expected) throw new LifeGuideError('VERSION_CHANGED', 409);

      const previousCheckedAt = readMeta('checkedAt');

      db.exec('DELETE FROM life_guide_entries; DELETE FROM life_guide_sections; DELETE FROM life_guide_docs; DELETE FROM life_guide_metadata;');

      const insertSection = db.prepare(
        'INSERT INTO life_guide_sections (id, number, title, file, intro, full_markdown, count, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const section of normalized.sections) {
        insertSection.run(section.id, section.number, section.title, section.file, section.intro, section.markdown, section.count, section.position);
      }

      const insertEntry = db.prepare(
        'INSERT INTO life_guide_entries (id, section_id, number, title, grade, money, time, will, raw, search_blob, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const entry of normalized.entries) {
        insertEntry.run(entry.id, entry.section_id, entry.number, entry.title, entry.grade, entry.money, entry.time, entry.will, entry.raw, entry.search_blob, entry.position);
      }

      const insertDoc = db.prepare(
        'INSERT INTO life_guide_docs (file, title, markdown, preview, raw, search_blob, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const doc of normalized.docs) {
        insertDoc.run(doc.file, doc.title, doc.markdown, doc.preview, doc.raw, doc.search_blob, doc.position);
      }

      writeMeta('repository', normalized.repository);
      writeMeta('commit', normalized.commit);
      writeMeta('date', normalized.date);
      writeMeta('generatedAt', normalized.generatedAt);
      writeMeta('chapterCount', normalized.sections.length);
      writeMeta('entryCount', normalized.entries.length);
      writeMeta('docCount', normalized.docs.length);
      writeMeta('sourceHashes', serializeJson(normalized.sourceHashes));
      writeMeta('sourceMetadata', serializeJson(normalized.sourceMetadata));
      writeMeta('readme', normalized.readme);
      writeMeta('featuredDocs', serializeJson(normalized.featuredDocs));
      writeMeta('checkedAt', opts.recordChecked === true ? new Date().toISOString() : previousCheckedAt);
      writeMeta('updatedAt', new Date().toISOString());

      db.exec('COMMIT');
      started = false;

      return {
        commit: normalized.commit,
        chapterCount: normalized.sections.length,
        entryCount: normalized.entries.length,
        docCount: normalized.docs.length,
      };
    } catch (error) {
      if (started) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback failures; the original error is what matters.
        }
      }
      if (error instanceof LifeGuideError) throw error;
      throw new LifeGuideError('INVALID_CORPUS', 400);
    }
  }

  function markChecked() {
    ensureReady();
    // Only the verification timestamp changes; content updatedAt is untouched.
    const now = new Date().toISOString();
    writeMeta('checkedAt', now);
    return { checkedAt: now };
  }

  function metadata() {
    return readSnapshot(() => {
      const commit = ensureReady();
      const sections = db.prepare('SELECT id, number, title, file, count FROM life_guide_sections ORDER BY position ASC')
        .all()
        .map(row => ({ id: row.id, number: row.number, title: row.title, file: row.file, count: row.count }));
      const docs = db.prepare('SELECT file, title FROM life_guide_docs ORDER BY position ASC')
        .all()
        .map(row => ({ file: row.file, title: row.title }));
      return {
        metadata: {
          repository: readMeta('repository'),
          commit,
          date: readMeta('date'),
          generatedAt: readMeta('generatedAt'),
          chapterCount: Number(readMeta('chapterCount') || 0),
          entryCount: Number(readMeta('entryCount') || 0),
          docCount: Number(readMeta('docCount') || 0),
          checkedAt: readMeta('checkedAt'),
          updatedAt: readMeta('updatedAt'),
        },
        sections,
        docs,
      };
    });
  }

  // Full original metadata, verbatim (including sourceHashes) and unchanged.
  function sourceMetadata() {
    return readSnapshot(() => {
      const raw = readMeta('sourceMetadata');
      return raw ? deserializeJson(raw) : null;
    });
  }

  function parseLimitOffset(params) {
    let limit = DEFAULT_LIMIT;
    let offset = 0;
    if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
      const parsed = Number(params.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw badRequest();
      limit = parsed;
    }
    if (params.offset !== undefined && params.offset !== null && params.offset !== '') {
      const parsed = Number(params.offset);
      if (!Number.isInteger(parsed) || parsed < 0) throw badRequest();
      offset = parsed;
    }
    return { limit, offset };
  }

  function buildWhere(params, view) {
    const clause = [];
    const values = [];
    // docs view ignores entry-only filters entirely.
    if (view === 'entries') {
      if (params.chapter !== undefined && params.chapter !== null && params.chapter !== '') {
        clause.push('section_id = ?');
        values.push(String(params.chapter));
      }
      for (const key of Object.keys(ENTRY_FILTERS)) {
        const raw = params[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const value = key === 'grade' ? String(raw).toUpperCase() : String(raw);
        if (!ENTRY_FILTERS[key].has(value)) throw badRequest();
        clause.push(`${key} = ?`);
        values.push(value);
      }
    }
    const rawQuery = params.q === undefined || params.q === null ? '' : String(params.q);
    // Bound the query before any SQL is compiled: an unbounded q can turn a few
    // KB of input into thousands of AND LIKE terms and pin the CPU.
    if ([...rawQuery].length > MAX_QUERY_LENGTH) throw badRequest();
    const tokens = rawQuery
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (tokens.length > MAX_QUERY_TOKENS) throw badRequest();
    for (const token of tokens) {
      clause.push("search_blob LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(token.toLowerCase())}%`);
    }
    return { sql: clause.length ? `WHERE ${clause.join(' AND ')}` : '', values };
  }

  function sectionTitles() {
    const map = new Map();
    for (const row of db.prepare('SELECT id, title FROM life_guide_sections').all()) map.set(row.id, row.title);
    return map;
  }

  function entrySummary(row, titles) {
    const raw = deserializeJson(row.raw);
    const entry = isObject(raw) ? raw : {};
    return {
      id: row.id,
      sectionId: row.section_id,
      section: titles.get(row.section_id) ?? null,
      number: row.number,
      title: row.title,
      grade: row.grade,
      money: row.money,
      time: row.time,
      will: row.will,
      human: entry.human ?? null,
      cost: entry.cost ?? null,
      tags: entry.tags ?? null,
    };
  }

  function list(params = {}) {
    return readSnapshot(() => {
      const p = toParams(params);
      const view = normalizeView(p.view);
      const version = checkVersion(p.version);
      const { limit, offset } = parseLimitOffset(p);
      const selected = p.selected === undefined || p.selected === null || p.selected === '' ? null : String(p.selected);
      const where = buildWhere(p, view);

      let summaries;
      if (view === 'docs') {
        summaries = db.prepare(`SELECT file, title, preview FROM life_guide_docs ${where.sql} ORDER BY position ASC`)
          .all(...where.values)
          .map(row => ({ file: row.file, title: row.title, preview: row.preview }));
      } else {
        const titles = sectionTitles();
        summaries = db.prepare(`SELECT id, section_id, number, title, grade, money, time, will, raw FROM life_guide_entries ${where.sql} ORDER BY position ASC`)
          .all(...where.values)
          .map(row => entrySummary(row, titles));
      }

      const count = summaries.length;
      const rows = summaries.slice(offset, offset + limit);

      let focus = null;
      if (selected !== null) {
        const key = view === 'docs' ? 'file' : 'id';
        const index = summaries.findIndex(summary => summary[key] === selected);
        if (index >= 0) focus = { ...summaries[index], position: index };
      }

      return { version, view, count, rows, limit, offset, focus };
    });
  }

  function detail(params = {}) {
    return readSnapshot(() => {
      const p = toParams(params);
      const view = normalizeView(p.view);
      const version = checkVersion(p.version);
      const id = p.id === undefined || p.id === null ? '' : String(p.id);
      if (!id) throw badRequest();

      if (view === 'docs') {
        const row = db.prepare('SELECT raw FROM life_guide_docs WHERE file = ?').get(id);
        if (!row) throw new LifeGuideError('NOT_FOUND', 404);
        return { version, selected: deserializeJson(row.raw), section: null };
      }

      const row = db.prepare('SELECT section_id, raw FROM life_guide_entries WHERE id = ?').get(id);
      if (!row) throw new LifeGuideError('NOT_FOUND', 404);

      let section = null;
      if (row.section_id) {
        const sectionRow = db.prepare('SELECT id, number, title, file, intro FROM life_guide_sections WHERE id = ?').get(row.section_id);
        if (sectionRow) {
          section = { id: sectionRow.id, number: sectionRow.number, title: sectionRow.title, file: sectionRow.file, intro: sectionRow.intro };
        }
      }
      return { version, selected: deserializeJson(row.raw), section };
    });
  }

  return { importCorpus, metadata, list, detail, getCommit, markChecked, sourceMetadata };
}
