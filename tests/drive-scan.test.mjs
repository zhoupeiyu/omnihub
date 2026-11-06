import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createDriveScanner} from '../lib/drive-scan.js';import {createDriveIndex,DRIVE_COLLECTIONS} from '../lib/openlist-library.js';
test('recursive scan covers all pages, resumes persisted work and indexes metadata only',async()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db);let calls=0;
 const root=DRIVE_COLLECTIONS[0].root;
 const scanner=createDriveScanner(db,{delay:0,remember:index.remember,list:async(id,path,page)=>{calls++;let rows=[];
 if(path===root)rows=Array.from({length:101},(_,i)=>({name:i?'book'+i+'.pdf':'nested',path:path+'/'+(i?'book'+i+'.pdf':'nested'),isDir:i===0,size:10}));
 if(path===root+'/nested')rows=[{name:'book.epub',path:path+'/book.epub',isDir:false,size:11}];
 return {path,page,total:rows.length,items:rows.slice((page-1)*100,page*100)};}});
 scanner.start(1);for(let n=0;n<100&&scanner.status(1).state==='running';n++)await new Promise(r=>setTimeout(r,5));
 const state=scanner.status(1);assert.equal(state.state,'complete');assert.equal(state.directories,8);assert.equal(state.done,8);assert.equal(state.files,101);assert.equal(calls,9);assert.equal(index.search(1,'book.epub').items.length,1);assert.equal(scanner.status(2).state,'not_started');db.close();
});
test('duplicate pages cannot report completion and failed directories can be retried',async()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),root=DRIVE_COLLECTIONS[0].root;let broken=true;
 const scanner=createDriveScanner(db,{delay:0,remember:index.remember,list:async(id,path,page)=>({path,page,total:path===root?2:0,items:path===root?[{name:`${broken?1:page}.pdf`,path:path+`/${broken?1:page}.pdf`,isDir:false,size:1}]:[]})});
 scanner.start(1);for(let n=0;n<1000&&scanner.status(1).state==='running';n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(scanner.status(1).state,'incomplete');assert.equal(scanner.status(1).failed,1);broken=false;scanner.start(1,{retry:true});
 for(let n=0;n<100&&scanner.status(1).state==='running';n++)await new Promise(r=>setTimeout(r,5));assert.equal(scanner.status(1).state,'complete');assert.equal(scanner.status(1).files,2);db.close();
});
test('a service restart resumes the interrupted page instead of restarting finished folders',async()=>{
 const db=new DatabaseSync(':memory:'),index=createDriveIndex(db),root=DRIVE_COLLECTIONS[0].root;
 createDriveScanner(db,{list:async()=>{},remember:index.remember});
 db.prepare("INSERT INTO drive_scan_jobs VALUES (9,'running',?,NULL)").run(Date.now()-1000);
 for(const c of DRIVE_COLLECTIONS)db.prepare('INSERT INTO drive_scan_dirs(user_id,path,state,page,total,seen) VALUES (?,?,?,?,?,?)').run(9,c.root,c.root===root?'working':'done',c.root===root?2:1,c.root===root?2:0,c.root===root?1:0);
 index.remember(9,{path:root,page:1,total:2,items:[{path:root+'/a.pdf',name:'a.pdf',size:1,isDir:false}]});db.prepare('INSERT INTO drive_scan_seen VALUES (?,?,?)').run(9,root+'/a.pdf',root);
 let calls=0;const scanner=createDriveScanner(db,{delay:0,remember:index.remember,list:async(id,path,page)=>{calls++;assert.equal(page,2);return {path,page,total:2,items:[{path:path+'/b.pdf',name:'b.pdf',isDir:false,size:1}]};}});scanner.resume();
 for(let n=0;n<100&&scanner.status(9).state==='running';n++)await new Promise(r=>setTimeout(r,5));assert.equal(scanner.status(9).state,'complete');assert.equal(calls,1);assert.equal(scanner.status(9).files,2);db.close();
});
