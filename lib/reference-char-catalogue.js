export const CHAR_COLLECTION = { id: 'taki-anime-reference', name: '动漫角色参考 · たき AI' };
export function parseCharCatalogue(text) {
  const match = /^\s*window\.CHARDB\s*=\s*([\s\S]+?)\s*;?\s*$/.exec(text);
  if (!match) throw new Error('invalid_char_catalogue');
  const data = JSON.parse(match[1]);
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 10000) throw new Error('invalid_char_items');
  const seen = new Set();
  return data.items.map(item => {
    const kind = { hair: 'face', outfit: 'costume', pose: 'pose' }[item.set];
    if (!kind || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || seen.has(item.id)
      || typeof item.zh !== 'string' || typeof item.tags !== 'string' || typeof item.catZh !== 'string') throw new Error('invalid_char_item');
    seen.add(item.id);
    const stem = `taki-${item.id}`;
    return { id: `${kind}:${stem}`, stem, kind, collectionId: CHAR_COLLECTION.id, collectionName: CHAR_COLLECTION.name,
      title: item.zh, category: item.catZh, hair: '', tags: [item.catZh, item.zh, '', ...item.tags.split(',').map(x => x.trim()).filter(Boolean)],
      groupId: stem, angle: '', thumbnailPath: `thumbs/${item.id}.webp`,
      sourceUrl: 'https://sleepyzone.online/char-db-cn/', originalSourceUrl: `https://charadb-2fi.pages.dev/img/${item.id}.jpg`,
      lineSourceUrl: item.line ? `https://charadb-2fi.pages.dev/line/${item.id}.png` : null,
      sourceId: item.id, license: 'personal-reference-no-redistribution', sourceMissing: false };
  });
}
