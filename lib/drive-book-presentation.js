const ROOT = '/夸克网盘/20-电子书';
const ebook = row => /\.(pdf|epub|mobi|azw3?|fb2)$/i.test(row.name || '');
const inside = (root, path) => path === root || path.startsWith(root + '/');
const coverUrl = path => '/api/openlist/library/cover?' + new URLSearchParams({path});
function titleKey(name) {
  let value=String(name).normalize('NFKC').replace(/\.(pdf|epub|mobi|azw3?|fb2)$/i,'');
  const quoted=value.match(/《([^》]+)》/);
  if(quoted)value=quoted[1]+(value.slice(value.indexOf('》')+1).match(/^\s*([上中下]册?|第[0-9一二三四五六七八九十]+[卷册部])/)?.[1]||'');
  return value.replace(/財/g,'财').replace(/體/g,'体').replace(/國/g,'国').replace(/論/g,'论')
    .replace(/^(?:\d+[.、_-]\s*|\d+(?=[\u4e00-\u9fff]))/, '').replace(/[：:=].*$/, '')
    .replace(/\s+-\s+.*$/, '').replace(/[（(](?![上中下]|第|[0-9一二三四五六七八九十]+[卷册部版])[^）)]*[）)]/g,'')
    .replace(/作者[:：].*$/, '').replace(/(?:繁体|简体|原版|转换为).*$/, '')
    .replace(/[《》\s：:·，,。_—-]/g, '').toLowerCase();
}
function sameWork(a, b) {
  const x=titleKey(a),y=titleKey(b);
  return x.length>=2 && x===y;
}
const plural = name => /合集|套装|全\s*[\d一二三四五六七八九十]+\s*册|四部曲|书目|文集|系列丛书|[\d一二三四五六七八九十]+本书/.test(name);

// Presentation is separate from course navigation and never changes stored paths.
export function createBookPresentation(rows, covers) {
  const byPath = new Map(rows.map(row => [row.path, row]));
  const children = new Map(), exact = new Map(), descendantCovers = new Map();
  for (const row of rows) {
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
  }
  const documentsCache=new Map();
  function documentsUnder(path){
    if(documentsCache.has(path))return documentsCache.get(path);
    const found=[];documentsCache.set(path,found);
    for(const child of children.get(path)||[])if(ebook(child))found.push(child);else if(child.kind==='folder')found.push(...documentsUnder(child.path));
    return found;
  }
  const coverTitle=c=>{const source=byPath.get(c.source)||byPath.get(c.path);return /^cover[._]/i.test(source?.name||'')?byPath.get(source.parent)?.name:source?.name;};
  for (const cover of covers) {
    if (!byPath.has(cover.path) || !['book-cover', 'pdf'].includes(cover.kind)) continue;
    exact.set(cover.path, cover);
    let parent = byPath.get(cover.path).parent;
    while (inside(ROOT, parent)) {
      if (!descendantCovers.has(parent)) descendantCovers.set(parent, []);
      const list = descendantCovers.get(parent);
      const identity = cover.source || cover.path;
      if (list.length < 3 && !list.some(c => (c.source || c.path) === identity || sameWork(coverTitle(c),coverTitle(cover)))) list.push(cover);
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }
  return item => {
    if (!inside(ROOT, item.path)) return item;
    const actual = byPath.get(item.preferredPath) || byPath.get(item.path) || item;
    const files = children.get(actual.path) || [];
    const documents = documentsUnder(actual.path);
    const matching = documents.filter(file => sameWork(actual.name, file.name));
    const ownCover = exact.get(actual.path) || exact.get(item.path);
    const documentCover = matching.map(file => exact.get(file.path)).find(Boolean);
    const cover = ownCover || documentCover;
    const broad = actual.path === ROOT || actual.parent === ROOT;
    const distinctWorks=new Set(documents.map(file=>titleKey(file.name)).filter(Boolean));
    const isGroup = plural(actual.name) || (broad && !cover && documents.length !== 1) || (!ownCover && distinctWorks.size>1);
    const singleDocument = documents.length === 1 && !files.some(file => file.kind === 'folder');
    const isBook = actual.kind !== 'folder' ? ebook(actual) : !isGroup && (
      cover?.kind === 'book-cover' || matching.length > 0 || singleDocument ||
      (/有声读物|有声小说/.test(actual.name) && !plural(actual.name))
    );
    const contentType = isBook ? 'book' : actual.kind === 'folder' ? 'collection' : 'resource';
    const images = isBook && cover ? [cover] : contentType === 'collection' ? descendantCovers.get(actual.path) || [] : [];
    // Do not fall back by name or to a generic picture: only indexed lineage is evidence.
    return {...item, contentType, coverUrl: isBook && cover ? coverUrl(cover.path) : null,
      coverKind: isBook && cover ? cover.kind : null,
      collectionCovers: images.map(c => ({url:coverUrl(c.path), name:byPath.get(c.path)?.name || '', kind:c.kind})),
      coverStatus: images.length ? 'available' : 'missing'};
  };
}
