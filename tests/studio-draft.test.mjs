import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function setup() {
  const data = new Map();
  const storage = {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const c = vm.createContext({localStorage:storage});
  vm.runInContext(readFileSync(new URL('../public/studio-draft.js',import.meta.url),'utf8'),c);
  return {c,storage,data};
}
test('drafts survive remount and refresh, keeping edits rather than the original source',()=>{
  const {c,storage}=setup();
  const incoming={key:'source-key',prompt:'original',sourceType:'prompt',sourceId:42};
  const draft=c.resolveStudioDraft(null,incoming);
  draft.prompt='edited'; draft.requestKey='retry-key';
  c.writeStudioDraft(8,draft);
  assert.equal(c.resolveStudioDraft(c.readStudioDraft(8),incoming).prompt,'edited');
  const {c:refreshed}=setup();
  const recovered=refreshed.readStudioDraft(8,storage);
  assert.equal(recovered.prompt,'edited'); assert.equal(recovered.requestKey,'retry-key');
  assert.equal(recovered.source.sourceId,42);
  assert.equal(c.resolveStudioDraft(recovered,{key:'new',prompt:'new source'}).prompt,'new source');
});
test('account isolation and blocked storage preserve a session fallback without false persistence',()=>{
  const {c}=setup();
  const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('quota');}};
  assert.equal(c.writeStudioDraft(8,{prompt:'private'},blocked),false);
  assert.equal(c.readStudioDraft(8,blocked).prompt,'private');
  assert.equal(c.readStudioDraft(9,blocked),null);
  assert.equal(c.readStudioDraft(null),null);
});
test('reference and video drafts select compatible route but never restore spending consent',()=>{
  const {c}=setup();
  const edited=c.resolveStudioDraft(null,{key:'image',referenceAssetId:'image-42',parentAssetId:'image-42'});
  assert.equal(edited.generationRoute,'api'); assert.equal(edited.referenceIds[0],'image-42');
  const video=c.resolveStudioDraft(null,{key:'video',targetModule:'seedance',targetMode:'first_last_frame'});
  assert.equal(video.module,'seedance'); assert.equal(video.mode,'first_last_frame');
  const limited=c.normalizeStudioDraft({...video,acceptedCost:true,apiKey:'secret'},false);
  assert.equal(limited.module,'image');assert.equal(limited.generationRoute,'local');
  assert.equal(limited.acceptedCost,undefined);assert.equal(limited.apiKey,undefined);
});
test('malformed storage and explicit new draft do not resurrect old content',()=>{
  const {c,storage}=setup();
  storage.setItem(c.studioDraftKey(8),'not json');assert.equal(c.readStudioDraft(8),null);
  c.writeStudioDraft(8,{consumedKey:'old'});
  const blank=c.resolveStudioDraft(c.readStudioDraft(8),{key:'old',prompt:'must not reappear'});
  assert.equal(blank.prompt,'');assert.equal(c.studioDraftHasContent(blank),false);
});
