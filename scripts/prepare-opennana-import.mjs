#!/usr/bin/env node
/**
 * Prepare (only) an OpenNana prompt import.  This tool never talks to COS and
 * never writes the OmniHub database.  It turns the public dataset into a
 * reviewable JSON plan, including the exact original image URLs and the COS
 * object keys a later, explicitly-approved importer would use.
 *
 * Usage:
 *   node scripts/prepare-opennana-import.mjs \
 *     --input work/opennana/prompts.json --db data/app.db \
 *     --owner zane --out work/opennana/import-plan.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATASET_URL = 'https://raw.githubusercontent.com/songguoxs/gpt4o-image-prompts/master/data/prompts.json';
const REPOSITORY_URL = 'https://github.com/songguoxs/gpt4o-image-prompts';
const IMAGE_ROOT = 'https://raw.githubusercontent.com/songguoxs/gpt4o-image-prompts/master/';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function text(value, limit = 16_000) { return String(value || '').trim().slice(0, limit); }
function canonical(value) { return text(value).replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function safeImagePath(value) {
  const path = text(value, 300);
  return /^images\/[A-Za-z0-9._-]+$/.test(path) ? path : '';
}
function choosePrompts(item) {
  const values = Array.isArray(item?.prompts) ? item.prompts.map(value => text(value)).filter(Boolean) : [];
  const chinese = values.find(value => /[\u3400-\u9fff]/.test(value)) || '';
  const english = values.find(value => !/[\u3400-\u9fff]/.test(value)) || values[0] || '';
  return { chinese, english, display: chinese || english };
}
function source(value) {
  const url = text(value?.url, 700);
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return { author: text(value?.name, 160), url: parsed.href };
  } catch { return { author: text(value?.name, 160), url: '' }; }
}

const input = resolve(argument('--input', 'work/opennana/prompts.json'));
const database = resolve(argument('--db', 'data/app.db'));
const ownerName = argument('--owner', 'zane');
const output = resolve(argument('--out', 'work/opennana/import-plan.json'));
const record = JSON.parse(readFileSync(input, 'utf8'));
if (!record || !Array.isArray(record.items) || !Number.isSafeInteger(record.total)) throw new Error('Invalid OpenNana prompts.json');

const db = new DatabaseSync(database, { readOnly: true });
const owner = db.prepare('SELECT id, username FROM users WHERE username=?').get(ownerName);
if (!owner) throw new Error(`Owner not found: ${ownerName}`);
const existing = db.prepare(`SELECT id, text, source_url AS sourceUrl FROM prompts WHERE user_id=?`).all(owner.id);
db.close();
const textIndex = new Map(existing.map(row => [canonical(row.text), row.id]));
const sourceIndex = new Map(existing.filter(row => text(row.sourceUrl)).map(row => [text(row.sourceUrl), row.id]));

const seen = new Map();
const skipped = { malformed: [], duplicateDataset: [], existingText: [], existingSource: [] };
const items = [];
for (const raw of record.items) {
  const id = Number(raw?.id);
  const slug = text(raw?.slug, 120);
  const title = text(raw?.title, 240);
  const prompts = choosePrompts(raw);
  if (!Number.isSafeInteger(id) || id < 1 || !slug || !title || !prompts.display) {
    skipped.malformed.push({ id: Number.isSafeInteger(id) ? id : null, slug, title });
    continue;
  }
  const fingerprint = digest(canonical(prompts.english || prompts.display));
  if (seen.has(fingerprint)) {
    skipped.duplicateDataset.push({ id, slug, duplicateOf: seen.get(fingerprint) });
    continue;
  }
  seen.set(fingerprint, id);
  const original = source(raw?.source);
  if (textIndex.has(canonical(prompts.display))) {
    skipped.existingText.push({ id, slug, existingPromptId: textIndex.get(canonical(prompts.display)) });
    continue;
  }
  if (original.url && sourceIndex.has(original.url)) {
    skipped.existingSource.push({ id, slug, existingPromptId: sourceIndex.get(original.url) });
    continue;
  }
  const imagePaths = [...new Set((Array.isArray(raw?.images) ? raw.images : []).map(safeImagePath).filter(Boolean))];
  const coverPath = safeImagePath(raw?.coverImage);
  if (coverPath && !imagePaths.includes(coverPath)) imagePaths.unshift(coverPath);
  const tags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map(value => text(value, 80)).filter(Boolean))];
  const primaryImage = imagePaths[0] || '';
  items.push({
    importKey: `opennana:${slug}`,
    sourceId: id,
    slug,
    title,
    text: prompts.display,
    promptTextRaw: prompts.english || prompts.display,
    promptTextClean: prompts.display,
    category: '图像生成',
    kind: 'creative',
    summary: text(raw?.description, 600),
    tags,
    model: text(raw?.model, 160),
    sourceUrl: original.url || REPOSITORY_URL,
    sourceAuthor: original.author || 'OpenNana community dataset',
    sourceContent: `OpenNana ${slug}; origin: ${text(raw?.originFile, 200) || 'unknown'}`,
    facetData: { manualAsset: true, importSource: 'opennana', importKey: `opennana:${slug}`, sourceId: id, originFile: text(raw?.originFile, 200), englishPrompt: prompts.english, chinesePrompt: prompts.chinese },
    imagePlan: imagePaths.map((path, index) => ({
      role: index === 0 ? 'cover' : 'reference',
      sourceUrl: `${IMAGE_ROOT}${path}`,
      sourcePath: path,
      cosKey: `creative-media/v1/users/${owner.id}/opennana/${slug}/${path.split('/').at(-1)}`,
    })),
    image: primaryImage ? '' : '',
    media: [],
    fingerprint,
  });
}

const imageObjects = items.flatMap(item => item.imagePlan);
const plan = {
  version: 1,
  mode: 'dry-run',
  createdAt: new Date().toISOString(),
  dataset: { url: DATASET_URL, repositoryUrl: REPOSITORY_URL, generatedAt: record.generatedAt || '', declaredTotal: record.total, downloadedSha256: digest(readFileSync(input)) },
  target: { owner: owner.username, userId: owner.id, table: 'prompts', visibility: 'private', category: '图像生成' },
  counts: { sourceItems: record.items.length, eligiblePrompts: items.length, imageObjects: imageObjects.length, itemsWithoutImages: items.filter(item => !item.imagePlan.length).length, ...Object.fromEntries(Object.entries(skipped).map(([name, values]) => [name, values.length])) },
  deduplication: { existingPromptRows: existing.length, textAlgorithm: 'trim + collapse whitespace + lowercase', datasetAlgorithm: 'sha256 of normalized English prompt or display prompt', skipped },
  limitations: [
    'This is a dry-run only: no COS object, database row, or deployment was changed.',
    'Image URLs are public GitHub raw URLs at preparation time; each object must be fetched, MIME-checked, size-limited and checksum-recorded before COS upload.',
    'The upstream repository did not expose a LICENSE file at the checked path; confirm redistribution/hosting terms before any non-private use.',
  ],
  items,
};
writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, ...plan.counts, owner: owner.username, datasetSha256: plan.dataset.downloadedSha256 }, null, 2));
