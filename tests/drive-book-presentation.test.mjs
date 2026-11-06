import test from 'node:test';
import assert from 'node:assert/strict';
import {createBookPresentation} from '../lib/drive-book-presentation.js';
const root='/夸克网盘/20-电子书/人文与社会';
const row=(name,kind='folder',parent=root)=>({path:parent+'/'+name,parent,name,kind,isDir:kind==='folder'});
const book=row('1置身事内'),file=row('置身事内：中国政府与经济发展 - 兰小欢.azw3','file',book.path);
test('AZW3-only book is a book without relying on pdf counts or course view',()=>{
 const present=createBookPresentation([book,file],[]);
 const actual=present({...book,viewKind:'collection',counts:{files:1}});
 assert.equal(actual.contentType,'book');assert.equal(actual.coverStatus,'missing');assert.equal(actual.coverUrl,null);
});
test('verified book with supplementary videos is still a portrait book',()=>{
 const b=row('人情、面子与权力的再生产'),f=row('人情、面子与权力的再生产.epub','epub',b.path),v=row('访谈.mp4','video',b.path);
 const actual=createBookPresentation([b,f,v],[{path:f.path,kind:'book-cover',source:f.path}])({...b,viewKind:'course'});
 assert.equal(actual.contentType,'book');assert.ok(actual.coverUrl.includes(encodeURIComponent(f.path)));
});
test('collections use constituent art and never promote one child to the collection cover',()=>{
 const b=row('揭露世界本质的9本书'),a=row('第一本.epub','epub',b.path),c=row('第二本.epub','epub',b.path);
 const actual=createBookPresentation([b,a,c],[{path:a.path,kind:'book-cover',source:a.path},{path:c.path,kind:'book-cover',source:c.path}])(b);
 assert.equal(actual.contentType,'collection');assert.equal(actual.coverUrl,null);assert.equal(actual.collectionCovers.length,2);
});
test('single work in multiple formats is one book',()=>{
 const b=row('系统之美'),docs=['pdf','epub','mobi','azw3'].map(ext=>row('系统之美.'+ext,ext,b.path));
 assert.equal(createBookPresentation([b,...docs],[])(b).contentType,'book');
});
test('unrelated covers with same name and obsolete manifest entries are rejected',()=>{
 const b=row('同名作品'),outside={path:'/elsewhere/同名作品',name:b.name,kind:'book-cover'};
 const actual=createBookPresentation([b],[outside])(b);assert.equal(actual.coverStatus,'missing');assert.equal(actual.coverUrl,null);
});
test('preferred indexed source supplies its cover rather than empty duplicate source',()=>{
 const b=row('未来呼啸而来'),other=row(b.name,'folder','/夸克网盘/20-电子书/商业与财经'),f=row('未来呼啸而来.epub','epub',other.path);
 const actual=createBookPresentation([b,other,f],[{path:other.path,source:f.path,kind:'book-cover'}])({...b,preferredPath:other.path});
 assert.equal(actual.contentType,'book');assert.ok(actual.coverUrl.includes(encodeURIComponent(other.path)));
});
test('broad shelves are collections and generic photos are not book art',()=>{
 const b=row('人文与社会','folder','/夸克网盘/20-电子书');
 const actual=createBookPresentation([b],[{path:b.path,kind:'image'}])(b);
 assert.equal(actual.contentType,'collection');assert.equal(actual.coverStatus,'missing');
});
test('non-book libraries retain their contract',()=>{
 const item={path:'/夸克网盘/30-课程教程/摄影',counts:{video:20}};assert.equal(createBookPresentation([],[])(item),item);
});
test('traditional and simplified editions share one verified book cover',()=>{
 const b=row('《普通人的财富自由之道》'),a=row('普通人的財富自由之道 繁体原版.epub','epub',b.path),c=row('普通人的財富自由之道（繁体转换为简体版）.epub','epub',b.path);
 const actual=createBookPresentation([b,a,c],[{path:a.path,kind:'book-cover',source:a.path},{path:c.path,kind:'book-cover',source:c.path}])(b);
 assert.equal(actual.contentType,'book');assert.ok(actual.coverUrl);
});
test('same-title wrapper folders do not turn a book into a collection',()=>{
 const b=row('《人性破局》：走向高手之路的思维规则'),inner=row('《人性破局》','folder',b.path),f=row('人性破局.pdf','pdf',inner.path);
 assert.equal(createBookPresentation([b,inner,f],[])(b).contentType,'book');
});
test('a title prefix never merges a sequel or chooses its cover for the original',()=>{
 const b=row('三国演义'),a=row('三国演义.epub','epub',b.path),c=row('三国演义后传.epub','epub',b.path);
 const actual=createBookPresentation([b,a,c],[{path:a.path,kind:'book-cover',source:a.path},{path:c.path,kind:'book-cover',source:c.path}])(b);
 assert.equal(actual.contentType,'collection');assert.equal(actual.coverUrl,null);assert.equal(actual.collectionCovers.length,2);
});
test('volumes remain distinct in collection art',()=>{
 const b=row('三国演义合集'),a=row('三国演义(上).epub','epub',b.path),c=row('三国演义(下).epub','epub',b.path);
 const actual=createBookPresentation([b,a,c],[{path:a.path,kind:'book-cover',source:a.path},{path:c.path,kind:'book-cover',source:c.path}])(b);
 assert.equal(actual.collectionCovers.length,2);
});
test('book and unrelated appendix with a shared prefix cannot silently take one cover',()=>{
 const b=row('西游记详解'),a=row('西游记详解.epub','epub',b.path),c=row('西游记详解外传.epub','epub',b.path);
 assert.equal(createBookPresentation([b,a,c],[])(b).contentType,'collection');
});
test('numeric book titles are preserved',()=>{
 const b=row('1984'),f=row('1984.epub','epub',b.path);
 const actual=createBookPresentation([b,f],[{path:f.path,kind:'book-cover',source:f.path}])(b);
 assert.equal(actual.contentType,'book');assert.ok(actual.coverUrl);
});
