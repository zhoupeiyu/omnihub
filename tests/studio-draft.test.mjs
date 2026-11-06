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
test('image mention queries support Chinese, caret insertion and email/selection exclusions',()=>{
 const {c}=setup();
 assert.equal(c.studioMentionQuery('使用@source',9).query,'source');
 assert.equal(c.studioMentionQuery('mail@source',11),null);
 assert.equal(c.studioMentionQuery('@source name',12),null);
 assert.equal(c.studioMentionQuery('@source',2,7),null);
 const next=c.insertStudioMention('前文 @sou 后文',{start:3,end:7},'img-a',[]);
 assert.equal(next.prompt,'前文 @图片1  后文');
 assert.equal(next.caret,8);
});
test('mentions bind by ID even for duplicate names and retain aliases after refresh or attachment removal',()=>{
 const {c,storage}=setup();
 const first=c.insertStudioMention('@',{start:0,end:1},'a',[]);
 const second=c.insertStudioMention('@',{start:0,end:1},'b',first.mentions);
 assert.equal(second.prompt,'@图片2 ');
 assert.equal(c.insertStudioMention('@',{start:0,end:1},'a',second.mentions).prompt,'@图片1 ');
 c.writeStudioDraft(1,{prompt:'参考@图片1 和@图片2',promptMentions:second.mentions,referenceIds:['b','a']});
 const restored=setup().c.readStudioDraft(1,storage);
 const assets=[{id:'a',kind:'image',title:'same.png'},{id:'b',kind:'image',title:'same.png'},{id:'sound',kind:'audio'}];
 assert.equal(c.resolveStudioMentions(restored.prompt,restored.promptMentions,['sound','b','a'],assets).prompt,'参考图片2 和图片1');
 assert.match(c.resolveStudioMentions(restored.prompt,restored.promptMentions,['b'],assets).error,/已移除或不可用/);
 assert.match(c.resolveStudioMentions('@图片20',[],['a'],assets).error,/重新选择/);
 assert.equal(c.resolveStudioMentions('no mentions',second.mentions,[],assets).error,'');
 assert.equal(c.resolveStudioMentions('@图片10',[{alias:'图片1',assetId:'a'}],['a'],assets).prompt,'@图片10');
});
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
test('a reference combination keeps every image in role order with its prompt and no consent',()=>{
  const {c,storage}=setup();
  const incoming={key:'combo',title:'组合参考：人物、服装、姿势',prompt:'图1是人物参考\n图2是服装参考\n图3是姿势参考',
    referenceAssetId:'face-asset',referenceAssetIds:['face-asset','costume-asset','pose-asset'],
    acceptUnknownCost:true,acceptCodexUsage:true};
  const draft=c.resolveStudioDraft(null,incoming);
  assert.deepEqual([...draft.referenceIds],['face-asset','costume-asset','pose-asset']);
  assert.equal(draft.generationRoute,'api');
  assert.equal(draft.prompt,incoming.prompt);
  assert.equal(draft.title,incoming.title);
  assert.ok(!Object.keys(draft).some(key=>/accept|consent|cost/i.test(key)));
  c.writeStudioDraft(8,draft);
  const saved=JSON.parse(storage.getItem(c.studioDraftKey(8)));
  assert.deepEqual(saved.referenceIds,['face-asset','costume-asset','pose-asset']);
  // An existing draft is kept until the studio's own overwrite confirmation consumes the new key.
  const kept=c.resolveStudioDraft({...draft,prompt:'my edits'},{key:'combo'});
  assert.equal(kept.prompt,'my edits');
});
test('legacy single references still work and reference lists are bounded and sanitized',()=>{
  const {c}=setup();
  const legacy=c.resolveStudioDraft(null,{key:'one',referenceAssetId:'only',referenceAssetIds:[]});
  assert.deepEqual([...legacy.referenceIds],['only']);
  assert.deepEqual([...c.resolveStudioDraft(null,{key:'none'}).referenceIds],[]);
  assert.equal(c.resolveStudioDraft(null,{key:'none'}).generationRoute,'local');
  const many=Array.from({length:40},(_,index)=>`asset-${index}`);
  const bounded=c.resolveStudioDraft(null,{key:'many',referenceAssetIds:[...many,'asset-0',42,'x'.repeat(161)]});
  assert.equal(bounded.referenceIds.length,32);
  assert.equal(bounded.referenceIds[0],'asset-0');assert.equal(bounded.referenceIds[31],'asset-31');
});

// --- Screenshot-inspired controls: roles, bilingual templates, dirty edits,
// aspect/count, consent and sequential batch idempotency keys. ------------

test('reference role sanitization never assumes the first image is the face',()=>{
  const {c}=setup();
  // No kind hints at all (arbitrary uploads): no role is assumed.
  assert.deepEqual(JSON.parse(JSON.stringify(c.sanitizeStudioReferenceRoles([{assetId:'a1'},{assetId:'a2'}]))),[]);
  // Explicit kinds are kept, reordered to the canonical face/costume/pose order
  // regardless of the order they arrived in.
  const roles = c.sanitizeStudioReferenceRoles([{kind:'pose',assetId:'p1'},{kind:'face',assetId:'f1'},{kind:'costume',assetId:'c1'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(roles)),[{kind:'face',assetId:'f1'},{kind:'costume',assetId:'c1'},{kind:'pose',assetId:'p1'}]);
  // Unknown kinds, missing assetId, duplicate kind and duplicate assetId are dropped.
  const messy = c.sanitizeStudioReferenceRoles([
    {kind:'face',assetId:'f1'},{kind:'face',assetId:'f2'},{kind:'hat',assetId:'h1'},{kind:'pose'},{kind:'costume',assetId:'f1'},
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(messy)),[{kind:'face',assetId:'f1'}]);
});

test('reference-library onCreate metadata becomes role-ordered hints through resolveStudioDraft',()=>{
  const {c}=setup();
  const incoming = {key:'combo-roles', references:[
    {kind:'pose',id:'pose-item',title:'姿势',assetId:'asset-pose'},
    {kind:'face',id:'face-item',title:'人物',assetId:'asset-face'},
    {kind:'costume',id:'costume-item',title:'服装',assetId:'asset-costume'},
  ]};
  const draft = c.resolveStudioDraft(null, incoming);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.referenceRoles)),[
    {kind:'face',assetId:'asset-face'},{kind:'costume',assetId:'asset-costume'},{kind:'pose',assetId:'asset-pose'},
  ]);
});

test('bilingual templates are role-aware, preserve identity/garment/pose and never use safety-bypass wording',()=>{
  const {c}=setup();
  const roles=[{kind:'face',assetId:'f1'},{kind:'costume',assetId:'c1'},{kind:'pose',assetId:'p1'}];
  const zh = c.buildStudioTemplate({roles, style:'street', language:'zh', extras:'背景换成夜晚霓虹灯'});
  assert.match(zh,/图1是人物参考/); assert.match(zh,/图2是服装参考/); assert.match(zh,/图3是姿势参考/);
  assert.match(zh,/街拍写真/); assert.match(zh,/补充要求：背景换成夜晚霓虹灯/);
  assert.match(zh,/不要画出人体模型/);
  const en = c.buildStudioTemplate({roles, style:'anime', language:'en', extras:'add soft rim light'});
  assert.match(en,/Image 1 is the subject \/ face reference\./);
  assert.match(en,/Image 3 is the pose reference\./);
  assert.match(en,/anime illustration/);
  assert.match(en,/Additional requirements: add soft rim light/);
  assert.doesNotMatch(zh+en,/mannequin and guide lines are fine/i);
  assert.doesNotMatch(zh+en,/bypass|neutraliz|reduce moderation|无需审核|绕过审核/i);
  // No roles at all (arbitrary uploads / pure text): still a complete, valid template.
  const generic = c.buildStudioTemplate({style:'photo', language:'zh'});
  assert.match(generic,/原创图像/); assert.match(generic,/不要画出人体模型/);
});

test('role prompt numbering follows the actual reference attachment order, not the canonical role sort',()=>{
  const {c}=setup();
  const roles=[{kind:'face',assetId:'f1'},{kind:'costume',assetId:'c1'},{kind:'pose',assetId:'p1'}];
  // Attachment order differs from the canonical face/costume/pose sort: pose was attached first.
  const referenceIds=['p1','f1','c1'];
  const zh=c.buildStudioTemplate({roles, referenceIds, style:'photo', language:'zh'});
  assert.match(zh,/图1是姿势参考/);
  assert.match(zh,/图2是人物参考/);
  assert.match(zh,/图3是服装参考/);
  const en=c.buildStudioTemplate({roles, referenceIds, style:'photo', language:'en'});
  assert.match(en,/Image 1 is the pose reference\./);
  assert.match(en,/Image 2 is the subject \/ face reference\./);
  assert.match(en,/Image 3 is the costume \/ outfit reference\./);
});

test('removing a reference drops its role from the built prompt instead of pointing at a stale image',()=>{
  const {c}=setup();
  const roles=[{kind:'face',assetId:'f1'},{kind:'costume',assetId:'c1'}];
  const referenceIds=['f1']; // costume reference was removed from the attachment list
  const zh=c.buildStudioTemplate({roles, referenceIds, style:'photo', language:'zh'});
  assert.match(zh,/图1是人物参考/);
  assert.doesNotMatch(zh,/服装参考/);
  assert.deepEqual(c.filterStudioRolesByReferenceIds(roles, referenceIds), [{kind:'face',assetId:'f1'}]);
});

test('style/language/extras changes rebuild only when not dirty; manual edits are preserved until an explicit reset',()=>{
  const {c}=setup();
  const options1 = {style:'photo', language:'zh', extras:''};
  let draft = c.applyStudioTemplate({}, options1);
  assert.equal(draft.promptDirty,false);
  assert.ok(c.shouldAutoApplyStudioTemplate(draft));
  // Style change while not dirty: caller is allowed to auto-rebuild.
  const options2 = {style:'film', language:'zh', extras:''};
  draft = c.applyStudioTemplate(draft, options2);
  assert.match(draft.prompt,/胶片氛围/);
  // User hand-edits the prompt: now dirty, and must not be silently discarded.
  draft = c.markStudioPromptEdited(draft, '我的自定义提示词');
  assert.equal(draft.promptDirty,true);
  assert.ok(!c.shouldAutoApplyStudioTemplate(draft));
  const options3 = {style:'anime', language:'zh', extras:'加一点光斑'};
  // Simulate the UI respecting the dirty flag: it does not call applyStudioTemplate.
  assert.equal(draft.prompt,'我的自定义提示词');
  // Only an explicit reset overwrites the edit.
  draft = c.resetStudioPromptToTemplate(draft, options3);
  assert.match(draft.prompt,/二次元插画/); assert.equal(draft.promptDirty,false);
});

test('aspect ratio stays within the visible set and count is fixed to one outside API image mode',()=>{
  const {c}=setup();
  assert.equal(c.normalizeStudioAspect('9:16'),'9:16');
  assert.equal(c.normalizeStudioAspect('unsupported'),'1:1');
  assert.equal(c.normalizeStudioCount(3,{module:'image',generationRoute:'api'}),3);
  assert.equal(c.normalizeStudioCount(9,{module:'image',generationRoute:'api'}),1);
  assert.equal(c.normalizeStudioCount(4,{module:'image',generationRoute:'local'}),1);
  assert.equal(c.normalizeStudioCount(4,{module:'seedance',generationRoute:'api'}),1);
  assert.equal(c.normalizeStudioCount(4,{module:'hh1',generationRoute:'api'}),1);
  // normalizeStudioDraft wires this through automatically.
  const apiImage = c.normalizeStudioDraft({module:'image',generationRoute:'api',count:4});
  assert.equal(apiImage.count,4);
  const localImage = c.normalizeStudioDraft({module:'image',generationRoute:'local',count:4});
  assert.equal(localImage.count,1);
});

test('cost consent is explicit, includes the selected quantity, and resets whenever the draft signature changes',()=>{
  const {c}=setup();
  const draft = c.normalizeStudioDraft({module:'image',generationRoute:'api',prompt:'p',model:'nano-banana-pro',mode:'image',aspectRatio:'1:1',count:3,style:'photo',language:'zh'});
  const sig = c.studioConsentSignature(draft);
  const consent = c.normalizeStudioConsent({signature:sig,quantity:3,acceptedAt:'2026-10-31'}, sig);
  assert.equal(consent.quantity,3);
  // Editing the prompt (or anything else in the signature) invalidates it.
  const edited = {...draft, prompt:'p changed'};
  const newSig = c.studioConsentSignature(edited);
  assert.equal(c.normalizeStudioConsent({signature:sig,quantity:3}, newSig), null);
  // Out-of-range or malformed quantities are rejected even with a matching signature.
  assert.equal(c.normalizeStudioConsent({signature:sig,quantity:9}, sig), null);
  assert.equal(c.normalizeStudioConsent(null, sig), null);
});

test('sequential batch submission uses stable per-child idempotency keys and never duplicates accepted jobs on retry',()=>{
  const {c}=setup();
  let batch = c.initStudioBatch('req-abc', 3);
  const key1 = c.studioBatchNextKey(batch);
  assert.equal(key1,'req-abc-1');
  // Child keys must stay within the server's requestKey pattern (letters,
  // digits, underscore and hyphen only — a colon would be rejected).
  assert.match(key1,/^[a-zA-Z0-9_-]{8,100}$/);
  batch = c.recordStudioBatchAccepted(batch, 'job-1');
  assert.equal(c.studioBatchPartialCount(batch),1);
  assert.equal(c.studioBatchComplete(batch),false);
  const key2 = c.studioBatchNextKey(batch);
  assert.equal(key2,'req-abc-2');
  assert.match(key2,/^[a-zA-Z0-9_-]{8,100}$/);
  // Simulate a timeout/retry on the same slot: the key must be identical, not a new one.
  assert.equal(c.studioChildRequestKey('req-abc',1), key2);
  // A failure stops progress: nextIndex is not advanced until accepted.
  const stillAtTwo = c.studioBatchNextKey(batch);
  assert.equal(stillAtTwo, key2);
  batch = c.recordStudioBatchAccepted(batch, 'job-2');
  batch = c.recordStudioBatchAccepted(batch, 'job-3');
  assert.equal(c.studioBatchNextKey(batch), null);
  assert.equal(c.studioBatchComplete(batch), true);
  assert.equal(c.studioBatchPartialCount(batch), 3);
  // Persisted/reloaded batch state round-trips and stays bounded to its count.
  const persisted = c.normalizeStudioBatch({baseRequestKey:'req-abc',count:3,submittedJobIds:['job-1','job-2','job-3','job-4'],nextIndex:99});
  assert.equal(persisted.submittedJobIds.length,3);
  assert.equal(persisted.nextIndex,3);
  assert.equal(persisted.done,true);
  // A draft round-trip carries the batch through normalizeStudioDraft too.
  const draftWithBatch = c.normalizeStudioDraft({module:'image',generationRoute:'api',batch:{baseRequestKey:'req-xyz',count:2,submittedJobIds:['job-9'],nextIndex:1}});
  assert.equal(draftWithBatch.batch.baseRequestKey,'req-xyz');
  assert.equal(draftWithBatch.batch.submittedJobIds[0],'job-9');
});

test('batch normalization never trusts a stored/corrupted nextIndex that would skip a remaining job',()=>{
  const {c}=setup();
  const corrupted = c.normalizeStudioBatch({baseRequestKey:'req-skip',count:3,submittedJobIds:['job-1'],nextIndex:3});
  assert.equal(corrupted.nextIndex,1);
  assert.equal(corrupted.done,false);
  assert.equal(c.studioBatchNextKey(corrupted),'req-skip-2');
  // Even a nextIndex far below what was accepted is ignored the same way.
  const tooLow = c.normalizeStudioBatch({baseRequestKey:'req-skip',count:3,submittedJobIds:['job-1','job-2'],nextIndex:0});
  assert.equal(tooLow.nextIndex,2);
  assert.equal(c.studioBatchNextKey(tooLow),'req-skip-3');
});
