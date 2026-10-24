import { db } from "./db.js";
import {parseGitHubRepositoryLink} from './x-github-assets.js';

// Public source-derived articles need evidence. All callers alias knowledge as k.
// Hiding an evidence source must also hide its derived title, body and claims.
const PUBLIC_KNOWLEDGE_FILTER = `AND k.status IN ('ready', 'published')
  AND EXISTS (SELECT 1 FROM knowledge_sources evidence WHERE evidence.knowledge_id = k.id)
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_sources evidence
    LEFT JOIN inbox original ON original.id = evidence.inbox_id
    WHERE evidence.knowledge_id = k.id
      AND (original.id IS NULL OR original.user_id IS NOT k.user_id
        OR original.visibility IS NOT 'public' OR original.status IS NOT 'pending')
  )`;

db.exec(`
  CREATE TABLE IF NOT EXISTS repository_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    repo_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    topics TEXT NOT NULL DEFAULT '[]',
    personal_status TEXT NOT NULL DEFAULT 'to_review',
    personal_note TEXT NOT NULL DEFAULT '',
    source_post_count INTEGER NOT NULL DEFAULT 0,
    target_link_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, repo_key)
  );
  CREATE INDEX IF NOT EXISTS repository_assets_user_status
    ON repository_assets(user_id, personal_status, source_post_count DESC);

  CREATE TABLE IF NOT EXISTS repository_sources (
    repository_id INTEGER NOT NULL REFERENCES repository_assets(id) ON DELETE CASCADE,
    inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    external_id TEXT NOT NULL,
    PRIMARY KEY (repository_id, inbox_id)
  );
  CREATE INDEX IF NOT EXISTS repository_sources_inbox ON repository_sources(inbox_id);

  CREATE TABLE IF NOT EXISTS repository_links (
    repository_id INTEGER NOT NULL REFERENCES repository_assets(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (repository_id, url)
  );

  CREATE TABLE IF NOT EXISTS knowledge_sources (
    knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    external_id TEXT NOT NULL,
    citation_key TEXT NOT NULL,
    PRIMARY KEY (knowledge_id, citation_key)
  );
  CREATE INDEX IF NOT EXISTS knowledge_sources_inbox ON knowledge_sources(inbox_id);

  CREATE TABLE IF NOT EXISTS knowledge_claims (
    knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    claim_text TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    verdict TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (knowledge_id, claim_id)
  );

  CREATE TABLE IF NOT EXISTS x_asset_facets (
    user_id INTEGER NOT NULL REFERENCES users(id),
    inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    external_id TEXT NOT NULL,
    version TEXT NOT NULL,
    source_form TEXT NOT NULL,
    primary_route TEXT NOT NULL,
    content_sufficiency TEXT NOT NULL,
    reuse_value REAL NOT NULL,
    derived_assets TEXT NOT NULL DEFAULT '[]',
    needs_review INTEGER NOT NULL DEFAULT 0,
    decision TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, inbox_id)
  );
  CREATE INDEX IF NOT EXISTS x_asset_facets_route ON x_asset_facets(user_id, primary_route);

  CREATE TABLE IF NOT EXISTS x_prompt_facets (
    user_id INTEGER NOT NULL REFERENCES users(id),
    inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    external_id TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL,
    completeness TEXT NOT NULL,
    subject TEXT NOT NULL,
    scenario TEXT NOT NULL,
    style TEXT NOT NULL,
    reusability REAL NOT NULL,
    needs_review INTEGER NOT NULL DEFAULT 0,
    decision TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, inbox_id)
  );
`);

const STATUS_VALUES = new Set(["to_review", "ready_to_try", "using", "deprecated", "later"]);

function parsed(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); }
  catch { return fallback; }
}

function topicDescription(asset) {
  const topicLabels = {
    software: "软件与开发", workflow: "工作流与自动化", video: "视频创作",
    image: "图像创作", crypto: "加密与交易", business: "商业",
    product: "产品设计", other: "其他主题",
  };
  const topics = (asset.topics || []).map((topic) => topicLabels[topic] || topic);
  const focus = topics.length ? topics.slice(0, 2).join("、") : "待整理";
  const count = Number(asset.sourcePostCount || asset.sourcePosts?.length || 0);
  return `${focus}相关仓库，来自 ${count} 条 X 收藏的上下文。`;
}

function repositoryRow(row) {
  return {
    key: row.repoKey,
    owner: row.owner,
    name: row.name,
    repositoryUrl: row.repositoryUrl,
    description: row.description,
    topics: parsed(row.topics, []),
    personalStatus: row.personalStatus,
    personalNote: row.personalNote,
    sourcePostCount: Number(row.sourcePostCount || 0),
    targetLinkCount: Number(row.targetLinkCount || 0),
    metadata: parsed(row.metadata, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * True when the enrichment script (or any future producer) has explicitly attached a
 * source-grounded description with recognized provenance to this asset. Plain refinery
 * imports never set this, so their generic topic description must not clobber it.
 */
function hasExplicitOfficialDescription(asset) {
  const provenance = asset?.officialDescription?.provenance;
  return Boolean(asset?.officialDescription?.text) &&
    ["github_readme", "github_description", "sources", "topics_fallback"].includes(provenance);
}

export function replaceRepositoryAssets(userId, assets) {
  const findInbox = db.prepare(`
    SELECT id FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?
  `);
  const getExisting = db.prepare(`
    SELECT id, description, metadata FROM repository_assets WHERE user_id = ? AND repo_key = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO repository_assets
      (user_id, repo_key, owner, name, repository_url, description, topics,
       source_post_count, target_link_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, repo_key) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      repository_url = excluded.repository_url,
      description = excluded.description,
      topics = excluded.topics,
      source_post_count = excluded.source_post_count,
      target_link_count = excluded.target_link_count,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `);
  const getRepository = db.prepare(`
    SELECT id FROM repository_assets WHERE user_id = ? AND repo_key = ?
  `);
  const deleteSources = db.prepare("DELETE FROM repository_sources WHERE repository_id = ?");
  const deleteLinks = db.prepare("DELETE FROM repository_links WHERE repository_id = ?");
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO repository_sources (repository_id, inbox_id, external_id)
    VALUES (?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO repository_links (repository_id, url, kind) VALUES (?, ?, ?)
  `);
  const updateCounts = db.prepare(`
    UPDATE repository_assets SET source_post_count = ?, target_link_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    let repositories = 0;
    let sources = 0;
    let links = 0;
    for (const asset of assets) {
      const existing = getExisting.get(userId, asset.key);
      const existingMetadata = parsed(existing?.metadata, {});
      const hasExistingEnrichment = Boolean(existingMetadata.descriptionProvenance);
      const explicitOfficial = hasExplicitOfficialDescription(asset);
      let description;
      let metadata;
      if (explicitOfficial) {
        description = String(asset.officialDescription.text);
        metadata = {
          existingAssetTypes: asset.existingAssetTypes || [],
          linkOccurrenceCount: Number(asset.linkOccurrenceCount || 0),
          descriptionProvenance: asset.officialDescription.provenance,
          ...(asset.officialDescription.github || {}),
        };
      } else if (existing && hasExistingEnrichment) {
        // Normal re-imports must preserve a previous source-grounded enrichment.
        description = existing.description;
        metadata = existingMetadata;
        metadata.existingAssetTypes = asset.existingAssetTypes || metadata.existingAssetTypes || [];
        metadata.linkOccurrenceCount = Number(asset.linkOccurrenceCount || 0);
      } else {
        description = topicDescription(asset);
        metadata = {
          existingAssetTypes: asset.existingAssetTypes || [],
          linkOccurrenceCount: Number(asset.linkOccurrenceCount || 0),
        };
      }
      // Importing source descriptions must not discard separately reviewed uses.
      if (existingMetadata.classification) metadata.classification = existingMetadata.classification;
      upsert.run(userId, asset.key, asset.owner, asset.name, asset.repositoryUrl,
        description, JSON.stringify(asset.topics || []),
        Number(asset.sourcePostCount || 0), Number(asset.targetLinkCount || 0), JSON.stringify(metadata));
      const repositoryId = getRepository.get(userId, asset.key).id;
      deleteSources.run(repositoryId);
      deleteLinks.run(repositoryId);
      let sourceCount = 0;
      for (const source of asset.sourcePosts || []) {
        const inbox = findInbox.get(userId, String(source.externalId || ""));
        if (!inbox) continue;
        sourceCount += insertSource.run(repositoryId, inbox.id, String(source.externalId)).changes;
      }
      let linkCount = 0;
      for (const link of asset.targetLinks || []) {
        linkCount += insertLink.run(repositoryId, String(link.url || ""), String(link.kind || "repository")).changes;
      }
      updateCounts.run(sourceCount, linkCount, repositoryId);
      repositories += 1;
      sources += sourceCount;
      links += linkCount;
    }
    db.exec("COMMIT");
    return { repositories, sources, links };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listRepositoryAssets(userId, { publicOnly = false } = {}) {
  const visibility = publicOnly ? "AND i.visibility = 'public' AND i.status = 'pending'" : "";
  const rows = db.prepare(`
    SELECT r.repo_key AS repoKey, r.owner, r.name, r.repository_url AS repositoryUrl,
      r.description, r.topics, r.personal_status AS personalStatus,
      ${publicOnly ? "''" : "r.personal_note"} AS personalNote,
      COUNT(DISTINCT rs.inbox_id) AS sourcePostCount,
      r.target_link_count AS targetLinkCount, r.metadata,
      r.created_at AS createdAt, r.updated_at AS updatedAt
    FROM repository_assets r
    JOIN repository_sources rs ON rs.repository_id = r.id
    JOIN inbox i ON i.id = rs.inbox_id ${visibility}
    WHERE r.user_id = ?
    GROUP BY r.id
    ORDER BY sourcePostCount DESC, r.repo_key ASC
  `).all(userId);
  return rows.map(repositoryRow);
}

// Only called inside the explicit-publication transaction. Existing descriptions,
// classifications and saved links remain authoritative; this is additive indexing.
export function indexPublishedRepositories(userId,{source,article,kind}) {
  if(!(article.assets||[kind]).includes('repository'))return;
  if(!db.prepare("SELECT 1 FROM inbox WHERE id=? AND user_id=? AND visibility='public' AND status='pending'").get(source.id,userId))return;
  const matches=[...source.links,source.url,...(source.content.match(/https:\/\/github\.com\/[^\s<>"\u3000]+/g)||[])]
    .flatMap(value=>{try{const match=parseGitHubRepositoryLink(value);
      return match&&/^[a-zA-Z0-9_-]+$/.test(match.owner)&&/^[a-zA-Z0-9_.-]+$/.test(match.name)?[match]:[];}catch{return [];}});
  const keys=new Set(matches.map(item=>item.key));
  for(const item of matches) {
    const description=keys.size===1?article.summary:`收藏「${article.title}」提到了 ${item.owner}/${item.name}；该仓库的单独说明待补充。`;
    db.prepare(`INSERT OR IGNORE INTO repository_assets(user_id,repo_key,owner,name,repository_url,description,topics,metadata)
      VALUES(?,?,?,?,?,?,?,?)`).run(userId,item.key,item.owner,item.name,item.repositoryUrl,description,JSON.stringify(article.topics||[]),
      JSON.stringify({descriptionProvenance:'sources',pipeline:true}));
    const id=db.prepare('SELECT id FROM repository_assets WHERE user_id=? AND repo_key=?').get(userId,item.key).id;
    db.prepare('INSERT OR IGNORE INTO repository_sources VALUES(?,?,?)').run(id,source.id,source.externalId);
    db.prepare('INSERT OR IGNORE INTO repository_links VALUES(?,?,?)').run(id,item.targetUrl,item.kind);
    db.prepare(`UPDATE repository_assets SET source_post_count=(SELECT count(*) FROM repository_sources WHERE repository_id=?),
      target_link_count=(SELECT count(*) FROM repository_links WHERE repository_id=?) WHERE id=?`).run(id,id,id);
  }
}

export function getRepositoryAsset(userId, key, { publicOnly = false } = {}) {
  const row = db.prepare(`
    SELECT repo_key AS repoKey, owner, name, repository_url AS repositoryUrl,
      description, topics, personal_status AS personalStatus,
      ${publicOnly ? "''" : "personal_note"} AS personalNote,
      source_post_count AS sourcePostCount, target_link_count AS targetLinkCount,
      metadata, created_at AS createdAt, updated_at AS updatedAt, id
    FROM repository_assets WHERE user_id = ? AND repo_key = ?
  `).get(userId, String(key || "").toLowerCase());
  if (!row) return null;
  const visibility = publicOnly ? "AND i.visibility = 'public' AND i.status = 'pending'" : "";
  const sources = db.prepare(`
    SELECT i.id, i.external_id AS externalId, i.title, i.url, i.author, i.content,
      i.metrics, i.ai_type AS aiType
    FROM repository_sources rs
    JOIN inbox i ON i.id = rs.inbox_id
    WHERE rs.repository_id = ? ${visibility}
    ORDER BY i.id DESC
  `).all(row.id).map((source) => ({
    ...source,
    metrics: parsed(source.metrics, {}),
    excerpt: String(source.content || "").replace(/\s+/g, " ").trim().slice(0, 260),
    content: undefined,
  }));
  if (publicOnly && !sources.length) return null;
  const targetLinks = db.prepare(`
    SELECT url, kind FROM repository_links WHERE repository_id = ? ORDER BY kind, url
  `).all(row.id);
  const relatedKnowledge = db.prepare(`
    SELECT DISTINCT k.id, k.title, k.summary, k.verification_status AS verificationStatus
    FROM repository_sources rs
    JOIN knowledge_sources ks ON ks.inbox_id = rs.inbox_id
    JOIN knowledge k ON k.id = ks.knowledge_id
    WHERE rs.repository_id = ? AND k.user_id = ?
      ${publicOnly ? PUBLIC_KNOWLEDGE_FILTER : ""}
    ORDER BY k.updated_at DESC
  `).all(row.id,userId);
  return {
    ...repositoryRow({ ...row, sourcePostCount: sources.length }),
    sources,
    targetLinks,
    relatedKnowledge,
  };
}

export function updateRepositoryStatus(userId, key, status) {
  if (!STATUS_VALUES.has(status)) return false;
  return db.prepare(`
    UPDATE repository_assets SET personal_status = ?, updated_at = datetime('now')
    WHERE user_id = ? AND repo_key = ?
  `).run(status, userId, String(key || "").toLowerCase()).changes > 0;
}

/** Update one source-grounded description without touching status, links, or evidence. */
export function updateRepositoryEnrichment(userId, key, { description, metadata = {} } = {}) {
  const repoKey = String(key || "").toLowerCase();
  const existing = db.prepare(`
    SELECT metadata FROM repository_assets WHERE user_id = ? AND repo_key = ?
  `).get(userId, repoKey);
  if (!existing) return false;
  const mergedMetadata = { ...parsed(existing.metadata, {}), ...metadata };
  return db.prepare(`
    UPDATE repository_assets SET description = ?, metadata = ?, updated_at = datetime('now')
    WHERE user_id = ? AND repo_key = ?
  `).run(String(description || ""), JSON.stringify(mergedMetadata), userId, repoKey).changes > 0;
}

const PROMPT_CATEGORY = {
  image_generation: "图像生成",
  video_generation: "视频生成",
  writing: "写作",
  research: "研究",
  coding: "编程",
  agent_system: "Agent 系统",
  automation: "自动化",
  social_content: "社媒内容",
  other: "其他",
};

function promptTags(facets, tools = []) {
  const values = [facets.subject?.value, facets.scenario?.value, facets.style?.value, ...tools];
  for (const [name, signal] of Object.entries(facets.signals || {})) {
    if (signal?.value) values.push(name);
  }
  return [...new Set(values.filter((value) => value && value !== "none" && value !== "not_applicable"))].join(",");
}

export function replacePromptRefinements(userId, entries) {
  const findInbox = db.prepare(`
    SELECT id FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?
  `);
  const upsertFacet = db.prepare(`
    INSERT INTO x_prompt_facets
      (user_id, inbox_id, external_id, version, kind, completeness, subject, scenario,
       style, reusability, needs_review, decision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, inbox_id) DO UPDATE SET
      external_id = excluded.external_id, version = excluded.version, kind = excluded.kind,
      completeness = excluded.completeness, subject = excluded.subject,
      scenario = excluded.scenario, style = excluded.style,
      reusability = excluded.reusability, needs_review = excluded.needs_review,
      decision = excluded.decision, updated_at = datetime('now')
  `);
  const findPrompt = db.prepare(`
    SELECT id FROM prompts WHERE user_id = ? AND source_inbox_id = ?
  `);
  const insertPrompt = db.prepare(`
    INSERT INTO prompts
      (user_id, title, text, category, image, model, tags, sns_url, sns_url_normalized,
       sns_type, note, kind, summary, prompt_text_raw, media, source_url, source_author,
       source_content, status, source_inbox_id, facet_data, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?, datetime('now'))
  `);
  const updatePrompt = db.prepare(`
    UPDATE prompts SET title = ?, text = ?, category = ?, tags = ?, sns_url = ?,
      sns_url_normalized = ?, note = ?, kind = ?, summary = ?, prompt_text_raw = ?,
      media = ?, source_url = ?, source_author = ?, source_content = ?, facet_data = ?,
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    let facetsImported = 0;
    let promptsCreated = 0;
    let promptsUpdated = 0;
    for (const entry of entries) {
      const inbox = findInbox.get(userId, String(entry.externalId || ""));
      if (!inbox) continue;
      const facets = entry.facets || {};
      upsertFacet.run(userId, inbox.id, String(entry.externalId), facets.version || "",
        facets.kind?.value || "other", facets.completeness?.value || "not_prompt",
        facets.subject?.value || "none", facets.scenario?.value || "other",
        facets.style?.value || "not_applicable", Number(facets.reusability?.value || 0),
        facets.needsReview ? 1 : 0, JSON.stringify(facets));
      facetsImported += 1;

      const reusable = facets.kind?.value !== "not_reusable_prompt" &&
        facets.completeness?.value === "full_prompt";
      if (!reusable) continue;
      const source = entry.source || {};
      const category = PROMPT_CATEGORY[facets.kind?.value] || "其他";
      const tags = promptTags(facets, entry.tools || []);
      const note = `由 Jev ${facets.model || ""} 细分；完整度为完整提示词，复用评分 ${Number(facets.reusability?.value || 0).toFixed(2)}。`;
      const summary = String(source.title || "").slice(0, 240);
      const values = [String(source.title || "未命名提示词").slice(0, 160), String(source.content || ""),
        category, tags, source.url || "", source.url || "", note, facets.kind?.value || "other",
        summary, source.content || "", JSON.stringify(source.media || []), source.url || "",
        source.author || "", source.content || "", JSON.stringify(facets)];
      const existing = findPrompt.get(userId, inbox.id);
      if (existing) {
        updatePrompt.run(...values, existing.id, userId);
        promptsUpdated += 1;
      } else {
        insertPrompt.run(userId, values[0], values[1], values[2], "", values[3], values[4], values[5],
          values[6], values[7], values[8], values[9], values[10], values[11], values[12], values[13],
          inbox.id, values[14]);
        promptsCreated += 1;
      }
    }
    db.exec("COMMIT");
    return { facetsImported, promptsCreated, promptsUpdated };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function replaceAssetFacets(userId, entries) {
  const findInbox = db.prepare(`
    SELECT id FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO x_asset_facets
      (user_id, inbox_id, external_id, version, source_form, primary_route,
       content_sufficiency, reuse_value, derived_assets, needs_review, decision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, inbox_id) DO UPDATE SET
      external_id = excluded.external_id, version = excluded.version,
      source_form = excluded.source_form, primary_route = excluded.primary_route,
      content_sufficiency = excluded.content_sufficiency, reuse_value = excluded.reuse_value,
      derived_assets = excluded.derived_assets, needs_review = excluded.needs_review,
      decision = excluded.decision, updated_at = datetime('now')
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    let imported = 0;
    for (const entry of entries) {
      const inbox = findInbox.get(userId, String(entry.externalId || ""));
      if (!inbox) continue;
      const facets = entry.facets || {};
      upsert.run(userId, inbox.id, String(entry.externalId), facets.version || "",
        facets.sourceForm?.value || "other", facets.primaryRoute?.value || "review",
        facets.contentSufficiency?.value || "unavailable", Number(facets.reuseValue?.value || 0),
        JSON.stringify(facets.derivedAssets || []), facets.needsReview ? 1 : 0, JSON.stringify(facets));
      imported += 1;
    }
    db.exec("COMMIT");
    return { imported };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseKnowledgeMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
  const title = titleIndex >= 0 ? lines[titleIndex].replace(/^#\s+/, "").trim() : "未命名知识";
  const bodyLines = lines.slice(titleIndex + 1);
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  if (/^状态[　\s]/.test(bodyLines[0] || "")) bodyLines.shift();
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  const body = bodyLines.join("\n").trim();
  const summary = body.split(/\n\s*\n/).find((paragraph) => paragraph && !paragraph.startsWith("#")) || "";
  return { title, body, summary: summary.replace(/\[S:\d+\]/g, "").trim().slice(0, 420) };
}

export function upsertKnowledgeArticle(userId, { subjectId, markdown, tags = [], claims = [] }) {
  const article = parseKnowledgeMarkdown(markdown);
  const sourceIds = [...new Set([...String(markdown).matchAll(/\[S:([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]))];
  const allSupported = claims.length > 0 && claims.every((claim) => claim.check?.verdict?.value === "supported");
  const status = allSupported ? "ready" : "draft";
  const verificationStatus = allSupported ? "verified" : "needs_review";
  const existing = db.prepare(`
    SELECT id, version FROM knowledge WHERE user_id = ? AND subject_id = ?
  `).get(userId, subjectId);
  const sourceUrl = sourceIds.length ? db.prepare(`
    SELECT url FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?
  `).get(userId, sourceIds[0])?.url || "" : "";

  db.exec("BEGIN IMMEDIATE");
  try {
    let knowledgeId;
    if (existing) {
      db.prepare(`
        UPDATE knowledge SET title = ?, summary = ?, body = ?, tags = ?, source_url = ?,
          status = ?, verification_status = ?, version = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?
      `).run(article.title, article.summary, article.body, tags.join(","), sourceUrl,
        status, verificationStatus, Number(existing.version || 1) + 1, existing.id, userId);
      knowledgeId = existing.id;
    } else {
      knowledgeId = Number(db.prepare(`
        INSERT INTO knowledge
          (user_id, title, summary, body, tags, source_url, status, subject_id,
           verification_status, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(userId, article.title, article.summary, article.body, tags.join(","), sourceUrl,
        status, subjectId, verificationStatus).lastInsertRowid);
    }
    db.prepare("DELETE FROM knowledge_sources WHERE knowledge_id = ?").run(knowledgeId);
    db.prepare("DELETE FROM knowledge_claims WHERE knowledge_id = ?").run(knowledgeId);
    const findInbox = db.prepare(`
      SELECT id FROM inbox WHERE user_id = ? AND source = 'x' AND external_id = ?
    `);
    const insertSource = db.prepare(`
      INSERT OR IGNORE INTO knowledge_sources
        (knowledge_id, inbox_id, external_id, citation_key) VALUES (?, ?, ?, ?)
    `);
    for (const externalId of sourceIds) {
      const inbox = findInbox.get(userId, externalId);
      if (inbox) insertSource.run(knowledgeId, inbox.id, externalId, `S:${externalId}`);
    }
    const insertClaim = db.prepare(`
      INSERT INTO knowledge_claims
        (knowledge_id, claim_id, section, claim_text, source_ids, verdict, confidence, needs_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const claim of claims) {
      insertClaim.run(knowledgeId, claim.id, claim.section || "", claim.text || "",
        JSON.stringify(claim.sourceIds || []), claim.check?.verdict?.value || "unsupported",
        Number(claim.check?.verdict?.answer?.confidence || 0), claim.check?.needsReview ? 1 : 0);
    }
    db.exec("COMMIT");
    return { knowledgeId, sources: sourceIds.length, claims: claims.length, status, verificationStatus };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function knowledgeSummaryRow(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    tags: String(row.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    status: row.status,
    subjectId: row.subjectId,
    verificationStatus: row.verificationStatus,
    version: Number(row.version || 1),
    sourceCount: Number(row.sourceCount || 0),
    claimCount: Number(row.claimCount || 0),
    updatedAt: row.updatedAt,
  };
}

export function listKnowledgeArticles(userId, { publicOnly = false } = {}) {
  return db.prepare(`
    SELECT k.id, k.title, k.summary, k.tags, k.status, k.subject_id AS subjectId,
      k.verification_status AS verificationStatus, k.version, k.updated_at AS updatedAt,
      COUNT(DISTINCT ks.inbox_id) AS sourceCount,
      COUNT(DISTINCT kc.claim_id) AS claimCount
    FROM knowledge k
    LEFT JOIN knowledge_sources ks ON ks.knowledge_id = k.id
    LEFT JOIN knowledge_claims kc ON kc.knowledge_id = k.id
    WHERE k.user_id = ? ${publicOnly ? PUBLIC_KNOWLEDGE_FILTER : ""}
    GROUP BY k.id ORDER BY k.updated_at DESC, k.id DESC
  `).all(userId).map(knowledgeSummaryRow);
}

export function getKnowledgeArticle(userId, id, { publicOnly = false } = {}) {
  const row = db.prepare(`
    SELECT id, title, summary, body, tags, status, subject_id AS subjectId,
      verification_status AS verificationStatus, version, updated_at AS updatedAt
    FROM knowledge k WHERE k.user_id = ? AND k.id = ?
      ${publicOnly ? PUBLIC_KNOWLEDGE_FILTER : ""}
  `).get(userId, id);
  if (!row) return null;
  const visibility = publicOnly ? "AND i.visibility = 'public' AND i.status = 'pending'" : "";
  const sources = db.prepare(`
    SELECT i.id, i.external_id AS externalId, i.title, i.url, i.author, i.content, ks.citation_key AS citationKey
    FROM knowledge_sources ks JOIN inbox i ON i.id = ks.inbox_id
    WHERE ks.knowledge_id = ? ${visibility}
    ORDER BY ks.citation_key
  `).all(row.id).map((source) => ({
    ...source,
    excerpt: String(source.content || "").replace(/\s+/g, " ").trim().slice(0, 320),
    content: undefined,
  }));
  const claims = db.prepare(`
    SELECT claim_id AS id, section, claim_text AS text, source_ids AS sourceIds,
      verdict, confidence, needs_review AS needsReview
    FROM knowledge_claims WHERE knowledge_id = ? ORDER BY claim_id
  `).all(row.id).map((claim) => ({ ...claim, sourceIds: parsed(claim.sourceIds, []), needsReview: Boolean(claim.needsReview) }));
  const repositories = db.prepare(`
    SELECT DISTINCT r.repo_key AS key, r.owner, r.name, r.repository_url AS repositoryUrl
    FROM knowledge_sources ks
    JOIN repository_sources rs ON rs.inbox_id = ks.inbox_id
    JOIN repository_assets r ON r.id = rs.repository_id
    WHERE ks.knowledge_id = ? ORDER BY r.repo_key
  `).all(row.id);
  return {
    ...knowledgeSummaryRow({ ...row, sourceCount: sources.length, claimCount: claims.length }),
    body: row.body,
    sources,
    claims,
    repositories,
  };
}

export function listPromptAssets(userId, { publicOnly = false } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.text, p.category, p.tags, p.kind, p.summary,
      p.source_inbox_id AS sourceInboxId, p.source_url AS sourceUrl, p.source_author AS sourceAuthor,
      p.media AS savedMedia, i.media AS sourceMedia,
      p.status, p.rating, p.facet_data AS facetData, p.updated_at AS updatedAt
    FROM prompts p
    LEFT JOIN inbox i ON i.id = p.source_inbox_id AND i.user_id = p.user_id
    WHERE p.user_id = ? AND p.source_inbox_id IS NOT NULL
      ${publicOnly ? "AND i.visibility = 'public' AND i.status = 'pending'" : ""}
    ORDER BY p.id DESC
  `).all(userId);
  return rows.map(({ savedMedia, sourceMedia, ...row }) => {
    const originalMedia = parsed(sourceMedia, []);
    const importedMedia = parsed(savedMedia, []);
    return {
      ...row,
      media: Array.isArray(originalMedia) && originalMedia.length ? originalMedia
        : Array.isArray(importedMedia) ? importedMedia : [],
      tags: String(row.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      facets: parsed(row.facetData, {}),
      facetData: undefined,
    };
  });
}
