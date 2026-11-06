import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDriveIndex,DRIVE_COLLECTIONS,driveCollection,driveKind} from '../lib/openlist-library.js';
test('drive metadata and progress are isolated per owner and category',()=>{
 const db=new DatabaseSync(':memory:');const index=createDriveIndex(db);const root=DRIVE_COLLECTIONS[0].root;
 const item={name:'lesson_100%.mp4',path:root+'/lesson_100%.mp4',size:10,isDir:false};
 index.remember(1,{path:root,page:1,total:1,items:[item]});
 assert.equal(index.search(1,'100%','courses').items.length,1);
 assert.equal(index.search(2,'').items.length,0);assert.equal(index.search(1,'','books').items.length,0);
 assert.equal(index.search(1,'100_').items.length,0);
 index.progress(1,item.path,30,60);assert.equal(index.recent(1)[0].position,30);assert.equal(index.recent(2).length,0);
 assert.equal(index.position(2,item.path).position,0);
 for(const pos of [-1,Infinity,'bad',61])assert.throws(()=>index.progress(1,item.path,pos,60));
 index.remember(1,{path:root,page:1,total:0,items:[]});assert.equal(index.recent(1).length,0);db.close();
});
test('only approved category paths map; unsafe preview formats remain downloads',()=>{
 assert.equal(DRIVE_COLLECTIONS.length,7);
 for(const c of DRIVE_COLLECTIONS){assert.equal(driveCollection(c.root+'/nested').id,c.id);assert.equal(driveCollection(c.root+'-other'),undefined);}
 assert.equal(driveKind('document.html'),'file');assert.equal(driveKind('a.svg'),'file');assert.equal(driveKind('a.epub'),'epub');assert.equal(driveKind('a.pdf'),'pdf');assert.equal(driveKind('folder',true),'folder');
});
test('reading positions validate format and remain isolated between accounts',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db);const pdf=DRIVE_COLLECTIONS[2].root+'/book.pdf',epub=DRIVE_COLLECTIONS[2].root+'/book.epub';
 index.reading(1,pdf,{location:'5'});assert.equal(index.reading(1,pdf).location,'5');assert.equal(index.reading(2,pdf).location,null);
 index.reading(1,epub,{location:'epubcfi(/6/2!/4/2:0)'});assert.match(index.reading(1,epub).location,/epubcfi/);
 for(const value of ['0','-1','1.5','javascript:bad'])assert.throws(()=>index.reading(1,pdf,{location:value}));assert.throws(()=>index.reading(1,epub,{location:'https://bad'}));db.close();
});
test('course attachments stay in their own course and retain document types',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),root=DRIVE_COLLECTIONS[0].root+'/course';
 index.remember(1,{path:root,page:1,total:3,items:[{path:root+'/lesson.mp4',name:'lesson.mp4',isDir:false,size:10},{path:root+'/notes.pdf',name:'notes.pdf',isDir:false,size:20},{path:root+'/source.zip',name:'source.zip',isDir:false,size:30}]});
 index.remember(1,{path:root+'-other',page:1,total:1,items:[{path:root+'-other/private.pdf',name:'private.pdf',isDir:false,size:1}]});
 const materials=index.materials(1,root);assert.equal(materials.total,2);assert.deepEqual(materials.items.map(x=>x.kind).sort(),['file','pdf']);assert.equal(index.materials(2,root).total,0);db.close();
});

test('search scopes SQL before its limit and never reports unauthorized index counts',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),courses=DRIVE_COLLECTIONS[0].root,materials=DRIVE_COLLECTIONS[1].root;
 index.remember(1,{path:materials,page:1,total:205,items:Array.from({length:205},(_,n)=>({path:`${materials}/needle-${n}.mp4`,name:`needle-${n}.mp4`,isDir:false,size:1}))});
 index.remember(1,{path:courses,page:1,total:3,items:Array.from({length:3},(_,n)=>({path:`${courses}/needle-course-${n}.mp4`,name:`needle-course-${n}.mp4`,isDir:false,size:1}))});
 const none=index.search(1,'needle','',[]);assert.deepEqual(none,{items:[],indexed:0,limited:false});
 const scoped=index.search(1,'needle','',['courses']);assert.equal(scoped.items.length,3);assert.equal(scoped.indexed,3);assert.equal(scoped.limited,false);
 assert.equal(index.search(1,'needle','materials',['courses']).items.length,0);
 db.close();
});
