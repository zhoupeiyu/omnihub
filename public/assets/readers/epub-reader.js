(async()=>{
 const $=id=>document.getElementById(id),path=new URLSearchParams(location.search).get('path');
 if(!path || !path.toLowerCase().endsWith('.epub')){$('error').textContent='无效的 EPUB 文件';return;}
 $('back').href='/#knowledgeLibrary?space=mine&tab=drive&category='+({'20':'books','30':'courses','40':'business','50':'ai','60':'development','70':'finance','80':'materials'}[path.split('/')[2].slice(0,2)]||'books')+'&file='+encodeURIComponent(path);
 if(new URLSearchParams(location.search).get('embedded')==='1')$('back').hidden=true;
 $('title').textContent=path.split('/').at(-1);document.title=$('title').textContent;
 const controller=new AbortController();let book,rendition,font=100,dark=false,saveTimer,ready=false;
 const api=async(url,options={})=>{const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});if(!response.ok)throw Error('网盘读取失败（'+response.status+'）');return response.json();};
 const report=e=>{$('error').textContent='阅读失败：'+(e?.message||'无法解析此电子书');};
 window.addEventListener('pagehide',()=>{controller.abort();clearTimeout(saveTimer);book?.destroy();});
 try{
  const saved=api('/api/openlist/library/reading?'+new URLSearchParams({path})).catch(()=>({}));
  const response=await fetch('/api/openlist/file?'+new URLSearchParams({path}),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!response.ok)throw Error('网盘文件读取失败（'+response.status+'）');
  const buffer=await response.arrayBuffer();
  book=ePub(buffer);const loadSection=book.load.bind(book);book.load=async url=>{const value=await loadSection(url);if(typeof value==='string'&&/<(?:html|\?xml)[\s>]/i.test(value)){const doc=new DOMParser().parseFromString(value,'application/xhtml+xml');if(doc.querySelector('parsererror'))throw Error('电子书章节格式无效');return doc;}return value;};book.spine.hooks.content.register(doc=>{
   doc.querySelectorAll('script,iframe,object,embed,form,base,meta[http-equiv]').forEach(n=>n.remove());
   doc.querySelectorAll('*').forEach(el=>{for(const a of [...el.attributes])if(/^on/i.test(a.name))el.removeAttribute(a.name);});
   doc.querySelectorAll('a[href]').forEach(a=>{if(/^(?:https?:|javascript:|data:|\/\/)/i.test(a.getAttribute('href')))a.removeAttribute('href');});
   const csp=doc.createElement('meta');csp.setAttribute('http-equiv','Content-Security-Policy');csp.setAttribute('content',"default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:; form-action 'none'; base-uri 'none'");doc.head.prepend(csp);
  });
  await book.ready;
  rendition=book.renderTo('book',{width:'100%',height:'100%',spread:'none',flow:'paginated',allowScriptedContent:false,allowPopups:false});
  for(const name of ['day','night'])rendition.themes.register(name,{'body':{color:(name==='night'?'#eee':'#202124')+' !important',background:(name==='night'?'#1c2025':'#f8f7f3')+' !important'},'p,span,h1,h2,h3,h4,h5,h6,strong,em,a,li,div':{color:'inherit !important',background:'transparent !important'}});
  rendition.themes.select('day');
  rendition.themes.default({'body':{'line-height':'1.8 !important','padding':'0 12px !important'}});
  rendition.on('displayError',report);
  const navigation=await book.loaded.navigation;
  $('toc').replaceChildren();const add=(items,depth=0)=>items.forEach(item=>{const o=document.createElement('option');o.value=item.href;o.textContent='　'.repeat(depth)+item.label.trim();$('toc').append(o);if(item.subitems?.length)add(item.subitems,depth+1);});add(navigation.toc);
  $('toc').onchange=()=>rendition.display($('toc').value).catch(report);
  const previous=await saved;try{await rendition.display(previous.location||undefined);}catch{await rendition.display();}
  ready=true;$('status').textContent='浏览器内阅读 · 自动记录阅读位置 · 服务器不缓存书籍';
  const relocated=location=>{const start=location.start;$('position').textContent=`第 ${start.index+1} 节 · 本节 ${start.displayed.page}/${start.displayed.total} 页`;$('previous').disabled=location.atStart;$('next').disabled=location.atEnd;const option=[...$('toc').options].find(o=>o.value.split('#')[0]===start.href);if(option)$('toc').value=option.value;
   if(ready){clearTimeout(saveTimer);saveTimer=setTimeout(()=>api('/api/openlist/library/reading',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,location:start.cfi}),keepalive:true}).catch(report),350);}
  };
  rendition.on('relocated',relocated);const current=rendition.currentLocation();if(current?.start)relocated(current);
  $('previous').onclick=()=>rendition.prev().catch(report);$('next').onclick=()=>rendition.next().catch(report);
  $('smaller').onclick=()=>{font=Math.max(70,font-10);rendition.themes.fontSize(font+'%');};$('larger').onclick=()=>{font=Math.min(200,font+10);rendition.themes.fontSize(font+'%');};
  $('theme').onclick=()=>{dark=!dark;document.body.classList.toggle('dark',dark);rendition.themes.select(dark?'night':'day');rendition.themes.override('color',dark?'#eee':'#202124',true);rendition.themes.override('background',dark?'#1c2025':'#f8f7f3',true);$('theme').textContent=dark?'日间模式':'夜间模式';};
  $('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(report);
  $('searchForm').onsubmit=async event=>{event.preventDefault();const q=$('search').value.trim();if(!q)return;$('searchResults').replaceChildren();$('status').textContent='正在搜索书内文字…';let count=0;try{for(const section of book.spine.spineItems){await section.load(book.load.bind(book));for(const hit of section.find(q)){if(count++>=100)break;const button=document.createElement('button');button.textContent=hit.excerpt;button.onclick=()=>{rendition.display(hit.cfi).catch(report);$('searchResults').replaceChildren();};$('searchResults').append(button);}if(count>=100)break;}$('status').textContent=count?'找到 '+Math.min(count,100)+' 处匹配'+(count>=100?'（最多显示 100 处）':''):'未找到匹配文字';}catch(e){report(e);}};
 }catch(e){if(!controller.signal.aborted)report(e);}
})();
