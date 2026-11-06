import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/drive-library.jsx',import.meta.url),'utf8');
function section(name){
 const start=`/* study-tools:${name}:start */`,end=`/* study-tools:${name}:end */`,from=source.indexOf(start),to=source.indexOf(end);
 assert.ok(from>=0&&to>from,`missing ${name} markers`);
 return source.slice(from+start.length,to);
}
const api=vm.runInNewContext(section('pure')+'\n'+section('sync')+'\n;({driveStudyKey,driveStudyLoad,driveStudySave,driveStudyNormalize,driveStudyBackup,driveStudySetNotes,driveStudyAddCard,driveStudyParse,driveStudyRead,driveStudyCommit,driveStudySession})',{},{filename:'study-tools.jsx'});
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const setNotes=text=>(state,now)=>api.driveStudySetNotes(state,text,now);
const addCard=(id,front='Q '+id,back='A '+id)=>(state,now)=>api.driveStudyAddCard(state,front,back,id,now);
const stored=(view,key)=>api.driveStudyLoad(view,key).state;

// One shared origin storage seen through per-tab views. Like the browser, a write fires storage events only in the other tabs;
// tests deliver them explicitly so they can also model delayed or missed events and stale cross-process reads.
function sharedStorage(){
 const data=new Map(),views=[];
 function write(from,key,value){
  const oldValue=data.has(key)?data.get(key):null;
  if(value==null)data.delete(key);else data.set(key,value);
  for(const view of views)if(view!==from)view.queue.push({key,oldValue,newValue:value,storageArea:view});
 }
 return {data,tab(){
  const view={queue:[],stale:null,failWrites:false,failReads:false,
   getItem(key){if(view.failReads)throw new Error('SecurityError');if(view.stale&&view.stale.has(key))return view.stale.get(key);return data.has(key)?data.get(key):null;},
   setItem(key,value){if(view.failWrites)throw new Error('QuotaExceededError');write(view,key,String(value));},
   removeItem(key){write(view,key,null);},
   deliver(session){for(const event of view.queue.splice(0))session.onStorage(event);}};
  views.push(view);
  return view;
 }};
}
// Exclusive per-name lock manager shared by all tabs. With manual=true each grant waits for release(), modelling a slow lock/save.
function fakeLocks({manual=false}={}){
 const tails=new Map(),grants=[];
 return {grants,
  request(name,options,callback){
   assert.equal(options.mode,'exclusive');
   const run=(tails.get(name)||Promise.resolve()).then(()=>manual?new Promise(resolve=>grants.push(resolve)):null).then(()=>callback());
   tails.set(name,run.then(()=>{},()=>{}));
   return run;
  },
  release(){const grant=grants.shift();assert.ok(grant,'no pending lock grant');grant();}
 };
}
const KEY=api.driveStudyKey('user-1','courses/algebra');

test('stale baseline cannot silently clear notes saved by another tab; recovery is an explicit reload',async()=>{
 const store=sharedStorage(),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY}),b=api.driveStudySession({storage:tabB,key:KEY});
 a.edit(setNotes('A notes'));await a.flush();
 assert.equal(stored(tabA,KEY).notes,'A notes');
 // B never saw A's write (event not delivered yet) and adds a card on top of its old snapshot.
 b.edit(addCard('c1'));await b.flush();
 assert.equal(stored(tabA,KEY).notes,'A notes');
 assert.equal(stored(tabA,KEY).cards.length,0);
 let snap=b.snapshot();
 assert.equal(snap.status,'conflict');
 assert.equal(snap.dirty,true);
 assert.deepEqual(plain(snap.study.cards.map(card=>card.id)),['c1']);
 assert.deepEqual(plain(api.driveStudyBackup(snap.study,{scope:'courses/algebra',title:'Algebra',now:0}).cards.map(card=>card.id)),['c1']);
 // Further edits stay local and are still not written while the conflict is open, even if a late event arrives.
 b.edit(addCard('c2'));tabB.deliver(b);await b.flush();
 assert.equal(b.snapshot().status,'conflict');
 assert.equal(b.snapshot().study.cards.length,2);
 assert.equal(stored(tabA,KEY).cards.length,0);
 // Only the user's explicit reload replaces local content.
 assert.equal(b.reload(),true);
 snap=b.snapshot();
 assert.equal(snap.status,'ok');
 assert.equal(snap.study.notes,'A notes');
 assert.equal(snap.study.cards.length,0);
 b.edit(addCard('c3'));await b.flush();
 assert.equal(stored(tabA,KEY).notes,'A notes');
 assert.deepEqual(plain(stored(tabA,KEY).cards.map(card=>card.id)),['c3']);
});

test('storage events refresh a clean tab but never overwrite unsaved local edits',async()=>{
 const store=sharedStorage(),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY}),b=api.driveStudySession({storage:tabB,key:KEY});
 let renders=0;b.subscribe(()=>renders++);
 a.edit(setNotes('v1'));await a.flush();
 tabB.deliver(b);
 assert.equal(b.snapshot().study.notes,'v1');
 assert.equal(b.snapshot().status,'ok');
 assert.ok(renders>0);
 b.edit(addCard('c1'));await b.flush();
 assert.equal(b.snapshot().status,'ok');
 assert.equal(stored(tabA,KEY).notes,'v1');
 assert.equal(stored(tabA,KEY).cards.length,1);
 tabA.deliver(a);
 assert.equal(a.snapshot().status,'ok');
 assert.equal(a.snapshot().study.cards.length,1);
 // B now has an unsaved edit (write fails) when A's next save arrives.
 tabB.failWrites=true;
 b.edit(setNotes('B local'));await b.flush();
 assert.equal(b.snapshot().status,'error');
 a.edit(setNotes('A2'));await a.flush();
 tabB.deliver(b);
 assert.equal(b.snapshot().status,'conflict');
 assert.equal(b.snapshot().study.notes,'B local');
 tabB.failWrites=false;
 b.edit(setNotes('B local 2'));await b.flush();
 assert.equal(stored(tabA,KEY).notes,'A2');
 assert.equal(b.snapshot().study.notes,'B local 2');
});

test('delayed locked save: edits made while waiting are saved afterwards and never rolled back',async()=>{
 const store=sharedStorage(),tab=store.tab(),locks=fakeLocks({manual:true});
 const a=api.driveStudySession({storage:tab,key:KEY,locks});
 assert.equal(a.snapshot().locked,true);
 a.edit(setNotes('one'));await settle();
 assert.equal(locks.grants.length,1);
 assert.equal(store.data.has(KEY),false);
 assert.equal(a.snapshot().saving,true);
 a.edit(setNotes('one two'));await settle();
 assert.equal(locks.grants.length,1);
 locks.release();await settle();
 assert.equal(stored(tab,KEY).notes,'one');
 assert.equal(a.snapshot().study.notes,'one two');
 assert.equal(a.snapshot().dirty,true);
 assert.equal(locks.grants.length,1);
 const done=a.flush();
 locks.release();await done;
 assert.equal(stored(tab,KEY).notes,'one two');
 assert.equal(a.snapshot().dirty,false);
 assert.equal(a.snapshot().status,'ok');
 assert.equal(a.snapshot().study.notes,'one two');
});

test('Web Locks serialise read-compare-write for two tabs saving from the same baseline',async()=>{
 const store=sharedStorage(),locks=fakeLocks({manual:true}),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY,locks}),b=api.driveStudySession({storage:tabB,key:KEY,locks});
 a.edit(setNotes('A notes'));b.edit(addCard('c1'));await settle();
 assert.equal(locks.grants.length,1);
 locks.release();await settle();
 assert.equal(stored(tabA,KEY).notes,'A notes');
 assert.equal(locks.grants.length,1);
 locks.release();await settle();
 assert.equal(stored(tabA,KEY).notes,'A notes');
 assert.equal(stored(tabA,KEY).cards.length,0);
 assert.equal(b.snapshot().status,'conflict');
 assert.equal(b.snapshot().study.cards.length,1);
 assert.equal(a.snapshot().status,'ok');
});

test('without Web Locks the session degrades explicitly but still checks before writing',async()=>{
 const store=sharedStorage(),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY}),b=api.driveStudySession({storage:tabB,key:KEY});
 assert.equal(a.snapshot().locked,false);
 a.edit(setNotes('A'));await a.flush();
 b.edit(setNotes('B'));await b.flush();
 assert.equal(stored(tabA,KEY).notes,'A');
 assert.equal(b.snapshot().status,'conflict');
 // A lock API that rejects (e.g. opaque origin) is dropped and reported as unlocked; the save still happens with the check.
 const broken={request(){return Promise.reject(new Error('SecurityError'));}},key2=api.driveStudyKey('user-1','courses/other');
 const c=api.driveStudySession({storage:store.tab(),key:key2,locks:broken});
 assert.equal(c.snapshot().locked,true);
 c.edit(setNotes('C'));await c.flush();
 assert.equal(c.snapshot().locked,false);
 assert.equal(c.snapshot().status,'ok');
 assert.equal(stored(tabA,key2).notes,'C');
});

test('an overwrite that slips past a stale read is reported by rev/parent, not refreshed away',async()=>{
 const store=sharedStorage(),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY}),b=api.driveStudySession({storage:tabB,key:KEY});
 tabB.stale=new Map([[KEY,null]]); // B's process has not yet seen A's write
 a.edit(setNotes('A notes'));await a.flush();
 b.edit(addCard('c1'));await b.flush();
 // localStorage offers no atomic compare-and-set: B's check passed on its stale copy and replaced A's record.
 assert.equal(stored(tabA,KEY).notes,'');
 tabA.deliver(a);
 assert.equal(a.snapshot().status,'conflict');
 assert.equal(a.snapshot().study.notes,'A notes');
 assert.equal(api.driveStudyBackup(a.snapshot().study,{scope:'s',title:'t',now:0}).notes,'A notes');
});

test('a clean observer that never wrote still detects an overwrite based on an older revision',async()=>{
 const store=sharedStorage(),tabA=store.tab(),tabB=store.tab(),revs=['r0','r1','r2'];
 const a=api.driveStudySession({storage:tabA,key:KEY,makeRev:()=>revs.shift()});
 a.edit(setNotes('zero'));await a.flush();
 const r0=store.data.get(KEY);
 const b=api.driveStudySession({storage:tabB,key:KEY,makeRev:()=>'rb'});
 a.edit(setNotes('one'));await a.flush();
 // The observer page opens on r1 and only ever reads: it has no rev of its own.
 const tabO=store.tab(),o=api.driveStudySession({storage:tabO,key:KEY});
 assert.equal(o.snapshot().study.notes,'one');
 // An in-order successor (parent = the observer's baseline) still refreshes the clean page.
 a.edit(setNotes('two'));await a.flush();
 tabO.deliver(o);
 assert.equal(o.snapshot().status,'ok');
 assert.equal(o.snapshot().study.notes,'two');
 // B's process still reads r0 and saves on top of it, replacing r2 unseen.
 tabB.stale=new Map([[KEY,r0]]);
 b.edit(addCard('c1'));await b.flush();
 assert.equal(api.driveStudyParse(store.data.get(KEY)).parent,'r0');
 assert.equal(stored(tabA,KEY).notes,'zero');
 tabO.deliver(o);
 const snap=o.snapshot();
 assert.equal(snap.status,'conflict');
 assert.equal(snap.dirty,false);
 assert.equal(snap.study.notes,'two');
 assert.equal(snap.study.cards.length,0);
 assert.equal(api.driveStudyBackup(snap.study,{scope:'s',title:'t',now:0}).notes,'two');
 // Edits made on the observer during the conflict stay local and are not written.
 o.edit(setNotes('two+'));await o.flush();
 assert.equal(o.snapshot().status,'conflict');
 assert.equal(stored(tabA,KEY).notes,'zero');
 // Only an explicit reload adopts the stored record.
 assert.equal(o.reload(),true);
 assert.equal(o.snapshot().status,'ok');
 assert.equal(o.snapshot().study.notes,'zero');
 assert.equal(o.snapshot().study.cards.length,1);
 // Clearing the record under a page whose baseline has a rev is likewise not accepted silently.
 store.tab().removeItem(KEY);
 tabO.queue.splice(0);
 o.onStorage({key:KEY,oldValue:null,newValue:null,storageArea:tabO});
 assert.equal(o.snapshot().status,'conflict');
 assert.equal(o.snapshot().study.cards.length,1);
});

test('storage failures keep local edits exportable and retry on the next edit',async()=>{
 const store=sharedStorage(),tab=store.tab();
 const a=api.driveStudySession({storage:tab,key:KEY});
 tab.failWrites=true;
 a.edit(setNotes('draft'));a.edit(addCard('c1'));await a.flush();
 assert.equal(a.snapshot().status,'error');
 assert.equal(a.snapshot().dirty,true);
 assert.equal(store.data.has(KEY),false);
 const backup=api.driveStudyBackup(a.snapshot().study,{scope:'s',title:'t',now:0});
 assert.equal(backup.notes,'draft');
 assert.equal(backup.cards.length,1);
 tab.failWrites=false;
 a.edit(setNotes('draft 2'));await a.flush();
 assert.equal(a.snapshot().status,'ok');
 assert.equal(stored(tab,KEY).notes,'draft 2');
 assert.equal(stored(tab,KEY).cards.length,1);
 const unreadable=store.tab();unreadable.failReads=true;
 const u=api.driveStudySession({storage:unreadable,key:KEY});
 assert.equal(u.snapshot().status,'error');
 u.edit(setNotes('kept'));await u.flush();
 assert.equal(u.snapshot().study.notes,'kept');
 assert.equal(stored(tab,KEY).notes,'draft 2');
});

test('reload during an in-flight save and key switching drop stale save results',async()=>{
 const store=sharedStorage(),locks=fakeLocks({manual:true}),tabA=store.tab(),tabB=store.tab();
 const a=api.driveStudySession({storage:tabA,key:KEY,locks}),other=api.driveStudySession({storage:tabB,key:KEY});
 a.edit(setNotes('local'));await settle();
 other.edit(setNotes('external'));await other.flush();
 tabA.deliver(a);
 assert.equal(a.snapshot().status,'conflict');
 assert.equal(a.reload(),true);
 locks.release();await settle();
 assert.equal(stored(tabA,KEY).notes,'external');
 assert.equal(a.snapshot().study.notes,'external');
 assert.equal(a.snapshot().status,'ok');
 // Unmount / key switch: the old course's session finishes its own save; the new course's state is untouched.
 const key2=api.driveStudyKey('user-1','courses/geometry'),locks2=fakeLocks({manual:true});
 const first=api.driveStudySession({storage:tabA,key:KEY,locks:locks2});
 let calls=0;const off=first.subscribe(()=>calls++);
 first.edit(setNotes('course one'));await settle();
 off();const before=calls;
 const second=api.driveStudySession({storage:tabA,key:key2,locks:locks2});
 second.edit(setNotes('course two'));await settle();
 assert.equal(locks2.grants.length,2);
 locks2.release();locks2.release();await settle();
 assert.equal(calls,before);
 assert.equal(stored(tabA,KEY).notes,'course one');
 assert.equal(stored(tabA,key2).notes,'course two');
 assert.equal(second.snapshot().study.notes,'course two');
});

test('records stay compatible with the existing load/save API',async()=>{
 const store=sharedStorage(),tab=store.tab();
 const a=api.driveStudySession({storage:tab,key:KEY,makeRev:()=>'r1'});
 a.edit(setNotes('n'));await a.flush();
 const loaded=api.driveStudyLoad(tab,KEY);
 assert.equal(loaded.error,null);
 assert.deepEqual(Object.keys(loaded.state),['version','notes','cards','updatedAt']);
 assert.equal(api.driveStudyParse(store.data.get(KEY)).rev,'r1');
 // A legacy record (no rev) written by driveStudySave is a valid baseline.
 assert.equal(api.driveStudySave(tab,KEY,{notes:'legacy',cards:[]}),true);
 const b=api.driveStudySession({storage:tab,key:KEY,makeRev:()=>'r2'});
 assert.equal(b.snapshot().study.notes,'legacy');
 b.edit(setNotes('legacy+'));await b.flush();
 assert.equal(b.snapshot().status,'ok');
 assert.deepEqual(plain({rev:api.driveStudyParse(store.data.get(KEY)).rev,parent:api.driveStudyParse(store.data.get(KEY)).parent}),{rev:'r2',parent:null});
 assert.equal(api.driveStudyKey('',''),null);
 const none=api.driveStudySession({storage:tab,key:null});
 none.edit(setNotes('page only'));await none.flush();
 assert.equal(none.snapshot().study.notes,'page only');
});

test('component uses the guarded session with Web Locks feature detection',()=>{
 assert.match(source,/navigator\.locks/);
 assert.match(source,/typeof locks\.request==='function'/);
 assert.match(source,/driveStudySession\(\{storage:driveStudyStorage\(\),key,locks:driveStudyLocks\(\)\}\)/);
 assert.doesNotMatch(source,/setSaveState\(driveStudySave\(/);
 assert.match(source,/addEventListener\('storage'/);
});
