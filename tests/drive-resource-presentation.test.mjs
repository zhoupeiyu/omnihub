import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePresentation } from '../lib/drive-resource-presentation.js';

const root = '/夸克网盘/80-素材库';
const folder = (path, name = path.split('/').at(-1)) => ({ path, parent: path.slice(0, path.lastIndexOf('/')), name, kind: 'folder', size: 0 });
const file = (path, kind, name = path.split('/').at(-1)) => ({ path, parent: path.slice(0, path.lastIndexOf('/')), name, kind, size: 100 });

test('PDF is a document unless title or cover evidence establishes another type', () => {
  const pdf = file(root + '/向上汇报.pdf', 'pdf');
  const slides = file(root + '/季度汇报课件.pdf', 'pdf');
  const decorate = createResourcePresentation([pdf, slides], []);
  assert.equal(decorate(pdf).contentType, 'document');
  assert.equal(decorate(pdf).coverLayout, 'wide');
  assert.equal(decorate(slides).contentType, 'presentation');
});

test('music folders stay audio even when their names mention film, and single video is video', () => {
  const bgm = folder(root + '/影视BGM背景音乐合集');
  const tracks = [file(bgm.path + '/主题曲.mp3', 'audio'), file(bgm.path + '/片尾曲.flac', 'audio')];
  const video = file(root + '/介绍.mp4', 'video');
  const decorate = createResourcePresentation([bgm, ...tracks, video], []);
  assert.equal(decorate({ ...bgm, viewKind: 'course' }).contentType, 'audio');
  assert.equal(decorate(bgm).displayType, '音乐合集');
  assert.equal(decorate({ ...bgm, viewKind: 'course' }).viewKind, 'collection');
  assert.equal(decorate(video).contentType, 'video');
  assert.equal(decorate(bgm).previewCandidates[0].kind, 'audio');
});

test('reviewed course layout and video majority outrank broad chapter folders', () => {
  const course = folder(root.replace('80-素材库', '30-课程教程') + '/RN从0到1系统精讲');
  const chapters = [folder(course.path + '/章节一'), folder(course.path + '/章节二')];
  const rows = [course, ...chapters,
    ...Array.from({ length: 18 }, (_, i) => file(chapters[i % 2].path + `/课时${i + 1}.mp4`, 'video')),
    ...Array.from({ length: 2 }, (_, i) => file(course.path + `/资料${i + 1}.pdf`, 'pdf')),
    file(course.path + '/怎么转存文件.pdf', 'pdf'), file(course.path + '/新手图文.jpg', 'image')];
  const result = createResourcePresentation(rows, [])({ ...course, viewKind: 'course' });
  assert.equal(result.contentType, 'course');
  assert.equal(result.viewKind, 'course');
  assert.equal(result.previewCandidates[0].kind, 'video');
  assert.ok(result.previewCandidates.every(item => !/怎么转存|新手图文/.test(item.name)));
});

test('audio folder labels distinguish sound effects and audiobooks', () => {
  const effects = folder(root + '/百万音效库');
  const spoken = folder(root + '/名著有声书');
  const decorate = createResourcePresentation([effects, spoken,
    file(effects.path + '/敲击.mp3', 'audio'), file(spoken.path + '/第一章.mp3', 'audio')], []);
  assert.equal(decorate(effects).displayType, '音效库');
  assert.equal(decorate(spoken).displayType, '有声书');
});

test('video-rich course collections preview lessons before attachment PDFs', () => {
  const group = folder(root.replace('80-素材库', '30-课程教程') + '/PS教程合集');
  const chapters = [folder(group.path + '/甲教程'), folder(group.path + '/乙课程')];
  const rows = [group, ...chapters,
    ...chapters.flatMap(chapter => [file(chapter.path + '/本章素材位置.pdf', 'pdf'),
      file(chapter.path + '/01 第一课.mp4', 'video'), file(chapter.path + '/02 正课.mp4', 'video')])];
  const result = createResourcePresentation(rows, [])({ ...group, viewKind: 'collection' });
  assert.equal(result.contentType, 'collection');
  assert.deepEqual(result.previewCandidates.map(candidate => candidate.kind), ['video', 'video', 'video']);
});

test('course collection mosaic ranks lesson video above attachment PDF regardless of manifest order', () => {
  const group = folder(root.replace('80-素材库', '30-课程教程') + '/PS创意合集');
  const lesson = [1, 2, 3].map(i => file(group.path + `/第${i}课.mp4`, 'video'));
  const attachments = [1, 2, 3].map(i => file(group.path + `/第${i}章本章素材位置.pdf`, 'pdf'));
  const covers = [
    ...attachments.map(row => ({ path: row.path, kind: 'pdf', source: row.path })),
    { path: group.path, kind: 'video', source: lesson[0].path },
    ...lesson.map(row => ({ path: row.path, kind: 'video', source: row.path })),
  ];
  const result = createResourcePresentation([group, ...lesson, ...attachments], covers)(group);
  assert.equal(result.contentType, 'collection');
  assert.equal(result.coverUrl, null);
  assert.deepEqual(result.collectionCovers.map(cover => cover.kind), ['video', 'video', 'video']);
});

test('document-heavy folders do not become video courses from one introduction', () => {
  const guide = folder(root + '/志愿填报指导资料');
  const rows = [guide, file(guide.path + '/介绍.mp4', 'video'),
    ...Array.from({ length: 8 }, (_, i) => file(guide.path + `/资料${i}.pdf`, 'pdf'))];
  const result = createResourcePresentation(rows, [])({ ...guide, viewKind: 'course' });
  assert.equal(result.contentType, 'document');
  assert.notEqual(result.contentType, 'course');
  assert.equal(result.viewKind, 'collection');
  assert.equal(result.previewCandidates.length, 3);
});

test('cover selection uses exact path or evidenced descendants, never same-name siblings', () => {
  const a = folder(root + '/甲/同名课程');
  const b = folder(root + '/乙/同名课程');
  const child = file(a.path + '/第一课.mp4', 'video');
  const covers = [{ path: a.path, kind: 'video', source: child.path }];
  const decorate = createResourcePresentation([folder(root + '/甲'), folder(root + '/乙'), a, b, child], covers);
  assert.ok(decorate(a).coverUrl?.includes(encodeURIComponent(a.path)));
  assert.equal(decorate(b).coverUrl, null);
  assert.equal(decorate(b).coverStatus, 'missing');
});

test('single book and multiwork collection use different cover policies', () => {
  const base = '/夸克网盘/20-电子书';
  const single = folder(base + '/《结构性改革》');
  const epub = file(single.path + '/《结构性改革》.epub', 'epub');
  const group = folder(base + '/经济学四部曲');
  const first = file(group.path + '/《甲书》.epub', 'epub');
  const second = file(group.path + '/《乙书》.epub', 'epub');
  const covers = [
    { path: epub.path, kind: 'book-cover', source: epub.path },
    { path: first.path, kind: 'book-cover', source: first.path },
    { path: second.path, kind: 'book-cover', source: second.path },
  ];
  const decorate = createResourcePresentation([single, epub, group, first, second], covers);
  const book = decorate(single), collection = decorate(group);
  assert.equal(book.contentType, 'book');
  assert.equal(book.coverLayout, 'portrait');
  assert.ok(book.coverUrl);
  assert.equal(collection.contentType, 'collection');
  assert.equal(collection.coverUrl, null);
  assert.equal(collection.collectionCovers.length, 2);
  assert.deepEqual(collection.previewCandidates.map(item => item.kind), ['epub', 'epub']);
});

test('preferredPath cover and dimensions are accepted without using a name fallback', () => {
  const primary = folder(root + '/专题');
  const preferred = folder(root + '/专题实际来源');
  const preview = file(preferred.path + '/封面.jpg', 'image');
  const decorate = createResourcePresentation([primary, preferred, preview], [
    { path: preferred.path, kind: 'image', source: preview.path, width: 1200, height: 800 },
  ]);
  const result = decorate({ ...primary, preferredPath: preferred.path });
  assert.equal(result.coverLayout, 'square');
  assert.ok(result.coverUrl?.includes(encodeURIComponent(preferred.path)));
  assert.deepEqual(result.previewCandidates, [{ path: preview.path, name: preview.name, kind: 'image', size: 100 }]);
});

test('archive preview is real evidence while illustration stays an exact-target fallback', () => {
  const pack = folder(root + '/姿势素材包');
  const zip = file(pack.path + '/人物姿势.zip', 'file');
  const broad = folder(root + '/主题合集');
  const child = folder(broad.path + '/子主题');
  const decorate = createResourcePresentation([pack, zip, broad, child], [
    { path: pack.path, kind: 'archive-preview', source: zip.path, width: 1200, height: 800 },
    { path: child.path, kind: 'illustration', source: child.path },
  ]);
  assert.equal(decorate(pack).coverKind, 'archive-preview');
  assert.equal(decorate(pack).coverStatus, 'available');
  assert.equal(decorate(child).coverStatus, 'illustration');
  assert.equal(decorate(broad).coverUrl, null);
});

test('archive preview accepts the indexed archive itself as its source', () => {
  const zip = file(root + '/人物姿势.zip', 'file');
  const result = createResourcePresentation([zip], [
    { path: zip.path, kind: 'archive-preview', source: zip.path, width: 900, height: 1200 },
  ])(zip);
  assert.equal(result.contentType, 'archive');
  assert.equal(result.coverKind, 'archive-preview');
  assert.equal(result.coverLayout, 'square');
  assert.equal(result.coverStatus, 'available');
});

test('a lesson-rich course outranks incidental assets, while an explicit course collection stays a collection', () => {
  const course = folder(root + '/剪映素材模板视频教程');
  const group = folder(root + '/多套课程合集');
  const first = folder(group.path + '/甲课程');
  const second = folder(group.path + '/乙教程');
  const rows = [course, group, first, second,
    ...Array.from({ length: 58 }, (_, i) => file(course.path + `/第${i + 1}课.mp4`, 'video')),
    ...Array.from({ length: 67 }, (_, i) => file(course.path + `/素材${i + 1}.png`, 'image')),
    ...Array.from({ length: 3 }, (_, i) => file(first.path + `/第${i + 1}课.mp4`, 'video')),
    ...Array.from({ length: 3 }, (_, i) => file(second.path + `/第${i + 1}课.mp4`, 'video'))];
  const decorate = createResourcePresentation(rows, []);
  assert.equal(decorate({ ...course, viewKind: 'course' }).contentType, 'course');
  assert.equal(decorate({ ...course, viewKind: 'course' }).viewKind, 'course');
  assert.equal(decorate({ ...group, viewKind: 'collection' }).contentType, 'collection');
});

test('a nonbook folder never inherits an unrelated descendant PDF cover', () => {
  const pack = folder(root + '/档案压缩包');
  const archive = file(pack.path + '/档案.zip', 'file');
  const archive2 = file(pack.path + '/附件.zip', 'file');
  const guide = file(pack.path + '/说明.pdf', 'pdf');
  const decorate = createResourcePresentation([pack, archive, archive2, guide], [
    { path: guide.path, kind: 'pdf', source: guide.path },
  ]);
  assert.equal(decorate(pack).contentType, 'archive');
  assert.equal(decorate(pack).coverUrl, null);
  assert.equal(decorate(pack).coverStatus, 'missing');
});

test('source-less older covers remain visible but are marked legacy', () => {
  const image = file(root + '/风景.jpg', 'image');
  const result = createResourcePresentation([image], [{ path: image.path, kind: 'image' }])(image);
  assert.ok(result.coverUrl);
  assert.equal(result.coverStatus, 'legacy');
});

test('video extensions supply type and preview when index kind is generic', () => {
  const video = file(root + '/IOS逆向与安全内.avi', 'file');
  const result = createResourcePresentation([video], [])(video);
  assert.equal(result.contentType, 'video');
  assert.equal(result.previewCandidates[0].kind, 'video');
});

test('a verified archive book requires exact manifest evidence', () => {
  const wrapper = folder(root + '/架构师启示录');
  const book = file(wrapper.path + '/架构师启示录.zip', 'file');
  const other = file(root + '/普通合集.zip', 'file');
  const decorate = createResourcePresentation([wrapper, book, other], [
    { path: book.path, kind: 'book-cover', source: book.path, verifiedContentType: 'book' },
  ]);
  assert.equal(decorate(book).contentType, 'book');
  assert.equal(decorate(wrapper).contentType, 'book');
  assert.equal(decorate(other).contentType, 'archive');
});

test('a verified folder book can contain only its indexed ZIP', () => {
  const wrapper = folder(root + '/架构师启示录');
  const zip = file(wrapper.path + '/架构师启示录.zip', 'file');
  const result = createResourcePresentation([wrapper, zip], [
    { path: wrapper.path, kind: 'book-cover', source: zip.path, verifiedContentType: 'book' },
  ])(wrapper);
  assert.equal(result.contentType, 'book');
  assert.equal(result.coverLayout, 'portrait');
  assert.equal(result.coverKind, 'book-cover');
});

test('one real book stays a book despite duplicate empty sibling folders', () => {
  const shelf = folder('/夸克网盘/20-电子书/高性价比人生指南');
  const emptyA = folder(shelf.path + '/随时和谐 尽快保存');
  const emptyB = folder(shelf.path + '/先保存 河蟹不补哦');
  const pdf = file(shelf.path + '/高性价比人生指南.pdf', 'pdf');
  const result = createResourcePresentation([shelf, emptyA, emptyB, pdf], [
    { path: shelf.path, kind: 'pdf', source: pdf.path },
  ])({ ...shelf, viewKind: 'collection' });
  assert.equal(result.contentType, 'book');
  assert.equal(result.coverLayout, 'portrait');
  assert.ok(result.coverUrl);
});

test('a collection can use its sourced preview when no mosaic exists', () => {
  const group = folder(root + '/油管教程合集');
  const video = file(group.path + '/介绍.mp4', 'video');
  const result = createResourcePresentation([group, video], [
    { path: group.path, kind: 'video', source: video.path },
  ])(group);
  assert.equal(result.contentType, 'collection');
  assert.equal(result.coverKind, 'video');
  assert.equal(result.coverStatus, 'available');
});

test('a multi-cover collection favors the mosaic over its own single preview', () => {
  const group = folder(root + '/教程合集');
  const first = file(group.path + '/甲.jpg', 'image');
  const second = file(group.path + '/乙.jpg', 'image');
  const decorate = createResourcePresentation([group, first, second], [
    { path: group.path, kind: 'image', source: first.path },
    { path: first.path, kind: 'image', source: first.path },
    { path: second.path, kind: 'image', source: second.path },
  ]);
  const result = decorate(group);
  assert.equal(result.contentType, 'collection');
  assert.equal(result.coverUrl, null);
  assert.equal(result.collectionCovers.length, 2);
});

test('one sourced descendant is a cover fallback for collections and assets', () => {
  const collection = folder(root + '/教程合集');
  const lesson = file(collection.path + '/第一课.mp4', 'video');
  const assets = folder(root + '/设计素材');
  const image = file(assets.path + '/素材封面.jpg', 'image');
  const other = file(assets.path + '/素材2.jpg', 'image');
  const decorate = createResourcePresentation([collection, lesson, assets, image, other], [
    { path: lesson.path, kind: 'video', source: lesson.path },
    { path: image.path, kind: 'image', source: image.path },
  ]);
  assert.equal(decorate(collection).contentType, 'collection');
  assert.equal(decorate(collection).coverKind, 'video');
  assert.equal(decorate(collection).coverStatus, 'available');
  assert.equal(decorate(assets).contentType, 'assets');
  assert.equal(decorate(assets).coverKind, 'image');
});

test('one legacy descendant cannot impersonate a sourced cover', () => {
  const group = folder(root + '/教程合集');
  const lesson = file(group.path + '/第一课.mp4', 'video');
  const result = createResourcePresentation([group, lesson], [
    { path: lesson.path, kind: 'video' },
  ])(group);
  assert.equal(result.coverUrl, null);
  assert.equal(result.coverStatus, 'missing');
});

test('collection own text preview accepts only an indexed internal source', () => {
  const group = folder(root + '/资料合集');
  const readme = file(group.path + '/01-minimum-loop.md', 'text');
  const decorate = createResourcePresentation([group, readme], [
    { path: group.path, kind: 'text', source: readme.path },
  ]);
  assert.equal(decorate(group).coverKind, 'text');
  assert.equal(decorate(group).coverStatus, 'available');
});

test('rejected visual paths cannot become exact covers, descendant covers, or preview candidates', () => {
  const folderRow = folder(root + '/课程');
  const ad = file(folderRow.path + '/广告二维码.jpg', 'image');
  const promo = file(folderRow.path + '/课程海报.jpg', 'image');
  const lesson = file(folderRow.path + '/01 导学.mp4', 'video');
  const reject = { path: promo.path, previewRejected: true, reason: '人工确认宣传素材' };
  const decorate = createResourcePresentation([folderRow, ad, promo, lesson], [
    { path: folderRow.path, kind: 'image', source: promo.path },
    { path: promo.path, kind: 'image', source: promo.path },
    reject,
  ]);
  assert.equal(decorate(folderRow).coverUrl, null);
  assert.equal(decorate(promo).coverUrl, null);
  assert.ok(decorate(folderRow).previewCandidates.every(candidate => candidate.path !== promo.path));
});

test('named promotional files stay out of dynamic previews', () => {
  const shelf = folder(root + '/资料');
  const names = ['更多资源.pdf', '免费教程.jpg', '加V领取.pdf', '+V咨询.jpg', 'OPC创作平台.pdf'];
  const rows = [shelf, ...names.map(name => file(shelf.path + '/' + name,
    name.endsWith('.jpg') ? 'image' : 'pdf')), file(shelf.path + '/正式内容.pdf', 'pdf')];
  const result = createResourcePresentation(rows, [])(shelf);
  assert.deepEqual(result.previewCandidates.map(candidate => candidate.name), ['正式内容.pdf']);
});

test('topic words in real documents are not mistaken for promotion', () => {
  const shelf = folder(root + '/开发资料');
  const real = [file(shelf.path + '/公众号 10w+ 爆款运营精华版.pdf', 'pdf'),
    file(shelf.path + '/微信小程序开发.pdf', 'pdf')];
  const promo = file(shelf.path + '/扫码关注公众号.jpg', 'image');
  const result = createResourcePresentation([shelf, ...real, promo], [])(shelf);
  assert.deepEqual(result.previewCandidates.map(candidate => candidate.name).sort(), real.map(row => row.name).sort());
});

test('advertising as a book topic is retained while explicit promo artwork is excluded', () => {
  const shelf = folder('/夸克网盘/20-电子书/广告主题');
  const books = [file(shelf.path + '/(NEW)广告文案.pdf', 'pdf'),
    file(shelf.path + '/(NEW)广告争夺战.pdf', 'pdf')];
  const promo = file(shelf.path + '/广告图.jpg', 'image');
  const result = createResourcePresentation([shelf, ...books, promo], [])(shelf);
  assert.deepEqual(result.previewCandidates.map(candidate => candidate.name).sort(), books.map(row => row.name).sort());
});

test('course PDF cover yields to an indexed descendant lesson video', () => {
  const course = folder(root.replace('80-素材库', '30-课程教程') + '/股票实战课程');
  const pdf = file(course.path + '/资料.pdf', 'pdf');
  const videos = [1, 2, 3].map(i => file(course.path + `/第${i}课.mp4`, 'video'));
  const decorate = createResourcePresentation([course, pdf, ...videos], [
    { path: course.path, kind: 'pdf', source: pdf.path },
    { path: videos[0].path, kind: 'video', source: videos[0].path },
  ]);
  const result = decorate(course);
  assert.equal(result.contentType, 'course');
  assert.equal(result.coverKind, 'video');
  assert.ok(result.coverUrl?.includes(encodeURIComponent(videos[0].path)));
});

test('an audiobook mosaic uses scoped verified book covers, not a source-less legacy cover', () => {
  const group = folder('/夸克网盘/20-电子书/有声书');
  const first = folder(group.path + '/《冯唐成事心法》有声读物');
  const second = folder(group.path + '/《我当阴阳先生的那几年》有声读物');
  const other = folder('/夸克网盘/20-电子书/其他有声书');
  const rows = [group, first, second, other,
    file(first.path + '/01.mp3', 'audio'), file(second.path + '/01.mp3', 'audio')];
  const result = createResourcePresentation(rows, [
    { path: group.path, kind: 'image' },
    { path: first.path, kind: 'book-cover', source: 'https://www.dedao.cn/ebook/detail?id=verified' },
    { path: second.path, kind: 'book-cover', source: 'https://cread.jd.com/read/startRead.action?bookId=verified' },
    { path: other.path, kind: 'book-cover', source: 'https://www.dedao.cn/ebook/detail?id=unrelated' },
  ])(group);
  assert.equal(result.contentType, 'audio');
  assert.equal(result.coverUrl, null);
  assert.deepEqual(result.collectionCovers.map(cover => cover.kind), ['book-cover', 'book-cover']);
  assert.equal(result.coverStatus, 'available');
});

test('archive preview and illustration reject unrelated source paths', () => {
  const pack = folder(root + '/素材包');
  const other = folder(root + '/其他');
  const zip = file(other.path + '/别处.zip', 'file');
  const decorate = createResourcePresentation([pack, other, zip], [
    { path: pack.path, kind: 'archive-preview', source: zip.path },
    { path: other.path, kind: 'illustration', source: pack.path },
  ]);
  assert.equal(decorate(pack).coverUrl, null);
  assert.equal(decorate(other).coverStatus, 'missing');
});

test('promotional images do not crowd out course videos or count as audio artwork', () => {
  const course = folder(root + '/视频课程');
  const bgm = folder(root + '/影视BGM');
  const rows = [course, bgm,
    ...Array.from({ length: 8 }, (_, i) => file(course.path + `/Screenshot_${i}.jpg`, 'image')),
    file(course.path + '/01 导学.mp4', 'video'), file(course.path + '/02 第一课.mp4', 'video'), file(course.path + '/03 正课.mp4', 'video'),
    file(bgm.path + '/免责声明.png', 'image'), file(bgm.path + '/主题曲.mp3', 'audio')];
  const decorate = createResourcePresentation(rows, []);
  assert.equal(decorate(course).previewCandidates[0].kind, 'video');
  assert.equal(decorate(course).previewCandidates[0].name, '01 导学.mp4');
  assert.equal(decorate(bgm).previewCandidates[0].kind, 'audio');
});

test('code and text previews prefer real local readme and notes', () => {
  const project = folder(root + '/项目源码');
  const rows = [project, file(project.path + '/z-main.py', 'file'), file(project.path + '/z-helper.py', 'file'), file(project.path + '/README.md', 'text'),
    file(project.path + '/说明笔记.txt', 'text')];
  const result = createResourcePresentation(rows, [])(project);
  assert.equal(result.contentType, 'code');
  assert.deepEqual(result.previewCandidates.map(item => item.kind), ['text', 'text', 'code']);
  assert.equal(result.previewCandidates[0].name, 'README.md');
});

test('reviewed report type and primary content preview override automatic shelf inference', () => {
  const report=folder('/夸克网盘/20-电子书/从内卷到躺平研究报告');
  const pdf=file(report.path+'/研究报告.pdf','pdf');
  const album=folder(root+'/志愿填报资料');
  const video=file(album.path+'/规则介绍.mp4','video');
  const pages=[file(album.path+'/资料一.pdf','pdf'),file(album.path+'/资料二.pdf','pdf')];
  const decorate=createResourcePresentation([report,pdf,album,video,...pages],[
    {path:report.path,kind:'pdf',source:pdf.path,verifiedContentType:'document'},
    {path:album.path,kind:'video',source:video.path,primary:true},
    ...pages.map(row=>({path:row.path,kind:'pdf',source:row.path}))]);
  assert.equal(decorate(report).contentType,'document');
  assert.equal(decorate(report).coverLayout,'wide');
  assert.equal(decorate({...album,viewKind:'collection'}).coverKind,'video');
  assert.equal(decorate({...album,viewKind:'collection'}).collectionCovers.length,0);
});

test('explicit short tutorials and full course bundles use their lesson previews', () => {
  const short = folder(root + '/软件使用教程');
  const bundle = folder(root + '/零基础全套课第二期');
  const rows = [short, bundle, file(short.path + '/手机版.mp4', 'video'),
    file(short.path + '/电脑版.mp4', 'video'), file(short.path + '/问题解答.txt', 'text'),
    ...Array.from({length: 12}, (_, i) => file(bundle.path + `/课${i}.mp4`, 'video')),
    ...Array.from({length: 35}, (_, i) => file(bundle.path + `/素材${i}.png`, 'image'))];
  const decorate = createResourcePresentation(rows);
  assert.equal(decorate(short).contentType, 'course');
  assert.equal(decorate(bundle).contentType, 'course');
  assert.equal(decorate(short).previewCandidates[0].kind, 'video');
  assert.equal(decorate(bundle).previewCandidates[0].kind, 'video');
});
