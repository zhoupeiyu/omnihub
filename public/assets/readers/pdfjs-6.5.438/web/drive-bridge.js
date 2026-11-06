(() => {
 const file=new URLSearchParams(location.search).get('file');
 let path;try{const url=new URL(file,location.origin);if(url.origin!==location.origin||url.pathname!=='/api/openlist/file')throw Error();path=url.searchParams.get('path');if(!path?.toLowerCase().endsWith('.pdf'))throw Error();}catch{document.addEventListener('DOMContentLoaded',()=>{document.body.textContent='无效的网盘 PDF 地址';});return;}
 const endpoint='/api/openlist/library/reading';
 const saved=fetch(endpoint+'?'+new URLSearchParams({path}),{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).catch(()=>({}));
 document.addEventListener('webviewerloaded',()=>{
  const app=window.PDFViewerApplication,options=window.PDFViewerApplicationOptions;
  options.setAll({disablePreferences:true,enableScripting:false,disableAutoFetch:true,disableStream:true,enableAltText:false,enableAltTextModelDownload:false,enableUpdatedAddImage:false});
  document.addEventListener('DOMContentLoaded',()=>{}, {once:true});
  const back=document.createElement('a');back.className='drive-back';back.textContent='返回网盘';back.href='/#knowledgeLibrary?space=mine&tab=drive&category='+({'20':'books','30':'courses','40':'business','50':'ai','60':'development','70':'finance','80':'materials'}[path.split('/')[2].slice(0,2)]||'books')+'&file='+encodeURIComponent(path);back.target='_top';if(new URLSearchParams(location.search).get('embedded')!=='1')document.getElementById('toolbarViewerLeft').prepend(back);
  let ready=false,timer;
  app.initializedPromise.then(()=>{
   app.eventBus.on('documentinit',async()=>{const value=await saved;if(value.location){const page=Number(value.location);if(page>0&&page<=app.pagesCount)app.page=page;}ready=true;document.title=path.split('/').at(-1);});
   app.eventBus.on('pagechanging',({pageNumber})=>{if(!ready)return;clearTimeout(timer);timer=setTimeout(()=>fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,location:String(pageNumber)}),keepalive:true}).catch(()=>{}),350);});
  });
 });
})();
