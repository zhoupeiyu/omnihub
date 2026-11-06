import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

const source=transformSync(readFileSync(new URL('../public/drive-library.jsx',import.meta.url),'utf8'),{loader:'jsx'}).code;

function render(hash,overrides={},sourceKey=''){
 let stateIndex=0,refIndex=0;
 const effects=[];
 const React={
  Fragment:'fragment',
  createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState(initial){const index=stateIndex++;return [Object.hasOwn(overrides,index)?overrides[index]:typeof initial==='function'?initial():initial,()=>{}];},
  useRef(value){return {current:refIndex++===2?sourceKey:value};},
  useCallback:callback=>callback,useMemo:compute=>compute(),useEffect:effect=>effects.push(effect),useLayoutEffect:()=>{}
 };
 const context=vm.createContext({React,AbortController,window:{},location:{hash},URLSearchParams,api:()=>Promise.resolve({})});
 vm.runInContext(source,context);
 return {tree:context.DriveLibrary({active:true}),location:context.location,context,effects};
}
function descendants(node){
 if(!node||typeof node!=='object')return [];
 if(Array.isArray(node))return node.flatMap(descendants);
 return [node,...(node.props?.children||[]).flatMap(descendants)];
}

test('selected lesson or document keeps its own stage while course rail loads',()=>{
 for(const file of ['lesson.mp4','notes.pdf']){
  const {tree}=render('#knowledgeLibrary?tab=drive&category=courses&course=%2Froot%2FCourse&file='+encodeURIComponent('/root/Course/'+file),{5:true});
  const all=descendants(tree);
  assert.equal(all.some(node=>node.type?.name==='DriveStudyLoading'),false);
  assert.equal(all.some(node=>node.type?.name===(file.endsWith('.pdf')?'DriveDocument':'DriveMedia')),true);
  assert.equal(all.some(node=>node.props?.className?.includes('drive-curriculum-loading')),true);
 }
 const pending=descendants(render('#knowledgeLibrary?tab=drive&category=courses&course=%2Froot%2FCourse',{5:true}).tree);
 assert.equal(pending.some(node=>node.type?.name==='DriveStudyLoading'),true);
});

test('course overview opens first playable file without changing course path',()=>{
 const lesson={path:'/root/Course/Chapter/lesson.mp4',name:'lesson.mp4',kind:'video',isDir:false};
 const notes={path:'/root/Course/Chapter/notes.pdf',name:'notes.pdf',kind:'pdf',isDir:false};
 const chapter={path:'/root/Course/Chapter',name:'Chapter',isDir:true,children:[notes,lesson]};
 const course={name:'Course',path:'/root/Course',files:[notes,lesson],outline:{path:'/root/Course',isDir:true,children:[chapter]},sources:[],substituted:[]};
 const {tree,location}=render('#knowledgeLibrary?tab=drive&category=courses&course=%2Froot%2FCourse',{1:{collections:[{id:'courses',root:'/root',label:'课程'}]},3:course});
 const overview=descendants(tree).find(node=>node.props?.className==='drive-course-overview');
 assert.ok(overview);
 const entry=descendants(overview).find(node=>node.type==='button');
 entry.props.onClick();
 const params=new URLSearchParams(location.hash.split('?')[1]);
 assert.equal(params.get('course'),'/root/Course');
 assert.equal(params.get('file'),lesson.path);
});

test('semantic course response is not redirected by legacy collection viewKind',()=>{
 const path='/root/RN课程';
 const base={path,name:'RN课程',viewKind:'collection',outline:{children:[]},files:[],sources:[],substituted:[]};
 const hash='#knowledgeLibrary?tab=drive&category=courses&course='+encodeURIComponent(path);
 const course=render(hash,{3:{...base,contentType:'course'}});
 course.effects[3]();
 assert.equal(course.location.hash,hash);
 const collection=render(hash,{3:{...base,contentType:'collection'}});
 collection.effects[3]();
 const params=new URLSearchParams(collection.location.hash.split('?')[1]);
 assert.equal(params.get('course'),null);
 assert.equal(params.get('path'),path);
});

test('shelf shape is saved after commit for matching source and current client filter',()=>{
 const book={path:'/root/book.pdf',name:'book.pdf',kind:'pdf',contentType:'book'};
 const video={path:'/root/lesson.mp4',name:'lesson.mp4',kind:'video'};
 const hash='#knowledgeLibrary?tab=drive&category=books&filter=reading';
 const data={items:[book,video]};
 const catalog={collections:[{id:'books',root:'/root',label:'电子书'}]};
 const key='books|||reading|1';
 const matching=render(hash,{1:catalog,2:data},'books|||1');
 assert.equal(vm.runInContext(`driveShelfShapes.has(${JSON.stringify(key)})`,matching.context),false);
 matching.effects.at(-1)();
 const shape=vm.runInContext(`driveShelfShapes.get(${JSON.stringify(key)})`,matching.context);
 assert.equal(shape.length,1);
 assert.equal(shape[0].kind,'books');
 assert.deepEqual([...shape[0].layouts],['portrait']);
 const stale=render(hash,{1:catalog,2:data},'courses|||1');
 stale.effects.at(-1)();
 assert.equal(vm.runInContext(`driveShelfShapes.has(${JSON.stringify(key)})`,stale.context),false);
});

test('semantic type controls card layout, filter, and course navigation',()=>{
 const {context}=render('#knowledgeLibrary?tab=drive',{1:{collections:[]}});
 const book={name:'《书》.pdf',path:'/root/book.pdf',kind:'pdf',contentType:'book',coverLayout:'wide',displayType:'书籍'};
 const slides={name:'展示.pptx',path:'/root/slides.pptx',kind:'file',contentType:'presentation',coverLayout:'portrait',displayType:'演示文稿',coverUrl:'/api/openlist/library/cover?path=slides'};
 const assets={name:'素材',path:'/root/assets',isDir:true,contentType:'assets',counts:{video:1,files:8}};
 const course={name:'课程',path:'/root/course',isDir:true,contentType:'course',counts:{video:0,files:8}};
 assert.equal(context.driveCoverLayout(book),'portrait');
 assert.equal(context.driveCoverLayout(slides),'wide');
 assert.equal(context.driveMatchesFilter(slides,'reading'),true);
 assert.equal(context.driveMatchesFilter(assets,'video'),false);
 assert.equal(context.driveMatchesFilter(course,'video'),true);
 assert.equal(context.driveOpensAsCourse(assets),false);
 assert.equal(context.driveOpensAsCourse(course),true);
 const card=context.DriveResourceCard({reactRuntime:context.React,item:slides,onOpen:()=>{}});
 assert.ok(card.props.className.includes('cover-layout-wide'));
 assert.ok(!card.props.className.includes('is-ebook-card'));
 assert.equal(descendants(card).find(node=>node.type==='img').props.src,slides.coverUrl);
 assert.equal(descendants(card).find(node=>node.props?.className==='drive-cover-type').props.children[0],'演示文稿');
});

test('cards prioritize real cover and mosaic, then preview component or explicit missing state',()=>{
 const {context}=render('#knowledgeLibrary?tab=drive',{1:{collections:[]}});
 const item={name:'资料合集',path:'/root/materials',isDir:true,contentType:'assets',collectionCovers:[{url:'/api/cover/a',name:'A'},{url:'/api/cover/b',name:'B'}],previewCandidates:[{path:'/root/slide.pdf',kind:'pdf'}]};
 let card=context.DriveResourceCard({reactRuntime:context.React,item,onOpen:()=>{}});
 assert.equal(descendants(card).filter(node=>node.type==='img').length,2);
 assert.equal(descendants(card).some(node=>node.props?.className==='drive-cover-mosaic'),true);
 const Preview=function ContentPreview(){};
 context.window.OmniDrivePreview={ContentPreview:Preview};
 card=context.DriveResourceCard({reactRuntime:context.React,item:{...item,collectionCovers:[]},onOpen:()=>{}});
 assert.equal(descendants(card).some(node=>node.type===Preview),true);
 card=context.DriveResourceCard({reactRuntime:context.React,item:{...item,collectionCovers:[],previewCandidates:[]},onOpen:()=>{}});
 assert.equal(descendants(card).some(node=>node.props?.className==='drive-cover-missing'),true);
 assert.equal(source.includes('data:image/svg+xml'),false);
});

test('files without usable previews use compact rows while visual resources stay cards',()=>{
 const {context}=render('#knowledgeLibrary?tab=drive',{1:{collections:[]}});
 context.window.OmniDrivePreview={ContentPreview(){},validCandidates(value){return (value||[]).filter(candidate=>['image','video','pdf','epub','text','code','audio'].includes(candidate.kind)&&candidate.path?.startsWith('/夸克网盘/'));}};
 const track={path:'/root/song.mp3',name:'song.mp3',kind:'audio',contentType:'audio',size:2097152};
 const sourceFile={path:'/root/readme.md',name:'readme.md',kind:'text',contentType:'code',size:1536};
 const plainZip={path:'/root/pack.zip',name:'pack.zip',kind:'file',contentType:'archive'};
 const previewZip={...plainZip,path:'/root/preview.zip',previewCandidates:[{path:'/夸克网盘/80-素材库/slide.pdf',kind:'pdf'}]};
 const pdf={path:'/root/guide.pdf',name:'guide.pdf',kind:'pdf',contentType:'document'};
 const previewPdf={...pdf,path:'/root/preview.pdf',previewCandidates:[{path:'/夸克网盘/20-电子书/preview.pdf',kind:'pdf'}]};
 const docx={path:'/root/notes.docx',name:'notes.docx',kind:'file',contentType:'document'};
 const slides={path:'/root/slides.pptx',name:'slides.pptx',kind:'file',contentType:'presentation'};
 const resource={path:'/root/data.bin',name:'data.bin',kind:'file',contentType:'resource'};
 const promo={path:'/root/promo.jpg',name:'推广.jpg',kind:'image',contentType:'image',previewCandidates:[]};
 const invalidPreview={...docx,path:'/root/invalid.docx',previewCandidates:[{path:'/outside/cover.png',kind:'image'}]};
 const book={path:'/root/book.epub',name:'book.epub',kind:'epub',contentType:'book'};
 const emptyFolder={path:'/root/empty',name:'未分类',isDir:true,contentType:'collection',counts:{files:0}};
 const sections=context.driveShelfSections([track,sourceFile,plainZip,previewZip,pdf,previewPdf,docx,slides,resource,promo,invalidPreview,book,emptyFolder],'materials');
 assert.deepEqual(Array.from(sections.find(section=>section.kind==='files').items,item=>item.path),[track,sourceFile,plainZip,pdf,docx,slides,resource,promo,invalidPreview].map(item=>item.path));
 assert.deepEqual(Array.from(sections.find(section=>section.kind==='collections').items,item=>item.path),[previewZip,previewPdf,emptyFolder].map(item=>item.path));
 assert.deepEqual(Array.from(sections.find(section=>section.kind==='books').items,item=>item.path),[book.path]);
 assert.equal(context.driveIsCompactFile(previewZip),false);
 assert.equal(context.driveIsCompactFile(pdf),true);
 assert.equal(context.driveIsCompactFile(previewPdf),false);
 assert.equal(context.driveIsCompactFile(promo),true);
 assert.equal(context.driveIsCompactFile(book),false);
 assert.equal(context.driveIsCompactFile(emptyFolder),false);
 const fileList=context.DriveFileList({items:[track,sourceFile],onOpen:()=>{}});
 const rows=descendants(fileList).filter(node=>node.props?.className==='drive-file-row');
 assert.equal(rows.length,2);
 assert.ok(rows[0].props['aria-label'].startsWith('播放音频'));
 assert.equal(descendants(rows[0]).find(node=>node.type==='small').props.children[0],'2.0 MB');
 assert.equal(descendants(fileList).some(node=>node.type==='img'),false);
 const emptyCard=context.DriveResourceCard({reactRuntime:context.React,item:emptyFolder,onOpen:()=>{}});
 assert.equal(descendants(emptyCard).find(node=>node.props?.className==='drive-cover-missing').props.children[1].props.children[0],'空目录 · 暂无内容');
});

test('cached shelf skeleton mirrors compact file rows rather than image covers',()=>{
 const track={path:'/root/a.mp3',name:'a.mp3',kind:'audio',contentType:'audio'};
 const sourceFile={path:'/root/b.md',name:'b.md',kind:'text',contentType:'code'};
 const hash='#knowledgeLibrary?tab=drive&category=materials';
 const shelf=render(hash,{1:{collections:[{id:'materials',root:'/root'}]},2:{items:[track,sourceFile]}},'materials|||1');
 shelf.effects.at(-1)();
 const key='materials|||all|1';
 const skeleton=shelf.context.DriveShelfLoading({reactRuntime:shelf.context.React,category:'materials',routeKey:key});
 assert.equal(descendants(skeleton).filter(node=>node.props?.className==='drive-file-row').length,2);
 assert.equal(descendants(skeleton).some(node=>(node.props?.className||'').includes('drive-loading-cover')),false);
});
