import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
const source=readFileSync(new URL('../public/loading.jsx',import.meta.url),'utf8');
function harness(initialHash){const states=[];let cursor=0;const context=vm.createContext({URLSearchParams,window:{location:{hash:initialHash||''}},React:{createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):({type,props:{...props,children}}),useRef(initial){const index=cursor++;if(!(index in states))states[index]={current:initial};return states[index];},useEffect(){},useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>states[index]=typeof value==='function'?value(states[index]):value];}}});vm.runInContext(transformSync(source,{loader:'jsx'}).code,context);return {skeleton:context.LoadingSkeleton,frame:props=>{cursor=0;return context.LoadingFrame(props);},driveShelf:props=>context.DriveShelfSkeleton(props),drivePage:props=>context.DrivePageSkeleton(props),page:(props,hash)=>{if(hash!==undefined)context.window.location.hash=hash;return context.PageLoadingSkeleton(props);},context};}
function timedFrameHarness(){
 const slots=[],timers=new Map();let cursor=0,now=0,nextId=1,pending=[];
 const schedule=(kind,callback,delay)=>{const id=nextId++;timers.set(id,{kind,callback,at:now+delay,delay});return id;};
 const clear=id=>timers.delete(id);
 const React={
  createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):({type,props:{...props,children}}),
  useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
  useRef(initial){const index=cursor++;if(!slots[index])slots[index]={value:{current:initial}};return slots[index].value;},
  useEffect(effect,deps){const index=cursor++,previous=slots[index];if(previous&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return;pending.push(()=>{previous?.cleanup?.();slots[index]={deps,cleanup:effect()};});}
 };
 const context=vm.createContext({URLSearchParams,window:{},React,setTimeout:(fn,ms)=>schedule('timeout',fn,ms),clearTimeout:clear,setInterval:(fn,ms)=>schedule('interval',fn,ms),clearInterval:clear});
 vm.runInContext(transformSync(source,{loader:'jsx'}).code,context);
 return {
  frame(props){cursor=0;const tree=context.LoadingFrame(props);for(const commit of pending.splice(0))commit();return tree;},
  advance(ms){const end=now+ms;while(true){let earliest=null;for(const [id,timer] of timers)if(timer.at<=end&&(!earliest||timer.at<earliest.timer.at))earliest={id,timer};if(!earliest)break;now=earliest.timer.at;const {id,timer}=earliest;if(timer.kind==='timeout')timers.delete(id);else if(timers.has(id))timer.at+=timer.delay;timer.callback();}now=end;},
  count(kind){return [...timers.values()].filter(timer=>timer.kind===kind).length;}
 };
}
function flattenChildren(node){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node;const kids=node.props?.children;if(kids===undefined)return [];return Array.isArray(kids)?kids:[kids];}
function nodes(node,type){if(!node||typeof node!=='object')return [];return [...(node.type===type?[node]:[]),...flattenChildren(node).flatMap(n=>nodes(n,type))];}
function statusNodes(node){if(!node||typeof node!=='object')return [];return [...(node.props&&node.props.role==='status'?[node]:[]),...flattenChildren(node).flatMap(n=>statusNodes(n))];}

test('skeleton announces one status and decorative tiles cannot become interactive',()=>{const h=harness(),tree=h.skeleton({variant:'gallery',count:6,label:'正在加载作品'});assert.equal(tree.props.role,'status');assert.equal(tree.props['aria-busy'],'true');assert.equal(tree.props['aria-label'],'正在加载作品');assert.equal(nodes(tree,'button').length,0);assert.equal(nodes(tree,'img').length,0);assert.equal(nodes(tree,'div').filter(n=>n.props.className==='loading-tile').length,6);});
test('embedded page skeleton follows load, source changes, failure and retry without removing iframe permissions',()=>{const h=harness(),props={src:'/one',title:'工具',sandbox:'allow-scripts'};let tree=h.frame(props);assert.equal(tree.props['aria-busy'],true);let frame=nodes(tree,'iframe')[0];assert.equal(frame.props.sandbox,'allow-scripts');frame.props.onLoad({});assert.equal(h.frame(props).props['aria-busy'],false);tree=h.frame({...props,src:'/two'});assert.equal(tree.props['aria-busy'],true);nodes(tree,'iframe')[0].props.onError({});tree=h.frame({...props,src:'/two'});assert.equal(tree.props['aria-busy'],false);nodes(tree,'button')[0].props.onClick();assert.equal(h.frame({...props,src:'/two'}).props['aria-busy'],true);});

test('LoadingFrame timeout replaces indefinite skeleton with retry feedback and stops polling',()=>{
 const h=timedFrameHarness(),props={src:'/slow',title:'编辑器'};
 let tree=h.frame(props);
 assert.equal(tree.props['aria-busy'],true);
 assert.equal(h.count('interval'),1);
 h.advance(19999);
 assert.equal(nodes(h.frame(props),'button').length,0);
 h.advance(1);
 tree=h.frame(props);
 assert.equal(tree.props['aria-busy'],false);
 assert.equal(nodes(tree,'strong')[0].props.children[0],'加载时间较长');
 assert.equal(nodes(tree,'button').length,1);
 assert.equal(h.count('interval'),0);
 assert.equal(h.count('timeout'),0);
});

test('LoadingFrame clears the old source timer before watching a new source',()=>{
 const h=timedFrameHarness();
 h.frame({src:'/old',title:'工具'});
 h.advance(8000);
 let tree=h.frame({src:'/new',title:'工具'});
 assert.equal(tree.props['aria-busy'],true);
 assert.equal(h.count('interval'),1);
 assert.equal(h.count('timeout'),1);
 h.advance(12000);
 tree=h.frame({src:'/new',title:'工具'});
 assert.equal(nodes(tree,'button').length,0);
 h.advance(8000);
 tree=h.frame({src:'/new',title:'工具'});
 assert.equal(nodes(tree,'button').length,1);
});

test('LoadingFrame retry starts a fresh watch and onLoad clears feedback',()=>{
 const h=timedFrameHarness(),props={src:'/retry',title:'编辑器'};
 h.frame(props);
 h.advance(20000);
 let tree=h.frame(props);
 nodes(tree,'button')[0].props.onClick();
 tree=h.frame(props);
 assert.equal(tree.props['aria-busy'],true);
 assert.equal(nodes(tree,'button').length,0);
 assert.equal(h.count('interval'),1);
 nodes(tree,'iframe')[0].props.onLoad({});
 tree=h.frame(props);
 assert.equal(tree.props['aria-busy'],false);
 assert.equal(nodes(tree,'button').length,0);
 assert.equal(h.count('interval'),0);
 assert.equal(h.count('timeout'),0);
});

test('standalone DriveShelfSkeleton announces one status, stays decorative, and varies cover shape by category',()=>{const h=harness();const standBooks=h.driveShelf({reactRuntime:h.context.React,category:'books',count:4});assert.equal(statusNodes(standBooks).length,1);assert.equal(nodes(standBooks,'button').length,0);assert.equal(nodes(standBooks,'a').length,0);assert.equal(nodes(standBooks,'img').length,0);const covers=nodes(standBooks,'span').filter(n=>(n.props.className||'').includes('drive-loading-cover'));assert.ok(covers.every(n=>n.props.className.includes('book-cover')));const shelf=nodes(standBooks,'ul')[0];assert.ok(shelf.props.className.includes('is-book-grid'));assert.ok(!shelf.props.className.includes('drive-category-grid'));const plain=h.driveShelf({reactRuntime:h.context.React,category:'',count:3,decorative:true});assert.equal(statusNodes(plain).length,0);const plainShelf=plain.type==='ul'?plain:nodes(plain,'ul')[0];assert.ok(!plainShelf.props.className.includes('is-book-grid'));assert.ok(plainShelf.props.className.includes('drive-category-grid'));const plainCovers=nodes(plain,'span').filter(n=>(n.props.className||'').includes('drive-loading-cover'));assert.ok(plainCovers.every(n=>!n.props.className.includes('book-cover')));});

test('DrivePageSkeleton reads category/book flag from the hash and never duplicates status roles',()=>{const h=harness();const tree=h.drivePage({reactRuntime:h.context.React,hash:'#knowledgeLibrary?tab=drive&category=books'});assert.equal(statusNodes(tree).length,1);assert.equal(tree.props.role,'status');assert.equal(tree.props['aria-busy'],'true');assert.equal(nodes(tree,'button').length,0);assert.equal(nodes(tree,'a').length,0);assert.equal(nodes(tree,'img').length,0);const topbar=nodes(tree,'div').find(n=>(n.props.className||'').includes('drive-loading-topbar'));assert.ok(topbar);const tabsWrap=flattenChildren(topbar).find(n=>(n.props.className||'').includes('drive-loading-tabs'));assert.equal(flattenChildren(tabsWrap).length,2);const actionsWrap=flattenChildren(topbar).find(n=>(n.props.className||'').includes('drive-loading-actions'));assert.equal(flattenChildren(actionsWrap).length,2);const categories=nodes(tree,'div').find(n=>(n.props.className||'').includes('drive-loading-categories'));assert.ok(categories);const shelf=nodes(tree,'ul').find(n=>(n.props.className||'').includes('drive-shelf-loading'));assert.ok(shelf);assert.ok(shelf.props.className.includes('is-book-grid'));assert.ok(!shelf.props.className.includes('drive-category-grid'));});

test('DrivePageSkeleton swaps to a media/course placeholder for file and course hashes instead of the browse shelf',()=>{const h=harness();const withCourse=h.drivePage({reactRuntime:h.context.React,hash:'#knowledgeLibrary?tab=drive&course=c1&file=f1'});assert.equal(statusNodes(withCourse).length,1);assert.equal(nodes(withCourse,'ul').length,0);const media=nodes(withCourse,'div').find(n=>(n.props.className||'')==='drive-loading-media');assert.ok(media);const rail=nodes(withCourse,'div').find(n=>(n.props.className||'').includes('drive-loading-course-rail'));assert.ok(rail);const withoutCourse=h.drivePage({reactRuntime:h.context.React,hash:'#knowledgeLibrary?tab=drive&file=f1'});assert.equal(nodes(withoutCourse,'div').filter(n=>(n.props.className||'').includes('drive-loading-course-rail')).length,0);const browse=h.drivePage({reactRuntime:h.context.React,hash:'#knowledgeLibrary?tab=drive'});assert.ok(nodes(browse,'ul').find(n=>(n.props.className||'').includes('drive-shelf-loading')));});

test('PageLoadingSkeleton only swaps to the Drive skeleton for knowledgeLibrary tab=drive, matching other routes to their own page geometry',()=>{const h=harness('#knowledgeLibrary?tab=drive');const driveTree=h.page({label:'正在加载'},'#knowledgeLibrary?tab=drive');assert.ok((driveTree.props.className||'').includes('drive-loading'));assert.equal(statusNodes(driveTree).length,1);const articleTree=h.page({label:'正在加载'},'#knowledgeLibrary?tab=article');assert.equal(articleTree.props.className,'knowledge-hub');const worksTree=h.page({label:'正在加载'},'#works');assert.ok(worksTree.props.className.includes('route-loading-works'));});
