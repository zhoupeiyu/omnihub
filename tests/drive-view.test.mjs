import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDriveIndex,DRIVE_COLLECTIONS} from '../lib/openlist-library.js';
import {createDriveView,sourceKey,driveViewKind} from '../lib/drive-view.js';
test('same-title sources prefer populated folders and substitute only empty chapters without changing paths',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),a=DRIVE_COLLECTIONS[0].root,b=DRIVE_COLLECTIONS[5].root;
 function put(parent,children,user=1){index.remember(user,{path:parent,page:1,total:children.length,items:children.map(([name,isDir])=>({name,isDir,path:parent+'/'+name,size:1}))});}
 put(a,[['Seedance five courses',true]]);put(a+'/Seedance five courses',[['2.即梦完整课程【40集】',true]]);put(a+'/Seedance five courses/2.即梦完整课程【40集】',[]);
 put(b,[['2.即梦完整课程【40集】',true],['2.即梦完整课程【41集】',true]]);put(b+'/2.即梦完整课程【40集】',[['01.mp4',false],['notes.pdf',false]]);put(b+'/2.即梦完整课程【41集】',[['different.mp4',false]]);
 put(a,[['Seedance five courses',true]],2);put(a+'/Seedance five courses',[['private.mp4',false]],2);
 const view=createDriveView(db),course=view.course(1,a+'/Seedance five courses');
 assert.equal(course.files.length,2);assert.equal(course.substituted.length,1);assert.equal(course.files[0].path.startsWith(b+'/'),true);
 assert.equal(view.course(1,a+'/Seedance five courses/2.即梦完整课程【40集】').sourcePath,b+'/2.即梦完整课程【40集】');
 assert.equal(view.course(1,a+'/Seedance five courses/2.即梦完整课程【40集】',a+'/Seedance five courses/2.即梦完整课程【40集】').sourcePath,a+'/Seedance five courses/2.即梦完整课程【40集】');
 assert.throws(()=>view.course(1,a+'/Seedance five courses',b+'/2.即梦完整课程【41集】'));
 assert.equal(view.course(2,a+'/Seedance five courses').files[0].name,'private.mp4');
 assert.equal(db.prepare('select count(*) n from drive_index where user_id=1 and parent=?').get(a+'/Seedance five courses/2.即梦完整课程【40集】').n,0);
 assert.notEqual(sourceKey('course v2'),sourceKey('course v3'));db.close();
});
test('Quark copy suffix groups empty and populated folders without merging real edition numbers',()=>{
 const base='抖音80W粉丝博主，付费AI漫剧教学课程',root=DRIVE_COLLECTIONS[5].root;
 assert.equal(sourceKey(base),sourceKey(base+'(1)'));
 assert.equal(sourceKey(base),sourceKey(base+' （2） '));
 for(const suffix of ['第1期','第一部','卷1','(2024)','(0)'])assert.notEqual(sourceKey(base),sourceKey(base+suffix));
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db);
 const original=root+'/'+base,copy=original+'(1)';
 index.remember(1,{path:root,page:1,total:2,items:[{path:original,name:base,isDir:true},{path:copy,name:base+'(1)',isDir:true}]});
 index.remember(1,{path:original,page:1,total:0,items:[]});
 index.remember(1,{path:copy,page:1,total:10,items:[...Array.from({length:9},(_,i)=>({path:copy+'/'+(i+1)+'.mp4',name:(i+1)+'.mp4',isDir:false})),{path:copy+'/cover.jpg',name:'cover.jpg',isDir:false}]});
 const view=createDriveView(db),shelf=view.shelf(1,root);
 assert.equal(shelf.items.filter(item=>item.name.startsWith(base)).length,1);
 const item=shelf.items.find(item=>item.name.startsWith(base));
 assert.equal(item.preferredPath,copy);
 assert.equal(item.availableCounts.video,9);
 assert.equal(item.sources.length,2);
 const course=view.course(1,original);
 assert.equal(course.sourcePath,copy);
 assert.equal(course.files.length,10);
 db.close();
});
test('shelf reports recursive counts, separates files and pages results',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),root=DRIVE_COLLECTIONS[0].root;
 index.remember(1,{path:root,page:1,total:61,items:Array.from({length:61},(_,i)=>({path:root+'/book'+i+'.pdf',name:'book'+i+'.pdf',size:10,isDir:false}))});
 const view=createDriveView(db);assert.equal(view.shelf(1,root).items.length,60);assert.equal(view.shelf(1,root,2).items.length,1);assert.equal(view.shelf(2,root).total,0);db.close();
});

test('collections stay separate from numbered chapters and loose lessons',()=>{
 const folders=names=>names.map(name=>({name,kind:'folder'}));
 assert.equal(driveViewKind('摄影剪辑',folders(['手机摄影课','特效剪辑教程'])),'collection');
 assert.equal(driveViewKind('学习方法',folders(['学习课','思维课'])),'collection');
 assert.equal(driveViewKind('Seedance五套合集',folders(['第一套-入门','第二套-进阶'])),'collection');
 assert.equal(driveViewKind('PS大神高级创意教程合集',folders(['{1}--创意教程','{2}--海报教程'])),'course');
 assert.equal(driveViewKind('RN实战',folders(['第1章课程介绍','第2章基础教程'])),'course');
 assert.equal(driveViewKind('物理',folders(['1','2','3'])),'course');
 assert.equal(driveViewKind('摄影剪辑',[...folders(['1','2']),{name:'lesson.mp4',kind:'video'}]),'course');
});

test('book and subject shelves open as cards while individual books retain chapters',()=>{
 const folders=names=>names.map(name=>({name,kind:'folder'}));
 for(const name of ['有声书','听书解读','人文与社会','金融理财','百万剪辑狮的音效库'])assert.equal(driveViewKind(name,folders(['作品甲','作品乙'])),'collection');
 assert.equal(driveViewKind('精选',folders(['《暗时间》','《反脆弱》'])),'collection');
 assert.equal(driveViewKind('某本有声书',folders(['第一章 开始','第二章 继续'])),'course');
 assert.equal(driveViewKind('某书',folders(['《某书》第一卷','《某书》第二卷'])),'course');
 assert.equal(driveViewKind('《冯唐成事心法》有声读物',[{name:'001.mp3',kind:'audio'},{name:'002.mp3',kind:'audio'}]),'course');
});

test('reviewed layouts are account scoped and agree between shelf and old course links',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),root=DRIVE_COLLECTIONS[0].root;
 for(const user of [1,2]){
  index.remember(user,{path:root,items:[{name:'合集',path:root+'/合集',isDir:true}]});
  index.remember(user,{path:root+'/合集',items:[{name:'01.mp4',path:root+'/合集/01.mp4',isDir:false}]});
 }
 const view=createDriveView(db,id=>id===1?{[root+'/合集']:'collection'}:{});
 assert.equal(view.shelf(1,root).items[0].viewKind,'collection');
 assert.equal(view.course(1,root+'/合集').viewKind,'collection');
 assert.equal(view.shelf(2,root).items[0].viewKind,'course');
 assert.equal(view.course(2,root+'/合集').viewKind,'course');
 assert.equal(view.shelf(1,root).items[0].viewKind,'collection');
 assert.equal(db.prepare('select count(*) n from drive_index').get().n,4);
 db.close();
});

test('scoped graph never substitutes an unauthorized same-title source and recent belongs to viewer',()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),courses=DRIVE_COLLECTIONS[0].root,materials=DRIVE_COLLECTIONS[1].root;
 const title='同名课程合集';
 index.remember(1,{path:courses,items:[{name:title,path:courses+'/'+title,isDir:true}]});
 index.remember(1,{path:courses+'/'+title,items:[]});
 index.remember(1,{path:materials,items:[{name:title,path:materials+'/'+title,isDir:true}]});
 index.remember(1,{path:materials+'/'+title,items:[{name:'01.mp4',path:materials+'/'+title+'/01.mp4',isDir:false}]});
 index.progress(1,materials+'/'+title+'/01.mp4',19,40);
 index.progress(2,courses+'/'+title+'/missing.mp4',7,20);
 const view=createDriveView(db);
 const scoped=view.course(1,courses+'/'+title,undefined,2,['courses']);
 assert.deepEqual(scoped.sources.map(source=>source.path),[courses+'/'+title]);
 assert.equal(scoped.sourcePath,courses+'/'+title);
 assert.equal(scoped.files.length,0);
 assert.equal(scoped.recent,null,'viewer history may not read owner history');
 assert.equal(view.shelf(1,courses,1,['courses']).items[0].sources.length,1);
 db.close();
});
