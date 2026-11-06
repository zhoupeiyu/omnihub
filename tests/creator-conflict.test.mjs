import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=read('public/creator-workbench.jsx');
const region=name=>source.split('/* shotcraft-plan:'+name+':start */')[1].split('/* shotcraft-plan:'+name+':end */')[0];
const SOURCES=[['core',region('pure')],['ui',region('vm')]];
const KEY=user=>'omnihub:creator:video:v1:'+encodeURIComponent(user);
const settle=async(...tabs)=>{for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));tabs.forEach(tab=>tab.flush());}};

function makeHub(){
 const data=new Map(),events=[],tabs=[];
 const hub={data,tabs,failing:false,writes:0,
  area(tab){return {
   getItem:key=>data.has(key)?data.get(key):null,
   setItem(key,value){if(hub.failing)throw Error('QuotaExceededError');const oldValue=data.has(key)?data.get(key):null;data.set(key,String(value));hub.writes++;events.push({from:tab,key,oldValue,newValue:String(value)});},
   removeItem(key){const oldValue=data.get(key)??null;data.delete(key);events.push({from:tab,key,oldValue,newValue:null});}};},
  deliver(){for(const event of events.splice(0))for(const tab of tabs)if(tab!==event.from)tab.dispatch({key:event.key,oldValue:event.oldValue,newValue:event.newValue,storageArea:tab.storage});},
  plan:user=>JSON.parse(data.get(KEY(user)))};
 return hub;
}

function makeLocks(){
 const queue=[];let held=null;
 const grant=()=>{
  if(held||!queue.length)return;
  const entry=held=queue.shift();
  Promise.resolve().then(()=>entry.callback({name:entry.name,mode:'exclusive'})).then(
   value=>{held=null;entry.resolve(value);grant();},
   error=>{held=null;entry.reject(error);grant();});
 };
 const locks={requests:0,throwing:false,
  manager:{request(name,options,callback){
   locks.requests++;
   if(locks.throwing)throw Error('SecurityError');
   if(typeof options==='function'){callback=options;options={};}
   return new Promise((resolve,reject)=>{
    const entry={name,callback,resolve,reject};
    const signal=options&&options.signal;
    if(signal){
     if(signal.aborted)return reject(Error('AbortError'));
     signal.addEventListener('abort',()=>{const index=queue.indexOf(entry);if(index>=0){queue.splice(index,1);reject(Error('AbortError'));}});
    }
    queue.push(entry);grant();
   });
  }},
  hold(){assert.equal(held,null);held={external:true};},
  release(){held=null;grant();},
  get waiting(){return queue.length;}};
 return locks;
}

function makeTimers(){
 const list=[];
 return {list,setTimeout:(fn,ms)=>{const timer={fn,ms,done:false};list.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.done=true;},
  fire(){for(const timer of list.splice(0))if(!timer.done){timer.done=true;timer.fn();}}};
}

function makeHost(){
 const slots=[],effects=[];let slot=0,effect=0,dirty=false,mounted=true,queue=[],renderFn=null;
 const host={lateSets:0,out:null,
  React:{
   useState(init){const index=slot++;if(!(index in slots))slots[index]=typeof init==='function'?init():init;
    return [slots[index],value=>{if(!mounted){host.lateSets++;return;}const prev=slots[index];slots[index]=typeof value==='function'?value(prev):value;if(!Object.is(prev,slots[index]))dirty=true;}];},
   useRef(value){const index=slot++;if(!(index in slots))slots[index]={current:value};return slots[index];},
   useEffect(fn,deps){const index=effect++,prev=effects[index];if(!prev||!deps||deps.some((dep,n)=>!Object.is(dep,prev.deps[n])))queue.push(()=>{if(prev&&prev.cleanup)prev.cleanup();effects[index]={deps,cleanup:fn()};});},
   createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)})},
  render(fn){renderFn=fn;dirty=true;host.flush();},
  flush(){
   if(!mounted||!dirty)return;
   let rounds=0;
   do{dirty=false;slot=effect=0;queue=[];host.out=renderFn();assert.ok(++rounds<20,'render loop');}while(dirty);
   queue.forEach(run=>run());
   host.flush();
  },
  unmount(){effects.forEach(item=>item&&item.cleanup&&item.cleanup());mounted=false;}};
 return host;
}

function openTab(hub,{user='u1',locks,timers=makeTimers(),confirm=true}={}){
 const host=makeHost(),listeners=new Set(),downloads=[];
 const tab={host,timers,downloads,reloads:0,confirms:0,user};
 tab.storage=hub.area(tab);
 const windowObject={addEventListener:(type,fn)=>{if(type==='storage')listeners.add(fn);},removeEventListener:(type,fn)=>{if(type==='storage')listeners.delete(fn);},
  confirm:()=>{tab.confirms++;return confirm;},location:{reload:()=>{tab.reloads++;}}};
 const context=vm.createContext({React:host.React,localStorage:tab.storage,navigator:locks?{locks:locks.manager}:{},window:windowObject,
  setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,AbortController,console,
  Blob:class{constructor(parts,options){this.text=parts.join('');this.type=options.type;}},
  URL:{createObjectURL:blob=>{downloads.push(blob.text);return 'blob:test';},revokeObjectURL(){}},
  document:{createElement:()=>({click(){}})}});
 for(const [filename,code] of SOURCES)vm.runInContext(code,context,{filename});
 tab.context=context;
 tab.listeners=listeners;
 tab.dispatch=event=>{listeners.forEach(fn=>fn(event));host.flush();};
 tab.render=(nextUser=tab.user)=>{tab.user=nextUser;host.render(()=>context.useShotcraftPlan(nextUser));};
 tab.flush=()=>host.flush();
 tab.edit=change=>{host.out.update((current,now)=>change(context,current,now));host.flush();};
 tab.brief=(field,value)=>tab.edit((c,plan,now)=>c.shotcraftPlanSetBrief(plan,field,value,now));
 tab.addShot=(id,shot)=>tab.edit((c,plan,now)=>c.shotcraftPlanAddShot(plan,id,now,shot));
 tab.editor=()=>context.ShotcraftPlanEditor(host.out);
 Object.defineProperty(tab,'state',{get:()=>host.out});
 hub.tabs.push(tab);
 tab.render();
 return tab;
}

const text=node=>node==null||node===false?'':typeof node!=='object'?String(node):node.children.map(text).join('');
const find=(node,pred,out=[])=>{if(node&&typeof node==='object'){if(pred(node))out.push(node);node.children.forEach(child=>find(child,pred,out));}return out;};
const button=(tree,label)=>find(tree,node=>node.type==='button'&&text(node)===label)[0];
const plain=value=>JSON.parse(JSON.stringify(value));

test('hook keeps its return fields and the editor keeps its props',()=>{
 const hub=makeHub(),tab=openTab(hub,{locks:makeLocks()});
 assert.deepEqual(Object.keys(tab.state).sort(),['canSave','plan','saveState','update']);
 assert.equal(tab.state.canSave,true);
 assert.equal(tab.state.saveState,'ok');
 assert.ok(button(tab.editor(),'下载 JSON'));
 assert.equal(button(tab.editor(),'重新加载页面'),undefined);
});

test('A brief then stale B adds a shot: B does not overwrite, keeps edits, can export and reload',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks}),b=openTab(hub,{locks});
 a.brief('product','A 的产品');
 await settle(a,b);
 assert.equal(hub.plan('u1').product,'A 的产品');
 const saved=hub.data.get(KEY('u1')),writes=hub.writes;
 b.addShot('b1',{visual:'B 的镜头'});
 await settle(a,b);
 assert.equal(b.state.saveState,'conflict');
 assert.equal(hub.data.get(KEY('u1')),saved);
 assert.equal(hub.writes,writes);
 b.brief('audience','B 的受众');
 await settle(a,b);
 assert.equal(hub.data.get(KEY('u1')),saved,'later edits stay local after conflict');
 assert.equal(b.state.saveState,'conflict');
 assert.deepEqual(plain(b.state.plan.shots.map(shot=>shot.visual)),['B 的镜头']);
 assert.equal(b.state.plan.audience,'B 的受众');
 hub.deliver();
 assert.equal(b.state.saveState,'conflict','clean external update must not replace dirty memory');
 assert.equal(b.state.plan.shots.length,1);
 const tree=b.editor();
 assert.match(text(tree),/其他标签页/);
 button(tree,'下载 JSON').props.onClick();
 const exported=JSON.parse(b.downloads[0]);
 assert.equal(exported.shots[0].visual,'B 的镜头');
 assert.equal(exported.brief.audience,'B 的受众');
 button(tree,'下载 Markdown').props.onClick();
 assert.match(b.downloads[1],/B 的镜头/);
 button(tree,'重新加载页面').props.onClick();
 assert.equal(b.confirms,1);
 assert.equal(b.reloads,1);
});

test('reload asks first and does nothing when declined',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks}),b=openTab(hub,{locks,confirm:false});
 a.brief('product','x');await settle(a,b);
 b.brief('product','y');await settle(a,b);
 button(b.editor(),'重新加载页面').props.onClick();
 assert.equal(b.confirms,1);
 assert.equal(b.reloads,0);
 assert.equal(b.state.plan.product,'y');
});

test('clean storage event adopts the external value and later saves keep both changes',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks}),b=openTab(hub,{locks});
 a.brief('product','A 的产品');
 await settle(a,b);
 hub.deliver();
 assert.equal(b.state.plan.product,'A 的产品');
 assert.equal(b.state.saveState,'ok');
 b.addShot('b1',{visual:'B 的镜头'});
 await settle(a,b);
 assert.equal(b.state.saveState,'ok');
 const stored=hub.plan('u1');
 assert.equal(stored.product,'A 的产品');
 assert.deepEqual(stored.shots.map(shot=>shot.id),['b1']);
 hub.deliver();
 assert.equal(a.state.plan.shots.length,1);
 a.brief('message','A 再改');
 await settle(a,b);
 assert.equal(a.state.saveState,'ok');
 assert.equal(hub.plan('u1').shots.length,1);
});

test('shot edit in A versus reorder in B does not lose A data',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 a.addShot('s1',{visual:'一'});a.addShot('s2',{visual:'二'});
 await settle(a);
 const b=openTab(hub,{locks});
 assert.equal(b.state.plan.shots.length,2);
 a.edit((c,plan,now)=>c.shotcraftPlanUpdateShot(plan,'s1','visual','一（A 修改）',now));
 await settle(a,b);
 b.edit((c,plan,now)=>c.shotcraftPlanMoveShot(plan,'s2',-1,now));
 await settle(a,b);
 assert.equal(b.state.saveState,'conflict');
 const stored=hub.plan('u1');
 assert.deepEqual(stored.shots.map(shot=>shot.id),['s1','s2']);
 assert.equal(stored.shots[0].visual,'一（A 修改）');
 assert.deepEqual(plain(b.state.plan.shots.map(shot=>shot.id)),['s2','s1']);
});

test('card import in A versus manual edit in B does not lose the card',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks}),b=openTab(hub,{locks});
 const meta={card:{name:'推镜',summary:'缓慢推进',duration:'3 秒'},repository:'repo',license:'MIT'};
 a.edit((c,plan,now)=>c.shotcraftPlanAddCard(plan,c.shotcraftPlanCardFromSource({shotcraft:meta}),'card1',now));
 await settle(a,b);
 b.brief('product','B 手工填写');
 await settle(a,b);
 assert.equal(b.state.saveState,'conflict');
 const stored=hub.plan('u1');
 assert.equal(stored.shots[0].shotcraft.card.name,'推镜');
 assert.equal(stored.product,'');
 assert.equal(b.state.plan.product,'B 手工填写');
});

test('no write happens while the lock is not granted; queued edits save after release',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 locks.hold();
 a.brief('product','等待锁');
 a.brief('product','等待锁中继续输入');
 await settle(a);
 assert.equal(hub.writes,0);
 assert.equal(a.state.plan.product,'等待锁中继续输入');
 locks.release();
 await settle(a);
 assert.equal(hub.plan('u1').product,'等待锁中继续输入');
 assert.equal(a.state.saveState,'ok');
});

test('lock timeout reports locked without writing, then a later edit recovers',async()=>{
 const hub=makeHub(),locks=makeLocks(),timers=makeTimers(),a=openTab(hub,{locks,timers});
 locks.hold();
 a.brief('product','第一次');
 await settle(a);
 timers.fire();
 await settle(a);
 assert.equal(a.state.saveState,'locked');
 assert.equal(locks.waiting,0);
 assert.equal(hub.writes,0);
 assert.match(text(a.editor()),/尚未写入/);
 locks.release();
 a.brief('audience','第二次');
 await settle(a);
 assert.equal(a.state.saveState,'ok');
 const stored=hub.plan('u1');
 assert.equal(stored.product,'第一次');
 assert.equal(stored.audience,'第二次');
});

test('lock request failure does not write and keeps the edit',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 locks.throwing=true;
 a.brief('product','锁失败');
 await settle(a);
 assert.equal(a.state.saveState,'locked');
 assert.equal(hub.writes,0);
 locks.throwing=false;
 a.brief('message','恢复');
 await settle(a);
 assert.equal(a.state.saveState,'ok');
 assert.equal(hub.plan('u1').product,'锁失败');
});

test('storage write failure keeps memory and recovers on the next edit',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 hub.failing=true;
 a.addShot('s1',{visual:'写入失败'});
 await settle(a);
 assert.equal(a.state.saveState,'error');
 assert.equal(hub.data.has(KEY('u1')),false);
 hub.failing=false;
 a.brief('product','恢复');
 await settle(a);
 assert.equal(a.state.saveState,'ok');
 const stored=hub.plan('u1');
 assert.equal(stored.shots[0].visual,'写入失败');
 assert.equal(stored.product,'恢复');
});

test('rapid consecutive edits do not conflict with own writes and end with the last value',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 for(const value of ['快','快速','快速连','快速连续'])a.brief('product',value);
 await settle(a);
 assert.equal(hub.plan('u1').product,'快速连续');
 assert.ok(hub.writes<=2,'edits are coalesced while a save is in flight');
 a.brief('product','快速连续编');
 await new Promise(resolve=>setImmediate(resolve));
 a.brief('product','快速连续编辑');
 a.addShot('s1',{});
 await settle(a);
 assert.equal(a.state.saveState,'ok');
 const stored=hub.plan('u1');
 assert.equal(stored.product,'快速连续编辑');
 assert.equal(stored.shots.length,1);
});

test('without Web Locks it still compares before writing and says it is not atomic',async()=>{
 const hub=makeHub(),a=openTab(hub),b=openTab(hub);
 assert.equal(a.state.saveState,'unlocked');
 assert.match(text(a.editor()),/不支持 Web Locks.*无法保证/);
 a.brief('product','A');
 await settle(a,b);
 assert.equal(a.state.saveState,'unlocked');
 assert.equal(hub.plan('u1').product,'A');
 b.addShot('b1',{});
 await settle(a,b);
 assert.equal(b.state.saveState,'conflict');
 assert.equal(hub.plan('u1').shots.length,0);
});

test('unmount during a pending save writes the edit but never touches state afterwards',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 locks.hold();
 a.brief('product','卸载前');
 a.host.unmount();
 assert.equal(a.listeners.size,0);
 locks.release();
 await settle(a);
 assert.equal(a.host.lateSets,0);
 assert.equal(hub.plan('u1').product,'卸载前');
});

test('switching account ignores the old session callbacks',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 locks.hold();
 a.brief('product','u1 的内容');
 const staleUpdate=a.state.update;
 a.render('u2');
 assert.equal(a.state.plan.product,'');
 assert.equal(a.listeners.size,1);
 locks.release();
 await settle(a);
 assert.equal(hub.plan('u1').product,'u1 的内容');
 assert.equal(a.state.plan.product,'');
 assert.equal(a.state.saveState,'ok');
 staleUpdate((plan,now)=>a.context.shotcraftPlanSetBrief(plan,'product','旧回调',now));
 a.flush();
 await settle(a);
 assert.equal(a.state.plan.product,'');
 assert.equal(hub.data.has(KEY('u2')),false);
 assert.equal(hub.plan('u1').product,'u1 的内容');
 a.brief('product','u2 的内容');
 await settle(a);
 assert.equal(hub.plan('u2').product,'u2 的内容');
 assert.equal(hub.plan('u1').product,'u1 的内容');
});

test('storage events for other keys or other areas are ignored',async()=>{
 const hub=makeHub(),locks=makeLocks(),a=openTab(hub,{locks});
 hub.data.set(KEY('u1'),JSON.stringify({product:'外部'}));
 a.dispatch({key:'other',storageArea:a.storage});
 a.dispatch({key:KEY('u1'),storageArea:{}});
 assert.equal(a.state.plan.product,'');
 a.dispatch({key:KEY('u1'),storageArea:a.storage});
 assert.equal(a.state.plan.product,'外部');
 assert.equal(a.state.saveState,'ok');
});

test('corrupt record and missing account keep their previous behaviour',async()=>{
 const hub=makeHub(),locks=makeLocks();
 hub.data.set(KEY('u1'),'{broken');
 const a=openTab(hub,{locks});
 assert.equal(a.state.saveState,'corrupt');
 a.brief('product','覆盖');
 await settle(a);
 assert.equal(a.state.saveState,'ok');
 assert.equal(hub.plan('u1').product,'覆盖');
 const anon=openTab(hub,{locks,user:null});
 assert.equal(anon.state.canSave,false);
 const writes=hub.writes;
 anon.brief('product','匿名');
 await settle(anon);
 assert.equal(hub.writes,writes);
 assert.equal(anon.state.plan.product,'匿名');
 assert.match(text(anon.editor()),/未识别当前账号/);
});
