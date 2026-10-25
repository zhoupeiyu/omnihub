import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { validateRepositoryGuide } from '../public/repository-guides.js';

// Guides produced for a person's workspace deliberately live outside public/
// so a static deployment cannot disclose which repositories that person saved.
const PRIVATE_GUIDE_DIRECTORY = path.join(DATA_DIR, 'repository-guides', 'private');
const GUIDE_KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const MEDIA_FILE = /^media-[a-f0-9]{12,64}\.webp$/;
const MAX_GUIDE_BYTES = 2 * 1024 * 1024;

function normalizeKey(value) {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  return GUIDE_KEY.test(key) ? key : '';
}

function guideFile(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return '';
  return path.join(PRIVATE_GUIDE_DIRECTORY, `${normalized.replace('/', '~')}.json`);
}

function mediaFile(key, filename) {
  if (!normalizeKey(key) || !MEDIA_FILE.test(filename || '')) return '';
  return path.join(PRIVATE_GUIDE_DIRECTORY, filename);
}

function mediaFilename(key, value) {
  if (typeof value !== 'string') return '';
  const staticMatch = value.match(/^\/assets\/repository-guides\/(media-[a-f0-9]{12,64}\.webp)$/);
  if (staticMatch) return staticMatch[1];
  const apiMatch = value.match(/^\/api\/repositories\/[^/]+\/[^/]+\/guide-media\/(media-[a-f0-9]{12,64}\.webp)$/);
  return apiMatch && value === mediaUrl(key, apiMatch[1]) ? apiMatch[1] : '';
}

function mediaUrl(key, filename) {
  const [owner, name] = key.split('/');
  return `/api/repositories/${owner}/${name}/guide-media/${filename}`;
}

async function existingMedia(key, rawMedia) {
  const media = [];
  for (const item of Array.isArray(rawMedia) ? rawMedia : []) {
    const filename = mediaFilename(key, item?.url);
    const file = mediaFile(key, filename);
    if (!file) continue;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size < 1) continue;
      media.push({ ...item, url: mediaUrl(key, filename) });
    } catch { /* A guide can still render when an optional media download failed. */ }
  }
  return media;
}

export async function readPrivateRepositoryGuide(key) {
  const normalized = normalizeKey(key);
  const file = guideFile(normalized);
  if (!file) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 1 || info.size > MAX_GUIDE_BYTES) return null;
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (normalizeKey(raw?.key) !== normalized) return null;
    const media = await existingMedia(normalized, raw.media);
    return validateRepositoryGuide({ ...raw, key: normalized, media }, normalized);
  } catch { return null; }
}

export async function readPrivateRepositoryGuideMedia(key, filename) {
  const normalized = normalizeKey(key);
  if (!normalized || !MEDIA_FILE.test(filename || '')) return null;
  const guide = await readPrivateRepositoryGuide(normalized);
  if (!guide?.media?.some(item => item.url === mediaUrl(normalized, filename))) return null;
  const file = mediaFile(normalized, filename);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 1) return null;
    return { file, size: info.size };
  } catch { return null; }
}
