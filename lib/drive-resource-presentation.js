const ROOT = '/夸克网盘/';
const coverHref = path => '/api/openlist/library/cover?' + new URLSearchParams({ path });
const inside = (root, path) => path === root || path.startsWith(root + '/');
const ext = name => String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
const plural = name => /合集|套装|系列丛书|书目|文集|大全|资源包|素材包|资源库|音乐库|音效库|全集|全\s*[\d一二三四五六七八九十]+\s*册|四部曲|\d+\+?\s*(?:本|首|份|套|组)/i.test(name);
const audioSubject = name => /BGM|背景音乐|歌曲|音乐|音效|配乐|歌单|音频|有声|白噪音|助眠|播客/i.test(name);
const assetSubject = name => /素材|图库|图片|照片|摄影作品|壁纸|字体|模板|贴图|图集|设计源文件|特效包/i.test(name);
const presentationSubject = name => /PPT|幻灯|演示|汇报模板|课件|slide/i.test(name);
const courseSubject = name => /课程|教程|训练营|全套课|实战课|系统课|入门课|进阶课|大师课|必修课|课堂|教学|讲座|课件|\d+\s*[节讲课时]/i.test(name);
const bookExt = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2']);
const presentationExt = new Set(['ppt', 'pptx', 'key']);
const documentExt = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'pages']);
const archiveExt = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
const videoExt = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts']);
const codeExt = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'kt', 'swift', 'go', 'rs', 'html', 'css', 'json', 'sql', 'ipynb']);
const assetExt = new Set(['psd', 'ai', 'eps', 'sketch', 'fig', 'blend', 'aep', 'prproj', 'indd']);
const labels = { book: '书籍', presentation: '演示文稿', document: '文档', course: '课程', video: '视频', audio: '音频', image: '图片', assets: '素材', archive: '压缩包', code: '代码', collection: '合集', resource: '资源' };
const layout = { book: 'portrait', document: 'wide', presentation: 'wide', course: 'wide', video: 'wide', image: 'square', audio: 'square', assets: 'square', archive: 'square', code: 'square', collection: 'square', resource: 'square' };
const unsuitablePreview = /二维码|关注.{0,12}公众号|扫码.{0,12}(关注|领取)|领取.{0,12}(资源|福利|资料)|(?:加|添加).{0,4}微信|扩容|tg频道|手机分享|mmexport|mmwebw|screenshot[_-]|宣传(?:页|图|海报|二维码)|广告(?:图|页|二维码)|推广二维码|群聊|扫码|加群|加V|\+V|试看|试看须知|免责声明|每日更|毎曰更|转存到自己网盘|流量变现平台|收益与反馈|课件资料必看|联系方式|福利群|更多资源|免费教程|OPC创作平台/i;
const unsuitableVisual = /怎么转存|转存文件|新手图文|配音神器|去水印|必看说明|资源说明|学习社/i;
const bookPdfDocumentCue = /资料|课件|讲义|报告|清单|笔记|题库|题型|习题|试卷|押题|表格|手册|操作指南|导图|论文|合同|模板|发票|说明书/i;

// Keep the existing book-title matching conservative: volumes and editions remain distinct.
function workKey(name) {
  let value = String(name || '').normalize('NFKC').replace(/\.(pdf|epub|mobi|azw3?|fb2)$/i, '');
  const quoted = value.match(/《([^》]+)》/);
  if (quoted) value = quoted[1] + (value.slice(value.indexOf('》') + 1).match(/^\s*([上中下]册?|第[0-9一二三四五六七八九十]+[卷册部])/)?.[1] || '');
  return value.replace(/財/g, '财').replace(/體/g, '体').replace(/國/g, '国').replace(/論/g, '论')
    .replace(/^(?:\d+[.、_-]\s*|\d+(?=[\u4e00-\u9fff]))/, '').replace(/[：:=].*$/, '')
    .replace(/\s+-\s+.*$/, '').replace(/[（(](?![上中下]|第|[0-9一二三四五六七八九十]+[卷册部版])[^）)]*[）)]/g, '')
    .replace(/作者[:：].*$/, '').replace(/(?:繁体|简体|原版|转换为).*$/, '')
    .replace(/[《》\s：:·，,。_—-]/g, '').toLowerCase();
}
const sameWork = (a, b) => { const x = workKey(a), y = workKey(b); return x.length >= 2 && x === y; };
const counts = () => ({ files: 0, book: 0, pdf: 0, presentation: 0, document: 0, video: 0, audio: 0, image: 0, assets: 0, archive: 0, code: 0, other: 0 });
function fileType(row, ownCover) {
  const suffix = ext(row.name);
  if (['document', 'presentation'].includes(ownCover?.verifiedContentType) && (suffix === 'pdf' || presentationExt.has(suffix))) return ownCover.verifiedContentType;
  if (ownCover?.kind === 'book-cover' && ownCover.verifiedContentType === 'book' && (archiveExt.has(suffix) || suffix === 'pdf')) return 'book';
  if (row.kind === 'audio') return 'audio';
  if (row.kind === 'image') return 'image';
  if (row.kind === 'video' || videoExt.has(suffix)) return 'video';
  if (bookExt.has(suffix) || row.kind === 'epub') return 'book';
  if (presentationExt.has(suffix) || presentationSubject(row.name) && suffix === 'pdf') return 'presentation';
  if (suffix === 'pdf' || row.kind === 'pdf') {
    const bookShelf = row.path.startsWith('/夸克网盘/20-电子书/');
    const title = String(row.name || '').replace(/\.pdf$/i, '');
    const bookEvidence = ownCover?.kind === 'book-cover' || bookShelf &&
      !bookPdfDocumentCue.test(title) && (/(?:《[^》]+》|[：:].{3,}|[（(][^）)]{2,}[）)])/.test(title) ||
        title.length >= 6 && !/^\d+[.、_-]/.test(title));
    return bookEvidence ? 'book' : 'document';
  }
  if (documentExt.has(suffix) || row.kind === 'text') return 'document';
  if (archiveExt.has(suffix)) return 'archive';
  if (codeExt.has(suffix)) return 'code';
  if (assetExt.has(suffix)) return 'assets';
  return 'resource';
}
function candidateKind(row) {
  const suffix = ext(row.name);
  if (unsuitablePreview.test(row.name || '') || /(?:^|\/)\.|__MACOSX|\.DS_Store/i.test(row.path || '')) return null;
  if ((row.kind === 'image' || row.kind === 'pdf' || suffix === 'pdf') && unsuitableVisual.test(row.name || '')) return null;
  if (row.kind === 'image') return 'image';
  if (row.kind === 'video' || videoExt.has(suffix)) return 'video';
  if (row.kind === 'audio') return 'audio';
  if (suffix === 'pdf' || row.kind === 'pdf') return 'pdf';
  if (suffix === 'epub' || row.kind === 'epub') return 'epub';
  if (codeExt.has(suffix)) return 'code';
  if (['txt', 'md', 'rtf'].includes(suffix) || row.kind === 'text') return 'text';
  return null;
}
function candidateRank(entry, type) {
  const name = entry.name || '';
  const explanatory = /readme|说明|笔记|目录|概述|简介|使用方法|开始前|学习指南/i.test(name);
  if (type === 'course') {
    if (entry.kind === 'video' && /导学|介绍|简介|开篇|第一课|第[一1]讲|课时0?1|^0?1[.、_-]/i.test(name)) return 100;
    if (entry.kind === 'image' && /封面|海报|cover|poster/i.test(name)) return 90;
    if (entry.kind === 'video') return 80;
    if (['text', 'code'].includes(entry.kind) && explanatory) return 55;
    return 20;
  }
  if (type === 'audio') return entry.kind === 'image' && /封面|专辑|海报|cover|album/i.test(name) ? 100 : entry.kind === 'audio' ? 90 : -1;
  if (type === 'book') return entry.kind === 'image' && /封面|cover/i.test(name) ? 100 :
    entry.kind === 'epub' ? 90 : entry.kind === 'pdf' ? 80 : 10;
  if (type === 'document' || type === 'presentation') return entry.kind === 'pdf' ? 90 : entry.kind === 'text' && explanatory ? 85 : entry.kind === 'image' ? 70 : 30;
  if (type === 'code') return entry.kind === 'code' && explanatory ? 100 : entry.kind === 'text' && explanatory ? 95 : entry.kind === 'code' ? 80 : 20;
  if (type === 'resource' && ['text', 'code'].includes(entry.kind) && explanatory) return 95;
  if (type === 'assets' || type === 'image') return entry.kind === 'image' ? 90 : entry.kind === 'video' ? 80 : 20;
  return { image: 80, pdf: 70, video: 60, epub: 50, audio: 45, text: 40, code: 35 }[entry.kind] || 0;
}
function addCandidate(summary, row, branch, rejectedPaths) {
  if (rejectedPaths.has(row.path)) return;
  const kind = candidateKind(row);
  if (!kind) return;
  const entry = { path: row.path, name: row.name, kind, size: Number(row.size) || 0, branch };
  if (summary.candidates.some(other => other.path === row.path)) return;
  const sameKind = summary.candidates.filter(other => other.kind === kind);
  if (sameKind.length >= 4) {
    const weakest = sameKind.sort((a,b)=>candidateRank(a,'course')-candidateRank(b,'course') || b.path.localeCompare(a.path))[0];
    if (candidateRank(entry,'course') <= candidateRank(weakest,'course')) return;
    summary.candidates.splice(summary.candidates.indexOf(weakest),1);
  }
  summary.candidates.push(entry);
}
function chooseCandidates(summary, type) {
  const rankType = type === 'collection' && summary?.counts.video >= 3 &&
    summary.counts.video >= summary.counts.files * 0.35 ? 'course' : type;
  const pool = [...(summary?.candidates || [])].filter(entry => candidateRank(entry,rankType) >= 0)
    .sort((a,b)=>candidateRank(b,rankType)-candidateRank(a,rankType)||a.path.localeCompare(b.path));
  const videoOnly = rankType === 'course' && pool.filter(entry => entry.kind === 'video').length >= 3;
  const chosen = [], branches = new Set();
  for (const entry of pool) {
    if (videoOnly && entry.kind !== 'video') continue;
    if (type === 'book' && !['image', 'epub', 'pdf'].includes(entry.kind)) continue;
    if (branches.has(entry.branch)) continue;
    chosen.push(entry); branches.add(entry.branch);
    if (chosen.length === 3) break;
  }
  for (const entry of pool) {
    if (videoOnly && entry.kind !== 'video') continue;
    if (chosen.length === 3) break;
    if (chosen.some(other => other.path === entry.path)) continue;
    chosen.push(entry);
  }
  return chosen.map(({ path, name, kind, size }) => ({ path, name, kind, size }));
}

// Presentation data is derived from the existing index and cover manifest only.
export function createResourcePresentation(rows, covers = []) {
  const byPath = new Map(rows.map(row => [row.path, row]));
  const rejectedPaths = new Set(covers.filter(cover => cover.previewRejected === true && byPath.has(cover.path))
    .map(cover => cover.path));
  const children = new Map(), exact = new Map(), descendants = new Map(), summaries = new Map();
  for (const row of rows) {
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
    summaries.set(row.path, { counts: counts(), candidates: [], works: new Set(), singleFile: null });
  }
  for (const cover of covers) {
    if (cover.previewRejected || rejectedPaths.has(cover.path) || rejectedPaths.has(cover.source)) continue;
    if (!byPath.has(cover.path) || exact.has(cover.path)) continue;
    if (cover.kind === 'illustration' && cover.source !== cover.path) continue;
    if (cover.kind === 'archive-preview' && (!inside(cover.path, cover.source || '') ||
      !byPath.has(cover.source) || !archiveExt.has(ext(byPath.get(cover.source).name)))) continue;
    if (cover.source?.startsWith(ROOT) && cover.source !== cover.path &&
      !inside(cover.path, cover.source)) continue;
    if (cover.source?.startsWith(ROOT) &&
      (unsuitablePreview.test(byPath.get(cover.source)?.name || cover.source.split('/').at(-1)) ||
        ['image', 'pdf'].includes(cover.kind) && unsuitableVisual.test(byPath.get(cover.source)?.name || ''))) continue;
    exact.set(cover.path, cover);
    let parent = byPath.get(cover.path).parent;
    while (byPath.has(parent)) {
      if (!descendants.has(parent)) descendants.set(parent, []);
      descendants.get(parent).push(cover);
      parent = byPath.get(parent).parent;
    }
  }
  for (const row of rows) {
    if (row.kind === 'folder') continue;
    const type = fileType(row, exact.get(row.path));
    let parent = row.path, branch = row.path;
    while (byPath.has(parent)) {
      const summary = summaries.get(parent);
      summary.counts.files++;
      summary.singleFile = summary.counts.files === 1 ? row : null;
      summary.counts[type in summary.counts ? type : 'other']++;
      if (ext(row.name) === 'pdf') summary.counts.pdf++;
      if (['book', 'document'].includes(type)) summary.works.add(workKey(row.name));
      addCandidate(summary, row, branch, rejectedPaths);
      branch = parent;
      parent = byPath.get(parent).parent;
    }
  }
  function folderType(row, summary, ownCover) {
    const c = summary?.counts || counts(), name = row.name || '';
    if (['document', 'presentation'].includes(ownCover?.verifiedContentType) && c.files === 1) return ownCover.verifiedContentType;
    const direct = children.get(row.path) || [];
    const broad = direct.filter(child => child.kind === 'folder').length >= 2;
    const manyWorks = summary?.works.size > 1;
    if (c.files === 1 && summary.singleFile &&
      fileType(summary.singleFile, exact.get(summary.singleFile.path)) === 'book' &&
      sameWork(name, summary.singleFile.name)) return 'book';
    const multiCourse = plural(name) && broad &&
      direct.filter(child => child.kind === 'folder' && courseSubject(child.name)).length >= 2;
    if (audioSubject(name) && c.audio > 0) return 'audio';
    if (row.viewKind === 'course' && !row.path.startsWith('/夸克网盘/80-素材库/') &&
      c.video >= 3 && c.video >= c.files * 0.35 && !multiCourse) return 'course';
    if (courseSubject(name) && (c.video >= 3 || c.video >= 1 && !plural(name)) &&
      c.video >= c.files * 0.25 && !multiCourse) return 'course';
    if (multiCourse || row.viewKind === 'collection' && broad) return 'collection';
    if (broad && !audioSubject(name) && !assetSubject(name) && !courseSubject(name) &&
      (direct.length >= 3 || manyWorks)) return 'collection';
    if (c.audio >= 2 && c.audio >= c.files * 0.65) return 'audio';
    if (plural(name) && (broad || c.files > 1)) return 'collection';
    if (assetSubject(name) && c.files > 0 || c.image + c.assets >= 3 && c.image + c.assets >= c.files * 0.65 ||
      row.path.startsWith('/夸克网盘/80-素材库/') && c.video >= 2) return 'assets';
    if (plural(name) || row.viewKind === 'collection' && broad || broad && manyWorks && c.book + c.document >= 2) return 'collection';
    const matchedBooks = (direct.filter(child => child.kind !== 'folder' && fileType(child, exact.get(child.path)) === 'book')
      .some(child => sameWork(name, child.name)) || descendants.get(row.path)?.some(cover => cover.kind === 'book-cover' &&
        cover.source?.startsWith(ROOT) && sameWork(name, byPath.get(cover.source)?.name)));
    if (ownCover?.kind === 'book-cover' &&
      (c.book > 0 || /《[^》]+》/.test(name) || ownCover.verifiedContentType === 'book' && c.archive === 1 && c.files === 1) ||
      c.book > 0 && !manyWorks && (matchedBooks || c.book === 1 && c.files === 1)) return 'book';
    if (c.presentation > 0 && c.presentation >= c.files * 0.5 || presentationSubject(name) && c.pdf > 0 && !c.video) return 'presentation';
    if (c.archive >= 1 && c.archive >= c.files * 0.6) return 'archive';
    if (c.code >= 2 && c.code >= c.files * 0.5) return 'code';
    if (c.document + c.book + c.presentation >= 1 && c.video < 3) return 'document';
    if (c.video >= 1 && broad) return 'collection';
    return 'resource';
  }
  return item => {
    const actual = byPath.get(item.preferredPath) || byPath.get(item.path) || item;
    const summary = summaries.get(actual.path);
    const ownCover = exact.get(actual.path) || exact.get(item.path);
    let contentType = actual.kind === 'folder' ? folderType({ ...actual, viewKind: item.viewKind }, summary, ownCover) : fileType(actual, ownCover);
    if (!labels[contentType]) contentType = 'resource';
    const descendantsHere = descendants.get(actual.path) || [];
    const previewCandidates = chooseCandidates(summary, contentType);
    const previewKinds = new Map(previewCandidates.map(candidate => [candidate.path, candidate.kind]));
    let selected = ownCover;
    if (contentType === 'course' && ownCover?.kind === 'pdf' && summary?.counts.video > 0) {
      selected = descendantsHere.find(cover => cover.kind === 'video' && cover.source?.startsWith(ROOT) &&
        byPath.has(cover.source) && inside(actual.path, cover.source) && previewKinds.get(cover.source) === 'video') ||
        descendantsHere.find(cover => cover.kind === 'video' && cover.source?.startsWith(ROOT) &&
          byPath.has(cover.source) && inside(actual.path, cover.source)) || ownCover;
    }
    if (!selected && contentType !== 'collection') {
      selected = descendantsHere.find(cover => cover.kind === 'book-cover' && contentType === 'book' &&
        cover.source?.startsWith(ROOT) && sameWork(actual.name, byPath.get(cover.source)?.name)) ||
        descendantsHere.find(cover => contentType !== 'book' && contentType !== 'archive' &&
          !['book-cover', 'illustration'].includes(cover.kind) && inside(actual.path, cover.path) &&
          previewKinds.get(cover.source || cover.path) === cover.kind);
    }
    const courseCollection = contentType === 'collection' && summary?.counts.video >= 3 &&
      summary.counts.video >= summary.counts.files * 0.35;
    const bookCollection = contentType === 'collection' && !courseCollection &&
      (actual.path.startsWith('/夸克网盘/20-电子书/') || summary?.counts.book >= 2 &&
        summary.counts.book >= summary.counts.files * 0.5);
    const coverRank = cover => {
      const sourceName = byPath.get(cover.source)?.name || byPath.get(cover.path)?.name || cover.name || '';
      if (contentType === 'audio') {
        if (cover.kind === 'book-cover' && /有声|听书/i.test(actual.name) && cover.source &&
          (cover.source.startsWith(ROOT) && byPath.has(cover.source) ||
            /^https:\/\/(?:www\.dedao\.cn|cread\.jd\.com)\//i.test(cover.source))) return 100;
        return cover.kind === 'image' && /封面|专辑|海报|cover|album/i.test(sourceName) ? 90 : -1;
      }
      if (contentType === 'assets') return { image: 100, video: 80, 'archive-preview': 70 }[cover.kind] ?? -1;
      if (courseCollection) return cover.kind === 'video' ? 100 : cover.kind === 'image' &&
        /封面|海报|cover|poster/i.test(sourceName) ? 90 : -1;
      if (bookCollection) return { 'book-cover': 100, pdf: 90, image: 70 }[cover.kind] ?? -1;
      return { image: 100, 'book-cover': 90, video: 80, 'archive-preview': 70, pdf: 60 }[cover.kind] ?? -1;
    };
    const collectionCovers = contentType === 'collection' || contentType === 'assets' || contentType === 'audio'
      ? descendantsHere.filter(cover => inside(actual.path, cover.path) && coverRank(cover) >= 0)
          .sort((a, b) => coverRank(b) - coverRank(a) || a.path.localeCompare(b.path))
          .filter((cover, index, list) =>
            list.findIndex(other => (other.source || other.path) === (cover.source || cover.path) ||
              sameWork(byPath.get(other.source)?.name || byPath.get(other.path)?.name,
                byPath.get(cover.source)?.name || byPath.get(cover.path)?.name)) === index).slice(0, 3)
          .map(cover => ({ url: coverHref(cover.path), name: byPath.get(cover.path)?.name || cover.name || '', kind: cover.kind,
            source: cover.source || null, status: cover.source ? 'available' : 'legacy' }))
      : [];
    const reviewedPrimary = ownCover?.primary === true && ownCover.source?.startsWith(ROOT) &&
      inside(actual.path, ownCover.source) && ['image', 'video', 'pdf', 'text', 'code'].includes(ownCover.kind);
    const mosaic = !reviewedPrimary && collectionCovers.length >= 2 ? collectionCovers : [];
    const singleDescendant = collectionCovers.length === 1 && collectionCovers[0].status === 'available' &&
      collectionCovers[0].source?.startsWith(ROOT) && inside(actual.path, collectionCovers[0].source)
      ? collectionCovers[0] : null;
    const ownCollectionCover = ownCover && (['archive-preview', 'illustration'].includes(ownCover.kind) ||
      ['image', 'pdf', 'video', 'text', 'code'].includes(ownCover.kind) && ownCover.source?.startsWith(ROOT) &&
        inside(actual.path, ownCover.source));
    const ownAssetsCover = ownCover && ['image', 'video', 'archive-preview', 'illustration'].includes(ownCover.kind);
    const selectedAssetsCover = selected !== ownCover && selected && ['image', 'video', 'archive-preview'].includes(selected.kind);
    const coverUrl = contentType === 'collection'
      ? !mosaic.length ? ownCollectionCover ? coverHref(ownCover.path) : singleDescendant?.url || null : null
      : contentType === 'assets'
      ? !mosaic.length ? ownAssetsCover ? coverHref(ownCover.path) : singleDescendant?.url ||
          (selectedAssetsCover ? coverHref(selected.path) : null) : null
      : contentType === 'audio'
      ? !mosaic.length ? ownCover && (ownCover.kind === 'illustration' || ownCover.kind === 'book-cover' && coverRank(ownCover) >= 0 || ownCover.kind === 'image' &&
          /封面|专辑|海报|cover|album/i.test(byPath.get(ownCover.source)?.name || '')) ? coverHref(ownCover.path) :
          singleDescendant?.url || null : null
      : contentType === 'course' && selected?.kind === 'pdf' && summary?.counts.video > 0 ? null
      : selected ? coverHref(selected.path) : null;
    const usedCover = coverUrl === singleDescendant?.url ? singleDescendant :
      coverUrl === coverHref(ownCover?.path) ? ownCover : selected;
    const coverKind = coverUrl ? usedCover?.kind || null : null;
    const coverLayout = layout[contentType];
    const viewKind = actual.kind === 'folder' && contentType === 'course' ? 'course' :
      actual.kind === 'folder' &&
      ((summary?.counts.video || 0) + (summary?.counts.audio || 0) > 0 ||
        ['collection', 'assets', 'audio'].includes(contentType) &&
          (summary?.counts.files > 1 || (children.get(actual.path) || []).length > 1)) ? 'collection' : item.viewKind;
    const displayType = contentType === 'audio' && actual.kind === 'folder'
      ? /音效/i.test(actual.name) ? '音效库' : /有声|听书/i.test(actual.name) ? '有声书'
        : /音乐|BGM|歌曲|配乐|歌单/i.test(actual.name) ? '音乐合集' : '音频合集'
      : labels[contentType];
    return { ...item, contentType, displayType, coverLayout, coverUrl, coverKind,
      coverAspect: usedCover?.width > 0 && usedCover?.height > 0 ? usedCover.width / usedCover.height : null,
      collectionCovers: mosaic, coverStatus: coverUrl && usedCover?.kind === 'illustration' ? 'illustration' :
        (coverUrl && !usedCover?.source || mosaic.some(cover => cover.status === 'legacy')) ? 'legacy' :
        coverUrl || mosaic.length ? 'available' : 'missing',
      previewCandidates, ...(viewKind ? { viewKind } : {}) };
  };
}
