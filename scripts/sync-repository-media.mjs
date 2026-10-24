// Refresh only local media from the same pinned public documents as each guide.
// No database writes, model calls, credentials, publication or guide regeneration.
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {guideFilename, permittedMediaUrl} from '../lib/repository-guide-pipeline.js';
import {repositoryMediaCandidates, isAnimatedWebp, archiveRepositoryMedia} from '../lib/repository-guide-media.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const runOption = option('--run-dir', '');
if (!runOption) throw new Error('Provide --run-dir for the pinned source collection');
const run = path.resolve(runOption);
const assets = path.join(root, 'public/assets/repository-guides');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const inventory = await readJson(path.join(root, 'content/repository-guide-inventory.json'));
const requested = process.argv.flatMap((argument,index)=>argument === '--key' ? [process.argv[index+1]] : []);
if (requested.some(key=>!inventory.keys.includes(key))) throw new Error('Key outside public inventory');
const keys = requested.length ? [...new Set(requested)] : inventory.keys;
const concurrency = Number(option('--concurrency', '4'));
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid concurrency');
const maximumImages = 6;
const report = {updated: [], unchanged: 0, failures: []};
const safeFailure = error => /^[a-z_]+(?:_\d+)?$/.test(error.message) ? error.message : 'conversion_failed';


async function sync(key) {
  const file = guideFilename(key), output = path.join(assets, file);
  const guide = await readJson(output);
  if (guide.curated) { report.unchanged++; return; }
  let source;
  try { source = await readJson(path.join(run, 'sources', file)); }
  catch (error) { if (error.code === 'ENOENT') { report.unchanged++; return; } throw error; }
  if (!source.documents?.length || source.revision !== guide.sourceRevision) { report.unchanged++; return; }
  const candidates = repositoryMediaCandidates(source.documents);
  if (!candidates.length && !guide.media?.length) { report.unchanged++; return; }
  const media = [], failures = [], references = [];
  // Preserve existing reviewed images and captions; backfill animation metadata.
  for (const item of guide.media || []) {
    if (!/^\/assets\/repository-guides\/(?:media-[a-f0-9]{24}|toonflow-[a-z]+)\.webp$/.test(item.url)) continue;
    try {
      const bytes = await readFile(path.join(root, 'public', item.url));
      media.push({...item, animated:isAnimatedWebp(bytes)});
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let attempts = 0;
  for (const item of candidates) {
    if (media.some(existing => existing.originalUrl === item.url)) continue;
    if (media.length >= maximumImages || attempts >= 12) break;
    attempts++;
    try {
      if (!permittedMediaUrl(item.url)) throw new Error('unsupported_media_host');
      media.push(await archiveRepositoryMedia(item, assets));
    } catch (error) {
      const reason = safeFailure(error);
      failures.push({sourceUrl:item.sourceUrl, reason});
      // Unarchivable assets remain discoverable without arbitrary remote embeds.
      references.push({label:(item.alt || item.heading || '原文演示').slice(0,160),url:item.sourceUrl});
    }
  }
  const next = {...guide, media, mediaStatus:media.length ? 'archived' : candidates.length ? 'unavailable' : 'none_in_official_documents',mediaFailures:attempts ? failures : guide.mediaFailures || [],mediaReferences:attempts ? references : guide.mediaReferences || []};
  if (JSON.stringify(next) === JSON.stringify(guide)) { report.unchanged++; return; }
  const temporary = `${output}.pending`;
  await writeFile(temporary, JSON.stringify(next,null,2)+'\n');
  await rename(temporary, output);
  report.updated.push({key,before:guide.media?.length || 0,after:media.length,animated:media.filter(item=>item.animated).length,failures:failures.length});
  console.log(JSON.stringify(report.updated.at(-1)));
}

let next = 0;
await Promise.all(Array.from({length:Math.min(concurrency, keys.length)}, async () => {
  while (next < keys.length) {
    const key = keys[next++];
    try { await sync(key); }
    catch (error) { report.failures.push({key,reason:safeFailure(error)}); }
  }
}));
await mkdir(run, {recursive:true});
await writeFile(path.join(run, 'media-refresh-report.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({updated:report.updated.length,unchanged:report.unchanged,failures:report.failures}));
if (report.failures.length) process.exitCode = 1;
