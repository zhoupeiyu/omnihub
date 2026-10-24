import { digestXBookmark } from "./x-digest.js";

function parseJson(value, fallback) {
  try { return JSON.parse(value || "") || fallback; }
  catch { return fallback; }
}

export function digestInputFromRow(row) {
  const extract = parseJson(row.aiExtract, {});
  return {
    title: row.title, content: row.content, aiType: row.aiType,
    media: parseJson(row.media, []), links: parseJson(row.links, []),
    organization: extract.xOrganization || {},
  };
}

/** Only replace summaries previously written by this pipeline. Preserve manual edits. */
export function applyXDigests(db, userId) {
  const update = db.prepare(`
    UPDATE inbox SET ai_summary = ?, ai_extract = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND source = 'x'
  `);
  const result = { total: 0, updated: 0, unchanged: 0, manualSkipped: 0,
    summaries: 0, reasons: 0, partial: 0, needsSource: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`
      SELECT id, title, content, media, links, ai_type AS aiType,
        ai_summary AS aiSummary, ai_extract AS aiExtract
      FROM inbox WHERE user_id = ? AND source = 'x' ORDER BY id
    `).all(userId);
    result.total = rows.length;
    for (const row of rows) {
      const extract = parseJson(row.aiExtract, {});
      const previous = extract.xDigest;
      if (row.aiSummary && (!previous || row.aiSummary !== previous.summary)) {
        result.manualSkipped += 1;
        continue;
      }
      const digest = digestXBookmark(digestInputFromRow(row));
      if (digest.summary) result.summaries += 1;
      if (digest.reason) result.reasons += 1;
      if (digest.status === "partial_excerpt") result.partial += 1;
      if (digest.status === "needs_source") result.needsSource += 1;
      if (previous?.sourceHash === digest.sourceHash && previous?.version === 1 &&
          previous?.summary === digest.summary && previous?.reason === digest.reason &&
          row.aiSummary === digest.summary) {
        result.unchanged += 1;
        continue;
      }
      update.run(digest.summary, JSON.stringify({ ...extract, xDigest: {
        ...digest, version: 1, method: "source_excerpt",
      } }), row.id, userId);
      result.updated += 1;
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
