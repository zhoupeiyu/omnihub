import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/drive-library.jsx',import.meta.url),'utf8');
const region=name=>{
 const start=`/* ${name}:start */`,a=source.indexOf(start),b=source.indexOf(`/* ${name}:end */`);
 assert.ok(a>=0&&b>a,`missing region ${name}`);
 return source.slice(a+start.length,b);
};
const plain=value=>JSON.parse(JSON.stringify(value));
const names=['DRIVE_FOCUS_MS','DRIVE_STUDY_LIMITS','driveStudyKey','driveStudyEmpty','driveStudyNormalize','driveStudyLoad','driveStudySave','driveStudySetNotes','driveStudyAddCard','driveStudyRateCard','driveStudyRemoveCard','driveStudyResetCards','driveStudyNextCard','driveStudyCounts','driveStudyBackup','driveFocusInitial','driveFocusStart','driveFocusPause','driveFocusReset','driveFocusRemaining','driveFocusTick','driveFocusFormat','DriveFocusTimer'];
function load(globals={}){return vm.runInContext(`${region('study-tools:pure')}\n${region('study-tools:vm')}\n;({${names.join(',')}})`,vm.createContext(globals));}
function memoryStorage(){const data=new Map();return {data,getItem:key=>data.has(key)?data.get(key):null,setItem:(key,value)=>{data.set(key,String(value));}};}

const study=load();

test('account and course keys never collide',()=>{
 const {driveStudyKey:key}=study;
 assert.notEqual(key('a','课程/一'),key('b','课程/一'));
 assert.notEqual(key('a','课程/一'),key('a','课程/二'));
 assert.notEqual(key('a:b','c'),key('a','b:c'));
 assert.equal(key(7,'x'),key('7','x'));
 assert.equal(key(0,'x')===null,false);
 for(const [user,scope] of [[null,'x'],[undefined,'x'],['  ','x'],['a',''],['a','  ']])assert.equal(key(user,scope),null);
});

test('saved study data is only visible to the same account and course',()=>{
 const {driveStudyKey:key,driveStudyEmpty,driveStudySetNotes,driveStudySave,driveStudyLoad}=study,storage=memoryStorage();
 assert.equal(driveStudySave(storage,key('a','课程一'),driveStudySetNotes(driveStudyEmpty(),'A 的笔记',1)),true);
 assert.equal(driveStudySave(storage,key('a','课程二'),driveStudySetNotes(driveStudyEmpty(),'A 的另一门',2)),true);
 assert.equal(driveStudyLoad(storage,key('a','课程一')).state.notes,'A 的笔记');
 assert.equal(driveStudyLoad(storage,key('a','课程二')).state.notes,'A 的另一门');
 assert.equal(driveStudyLoad(storage,key('b','课程一')).state.notes,'');
 assert.equal(storage.data.size,2);
 assert.equal(driveStudySave(storage,null,driveStudySetNotes(driveStudyEmpty(),'无账号',3)),false);
 assert.equal(storage.data.size,2);
});

test('damaged records load as empty and are reported instead of crashing',()=>{
 const {driveStudyLoad}=study,key='k';
 for(const raw of ['{broken','[]','5','"text"','null','true']){
  const storage=memoryStorage();
  storage.setItem(key,raw);
  const result=driveStudyLoad(storage,key);
  assert.equal(result.error,'corrupt',raw);
  assert.deepEqual(plain(result.state),{version:1,notes:'',cards:[],updatedAt:0});
  assert.equal(storage.getItem(key),raw,'loading must not rewrite the record');
 }
 const blocked={getItem(){throw Error('SecurityError');}};
 assert.equal(driveStudyLoad(blocked,key).error,'unavailable');
 assert.equal(driveStudyLoad(null,key).error,'unavailable');
 assert.equal(driveStudyLoad(memoryStorage(),key).error,null);
});

test('partly invalid records keep every usable card',()=>{
 const {driveStudyLoad}=study,storage=memoryStorage();
 storage.setItem('k',JSON.stringify({notes:42,updatedAt:-1,cards:[null,'x',{id:'a',front:'问',back:'答',status:'bogus',reviews:-2,reviewedAt:'x'},{id:'a',front:'重复',back:'重复'},{id:'b',front:'  ',back:'空问题'},{front:'无 id',back:'x'},{id:'c',front:'问二',back:'答二',status:'known',reviews:3,reviewedAt:9,createdAt:4}]}));
 const {state,error}=driveStudyLoad(storage,'k');
 assert.equal(error,null);
 assert.equal(state.notes,'');
 assert.equal(state.updatedAt,0);
 assert.deepEqual(plain(state.cards),[{id:'a',front:'问',back:'答',status:'new',reviews:0,reviewedAt:0,createdAt:0},{id:'c',front:'问二',back:'答二',status:'known',reviews:3,reviewedAt:9,createdAt:4}]);
});

test('a full quota reports failure, keeps the state and recovers later',()=>{
 const {driveStudyEmpty,driveStudySetNotes,driveStudySave,driveStudyLoad}=study,storage=memoryStorage(),write=storage.setItem;
 const state=driveStudySetNotes(driveStudyEmpty(),'重要内容',5);
 assert.equal(driveStudySave(storage,'k',driveStudySetNotes(state,'旧内容',4)),true);
 storage.setItem=()=>{throw Error('QuotaExceededError');};
 assert.equal(driveStudySave(storage,'k',state),false);
 assert.equal(state.notes,'重要内容');
 assert.equal(driveStudyLoad(storage,'k').state.notes,'旧内容');
 storage.setItem=write;
 assert.equal(driveStudySave(storage,'k',state),true);
 assert.equal(driveStudyLoad(storage,'k').state.notes,'重要内容');
 assert.equal(driveStudySave(null,'k',state),false);
});

test('flashcard self rating orders practice and tracks mastery',()=>{
 const {driveStudyEmpty,driveStudyAddCard:add,driveStudyRateCard:rate,driveStudyNextCard:next,driveStudyCounts:counts,driveStudyResetCards:reset,driveStudyRemoveCard:remove}=study;
 let state=add(add(add(driveStudyEmpty(),' 问一 ',' 答一 ','a',1),'问二','答二','b',2),'问三','答三','c',3);
 assert.equal(state.cards[0].front,'问一');
 assert.equal(next(state).id,'a');
 state=rate(state,'a','again',10);
 assert.equal(state.cards[0].status,'again');
 assert.equal(state.cards[0].reviews,1);
 assert.equal(next(state).id,'b','a card marked again waits behind unseen cards');
 state=rate(state,'b','known',11);
 assert.equal(next(state).id,'c');
 state=rate(state,'c','again',12);
 assert.equal(next(state).id,'a','the longest waiting card comes back first');
 assert.deepEqual(plain(counts(state)),{total:3,known:1,pending:2});
 state=rate(rate(state,'a','known',13),'c','known',14);
 assert.equal(next(state),null);
 assert.deepEqual(plain(counts(state)),{total:3,known:3,pending:0});
 assert.equal(rate(state,'a','bogus',15),state);
 assert.equal(rate(state,'missing','known',15),state);
 state=reset(state,16);
 assert.equal(next(state).id,'a');
 assert.equal(counts(state).known,0);
 assert.equal(state.cards[0].reviews,2,'history survives a reset');
 state=remove(state,'a',17);
 assert.equal(next(state).id,'b');
 assert.equal(remove(state,'missing',18),state);
});

test('invalid new cards are rejected and the limit is enforced',()=>{
 const {driveStudyEmpty,driveStudyAddCard:add,DRIVE_STUDY_LIMITS:limits}=study,empty=driveStudyEmpty();
 assert.equal(add(empty,'  ','答','a',1),empty);
 assert.equal(add(empty,'问','','a',1),empty);
 assert.equal(add(empty,'问','答','',1),empty);
 const one=add(empty,'问','答','a',1);
 assert.equal(add(one,'问','答','a',2),one);
 const full={...empty,cards:Array.from({length:limits.cards},(_,i)=>({id:'c'+i}))};
 assert.equal(add(full,'问','答','new',1),full);
});

test('focus timing follows the absolute deadline, not tick count',()=>{
 const {DRIVE_FOCUS_MS:total,driveFocusInitial:initial,driveFocusStart:start,driveFocusPause:pause,driveFocusRemaining:remaining,driveFocusTick:tick,driveFocusReset:reset,driveFocusFormat:format}=study;
 let timer=start(initial(),1000);
 assert.equal(timer.deadline,1000+total);
 assert.equal(remaining(timer,1000+600000),total-600000,'no ticks are needed to stay accurate');
 assert.equal(start(timer,5000),timer,'starting twice keeps the deadline');
 assert.equal(tick(timer,1000+total-1),timer);
 const slept=tick(timer,1000+total+3600000);
 assert.equal(slept.status,'done');
 assert.equal(slept.remaining,0);
 assert.equal(start(slept,9000).remaining,total);
 timer=pause(timer,1000+60000);
 assert.equal(timer.status,'paused');
 assert.equal(timer.remaining,total-60000);
 assert.equal(remaining(timer,999999999),total-60000,'time does not pass while paused');
 timer=start(timer,500000);
 assert.equal(timer.deadline,500000+total-60000);
 assert.equal(pause(timer,timer.deadline+1).status,'done');
 assert.deepEqual(plain(reset(timer)),plain(initial()));
 assert.equal(format(total),'25:00');
 assert.equal(format(61001),'01:02');
 assert.equal(format(-5),'00:00');
});

function timerHarness(){
 let now=1000;
 const listeners=new Set(),intervals=new Set(),timers={
  document:{addEventListener:(type,fn)=>{assert.equal(type,'visibilitychange');listeners.add(fn);},removeEventListener:(type,fn)=>listeners.delete(fn)},
  setInterval:fn=>{intervals.add(fn);return fn;},
  clearInterval:fn=>intervals.delete(fn),
 };
 const hooks=[];
 let cursor=0,tree,cleanup,queue=[];
 const React={
  createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),
  useState(init){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof init==='function'?init():init};const slot=hooks[i];return [slot.value,next=>{slot.value=typeof next==='function'?next(slot.value):next;dirty=true;}];},
  useEffect(fn,deps){const i=cursor++,slot=hooks[i],changed=!slot||deps.some((dep,n)=>dep!==slot.deps[n]);hooks[i]={deps};if(changed)queue.push(fn);},
 };
 let dirty=true;
 const {DriveFocusTimer}=load(timers);
 const paint=()=>{while(dirty){dirty=false;cursor=0;tree=DriveFocusTimer({reactRuntime:React,clock:()=>now});const run=queue;queue=[];for(const fn of run){cleanup?.();cleanup=fn();}}};
 paint();
 const walk=node=>node&&typeof node==='object'?[node,...node.children.flatMap(walk)]:[];
 return {
  advance(ms){now+=ms;},
  text:()=>walk(tree).find(node=>node.type==='time').children[0],
  status:()=>walk(tree).find(node=>node.type==='p').children[0],
  click(label){walk(tree).find(node=>node.type==='button'&&node.children[0]===label).props.onClick();paint();},
  labels:()=>walk(tree).filter(node=>node.type==='button').map(node=>node.children[0]),
  wake(){for(const fn of listeners)fn();paint();},
  tick(){for(const fn of intervals)fn();paint();},
  unmount(){cleanup?.();},
  listeners,intervals,
 };
}

test('the timer component recalibrates after the page was hidden',()=>{
 const timer=timerHarness();
 assert.equal(timer.text(),'25:00');
 timer.click('开始');
 assert.equal(timer.intervals.size,1);
 assert.equal(timer.listeners.size,1);
 timer.advance(10*60*1000);
 assert.equal(timer.text(),'25:00','nothing updates while throttled in the background');
 timer.wake();
 assert.equal(timer.text(),'15:00');
 timer.click('暂停');
 assert.equal(timer.intervals.size,0,'pausing stops the interval');
 assert.equal(timer.listeners.size,0);
 timer.advance(60*60*1000);
 assert.equal(timer.text(),'15:00');
 timer.click('继续');
 timer.advance(5*60*1000);
 timer.tick();
 assert.equal(timer.text(),'10:00');
 timer.advance(2*60*60*1000);
 timer.wake();
 assert.equal(timer.text(),'00:00');
 assert.match(timer.status(),/已完成/);
 assert.equal(timer.intervals.size,0);
 assert.deepEqual(timer.labels(),['再来一轮','重置']);
 timer.click('重置');
 assert.equal(timer.text(),'25:00');
});

test('backup keeps the course data and states it is local only',()=>{
 const {driveStudyBackup:backup,driveStudyEmpty,driveStudySetNotes,driveStudyAddCard}=study;
 const state=driveStudyAddCard(driveStudySetNotes(driveStudyEmpty(),'笔记',1000),'问','答','a',2000);
 const value=plain(backup(state,{scope:'课程/一',title:'课程一',now:3000}));
 assert.equal(value.format,'omnihub-study-notes');
 assert.deepEqual(value.course,{title:'课程一',path:'课程/一'});
 assert.equal(value.notes,'笔记');
 assert.equal(value.cards[0].front,'问');
 assert.equal(value.exportedAt,'1970-01-01T00:00:03.000Z');
 assert.equal(value.updatedAt,'1970-01-01T00:00:02.000Z');
 assert.match(value.storage,/未同步/);
 assert.equal(backup(driveStudyEmpty(),{now:0}).updatedAt,null);
});
