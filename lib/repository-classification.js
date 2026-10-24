import { createHash } from 'node:crypto';
import { CLASSIFICATION_VERSION, SUBTOPICS, isValidClassification } from '../public/repository-taxonomy.js';
import { REVIEW_ROWS, REVIEW_KEYSET_HASH, REVIEW_FINDINGS, TRUNCATED_LINKS } from './repository-classification-review.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const keysetDigest = rows => digest(rows.map(row => row.key).join('\n'));
export const sourceDigest = row => digest(JSON.stringify([row.key,row.description,row.url,row.topics]));

export function parseReview(text = REVIEW_ROWS, count = 597) {
  const entries = new Map();
  for (const line of text.trim().split('\n')) {
    const [ordinal, usesText, formsText, extra] = line.split('|');
    const index = Number(ordinal);
    const classification = {version:CLASSIFICATION_VERSION,uses:usesText?.split(','),forms:formsText?.split(',')};
    if (extra !== undefined || !Number.isInteger(index) || index < 1 || index > count || entries.has(index) || !isValidClassification(classification)) throw new Error(`Invalid review row ${ordinal}`);
    if (new Set(classification.uses).size !== classification.uses.length || new Set(classification.forms).size !== classification.forms.length) throw new Error(`Duplicate label at ${index}`);
    entries.set(index,classification);
  }
  if (entries.size !== count) throw new Error(`Incomplete review: ${entries.size}/${count}`);
  return entries;
}

export function buildClassificationPlan(rows, snapshot, {userId, caches = new Map()} = {}) {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('Explicit user ID required');
  if (keysetDigest(rows) !== REVIEW_KEYSET_HASH || keysetDigest(snapshot.rows) !== REVIEW_KEYSET_HASH) throw new Error('Reviewed keyset changed; re-review required');
  const reviews = parseReview();
  return rows.map((row, offset) => {
    const original = snapshot.rows[offset];
    if (row.userId !== userId || original.userId !== userId || row.id !== original.id || sourceDigest(row) !== sourceDigest(original)) throw new Error(`Reviewed source changed at row ${offset+1}`);
    const index = offset+1;
    const metadata = JSON.parse(row.metadata || '{}');
    const cached = caches.get(index);
    if (cached && cached.key !== row.key) throw new Error(`README cache mismatch at ${index}`);
    const finding = REVIEW_FINDINGS[index] || {};
    const classification = {
      ...reviews.get(index),reviewedAt:'2026-09-28',method:'source-reviewed',
      sourceDigest:sourceDigest(row),
      basis:cached?.status === 'found' ? 'github_readme' : ['github_description','github_readme'].includes(metadata.descriptionProvenance) ? `stored_${metadata.descriptionProvenance}` : 'saved_source_context',
      ...finding,
    };
    if (cached?.status === 'found') classification.evidenceUrl = cached.url;
    if (finding.candidateUrl) classification.evidenceUrl = finding.candidateUrl;
    if (TRUNCATED_LINKS.has(index)) classification.linkStatus = 'truncated';
    else if (cached?.status === 'not_found') classification.linkStatus = 'unavailable';
    if (classification.linkStatus) classification.linkCheckedAt = cached?.checkedAt || '2026-09-28';
    if (cached?.status === 'not_found') classification.basis = finding.candidateUrl ? 'related_official_repository' : 'saved_source_context';
    return {id:row.id,key:row.key,userId,previousMetadata:row.metadata,
      reviewedSource:{description:row.description,url:row.url,topics:row.topics},metadata:{...metadata,classification}};
  });
}

export function applyClassificationPlan(db, plan) {
  const update = db.prepare('UPDATE repository_assets SET metadata=? WHERE id=? AND user_id=? AND repo_key=? AND metadata=? AND description IS ? AND repository_url IS ? AND topics IS ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of plan) {
      if (!isValidClassification(item.metadata.classification)) throw new Error(`Invalid classification: ${item.key}`);
      const next = JSON.stringify(item.metadata);
      if (update.run(next,item.id,item.userId,item.key,item.previousMetadata,item.reviewedSource.description,item.reviewedSource.url,item.reviewedSource.topics).changes !== 1) throw new Error(`Repository changed during review: ${item.key}`);
      const stored = db.prepare('SELECT metadata FROM repository_assets WHERE id=? AND user_id=?').get(item.id,item.userId);
      if (stored.metadata !== next) throw new Error(`Read-back mismatch: ${item.key}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function classificationCounts(plan) {
  const topics = {}, uses = {}, forms = {};
  for (const {metadata:{classification:c}} of plan) {
    for (const topic of new Set(c.uses.map(use => SUBTOPICS.get(use).topic))) topics[topic] = (topics[topic] || 0)+1;
    for (const use of c.uses) uses[use] = (uses[use] || 0)+1;
    for (const form of c.forms) forms[form] = (forms[form] || 0)+1;
  }
  return {repositories:plan.length,topics,uses,forms,linkIssues:plan.filter(item=>item.metadata.classification.linkStatus).length};
}
