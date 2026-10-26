function parsed(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); }
  catch { return fallback; }
}

function stringList(value) {
  const decoded = parsed(value, null);
  const items = Array.isArray(decoded) ? decoded : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function mediaList(value, fallbackImage = "") {
  const decoded = parsed(value, []);
  if (Array.isArray(decoded) && decoded.length) return decoded;
  return fallbackImage ? [{ type: "photo", url: fallbackImage }] : [];
}

function sourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch { return ""; }
}

function manualPromptRows(db, userId, id = null) {
  return db.prepare(`
    SELECT p.id, p.title, p.text, p.category, p.image, p.tags, p.kind, p.summary,
      p.media, COALESCE(NULLIF(p.source_url,''),p.sns_url) AS sourceUrl, p.source_author AS sourceAuthor,
      p.source_content AS sourceContent, p.source_inbox_id AS sourceInboxId,
      p.status, p.rating, p.facet_data AS facetData,
      COALESCE(NULLIF(p.updated_at,''),p.created_at) AS updatedAt,
      p.created_at AS createdAt, i.dispatched_to AS dispatchedTo
    FROM prompts p
    LEFT JOIN inbox i ON i.id = p.source_inbox_id AND i.user_id = p.user_id
    WHERE p.user_id = ? ${id == null ? '' : 'AND p.id = ?'} ORDER BY p.id DESC
  `).all(...(id == null ? [userId] : [userId, id])).filter((row) => {
    const facets = parsed(row.facetData, {});
    return row.sourceInboxId == null || facets?.manualAsset === true || row.dispatchedTo === `prompt:${row.id}`;
  });
}

function promptView(row) {
  const facets = parsed(row.facetData, {});
  const sourceInboxId = Number(row.sourceInboxId ?? facets?.manualSourceInboxId);
  if (facets && typeof facets === "object") {
    delete facets.manualAsset;
    delete facets.manualSourceInboxId;
  }
  return {
    id: `manual-prompt-${row.id}`,
    type: "manual",
    manualAssetId: Number(row.id),
    title: row.title,
    text: row.text,
    category: row.category || "其他",
    tags: stringList(row.tags),
    media: mediaList(row.media, row.image),
    kind: row.kind || "creative",
    summary: row.summary || "",
    sourceUrl: sourceUrl(row.sourceUrl),
    sourceAuthor: row.sourceAuthor || "",
    sourceContent: row.sourceContent || "",
    ...(Number.isSafeInteger(sourceInboxId) && sourceInboxId > 0 ? { sourceInboxId } : {}),
    status: row.status || "untested",
    rating: Number(row.rating || 0),
    facets,
    updatedAt: row.updatedAt || row.createdAt || "",
    createdAt: row.createdAt || "",
    curated: true,
  };
}

export function listManualPromptAssets(db, userId) {
  return manualPromptRows(db, userId).map(promptView);
}

export function getManualPromptAsset(db, userId, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = manualPromptRows(db, userId, id)[0];
  return row ? promptView(row) : null;
}

function manualKnowledgeRows(db, userId, id = null) {
  return db.prepare(`
    SELECT k.id, k.title, k.summary, k.body, k.tags, k.source_url AS sourceUrl,
      k.source_author AS sourceAuthor, k.source_content AS sourceContent,
      k.status, k.verification_status AS verificationStatus, k.version,
      k.created_at AS createdAt, k.updated_at AS updatedAt,
      i.id AS inboxId, i.external_id AS inboxExternalId, i.title AS inboxTitle,
      i.url AS inboxUrl, i.author AS inboxAuthor, i.content AS inboxContent
    FROM knowledge k
    LEFT JOIN inbox i ON i.id = (
      SELECT MAX(source.id) FROM inbox source
      WHERE source.user_id = k.user_id AND source.dispatched_to = 'knowledge:' || k.id
    )
    WHERE k.user_id = ? AND COALESCE(k.subject_id,'') = ''
      AND NOT EXISTS (SELECT 1 FROM knowledge_sources ks WHERE ks.knowledge_id = k.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_claims kc WHERE kc.knowledge_id = k.id)
      ${id == null ? '' : 'AND k.id = ?'}
    ORDER BY k.updated_at DESC, k.id DESC
  `).all(...(id == null ? [userId] : [userId, id]));
}

function sourceForKnowledge(row) {
  if (row.inboxId) {
    return {
      id: row.inboxId,
      externalId: row.inboxExternalId || "",
      title: row.inboxTitle || row.title,
      url: sourceUrl(row.inboxUrl || row.sourceUrl),
      author: row.inboxAuthor || row.sourceAuthor || "",
      excerpt: String(row.inboxContent || row.sourceContent || "").replace(/\s+/g, " ").trim().slice(0, 320),
      citationKey: `S:${row.inboxExternalId || row.inboxId}`,
    };
  }
  const url = sourceUrl(row.sourceUrl);
  if (!url) return null;
  return {
    id: `manual-source-${row.id}`,
    externalId: "",
    title: row.sourceAuthor ? `${row.sourceAuthor} 的原文` : `${row.title}的原文`,
    url,
    author: row.sourceAuthor || "",
    excerpt: String(row.sourceContent || "").replace(/\s+/g, " ").trim().slice(0, 320),
    citationKey: `M:${row.id}`,
  };
}

function knowledgeSummary(row) {
  const source = sourceForKnowledge(row);
  return {
    id: `manual-knowledge-${row.id}`,
    type: "manual",
    manualAssetId: Number(row.id),
    title: row.title,
    summary: row.summary || "",
    tags: stringList(row.tags),
    status: row.status || "draft",
    verificationStatus: row.verificationStatus || "unverified",
    version: Number(row.version || 1),
    sourceCount: source ? 1 : 0,
    claimCount: 0,
    updatedAt: row.updatedAt || row.createdAt || "",
    createdAt: row.createdAt || "",
  };
}

export function listManualKnowledgeAssets(db, userId) {
  return manualKnowledgeRows(db, userId).map(knowledgeSummary);
}

export function getManualKnowledgeAsset(db, userId, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = manualKnowledgeRows(db, userId, id)[0];
  if (!row) return null;
  const source = sourceForKnowledge(row);
  return {
    ...knowledgeSummary(row),
    body: row.body || "",
    sources: source ? [source] : [],
    claims: [],
    repositories: [],
  };
}
