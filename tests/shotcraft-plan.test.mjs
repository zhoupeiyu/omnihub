import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=read('public/creator-workbench.jsx');
const videoSource=read('public/video-tools.jsx');
const handoff=videoSource.slice(videoSource.indexOf('  const useShotcraftCard ='),videoSource.indexOf('  return <section className="camera-recipe-workspace"'));
const region=name=>{
 const start=`/* ${name}:start */`,a=source.indexOf(start),b=source.indexOf(`/* ${name}:end */`);
 assert.ok(a>=0&&b>a,`missing region ${name}`);
 return source.slice(a+start.length,b);
};
const plain=value=>JSON.parse(JSON.stringify(value));
function memoryStorage(){const data=new Map();return {data,getItem:key=>data.has(key)?data.get(key):null,setItem:(key,value)=>{data.set(key,String(value));}};}

/* A small React stand-in: hooks per instance, keyed remounts, effects after render. */
function createRuntime(){
 const instances=new Map();
 let root=null,tree=null,effects=[],seen=new Set(),active=null,rendering=false,dirty=false;
 function expand(node,path){
  if(node==null||typeof node==='boolean')return null;
  if(typeof node!=='object')return String(node);
  if(Array.isArray(node))return node.map((child,index)=>expand(child,path+'/'+(child&&child.key!=null?'k'+child.key:index))).filter(child=>child!=null);
  if(typeof node.type==='function'){
   const id=path+':'+node.type.name+(node.key!=null?'#'+node.key:'');
   seen.add(id);
   if(!instances.has(id))instances.set(id,{hooks:[],cursor:0,dead:false});
   const instance=instances.get(id),previous=active;
   instance.cursor=0;active=instance;
   const output=node.type(node.props);
   active=previous;
   return expand(output,id);
  }
  return {type:node.type,props:node.props,children:expand(node.props.children,path+'/'+node.type)};
 }
 function flush(){
  while(dirty){
   dirty=false;rendering=true;seen=new Set();
   tree=expand(root,'root');
   for(const [id,instance] of instances)if(!seen.has(id)){instance.dead=true;for(const hook of instance.hooks)hook.cleanup?.();instances.delete(id);}
   const queue=effects;effects=[];
   for(const run of queue)run();
   rendering=false;
  }
 }
 const schedule=()=>{dirty=true;if(!rendering)flush();};
 const React={
  createElement(type,props,...children){const {key=null,...rest}=props||{};return {type,key,props:{...rest,children}};},
  useState(init){
   const instance=active,index=instance.cursor++;
   if(!instance.hooks[index])instance.hooks[index]={value:typeof init==='function'?init():init};
   const hook=instance.hooks[index];
   return [hook.value,next=>{if(instance.dead)return;const value=typeof next==='function'?next(hook.value):next;if(!Object.is(value,hook.value)){hook.value=value;schedule();}}];
  },
  useRef(value){const instance=active,index=instance.cursor++;if(!instance.hooks[index])instance.hooks[index]={ref:{current:value}};return instance.hooks[index].ref;},
  useEffect(fn,deps){
   const instance=active,index=instance.cursor++,hook=instance.hooks[index]||(instance.hooks[index]={});
   if(hook.deps&&deps.every((dep,n)=>Object.is(dep,hook.deps[n])))return;
   hook.deps=deps;
   effects.push(()=>{hook.cleanup?.();hook.cleanup=fn()||undefined;});
  },
 };
 return {React,render(element){root=element;dirty=true;flush();},tree:()=>tree};
}
function* walk(node){if(Array.isArray(node)){for(const child of node)yield* walk(child);}else if(node&&typeof node==='object'){yield node;yield* walk(node.children);}}
const textOf=node=>typeof node==='string'?node:Array.isArray(node)?node.map(textOf).join(''):node?textOf(node.children):'';

const names=['CREATOR_TASKS','SHOTCRAFT_PLAN_LIMITS','SHOTCRAFT_PLAN_NOTICE','creatorDraftKey','creatorDraftLoad','creatorDraftSave','shotcraftPlanKey','shotcraftPlanEmpty','shotcraftPlanNormalize','shotcraftPlanLoad','shotcraftPlanSave','shotcraftPlanSetBrief','shotcraftPlanAddShot','shotcraftPlanUpdateShot','shotcraftPlanRemoveShot','shotcraftPlanMoveShot','shotcraftPlanCardFromSource','shotcraftPlanAddCard','shotcraftPlanDurationRange','shotcraftPlanDurationText','shotcraftPlanExport','shotcraftPlanMarkdown','shotcraftPlanFilename','shotcraftPlanAiMessages','shotcraftPlanParseAi','shotcraftPlanMergeDraft','CreatorWorkbench'];
/* The panel itself is JSX; this stand-in wires the same hooks the same way so the account boundary runs for real. */
const panel=`function CreatorWorkbenchPanel({userId}){
 const key=creatorDraftKey(userId);
 const [draft]=React.useState(()=>creatorDraftLoad(creatorStorage(),key));
 const [input,setInput]=React.useState(draft.input||'');
 const failed=useCreatorDraftPersist(key,{task:draft.task||'copy',platform:draft.platform||'xiaohongshu',input,result:draft.result||null});
 const {plan,update,saveState,canSave}=useShotcraftPlan(userId);
 return React.createElement('div',{'data-failed':failed},
  React.createElement('label',null,'原始材料',React.createElement('textarea',{value:input,onChange:e=>setInput(e.target.value)})),
  React.createElement(ShotcraftPlanEditor,{plan,update,saveState,canSave}));
}`;
function workbench({storage=memoryStorage()}={}){
 const runtime=createRuntime(),downloads=[],network=[];
 const context=vm.createContext({
  React:runtime.React,localStorage:storage,Blob,
  URL:{createObjectURL:blob=>{downloads.push({blob});return 'blob:plan';},revokeObjectURL(){}},
  document:{createElement:()=>({click(){downloads.at(-1).name=this.download;}})},
  setTimeout:fn=>fn(),
  api:(...args)=>{network.push(args);throw Error('unexpected api call');},
  fetch:(...args)=>{network.push(args);throw Error('unexpected fetch call');},
 });
 const exports=vm.runInContext(`${region('shotcraft-plan:pure')}\n${region('shotcraft-plan:vm')}\n${panel}\n;({${names.join(',')}})`,context);
 const items=()=>[...walk(runtime.tree())];
 const ui={
  show:userId=>runtime.render(runtime.React.createElement(exports.CreatorWorkbench,{userId})),
  fields:label=>items().filter(node=>node.type==='label'&&node.children[0]===label).map(node=>[...walk(node.children)].find(child=>child.type==='input'||child.type==='textarea')),
  type(label,value,index=0){ui.fields(label)[index].props.onChange({target:{value}});},
  value:(label,index=0)=>ui.fields(label)[index].props.value,
  button:name=>items().find(node=>node.type==='button'&&(node.props['aria-label']===name||textOf(node)===name)),
  click(name){ui.button(name).props.onClick();},
  text:()=>textOf(runtime.tree()),
  items,
 };
 return {...exports,ui,storage,downloads,network};
}
const plan=workbench();
const sampleCard={id:'push-in',name:'缓推特写',summary:'镜头缓慢推近产品',use:'开场',duration:'3-5s',energy:'舒缓',intention:'建立质感',tags:['产品','特写'],camera:{move:'dolly',lens:35}};
function handoffRun({storage=memoryStorage(),toast=[]}={}){
 const events=[],window={location:{hash:'#before'},dispatchEvent:event=>events.push([event.type,window.location.hash])};
 const run=vm.runInContext(`${handoff}\n;useShotcraftCard`,vm.createContext({sessionStorage:storage,window,Event:class{constructor(type){this.type=type;}},shotcraft:{data:{source:{repository:'https://example.test/shotcraft'}}},showToast:message=>toast.push(message)}));
 return {run,storage,toast,events,window};
}

test('legacy tasks and draft format keep working',()=>{
 const {creatorDraftKey:key,creatorDraftLoad:load,creatorDraftSave:save,CREATOR_TASKS:tasks}=plan,storage=memoryStorage();
 assert.deepEqual(plain(tasks).map(([id])=>id),['copy','xhs','cover','video']);
 assert.equal(key(42),'omnihub:creator:v1:42');
 const legacy={task:'xhs',platform:'wechat',input:'旧输入',result:{titles:['旧标题'],body:'正文',checks:[],images:[{title:'图',prompt:'提示词',ratio:'3:4'}]}};
 storage.setItem(key(42),JSON.stringify(legacy));
 assert.deepEqual(plain(load(storage,key(42))),legacy);
 assert.equal(save(storage,key(42),load(storage,key(42))),true);
 assert.deepEqual(JSON.parse(storage.getItem(key(42))),legacy);
 storage.setItem(key(42),'{broken');
 assert.deepEqual(plain(load(storage,key(42))),{});
 assert.deepEqual(plain(load(memoryStorage(),key(42))),{});
 assert.equal(key(null),null);
 assert.equal(key(' '),null);
});

test('editing a video plan leaves the legacy draft untouched',()=>{
 const app=workbench(),legacy={task:'cover',platform:'x',input:'封面材料',result:{titles:['标题'],body:'正文',checks:[],images:[]}},key=app.creatorDraftKey('u1');
 app.storage.setItem(key,JSON.stringify(legacy));
 app.ui.show('u1');
 app.ui.type('产品或主题','新品');
 app.ui.click('添加镜头');
 assert.deepEqual(JSON.parse(app.storage.getItem(key)),legacy);
 assert.equal(JSON.parse(app.storage.getItem(app.shotcraftPlanKey('u1'))).product,'新品');
});

test('a plan can be written, reordered and exported by hand without AI or network',async()=>{
 const app=workbench(),{ui}=app;
 ui.show('u1');
 assert.match(ui.text(),/未生成或渲染视频/);
 assert.match(ui.text(),/不调用 AI，不触发付费/);
 assert.match(ui.text(),/还没有镜头/);
 ui.type('产品或主题','便携咖啡机');
 ui.type('目标受众','通勤白领');
 ui.type('核心信息','三分钟一杯现磨');
 for(const [index,visual] of ['开场','功能','结尾'].entries()){
  ui.click('添加镜头');
  ui.type('画面',visual,index);
  ui.type('时长（秒）',String(index+2),index);
  ui.type('字幕','字幕'+index,index);
  ui.type('声音','声音'+index,index);
 }
 assert.equal(ui.button('上移镜头 1').props.disabled,true);
 assert.equal(ui.button('下移镜头 3').props.disabled,true);
 ui.click('下移镜头 1');
 assert.deepEqual([0,1,2].map(index=>ui.value('画面',index)),['功能','开场','结尾']);
 ui.click('上移镜头 3');
 assert.deepEqual([0,1,2].map(index=>ui.value('画面',index)),['功能','结尾','开场']);
 ui.click('删除镜头 1');
 assert.deepEqual([0,1].map(index=>ui.value('画面',index)),['结尾','开场']);
 assert.match(ui.text(),/共 2 个镜头 · 预计时长 6 秒/);
 ui.click('下载 JSON');
 ui.click('下载 Markdown');
 const [json,markdown]=app.downloads;
 assert.equal(json.name,'视频方案-便携咖啡机.json');
 assert.equal(markdown.name,'视频方案-便携咖啡机.md');
 assert.match(json.blob.type,/^application\/json/);
 assert.match(markdown.blob.type,/^text\/markdown/);
 const exported=JSON.parse(await json.blob.text());
 assert.equal(exported.format,'omnihub-video-plan');
 assert.equal(exported.status,'planning-only');
 assert.deepEqual(exported.brief,{product:'便携咖啡机',audience:'通勤白领',message:'三分钟一杯现磨'});
 assert.deepEqual(exported.shots.map(({order,visual,duration,caption,sound})=>({order,visual,duration,caption,sound})),[{order:1,visual:'结尾',duration:'4',caption:'字幕2',sound:'声音2'},{order:2,visual:'开场',duration:'2',caption:'字幕0',sound:'声音0'}]);
 const text=await markdown.blob.text();
 assert.match(text,/^# 视频分镜方案：便携咖啡机/);
 assert.ok(text.indexOf('## 镜头 1')<text.indexOf('- 画面：结尾'));
 assert.ok(text.indexOf('- 画面：结尾')<text.indexOf('## 镜头 2'));
 assert.deepEqual(app.network,[],'manual editing must not call AI or the network');
});

test('every field has a label and reloading restores the plan',async()=>{
 const storage=memoryStorage(),first=workbench({storage});
 first.ui.show('u1');
 first.ui.click('添加镜头');
 first.ui.type('画面','保留的画面');
 for(const node of first.ui.items()){
  if(node.type==='label')assert.ok(typeof node.children[0]==='string'&&node.children[0].trim());
 }
 const controls=first.ui.items().filter(node=>node.type==='input'||node.type==='textarea').length;
 const labelled=first.ui.items().filter(node=>node.type==='label').flatMap(node=>[...walk(node.children)].filter(child=>child.type==='input'||child.type==='textarea')).length;
 assert.equal(labelled,controls);
 await new Promise(resolve=>setImmediate(resolve));
 const second=workbench({storage});
 second.ui.show('u1');
 assert.equal(second.ui.value('画面'),'保留的画面');
});

test('switching accounts never writes one account draft under another',async()=>{
 const app=workbench(),{ui,storage}=app;
 ui.show('a');
 ui.type('原始材料','A 的材料');
 ui.type('产品或主题','A 的产品');
 ui.click('添加镜头');
 ui.type('画面','A 的画面');
 await new Promise(resolve=>setImmediate(resolve));
 const a={plan:storage.getItem(app.shotcraftPlanKey('a')),draft:storage.getItem(app.creatorDraftKey('a'))};
 ui.show('b');
 assert.equal(ui.value('原始材料'),'');
 assert.equal(ui.value('产品或主题'),'');
 assert.equal(ui.fields('画面').length,0);
 assert.doesNotMatch(storage.getItem(app.creatorDraftKey('b')),/A 的/);
 assert.equal(storage.getItem(app.shotcraftPlanKey('b')),null);
 ui.type('产品或主题','B 的产品');
 ui.type('原始材料','B 的材料');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(storage.getItem(app.shotcraftPlanKey('a')),a.plan);
 assert.equal(storage.getItem(app.creatorDraftKey('a')),a.draft);
 ui.show('a');
 assert.equal(ui.value('产品或主题'),'A 的产品');
 assert.equal(ui.value('原始材料'),'A 的材料');
 assert.equal(ui.value('画面'),'A 的画面');
 assert.equal(JSON.parse(storage.getItem(app.shotcraftPlanKey('b'))).product,'B 的产品');
});

test('without an account nothing is stored and the page says so',()=>{
 const app=workbench(),{ui,storage}=app;
 ui.show(undefined);
 ui.type('原始材料','匿名材料');
 ui.type('产品或主题','匿名产品');
 assert.equal(storage.data.size,0);
 assert.match(ui.text(),/未识别当前账号/);
 ui.show('a');
 assert.equal(ui.value('产品或主题'),'');
 assert.doesNotMatch([...storage.data.values()].join(),/匿名/);
});

test('damaged plans are reported and only replaced after an edit',async()=>{
 for(const raw of ['{broken','[]','7','null']){
  const app=workbench(),key=app.shotcraftPlanKey('u1');
  app.storage.setItem(key,raw);
  app.ui.show('u1');
  assert.match(app.ui.text(),/无法读取/);
  assert.equal(app.storage.getItem(key),raw);
  app.ui.type('产品或主题','重写');
 await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.parse(app.storage.getItem(key)).product,'重写');
  assert.doesNotMatch(app.ui.text(),/无法读取/);
 }
 const {shotcraftPlanLoad:load}=plan,storage=memoryStorage();
 storage.setItem('k',JSON.stringify({product:7,shots:[null,'x',[],{id:'a',visual:'一',duration:3,shotcraft:{card:{}}},{id:'a',visual:'重复 id 也保留'},{visual:'无 id'}]}));
 const {plan:value,error}=load(storage,'k');
 assert.equal(error,null);
 assert.equal(value.product,'');
 assert.deepEqual(plain(value.shots.map(shot=>shot.visual)),['一','重复 id 也保留','无 id']);
 assert.equal(new Set(value.shots.map(shot=>shot.id)).size,3);
 assert.equal(value.shots[0].duration,'');
 assert.equal(value.shots[0].shotcraft,null);
 assert.equal(load({getItem(){throw Error('denied');}},'k').error,'unavailable');
 assert.equal(load(null,'k').error,'unavailable');
});

test('a full quota raises an alert, keeps the edit and still exports',async()=>{
 const app=workbench(),{ui,storage}=app,write=storage.setItem;
 const draftFailed=()=>ui.items().find(node=>node.type==='div'&&'data-failed' in node.props).props['data-failed'];
 ui.show('u1');
 storage.setItem=()=>{throw Error('QuotaExceededError');};
 ui.type('产品或主题','没存上的产品');
 ui.type('原始材料','没存上的材料');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.value('产品或主题'),'没存上的产品');
 assert.equal(ui.value('原始材料'),'没存上的材料');
 assert.equal(ui.items().find(node=>node.props?.role==='alert')!=null,true);
 assert.match(ui.text(),/浏览器无法保存/);
 assert.equal(draftFailed(),true);
 ui.click('下载 JSON');
 assert.equal(JSON.parse(await app.downloads[0].blob.text()).brief.product,'没存上的产品');
 storage.setItem=write;
 ui.type('产品或主题','存上了');
 ui.type('原始材料','也存上了');
 await new Promise(resolve=>setImmediate(resolve));
 assert.doesNotMatch(ui.text(),/浏览器无法保存/);
 assert.equal(draftFailed(),false);
 assert.equal(JSON.parse(storage.getItem(app.shotcraftPlanKey('u1'))).product,'存上了');
 assert.equal(JSON.parse(storage.getItem(app.creatorDraftKey('u1'))).input,'也存上了');
});

test('the handoff keeps structured card metadata through to the export',()=>{
 const flow=handoffRun();
 flow.run(sampleCard);
 assert.deepEqual(flow.events,[['omnihub:creator-source','#studio?space=mine&view=content']]);
 const stored=JSON.parse(flow.storage.getItem('omnihub:creator-source'));
 assert.equal(stored.title,'Shotcraft 镜头卡 · 缓推特写');
 assert.match(stored.summary,/适用：开场/);
 assert.equal(stored.url,'https://example.test/shotcraft');
 assert.deepEqual(stored.shotcraft,{version:1,card:sampleCard,repository:'https://example.test/shotcraft',license:'Apache-2.0'});
 const {shotcraftPlanCardFromSource:fromSource,shotcraftPlanAddCard:addCard,shotcraftPlanEmpty:empty,shotcraftPlanUpdateShot:edit,shotcraftPlanExport:exportPlan,shotcraftPlanMarkdown:markdown,shotcraftPlanNormalize:normalize}=plan;
 const meta=fromSource(stored);
 let value=addCard(empty(),meta,'s1',1);
 assert.equal(value.shots[0].duration,'3-5s');
 assert.equal(value.shots[0].visual,'镜头缓慢推近产品');
 value=edit(value,'s1','visual','改写后的画面',2);
 value=normalize(JSON.parse(JSON.stringify(value)));
 assert.equal(value.shots[0].visual,'改写后的画面');
 assert.deepEqual(plain(value.shots[0].shotcraft.card),sampleCard,'editing and reloading keep the original card');
 const shot=plain(exportPlan(value,0)).shots[0];
 assert.equal(shot.visual,'改写后的画面');
 assert.deepEqual(shot.shotcraft,{card:sampleCard,repository:'https://example.test/shotcraft',license:'Apache-2.0'});
 const text=markdown(value);
 assert.match(text,/- 镜头卡：缓推特写/);
 assert.match(text,/- 意图：建立质感/);
 assert.match(text,/- 来源：https:\/\/example\.test\/shotcraft · Apache-2\.0/);
});

test('a failed handoff warns and does not navigate',()=>{
 const toast=[],flow=handoffRun({toast,storage:{setItem(){throw Error('QuotaExceededError');}}});
 flow.run(sampleCard);
 assert.equal(toast.length,1);
 assert.equal(flow.window.location.hash,'#before');
 assert.deepEqual(flow.events,[]);
});

test('sources without valid card metadata stay on the old text path',()=>{
 const {shotcraftPlanCardFromSource:fromSource}=plan;
 for(const value of [null,{title:'普通选题',summary:'摘要'},{shotcraft:null},{shotcraft:{}},{shotcraft:{card:[]}},{shotcraft:{card:{name:'  '}}},{shotcraft:'x'}])assert.equal(fromSource(value),null);
});

test('shot editing rejects bad input and enforces limits',()=>{
 const {shotcraftPlanEmpty:empty,shotcraftPlanAddShot:add,shotcraftPlanUpdateShot:edit,shotcraftPlanMoveShot:move,shotcraftPlanRemoveShot:remove,shotcraftPlanSetBrief:brief,SHOTCRAFT_PLAN_LIMITS:limits}=plan;
 const one=add(empty(),'a',1);
 assert.equal(add(one,'a',2),one);
 assert.equal(add(one,'',2),one);
 assert.equal(edit(one,'a','id','x',2),one);
 assert.equal(edit(one,'missing','visual','x',2),one);
 assert.equal(move(one,'a',-1,2),one);
 assert.equal(move(one,'a',1,2),one);
 assert.equal(remove(one,'missing',2),one);
 assert.equal(brief(one,'shots','x',2),one);
 assert.equal(edit(one,'a','visual','画'.repeat(limits.text+5),2).shots[0].visual.length,limits.text);
 const full={...one,shots:Array.from({length:limits.shots},(_,index)=>({id:'s'+index}))};
 assert.equal(add(full,'new',2),full);
});

test('duration totals handle ranges and report what they cannot read',()=>{
 const {shotcraftPlanDurationRange:range,shotcraftPlanDurationText:text}=plan,of=(...durations)=>plain(range({shots:durations.map(duration=>({duration}))}));
 assert.deepEqual(of('3','2-4s','1.5–2 秒','5~3'),{min:9.5,max:14,unknown:0});
 assert.deepEqual(of('0.1','0.2'),{min:0.3,max:0.3,unknown:0});
 assert.deepEqual(of('','1 分钟','约 3 秒'),{min:0,max:0,unknown:3});
 assert.equal(text({min:0,max:0,unknown:2}),'待填写');
 assert.equal(text({min:6,max:6,unknown:0}),'6 秒');
 assert.equal(text({min:4,max:7,unknown:1}),'4–7 秒（另有 1 个镜头时长未按秒填写）');
});

test('exports are usable for production and never claim a finished video',()=>{
 const {shotcraftPlanEmpty:empty,shotcraftPlanAddShot:add,shotcraftPlanUpdateShot:edit,shotcraftPlanSetBrief:brief,shotcraftPlanExport:exportPlan,shotcraftPlanMarkdown:markdown,shotcraftPlanFilename:filename,SHOTCRAFT_PLAN_NOTICE:notice}=plan;
 const blank=markdown(empty());
 assert.match(blank,/^# 视频分镜方案：未命名/);
 assert.ok(blank.includes('> '+notice));
 assert.match(notice,/未生成或渲染视频/);
 assert.match(notice,/不代表成片/);
 let value=add(brief(empty(),'product','A/B: "新品"',1),'a',2);
 value=edit(value,'a','visual','第一行\r\n## 不是标题\n第三行',3);
 const text=markdown(value);
 assert.match(text,/- 画面：第一行\n {2}## 不是标题\n {2}第三行/);
 assert.match(text,/- 字幕：（待填写）/);
 assert.equal(filename(value,'md'),'视频方案-A-B-新品-.md');
 assert.equal(filename(empty(),'json'),'视频方案-未命名.json');
 const data=plain(exportPlan(value,1000));
 assert.equal(data.status,'planning-only');
 assert.equal(data.notice,notice);
 assert.equal(data.exportedAt,'1970-01-01T00:00:01.000Z');
 assert.deepEqual(data.duration,{minSeconds:0,maxSeconds:0,unknownShots:1});
 assert.equal(data.shots[0].visual,'第一行\r\n## 不是标题\n第三行');
});

test('optional AI output is validated and only ever adds to the plan',()=>{
 const {shotcraftPlanAiMessages:messages,shotcraftPlanParseAi:parse,shotcraftPlanMergeDraft:merge,shotcraftPlanEmpty:empty,shotcraftPlanSetBrief:brief,shotcraftPlanAddShot:add}=plan;
 for(const reply of ['','不是 JSON','[]','{"shots":[]}','{"shots":[{"visual":"  "}]}',null])assert.equal(parse(reply),null);
 const draft=parse('```json\n{"product":"AI 产品","audience":"AI 受众","message":"AI 信息","shots":[{"duration":"3 秒","visual":"AI 画面","caption":"","sound":"","shotcraft":{"card":{"name":"假卡"}}},{"visual":"  "}]}\n```');
 assert.equal(draft.shots.length,1);
 const mine=add(brief(empty(),'product','我的产品',1),'mine',2);
 const merged=merge(mine,draft,['ai1'],3);
 assert.equal(merged.product,'我的产品','existing text is not overwritten');
 assert.equal(merged.audience,'AI 受众');
 assert.deepEqual(plain(merged.shots.map(shot=>shot.id)),['mine','ai1']);
 assert.equal(merged.shots[1].visual,'AI 画面');
 assert.equal(merged.shots[1].shotcraft,null,'AI cannot forge card provenance');
 const [system,user]=messages(mine,'原始材料');
 assert.equal(system.role,'system');
 assert.match(system.content,/不生成或渲染视频/);
 assert.match(user.content,/原始材料/);
 assert.match(user.content,/我的产品/);
});
