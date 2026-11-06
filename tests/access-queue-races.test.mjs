import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

// Runs the real race logic from the JSX sources: the JSX-free block between the race-logic markers is
// compiled with node:vm and driven with hand-resolved promises so responses arrive in a chosen order.
const read=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const SOURCES=['public/user-access.jsx','public/omniget.jsx'];
const hashes=Object.fromEntries(SOURCES.map(name=>[name,createHash('sha256').update(read(name)).digest('hex')]));
after(()=>{for(const name of SOURCES)assert.equal(createHash('sha256').update(read(name)).digest('hex'),hashes[name],`${name} must not be modified by tests`);});

function extract(name,exports,extra=''){
  const source=read(name),start=source.indexOf('// race-logic:start'),end=source.indexOf('// race-logic:end');
  assert.ok(start>=0&&end>start,`${name} needs a race-logic block`);
  return vm.runInThisContext(`(function(){${extra}\n${source.slice(start,end)}\nreturn {${exports.join(',')}};})`,{filename:name})();
}
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));

// ---------------------------------------------------------------- user access
const {userAccessDraftFrom,userAccessSelect,userAccessSave}=extract('public/user-access.jsx',['userAccessDraftFrom','userAccessSelect','userAccessSave']);
const userA=()=>({id:1,username:'a',isAdmin:false,revision:1,permissions:{driveCategories:[],tools:[]}});
const userB=()=>({id:2,username:'b',isAdmin:false,revision:5,permissions:{driveCategories:['docs'],tools:['pdf']}});

// Mirrors the component: state/selected/draft, the [selected] effect that reloads the draft, and fetch.
function accessHarness(){
  const h={state:{users:[userA(),userB()]},selected:'1',saving:false,toasts:[],requests:[],reloads:0};
  h.refs={saving:{current:false},saveSeq:{current:0},selected:{current:'1'}};
  h.user=()=>h.state.users.find(item=>String(item.id)===h.selected)||null;
  h.draft=userAccessDraftFrom(h.user());
  h.setSelected=value=>{h.selected=value;h.draft=userAccessDraftFrom(h.user());};
  h.setState=value=>{h.state=typeof value==='function'?value(h.state):value;};
  h.setDraft=value=>{h.draft=typeof value==='function'?value(h.draft):value;};
  h.request=(url,options)=>{const pending=deferred();h.requests.push({url,options,...pending});return pending.promise;};
  h.save=()=>userAccessSave({user:h.user(),draft:h.draft,refs:h.refs,request:h.request,setSaving:value=>{h.saving=value;},setState:h.setState,setDraft:h.setDraft,showToast:message=>h.toasts.push(message),reload:()=>{h.reloads+=1;}});
  h.select=(id,confirmed=true)=>userAccessSelect({refs:h.refs,id,confirmDiscard:()=>confirmed,setSelected:h.setSelected});
  return h;
}

test('switching users is blocked synchronously while A is saving, and A\'s reply updates only A',async()=>{
  const h=accessHarness();
  h.draft={...h.draft,tools:['media']};
  const saving=h.save();
  assert.equal(h.refs.saving.current,true);
  assert.equal(h.select(2),false,'cannot switch to B while A is saving');
  assert.equal(h.selected,'1');
  h.save();
  assert.equal(h.requests.length,1,'a second click does not send another PUT');
  assert.equal(h.requests[0].url,'/api/admin/users/1/access');
  assert.deepEqual(h.requests[0].options.body,{revision:1,permissions:{driveCategories:[],tools:['media']}});
  h.requests[0].resolve({user:{...userA(),revision:2,permissions:{driveCategories:[],tools:['media']}}});
  await saving;
  assert.equal(h.saving,false);
  assert.deepEqual(h.draft,{revision:2,driveCategories:[],tools:['media']});
  assert.equal(h.select(2),true,'switching works again once the save settled');
  assert.deepEqual(h.draft,{revision:5,driveCategories:['docs'],tools:['pdf']});
});

test('a late PUT reply for A never overwrites B\'s draft even if selection moved underneath',async()=>{
  const h=accessHarness();
  h.draft={...h.draft,driveCategories:['secret-a']};
  const saving=h.save();
  // Selection changes without going through the guard (e.g. a list reload); B gets local edits.
  h.refs.selected.current='2';h.setSelected('2');
  h.draft={...h.draft,tools:['pdf','markdown']};
  h.requests[0].resolve({user:{...userA(),revision:2,permissions:{driveCategories:['secret-a'],tools:[]}}});
  await saving;
  assert.deepEqual(h.draft,{revision:5,driveCategories:['docs'],tools:['pdf','markdown']},'B keeps its own revision and edits');
  assert.deepEqual(h.state.users.find(item=>item.id===1).permissions.driveCategories,['secret-a'],'A\'s row still reflects the saved grant');
  assert.deepEqual(h.state.users.find(item=>item.id===2),userB(),'B\'s row is untouched');
  assert.equal(h.refs.saving.current,false);
});

test('a failed save releases the guard so the admin can switch and save again; conflicts reload',async()=>{
  const h=accessHarness();
  h.draft={...h.draft,tools:['media']};
  const first=h.save();
  h.requests[0].reject(new Error('网络错误'));
  await first;
  assert.equal(h.saving,false);assert.equal(h.refs.saving.current,false);
  assert.deepEqual(h.toasts,['网络错误']);assert.equal(h.reloads,0);
  assert.equal(h.select(2),true);
  h.draft={...h.draft,tools:[]};
  const second=h.save();
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].url,'/api/admin/users/2/access');
  assert.equal(h.requests[1].options.body.revision,5,'revision optimistic lock is still sent');
  h.requests[1].reject(new Error('权限已被其他管理员更新'));
  await second;
  assert.equal(h.reloads,1);assert.equal(h.refs.saving.current,false);
  const third=h.save();
  h.requests[2].resolve({user:{...userB(),revision:6,permissions:{driveCategories:['docs'],tools:[]}}});
  await third;
  assert.deepEqual(h.draft,{revision:6,driveCategories:['docs'],tools:[]});
});

test('user access component is wired to the guarded helpers',()=>{
  const source=read('public/user-access.jsx');
  assert.match(source,/const selectUser=id=>userAccessSelect\(\{refs,/);
  assert.match(source,/const save=\(\)=>userAccessSave\(\{/);
  assert.match(source,/selectedRef\.current=selected;/);
  assert.match(source,/disabled=\{saving\} onClick=\{\(\)=>selectUser\(item\.id\)\}/);
  assert.match(source,/if\(!savingRef\.current&&confirmDiscard/);
});

// ---------------------------------------------------------------- omniget queue
const omniget=read('public/omniget.jsx');
const activeFn=omniget.match(/^function omnigetQueueActive.*$/m)[0];
const {createOmnigetQueueSync,omnigetMergeBatch,omnigetMergeAction,omnigetQueueActive}=extract('public/omniget.jsx',['createOmnigetQueueSync','omnigetMergeBatch','omnigetMergeAction','omnigetQueueActive'],activeFn);

function queueHarness(initial){
  const h={queue:initial,gets:[],applied:0};
  h.sync=createOmnigetQueueSync({load:()=>{const pending=deferred();h.gets.push(pending);return pending.promise;},apply:value=>{h.applied+=1;h.queue=typeof value==='function'?value(h.queue):value;}});
  h.polling=()=>h.queue.some(item=>omnigetQueueActive(item.state));
  return h;
}

test('a GET started before a batch POST cannot overwrite the new jobs, whichever lands first',async()=>{
  for(const staleFirst of [false,true]){
    const h=queueHarness([{id:'old',state:'ready'}]);
    const poll=h.sync.refresh();
    const post=deferred();
    const batch=h.sync.mutate(()=>post.promise,omnigetMergeBatch);
    assert.equal(await h.sync.refresh(),false,'polls during the mutation skip');
    assert.equal(h.gets.length,1,'no new GET is issued while the POST is pending');
    if(staleFirst){h.gets[0].resolve({jobs:[{id:'old',state:'ready'}]});assert.equal(await poll,false);}
    post.resolve({jobs:[{id:'n1',state:'queued'},{id:'n2',state:'queued'}]});
    await batch;
    if(!staleFirst){h.gets[0].resolve({jobs:[{id:'old',state:'ready'}]});assert.equal(await poll,false);}
    assert.deepEqual(h.queue.map(item=>item.id),['n1','n2','old']);
    assert.equal(h.polling(),true,'polling keeps running for the new jobs');
    const fresh=h.sync.refresh();
    assert.equal(h.gets.length,2);
    h.gets[1].resolve({jobs:[{id:'n1',state:'downloading'},{id:'n2',state:'queued'},{id:'old',state:'ready'}]});
    assert.equal(await fresh,true,'a GET started after the mutation lands');
    assert.equal(h.queue[0].state,'downloading');
  }
});

test('cancel and retry replies are not reverted by stale GET snapshots',async()=>{
  const h=queueHarness([{id:'j1',state:'downloading'},{id:'j2',state:'failed'}]);
  const poll=h.sync.refresh();
  const cancel=deferred(),retry=deferred();
  const cancelling=h.sync.mutate(()=>cancel.promise,omnigetMergeAction);
  const retrying=h.sync.mutate(()=>retry.promise,omnigetMergeAction);
  cancel.resolve({id:'j1',state:'cancelling'});
  await cancelling;
  assert.equal(h.sync.pending(),1);
  assert.equal(await h.sync.refresh(),false,'still skipped while retry is pending');
  h.gets[0].resolve({jobs:[{id:'j1',state:'downloading'},{id:'j2',state:'failed'}]});
  assert.equal(await poll,false);
  retry.resolve({id:'j2',state:'queued',attempts:2});
  await retrying;
  assert.deepEqual(h.queue,[{id:'j1',state:'cancelling'},{id:'j2',state:'queued',attempts:2}]);
  assert.equal(h.polling(),true);
  assert.equal(h.gets.length,1,'successful mutations trigger no extra GET');
});

test('a failed mutation rethrows, releases the lock and reconciles once with a fresh GET',async()=>{
  const h=queueHarness([{id:'j1',state:'failed'}]);
  const poll=h.sync.refresh();
  const first=deferred(),second=deferred();
  const failing=h.sync.mutate(()=>first.promise,omnigetMergeAction);
  const ok=h.sync.mutate(()=>second.promise,omnigetMergeBatch);
  first.reject(new Error('超时'));
  await assert.rejects(failing,/超时/);
  assert.equal(h.gets.length,1,'no reconcile GET while another mutation is pending');
  second.resolve({jobs:[{id:'n1',state:'queued'}]});
  await ok;
  assert.equal(h.sync.pending(),0);
  assert.equal(h.gets.length,2,'one reconcile GET once everything settled');
  h.gets[0].resolve({jobs:[{id:'j1',state:'failed'}]});
  assert.equal(await poll,false,'the pre-mutation snapshot is still discarded');
  assert.deepEqual(h.queue.map(item=>item.id),['n1','j1']);
  h.gets[1].resolve({jobs:[{id:'j1',state:'queued'},{id:'n1',state:'queued'}]});
  await settle();
  assert.deepEqual(h.queue,[{id:'j1',state:'queued'},{id:'n1',state:'queued'}],'reconcile reflects what the server applied');
  const lone=deferred();
  const again=h.sync.mutate(()=>lone.promise,omnigetMergeAction);
  lone.reject(new Error('网络错误'));
  await assert.rejects(again,/网络错误/);
  h.gets[2].reject(new Error('仍然离线'));
  await settle();
  assert.equal(h.sync.pending(),0,'a failing reconcile GET is swallowed and nothing stays locked');
  assert.equal(await Promise.race([h.sync.refresh().then(()=> 'ran'),settle().then(()=> 'issued')]),'issued');
  assert.equal(h.gets.length,4,'refresh is usable again after failures');
});

test('omniget workspace routes queue writes through the sync helper and keeps .txt import intact',()=>{
  assert.match(omniget,/queueSync\.mutate\(\(\) => api\('\/api\/omniget\/queue\/batch', \{ method: 'POST', body \}\), omnigetMergeBatch\)/);
  assert.match(omniget,/queueSync\.mutate\(\(\) => api\(`\/api\/omniget\/queue\/\$\{id\}\/\$\{action\}`/);
  assert.match(omniget,/const refreshQueue = React\.useCallback\(\(\) => queueSync\.refresh\(\), \[queueSync\]\)/);
  assert.doesNotMatch(omniget,/setQueue\(Array\.isArray\(next\.jobs\)/,'no unguarded GET writes remain');
  assert.match(omniget,/const OMNIGET_BATCH_LIMIT = 10;/);
  assert.match(omniget,/async function importBatchFile\(event\)/);
  assert.match(omniget,/accept="\.txt,text\/plain"/);
});
