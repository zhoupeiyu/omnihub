import { CLASSIFICATION_VERSION, isValidClassification } from '../public/repository-taxonomy.js';

export const REPOSITORY_CURATION_FORMAT = 'omnihub-repository-curation-v1';

const REPOSITORY_KEY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION = /^[a-f0-9]{40}$/i;
const REVIEWED_AT = /^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-][0-2]\d:[0-5]\d)?)?$/;
const HAN = /[\u3400-\u9fff]/;

function fail(message) {
  throw new Error(message);
}

function parseObject(value, message) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(message);
    return parsed;
  } catch {
    fail(message);
  }
}

function validSourceUrl(value, key) {
  try {
    const url = new URL(value);
    const canonicalPath = `/${key}`.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      !url.username && !url.password && !url.port &&
      (pathname === canonicalPath || pathname.startsWith(`${canonicalPath}/`));
  } catch {
    return false;
  }
}

function validateClassification(value, key) {
  if (!isValidClassification(value) || value.version !== CLASSIFICATION_VERSION ||
    new Set(value.uses).size !== value.uses.length || new Set(value.forms).size !== value.forms.length) {
    fail(`Invalid classification: ${key}`);
  }
  return { version:value.version, uses:[...value.uses], forms:[...value.forms] };
}

function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('Curation packet must be an object');
  if (packet.format !== REPOSITORY_CURATION_FORMAT) fail('Unsupported curation packet format');
  if (typeof packet.username !== 'string' || !packet.username.trim()) fail('Packet username is required');
  if (typeof packet.reviewedAt !== 'string' || !REVIEWED_AT.test(packet.reviewedAt)) fail('Packet reviewedAt is invalid');
  if (!Array.isArray(packet.entries) || !packet.entries.length) fail('Packet entries are required');
  const keys = new Set();
  return {
    username:packet.username.trim(),
    reviewedAt:packet.reviewedAt,
    entries:packet.entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Invalid curation entry');
      const key = String(entry.key || '').trim();
      if (!REPOSITORY_KEY.test(key) || keys.has(key)) fail(`Duplicate or invalid repository key: ${key}`);
      keys.add(key);
      if (!entry.expected || typeof entry.expected !== 'object' ||
        typeof entry.expected.description !== 'string' || typeof entry.expected.metadata !== 'string' ||
        typeof entry.expected.updatedAt !== 'string') fail(`Missing expected source snapshot: ${key}`);
      if (typeof entry.description !== 'string' || !entry.description.trim() || !HAN.test(entry.description) || entry.description.length > 1200) {
        fail(`Description must be non-empty Chinese text: ${key}`);
      }
      if (typeof entry.sourceUrl !== 'string' || !validSourceUrl(entry.sourceUrl, key)) fail(`Official GitHub source is invalid: ${key}`);
      if (typeof entry.sourceRevision !== 'string' || !REVISION.test(entry.sourceRevision)) fail(`Source revision is invalid: ${key}`);
      return {
        key,
        expected:{ description:entry.expected.description, metadata:entry.expected.metadata, updatedAt:entry.expected.updatedAt },
        description:entry.description.trim(),
        classification:validateClassification(entry.classification,key),
        sourceUrl:entry.sourceUrl,
        sourceRevision:entry.sourceRevision.toLowerCase(),
      };
    }),
  };
}

function manualClassificationConflict(db, userId, entry) {
  const saved = db.prepare(`SELECT data,origin FROM library_curation
    WHERE user_id=? AND asset_type='repository' AND asset_key=?`).get(userId,entry.key);
  if (!saved || saved.origin !== 'manual') return false;
  const data = parseObject(saved.data, `Manual curation is malformed: ${entry.key}`);
  return JSON.stringify({uses:data.uses || [],forms:data.forms || []}) !==
    JSON.stringify({uses:entry.classification.uses,forms:entry.classification.forms});
}

function nextMetadata(current, entry, reviewedAt) {
  return {
    ...current,
    classification:{ ...current.classification, ...entry.classification, reviewedAt, method:'official-source-curation', sourceRevision:entry.sourceRevision },
    descriptionProvenance:'official_github',
    curatedAt:reviewedAt,
    officialSource:{ url:entry.sourceUrl, revision:entry.sourceRevision, reviewedAt },
  };
}

export function prepareRepositoryCurationImport(db, packet) {
  const clean = validatePacket(packet);
  const owner = db.prepare('SELECT id FROM users WHERE username=?').get(clean.username);
  if (!owner) fail(`Curation owner missing: ${clean.username}`);
  const read = db.prepare(`SELECT id,user_id,repo_key,description,metadata,updated_at,personal_status,personal_note
    FROM repository_assets WHERE user_id=? AND repo_key=?`);
  const plans = clean.entries.map(entry => {
    const row = read.get(owner.id,entry.key);
    if (!row) fail(`Repository missing for owner: ${entry.key}`);
    if (row.description !== entry.expected.description || row.metadata !== entry.expected.metadata || row.updated_at !== entry.expected.updatedAt) {
      fail(`Reviewed repository changed: ${entry.key}`);
    }
    if (manualClassificationConflict(db,owner.id,entry)) fail(`Manual classification would be overwritten: ${entry.key}`);
    const metadata = parseObject(row.metadata, `Repository metadata is malformed: ${entry.key}`);
    const next = nextMetadata(metadata,entry,clean.reviewedAt);
    return { ...entry, id:row.id, userId:owner.id, nextMetadata:JSON.stringify(next), nextUpdatedAt:clean.reviewedAt };
  });
  return { format:clean.format || REPOSITORY_CURATION_FORMAT, username:clean.username, reviewedAt:clean.reviewedAt, userId:owner.id, plans };
}

export function repositoryCurationSummary(plan) {
  return { username:plan.username, reviewedAt:plan.reviewedAt, entries:plan.plans.length, keys:plan.plans.map(item=>item.key) };
}

export function applyRepositoryCurationImport(db, plan) {
  if (!plan || !Number.isSafeInteger(plan.userId) || !Array.isArray(plan.plans) || !plan.plans.length) fail('Prepared curation plan is required');
  const update = db.prepare(`UPDATE repository_assets SET description=?,metadata=?,updated_at=?
    WHERE id=? AND user_id=? AND repo_key=? AND description IS ? AND metadata=? AND updated_at=?`);
  const readBack = db.prepare('SELECT description,metadata,updated_at FROM repository_assets WHERE id=? AND user_id=? AND repo_key=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of plan.plans) {
      if (manualClassificationConflict(db,plan.userId,item)) fail(`Manual classification would be overwritten: ${item.key}`);
      const changes = update.run(item.description,item.nextMetadata,item.nextUpdatedAt,item.id,plan.userId,item.key,
        item.expected.description,item.expected.metadata,item.expected.updatedAt).changes;
      if (changes !== 1) fail(`Repository changed during import: ${item.key}`);
      const stored = readBack.get(item.id,plan.userId,item.key);
      if (!stored || stored.description !== item.description || stored.metadata !== item.nextMetadata || stored.updated_at !== item.nextUpdatedAt) {
        fail(`Repository read-back mismatch: ${item.key}`);
      }
    }
    const quickCheck = db.prepare('PRAGMA quick_check').all().map(row=>Object.values(row)[0]);
    if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') fail(`SQLite quick_check failed: ${quickCheck.join(', ')}`);
    db.exec('COMMIT');
    return { ...repositoryCurationSummary(plan), written:plan.plans.length, quickCheck };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
