import { createHash } from 'node:crypto';

export const REFERENCE_KINDS = ['face', 'pose', 'costume'];
export const REFERENCE_REPOSITORY = 'sleepy-zone/ai-ref-library-cn';
export const REFERENCE_COLLECTION = Object.freeze({ id: 'gia-ai-reference', name: '人物造型参考 · あぎ / ギア' });
export const referenceDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const stemPattern = /^[A-Za-z0-9_-]{1,100}$/;
const origins = { face: 'https://ai-portrait-gallery.pages.dev/', pose: 'https://ai-pose-gallery.pages.dev/', costume: 'https://ai-costume-gallery.pages.dev/' };

// Upstream files contain a JSON assignment, not an executable input contract.
export function parseReferenceData(kind, text) {
  if (!REFERENCE_KINDS.includes(kind) || Buffer.byteLength(text) > 8 * 1024 ** 2) throw new Error('invalid_reference_data');
  const match = new RegExp(`^\\s*window\\.LIB_${kind.toUpperCase()}\\s*=([\\s\\S]*?);?\\s*$`).exec(text);
  if (!match) throw new Error('invalid_reference_assignment');
  const value = JSON.parse(match[1]);
  if (!value.data || !value.img || Array.isArray(value.img)) throw new Error('invalid_reference_data');
  const rows = [], ids = new Set();
  const label = value => String(value || '').slice(0, 300);
  function append(stem, fields) {
    if (!stemPattern.test(stem) || ids.has(stem)) throw new Error('invalid_reference_id');
    const thumbnailPath = value.img[stem];
    if (thumbnailPath !== `thumbs/${stem}.webp`) throw new Error('invalid_reference_thumbnail');
    ids.add(stem);
    const originalPath = kind === 'face' ? `img/full/${stem}.png` : kind === 'pose' ? `img/${stem}.png` : `png/${stem}.png`;
    rows.push({ id: `${kind}:${stem}`, stem, kind, collectionId: REFERENCE_COLLECTION.id, collectionName: REFERENCE_COLLECTION.name, thumbnailPath, sourceUrl: origins[kind],
      originalSourceUrl: new URL(originalPath, origins[kind]).href,
      license: kind === 'face' ? 'CC0-1.0' : 'personal-reference', ...fields });
  }
  if (kind === 'face') {
    if (!Array.isArray(value.data.items) || !Array.isArray(value.data.sections) || !Array.isArray(value.data.hairs)) throw new Error('invalid_face_index');
    for (const item of value.data.items) {
      const category = value.data.sections[item.s]?.name, hair = value.data.hairs[item.h]?.name;
      if (!category || !hair) throw new Error('invalid_face_category');
      append(item.id, { title: label(item.sz || `${hair} · ${category}`), category: label(category), hair: label(hair),
        tags: [hair, category, item.sz, item.sj].filter(Boolean).map(label), groupId: item.id, angle: '' });
    }
  } else if (kind === 'costume') {
    if (!Array.isArray(value.data.items) || !Array.isArray(value.data.cats)) throw new Error('invalid_costume_index');
    for (const item of value.data.items) {
      const category = value.data.cats[item.c]?.name;
      if (!category || !Array.isArray(item.zh) || !Array.isArray(item.kw)) throw new Error('invalid_costume_category');
      append(item.id, { title: label(item.zh.slice(0, 4).join(' · ') || item.id), category: label(category), hair: '',
        tags: [...item.zh, ...item.kw].slice(0, 50).map(label), groupId: item.id, angle: '' });
    }
  } else {
    if (!Array.isArray(value.data.poses) || !Array.isArray(value.data.series)) throw new Error('invalid_pose_index');
    for (const item of value.data.poses) {
      const category = value.data.series[item.s]?.name;
      if (!category || !item.ang || Array.isArray(item.ang)) throw new Error('invalid_pose_category');
      for (const [angle, stem] of Object.entries(item.ang)) append(stem, { title: label(item.zh || item.id), category: label(category), hair: '',
        tags: [category, item.cat, item.zh, item.ja, angle].filter(Boolean).map(label), groupId: label(item.key), angle: label(angle) });
    }
  }
  if (!rows.length || rows.length > 20000) throw new Error('unexpected_reference_count');
  return rows;
}

export function referenceImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 32 * 1024 ** 2) throw new Error('invalid_reference_image');
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: 'png', contentType: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', contentType: 'image/jpeg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', contentType: 'image/webp' };
  throw new Error('unsupported_reference_image');
}

export function referenceObject(bytes) {
  const { extension, contentType } = referenceImageType(bytes), sha256 = referenceDigest(bytes);
  return { key: `ai-reference/objects/${sha256.slice(0, 2)}/${sha256}.${extension}`, sha256, bytes: bytes.length, contentType };
}

export function validReferenceObject(item) {
  if (!item || typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
    || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 32 * 1024 ** 2) return false;
  const match = /^(?:x-bookmarks\/originals|ai-reference\/objects)\/([a-f0-9]{2})\/([a-f0-9]{64})\.(png|webp|jpg)$/.exec(item.key);
  if (match) return match[1] === match[2].slice(0, 2) && item.sha256 === match[2]
    && item.contentType === { png:'image/png', webp:'image/webp', jpg:'image/jpeg' }[match[3]];
  // Console uploads keep their collection folders and readable filenames. Only
  // trusted manifests select these keys; every read still verifies the SHA-256.
  if (!item.key.startsWith('ai-reference/') || item.key.startsWith('ai-reference/objects/')
    || Buffer.byteLength(item.key) > 1024 || /[\\%?#\x00-\x1f\x7f]/.test(item.key)) return false;
  const parts = item.key.split('/');
  if (parts.length < 3 || parts.some(part => !part || part === '.' || part === '..')) return false;
  const filename = /^[A-Za-z0-9_-]{1,100}\.(png|webp|jpg)$/.exec(parts.at(-1));
  return Boolean(filename && item.contentType === { png:'image/png', webp:'image/webp', jpg:'image/jpeg' }[filename[1]]);
}
