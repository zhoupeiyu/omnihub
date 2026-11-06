import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const draftCode=readFileSync(new URL('../public/studio-draft.js',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/media.jsx',import.meta.url),'utf8');
const start=source.indexOf('  async function submit() {',source.indexOf('function MediaStudioView'));
const submitCode=source.slice(start,source.indexOf('  async function refresh(job)',start));
function setup(count=3){
 const requests=[],bodies=[];let fail=true;const data=new Map();
 const c=vm.createContext({busy:false,acceptedCost:true,prompt:'test',submittedJobId:'',useLocal:false,isVideo:false,count,referenceIds:[],source:null,batch:null,submitKey:{current:'retry-base-key'},userId:1,promptDirty:false,faceProcessing:0,assets:[],module:'image',model:'nano-banana-pro',mode:'image',title:'',aspectRatio:'1:1',size:'1k',duration:5,resolution:'720p',deviceId:'',mounted:{current:true},editableDraft:{module:'image',generationRoute:'api',count,prompt:'test'},localStorage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},showToast:()=>{},setDraftSaved:()=>{},setSubmitError:()=>{},setStudioView:()=>{},onJobsChanged:async()=>{},api:async(_,{body})=>{requests.push(body.requestKey);if(fail&&requests.length===2){fail=false;throw Error('timeout');}return {id:body.requestKey,status:'queued'};}});
 for(const [fn,key] of [['setBusy','busy'],['setBatch','batch'],['setSubmittedJobId','submittedJobId'],['setAcceptedCost','acceptedCost']])c[fn]=value=>{c[key]=value;};
 c.promptMentions=[];
 const originalApi=c.api;c.api=async(url,options)=>{bodies.push(options.body);return originalApi(url,options);};
 vm.runInContext(draftCode+'\n'+submitCode,c);return {c,requests,bodies};
}
test('actual submit resumes a partial batch without resubmitting accepted slots',async()=>{const {c,requests}=setup();await c.submit();assert.deepEqual(requests,['retry-base-key-1','retry-base-key-2']);assert.equal(c.batch.nextIndex,1);await c.submit();assert.deepEqual(requests,['retry-base-key-1','retry-base-key-2','retry-base-key-2','retry-base-key-3']);assert.equal(c.submittedJobId,'retry-base-key-3');assert.equal(c.acceptedCost,false);await c.submit();assert.equal(requests.length,4);});
test('single generation retains legacy request identity and requires consent',async()=>{const {c,requests}=setup(1);c.acceptedCost=false;await c.submit();assert.equal(requests.length,0);c.acceptedCost=true;await c.submit();assert.deepEqual(requests,['retry-base-key']);});
test('actual submission resolves mentions against image order and sends the bound IDs',async()=>{
 const {c,bodies}=setup(1);
 c.prompt='沿用@图片1 的光线，与@图片2 合成';
 c.promptMentions=[{alias:'图片1',assetId:'second'},{alias:'图片2',assetId:'first'}];
 c.referenceIds=['audio','first','second'];
 c.assets=[{id:'audio',kind:'audio'},{id:'first',kind:'image'},{id:'second',kind:'image'}];
 await c.submit();
 assert.equal(bodies[0].prompt,'沿用图片2 的光线，与图片1 合成');
 assert.deepEqual(Array.from(bodies[0].referenceAssetIds),['audio','first','second']);
 assert.equal(c.editableDraft.prompt,'test');
});
test('missing mention bindings stop submission and never consume local or API usage',async()=>{
 const {c,requests}=setup(1); let error='';c.setSubmitError=value=>{error=value;};
 c.prompt='参考@图片1'; c.promptMentions=[{alias:'图片1',assetId:'gone'}];
 await c.submit();assert.equal(requests.length,0);assert.match(error,/已移除或不可用/);
 c.useLocal=true;await c.submit();assert.equal(requests.length,0);
});
