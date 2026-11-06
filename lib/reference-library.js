import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REFERENCE_KINDS, REFERENCE_COLLECTION, validReferenceObject } from './reference-catalogue.js';
import { createReferenceStorage } from './reference-storage.js';

const FRONT_ANGLE = '正面';
const hairstyleOf = item => item.kind === 'face' ? (item.tags?.[2] || '') : '';
// Metadata must remain evidence-led.  The main imported catalogue does not
// describe its rendering style or gender, while the char catalogue explicitly
// identifies itself as anime.  Unknown is deliberately not promoted to either
// "realistic" or a gender category.
const STYLE_LABELS = { realistic: '真人写实', anime: '动漫', unmarked: '未标注' };
const GENDER_LABELS = { female: '女性', male: '男性', neutral: '中性', unmarked: '未标注' };
const normalStyle = value => {
  const style = String(value || '').trim().toLowerCase();
  if (['realistic', 'photoreal', 'photorealistic', '真人写实'].includes(style)) return 'realistic';
  if (['anime', '动漫'].includes(style)) return 'anime';
  return /^[a-z][a-z0-9_-]{0,40}$/.test(style) ? style : '';
};
const styleOf = item => normalStyle(item.style) || (item.collectionId === 'taki-anime-reference' ? 'anime' : 'unmarked');
const genderOf = item => {
  const exact = String(item.gender || '').trim().toLowerCase();
  if (['female', '女性'].includes(exact)) return 'female';
  if (['male', '男性'].includes(exact)) return 'male';
  if (['neutral', '中性'].includes(exact)) return 'neutral';
  const tags = new Set([item.title, ...(item.tags || [])].map(value => String(value).trim().toLowerCase()));
  if (tags.has('female') || tags.has('女性')) return 'female';
  if (tags.has('male') || tags.has('男性')) return 'male';
  if (tags.has('neutral') || tags.has('中性')) return 'neutral';
  return 'unmarked';
};

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

export function createReferenceLibraryHandler({ directory, getUser, ownerName = 'zane', canRead = user => user?.username === ownerName, storage = createReferenceStorage({ directory }) }) {
  let cached = { version: 1, items: [] }, cacheStamp = '', reservedBytes = 0;
  let previewStamp = '', previewItems = {};
  async function previewObject(item) {
    try {
      const file = path.join(directory, 'previews.json'), info = await stat(file);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp !== previewStamp) {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.version !== 1 || !value.items) throw new Error('invalid_preview_manifest');
        previewItems = value.items; previewStamp = stamp;
      }
      const preview = previewItems[item.id];
      return preview?.originalSha256 === item.original?.sha256 && validReferenceObject(preview.object) ? preview.object : item.thumbnail;
    } catch { return item.thumbnail; }
  }
  const manifestFile = path.join(directory, 'manifest.json');
  const collectionId = item => item.collectionId || REFERENCE_COLLECTION.id;
  const collectionName = item => item.collectionName || (collectionId(item) === REFERENCE_COLLECTION.id ? REFERENCE_COLLECTION.name : collectionId(item));
  const publicItem = item => ({ id: item.id, stem: item.stem, kind: item.kind, title: item.title, category: item.category,
    collectionId: collectionId(item), collectionName: collectionName(item),
    hair: item.hair, tags: item.tags, groupId: item.groupId, angle: item.angle, style: styleOf(item), gender: genderOf(item), sourceUrl: item.sourceUrl,
    addedAt: item.addedAt, originalReady: Boolean(item.original), sourceMissing: Boolean(item.sourceMissing),
    thumbnailUrl: `/api/reference-library/items/${encodeURIComponent(item.id)}/thumbnail`,
    imageUrl: `/api/reference-library/items/${encodeURIComponent(item.id)}/${item.original ? 'original' : 'thumbnail'}` });
  // Pose rows that share a collection and groupId (falling back to the item id when
  // groupId is absent, so ungrouped records never collide) are folded into one card.
  const groupKey = item => JSON.stringify([collectionId(item), item.groupId || item.id]);
  function buildGroups(items) {
    const groups = new Map();
    for (const item of items) {
      const key = groupKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.values()].map(variants => {
      const sorted = variants.slice().sort((a, b) => a.id.localeCompare(b.id));
      const canonical = sorted.find(v => v.angle === FRONT_ANGLE) || sorted[0];
      return { ...publicItem(canonical), variantCount: variants.length, variants: sorted.map(publicItem) };
    });
  }
  // Facet counts are always derived from the collection-scoped, kind-scoped pool so one
  // facet's own selection never shrinks the options shown for every facet (including itself).
  function facetList(items, selector, grouping) {
    const counts = new Map();
    for (const item of items) {
      const value = selector(item);
      if (!value) continue;
      let entry = counts.get(value);
      if (!entry) { entry = { value, imageCount: 0, groups: new Set() }; counts.set(value, entry); }
      entry.imageCount++;
      entry.groups.add(groupKey(item));
    }
    return [...counts.values()].map(entry => ({ value: entry.value, count: grouping ? entry.groups.size : entry.imageCount, imageCount: entry.imageCount }));
  }
  async function manifest() {
    let stamp;
    try { const info = await stat(manifestFile); stamp = `${info.mtimeMs}:${info.size}`; }
    catch (error) { if (error.code === 'ENOENT') return cached; throw error; }
    if (stamp !== cacheStamp) {
      const value = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 60000
        || value.items.some(item => !/^(face|pose|costume):[A-Za-z0-9_-]{1,100}$/.test(item.id)
          || !REFERENCE_KINDS.includes(item.kind) || !Array.isArray(item.tags) || !validReferenceObject(item.thumbnail)
          || (item.original && !validReferenceObject(item.original)))
        || new Set(value.items.map(item => item.id)).size !== value.items.length) throw new Error('reference_manifest_invalid');
      cached = value; cacheStamp = stamp;
    }
    return cached;
  }
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/reference-library')) return false;
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' };
    const json = (status, data) => { const body = JSON.stringify(data); res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body); return true; };
    const allowed = () => Boolean(canRead(getUser(req)));
    if (!allowed()) return json(404, { error: '资源不存在或无权访问。' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: '不支持此操作。' });
    try {
      const data = await manifest(), query = new URL(req.url, 'http://localhost').searchParams;
      if (pathname === '/api/reference-library') {
        const kind = query.get('kind') || 'face', category = query.get('category') || '', hair = query.get('hair') || '', q = (query.get('q') || '').trim().slice(0, 200).toLocaleLowerCase();
        const action = query.get('action') || '', angle = query.get('angle') || '', hairstyle = query.get('hairstyle') || '';
        const style = normalStyle(query.get('style')) || (query.get('style') === 'unmarked' ? 'unmarked' : '');
        const gender = ['female', 'male', 'neutral', 'unmarked'].includes(query.get('gender')) ? query.get('gender') : '';
        if (!REFERENCE_KINDS.includes(kind)) return json(400, { error: '请选择有效的素材类型。' });
        const collection = query.get('collection') || '', collections = new Map();
        for (const item of data.items) {
          const id = collectionId(item);
          if (!collections.has(id)) collections.set(id, { id, name: collectionName(item), count: 0 });
          collections.get(id).count++;
        }
        const inCollection = data.items.filter(item => !collection || collectionId(item) === collection);
        const inKind = inCollection.filter(item => item.kind === kind), limit = 48;
        // Style and gender are a shared scope, not merely an after-the-fact
        // row filter: kind counters and the older category/hair facets must
        // describe exactly the same scoped catalogue.  Each new facet omits
        // only its own selection so users can switch it without losing options.
        const matchesStyle = item => !style || styleOf(item) === style;
        const matchesGender = item => !gender || genderOf(item) === gender;
        const scopedCollection = inCollection.filter(item => matchesStyle(item) && matchesGender(item));
        const scopedKind = inKind.filter(item => matchesStyle(item) && matchesGender(item));
        const styleFacetKind = inKind.filter(matchesGender);
        const genderFacetKind = inKind.filter(matchesStyle);
        // group=pose is an opt-in read-only view; every other kind keeps the legacy, ungrouped contract.
        const grouping = kind === 'pose' && query.get('group') === 'pose';
        const rawRows = scopedKind.filter(item => (!category || item.category === category) && (!hair || item.hair === hair) && (!hairstyle || hairstyleOf(item) === hairstyle)
          && (!action || item.tags[1] === action) && (!angle || item.angle === angle)
          && (!q || [item.stem, item.title, ...item.tags].join(' ').toLocaleLowerCase().includes(q))
          && (query.get('originals') !== '1' || item.original));
        const imageTotal = rawRows.length;
        // Grouping (when requested) happens on the whole filtered dataset before pagination.
        let rows = grouping ? buildGroups(rawRows) : rawRows;
        const sort = query.get('sort');
        if (sort === 'newest') rows.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || a.id.localeCompare(b.id));
        else if (sort === 'random') rows = shuffle(rows.slice());
        const total = rows.length, page = Math.min(Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1), Math.max(1, Math.ceil(total / limit)));
        const groupCounts = Object.fromEntries(REFERENCE_KINDS.map(key => {
          const keys = new Set(scopedCollection.filter(item => item.kind === key).map(groupKey));
          return [key, keys.size];
        }));
        return json(200, { items: rows.slice((page - 1) * limit, page * limit).map(row => grouping ? row : publicItem(row)),
          total, page, pages: Math.max(1, Math.ceil(total / limit)), imageTotal,
          categories: [...new Set(scopedKind.map(item => item.category))], hairs: [...new Set(scopedKind.map(item => item.hair).filter(Boolean))],
          counts: Object.fromEntries(REFERENCE_KINDS.map(key => [key, scopedCollection.filter(item => item.kind === key).length])),
          groupCounts,
          facets: { styles: facetList(styleFacetKind, styleOf, grouping), genders: facetList(genderFacetKind, genderOf, grouping), hairstyles: facetList(scopedKind.filter(item => (!category || item.category === category) && (!hair || item.hair === hair)), hairstyleOf, false), categories: facetList(scopedKind, item => item.category, grouping), hairs: facetList(scopedKind, item => item.hair, grouping),
            actions: facetList(scopedKind, item => item.tags[1], grouping), angles: facetList(scopedKind, item => item.angle, grouping) },
          collections: [...collections.values()], originalCount: inCollection.filter(item => item.original).length, updatedAt: data.updatedAt || null });
      }
      if (pathname === '/api/reference-library/status') {
        let status = {};
        try { status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')); } catch { /* First import may not have run. */ }
        return json(200, { state: status.state || 'pending', checkedAt: status.checkedAt || null, completedAt: status.completedAt || null,
          nextCheckAt: status.nextCheckAt || null, added: status.added || 0, changed: status.changed || 0,
          error: status.error || null, pendingOriginals: data.items.filter(item => !item.original).length,
          total: data.items.length, originalCount: data.items.filter(item => item.original).length });
      }
      const match = /^\/api\/reference-library\/items\/((?:face|pose|costume):[A-Za-z0-9_-]{1,100})(?:\/(thumbnail|original))?$/.exec(pathname);
      const item = match && data.items.find(item => item.id === match[1]);
      if (!item) return json(404, { error: '素材不存在。' });
      if (!match[2]) return json(200, { ...publicItem(item), variants: data.items.filter(other => other.kind === item.kind && collectionId(other) === collectionId(item) && other.groupId === item.groupId).map(publicItem) });
      const object = match[2] === 'thumbnail' ? await previewObject(item) : item[match[2]];
      if (!object) return json(404, { error: '原图尚未导入，请先下载预览图。' });
      if (reservedBytes + object.bytes > 96 * 1024 ** 2) return json(503, { error: '图片加载繁忙，请稍后重试。' });
      const extension = object.key.split('.').pop(), download = query.get('download') === '1';
      const etag = `"${object.sha256}"`;
      const cacheHeaders = download ? {} : { 'Cache-Control': 'private, no-cache', ETag: etag };
      if (!download && String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag)) {
        res.writeHead(304, { ...headers, ...cacheHeaders }); res.end(); return true;
      }
      const fileHeaders = { ...headers, ...cacheHeaders, 'Content-Type': object.contentType, 'Content-Length': object.bytes,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${item.stem}${match[2] === 'thumbnail' ? '-preview' : ''}.${extension}"` };
      if (req.method === 'HEAD') { res.writeHead(200, fileHeaders); res.end(); return true; }
      reservedBytes += object.bytes;
      let readDone = false, responseDone = false, released = false;
      const release = () => { if (readDone && responseDone && !released) { released = true; reservedBytes -= object.bytes; } };
      const finished = () => { responseDone = true; release(); };
      res.once('finish', finished); res.once('close', finished);
      try {
        const bytes = await storage.read(object);
        if (res.destroyed) return true;
        if (!allowed()) return json(404, { error: '资源不存在或无权访问。' });
        res.writeHead(200, fileHeaders); res.end(bytes); return true;
      } finally { readDone = true; release(); }
    } catch { return json(503, { error: '参考库暂时无法读取，请稍后重试。' }); }
  };
}
