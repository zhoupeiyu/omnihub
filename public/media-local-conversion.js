const MEDIA_LOCAL_RUNTIME_KEYS = Object.freeze(['Input','BlobSource','ALL_FORMATS','Output','BufferTarget','Mp4OutputFormat','WebMOutputFormat','Conversion','Quality']);
const mediaLocalRuntime = () => window.Mediabunny || null;
const mediaLocalConversionAvailable = () => {
  const runtime=mediaLocalRuntime();
  return Boolean(runtime && MEDIA_LOCAL_RUNTIME_KEYS.every(key => typeof runtime[key] === 'function' || runtime[key]));
};
const mediaLocalFormat = format => format === 'webm' ? { extension:'webm', mime:'video/webm', OutputFormat:'WebMOutputFormat' } : { extension:'mp4', mime:'video/mp4', OutputFormat:'Mp4OutputFormat' };
const mediaLocalFileName = (file,extension) => `${String(file?.name || 'media').replace(/\.[^.]+$/,'') || 'media'}-local.${extension}`;
const mediaLocalQuality = quality => ({small:'low',balanced:'medium',high:'high'}[quality] || 'medium');

async function startMediaLocalConversion({file,operation,options={},onProgress}) {
  if(!file) throw new Error('请先选择文件。');
  if(!mediaLocalConversionAvailable()) throw new Error('此浏览器暂不支持本地处理，可改用服务器处理。');
  const runtime=mediaLocalRuntime(), format=mediaLocalFormat(options.format);
  const input=new runtime.Input({source:new runtime.BlobSource(file),formats:runtime.ALL_FORMATS});
  let conversion=null;
  let cancelRequested=false;
  const cancel=async()=>{ cancelRequested=true; if(conversion && conversion.state !== 'done') await conversion.cancel(); };
  const done=(async()=>{
    try {
      if(!await input.canRead()) throw new Error('此文件格式无法在当前浏览器读取，可改用服务器处理。');
      const target=new runtime.BufferTarget();
      const output=new runtime.Output({format:new runtime[format.OutputFormat](),target});
      const conversionOptions={input,output,tracks:'primary',showWarnings:false};
      if(operation==='trim') conversionOptions.trim={start:Number(options.start)||0,end:Number(options.end)};
      if(operation==='compress') {
        const quality=new runtime.Quality(mediaLocalQuality(options.quality));
        conversionOptions.video={quality,forceTranscode:true};
        conversionOptions.audio={quality,forceTranscode:true};
      }
      if(operation==='convert') conversionOptions.copy={mode:'preferred'};
      conversion=await runtime.Conversion.init(conversionOptions);
      if(cancelRequested) { await conversion.cancel(); throw new Error('浏览器处理已取消。'); }
      if(!conversion.isValid) {
        const reasons=conversion.discardedTracks?.map(item=>item.reason).filter(Boolean).join('、');
        throw new Error(reasons ? `当前浏览器无法编码所需轨道（${reasons}），可改用服务器处理。` : '当前浏览器无法编码此文件，可改用服务器处理。');
      }
      conversion.onProgress=value=>onProgress?.(Math.max(0,Math.min(100,Math.round(Number(value||0)*100))));
      await conversion.execute();
      if(cancelRequested) throw new Error('浏览器处理已取消。');
      const blob=new Blob([target.buffer],{type:format.mime});
      if(!blob.size) throw new Error('浏览器未生成输出文件，可改用服务器处理。');
      onProgress?.(100);
      return new File([blob],mediaLocalFileName(file,format.extension),{type:format.mime});
    } finally { input.dispose?.(); }
  })();
  return {done,cancel};
}
