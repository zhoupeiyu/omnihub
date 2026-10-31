import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/media-local-conversion.js',import.meta.url),'utf8');
const runtimeFixture=({init}={})=>{
  const seen={options:null,disposed:0,executed:0,canceled:0};
  class Input { constructor(){ } async canRead(){return true;} dispose(){seen.disposed++;} }
  class BlobSource { constructor(file){this.file=file;} } class BufferTarget { constructor(){this.buffer=new Uint8Array([1,2,3]);} }
  class Output { constructor(options){this.target=options.target;} } class Mp4OutputFormat {} class WebMOutputFormat {} class Quality { constructor(value){this.value=value;} }
  const conversion={isValid:true,discardedTracks:[],state:'idle',async execute(){seen.executed++;this.state='done';},async cancel(){seen.canceled++;this.state='canceled';}};
  const Conversion={init:async options=>{seen.options=options;return init?await init(conversion):conversion;}};
  return {runtime:{Input,BlobSource,ALL_FORMATS:{},Output,BufferTarget,Mp4OutputFormat,WebMOutputFormat,Quality,Conversion},seen};
};
const load=fixture=>{const context=vm.createContext({window:{Mediabunny:fixture.runtime},Blob,File:class File extends Blob {constructor(parts,name,options){super(parts,options);this.name=name;}},Object,Math,Number,String,Error,Uint8Array});vm.runInContext(source,context);return {start:vm.runInContext('startMediaLocalConversion',context),...fixture};};

test('local compress uses Mediabunny Quality and conversion copy mode is a real contract key',async()=>{
  const app=load(runtimeFixture());const task=await app.start({file:{name:'clip.mp4'},operation:'compress',options:{format:'webm',quality:'small'}});const result=await task.done;
  assert.equal(app.seen.options.video.quality.value,'low');assert.equal(app.seen.options.audio.quality.value,'low');assert.equal(app.seen.options.video.forceTranscode,true);assert.equal(result.name,'clip-local.webm');assert.equal(app.seen.disposed,1);
  const convert=load(runtimeFixture());const next=await convert.start({file:{name:'clip.mp4'},operation:'convert',options:{}});await next.done;assert.equal(convert.seen.options.copy.mode,'preferred');
});

test('cancel requested during Conversion.init cancels after init and never executes',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const app=load(runtimeFixture({init:async conversion=>{await gate;return conversion;}}));const task=await app.start({file:{name:'clip.mp4'},operation:'convert',options:{}});await task.cancel();release();await assert.rejects(task.done,/已取消/);assert.equal(app.seen.canceled,1);assert.equal(app.seen.executed,0);assert.equal(app.seen.disposed,1);
});
