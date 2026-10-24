(function(){
"use strict";
var T="<div class=\"lg-top\"><h2 class=\"lg-heading\">生活指南</h2><p class=\"lg-source\"></p></div>"
+"<div class=\"lg-toolbar\">"
+"<div class=\"lg-filters\">"
+"<label class=\"lg-filter-label lg-filter-label--chapter\"><span class=\"lg-filter-name\">章节</span><span class=\"lg-filter-mirror\" aria-hidden=\"true\"><span class=\"lg-filter-dot\">·</span><span class=\"lg-filter-value\">全部章节</span><span class=\"lg-filter-arrow\">⌄</span></span><select class=\"lg-filter\" data-lg=\"chapter\"></select></label>"
+"<label class=\"lg-filter-label\"><span class=\"lg-filter-name\">证据等级</span><span class=\"lg-filter-mirror\" aria-hidden=\"true\"><span class=\"lg-filter-dot\">·</span><span class=\"lg-filter-value\">全部</span><span class=\"lg-filter-arrow\">⌄</span></span><select class=\"lg-filter\" data-lg=\"grade\"></select></label>"
+"<label class=\"lg-filter-label\"><span class=\"lg-filter-name\">金钱</span><span class=\"lg-filter-mirror\" aria-hidden=\"true\"><span class=\"lg-filter-dot\">·</span><span class=\"lg-filter-value\">全部</span><span class=\"lg-filter-arrow\">⌄</span></span><select class=\"lg-filter\" data-lg=\"money\"></select></label>"
+"<label class=\"lg-filter-label\"><span class=\"lg-filter-name\">时间</span><span class=\"lg-filter-mirror\" aria-hidden=\"true\"><span class=\"lg-filter-dot\">·</span><span class=\"lg-filter-value\">全部</span><span class=\"lg-filter-arrow\">⌄</span></span><select class=\"lg-filter\" data-lg=\"time\"></select></label>"
+"<label class=\"lg-filter-label\"><span class=\"lg-filter-name\">毅力</span><span class=\"lg-filter-mirror\" aria-hidden=\"true\"><span class=\"lg-filter-dot\">·</span><span class=\"lg-filter-value\">全部</span><span class=\"lg-filter-arrow\">⌄</span></span><select class=\"lg-filter\" data-lg=\"will\"></select></label>"
+"<button type=\"button\" class=\"lg-reset\">重置</button></div>"
+"<input class=\"lg-search\" type=\"search\" aria-label=\"搜索生活指南\" placeholder=\"搜索生活指南\">"
+"</div>"
+"<div class=\"lg-layout\"><nav class=\"lg-chapters\" aria-label=\"章节\"></nav><div class=\"lg-results\"></div></div>";
function safeUrl(u){u=(typeof u==="string")?u.trim():"";return /^https:\/\//i.test(u)?u:"";}
function extLink(text,url){var a=document.createElement("a");a.textContent=text;a.href=url;a.target="_blank";a.rel="noopener noreferrer";return a;}
function stripFirst(md){return String(md).replace(/^\s{0,3}#{1,6}[ \t]+[^\n]*\n?/,"");}
// Injective DOM id fragment: encodeURIComponent keeps distinct raw ids distinct
// (the old lossy [_] replacement made distinct non-ASCII ids collide).
function safeIdentity(v){return encodeURIComponent(String(v==null?"":v));}
function pad2(n){var s=String(n);return /^\d$/.test(s)?"0"+s:s;}
function numOf(v){if(v==null||v==="")return null;var m=/\d+/.exec(String(v));return m?String(parseInt(m[0],10)):null;}
// Strict positive safe integer from a digit-only value; null otherwise.
function posInt(v){var s=String(v==null?"":v).trim();if(!/^\d+$/.test(s))return null;var n=Number(s);return (Number.isSafeInteger(n)&&n>0)?n:null;}
// Strict non-negative safe integer count; null when unknown/invalid.
function countInt(v){if(typeof v==="number")return (Number.isSafeInteger(v)&&v>=0)?v:null;var s=String(v==null?"":v).trim();if(!/^\d+$/.test(s))return null;var n=Number(s);return Number.isSafeInteger(n)?n:null;}
// Cross-reference forms. The explicit "第 N 节第 M 条" alternative comes first
// and is matched atomically, so an invalid entry never degrades into a chapter link.
var REF_RE=/第\s*(\d+)\s*节(?:\s*第\s*(\d+)\s*条)?|第\s*(\d+)\s*条/g;
var REF_SKIP="a,code,pre,script,style,textarea,kbd,samp,var,button,select,option,input,svg,math,noscript,template,iframe,object,title";
var REF_BLOCK="p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,caption,summary,div";
// Non-whitespace break marker between blocks/skipped text: \s never spans it.
var REF_BRK=String.fromCharCode(0xFFFC);
// Entry field presentation: exact source labels only (colon ":" or "："), in
// immediate top-level bullet lists of an entry body. Purely class/label-span
// decoration -- no text is added, removed, renamed or reordered.
var FIELD_RE=/^\s*(成本|说人话|收益|证据等级|来源|备注)\s*[:：]/;
var FIELD_KIND={"成本":"cost","说人话":"action","收益":"benefit","证据等级":"evidence","来源":"source","备注":"note"};
var FIELD_COMPACT={cost:1,evidence:1};
// A bullet holding nested/structured Markdown stays ordinary Markdown.
var FIELD_SKIP="ul,ol,table,pre,blockquote,input,hr,h1,h2,h3,h4,h5,h6,details";
var ROUTE_KEYS=["q","chapter","grade","money","time","will","view","entry","doc"];
var FALLBACK={grade:[["A","A级"],["B","B级"],["C","C级"]],money:[["0","不花钱"],["少","少量"],["多","较多"]],time:[["少","顺手"],["中","中等"],["多","较多"]],will:[["否","不用"],["些","一些"],["是","需要"]]};
var CHIP_LABEL={grade:"证据 ",money:"钱 ",time:"时间 ",will:"毅力 "};
var CHIP_HUMAN={money:{"0":"不花钱","少":"少量","多":"较多"},time:{"少":"顺手","中":"中等","多":"较多"},will:{"否":"不用","些":"一些","是":"需要"}};
var chipText=function(k,v){var m=CHIP_HUMAN[k],hv=(m&&m[String(v)]!=null)?m[String(v)]:String(v);return (CHIP_LABEL[k]||"")+hv;};
// Independent-column card layout (desktop two-column grid only).
// Cards keep DOM order 1..N and alternate columns by index (i%2); each column
// stacks its own cards via explicit grid-row start/span on a fine row grid, so
// opening a card only pushes later cards of the same column.
var LAYOUT_GAP=12,LAYOUT_MAXROWS=9000,LAYOUT_MQ="(max-width: 1000px)";
// Automatic pagination: desktop observes the footer inside the scrolling
// .lg-results pane; mobile (<=760px) observes it against the document viewport.
var AUTO_MQ="(min-width: 761px)",AUTO_MARGIN=120;
function blobUrl(meta,file){
  meta=meta||{};
  var repo=String(meta.repository||"").replace(/^https?:\/\/github\.com\//i,"").replace(/\.git$/,"").replace(/\/+$/,"");
  var commit=String(meta.commit||"");
  if(!repo||!commit||!file)return "";
  return safeUrl("https://github.com/"+repo+"/blob/"+encodeURIComponent(commit)+"/"+String(file).split("/").map(encodeURIComponent).join("/"));
}
function skelCard(){
  var c=document.createElement("div");c.className="lg-skel-card";c.setAttribute("aria-hidden","true");
  c.innerHTML="<span class=\"lg-skel lg-skel-index\"></span><span class=\"lg-skel-lines\"><span class=\"lg-skel lg-skel-line\"></span></span>";
  return c;
}
// First child node that is not whitespace-only text or a comment.
function firstSignificant(node){
  for(var c=node.firstChild;c;c=c.nextSibling){
    if(c.nodeType===3&&!/\S/.test(c.data))continue;
    if(c.nodeType===8)continue;
    return c;
  }
  return null;
}
// Mark the leading label of a recognized field. Only moves existing nodes or
// splits a text node; textContent and DOM text order stay identical.
function markLabel(li,label){
  var host=li,f=firstSignificant(li);
  if(f&&f.nodeType===1&&f.tagName==="P"){host=f;f=firstSignificant(f);}
  if(!f)return;
  if(f.nodeType===1&&(f.tagName==="STRONG"||f.tagName==="B")){
    var lt=f.textContent||"";
    if(lt.replace(/\s+/g,"").replace(/[:：]$/,"")!==label)return;
    if(!/[:：]\s*$/.test(lt)){
      var ns=f.nextSibling;
      if(ns&&ns.nodeType===3){
        var cm=/^\s*[:：]/.exec(ns.data);
        if(cm){if(cm[0].length<ns.data.length)ns.splitText(cm[0].length);f.appendChild(ns);}
      }
    }
    f.classList.add("lg-field-label");
    return;
  }
  if(f.nodeType===3&&f.parentNode===host){
    var mm=FIELD_RE.exec(f.data);
    if(!mm||mm[1]!==label)return;
    if(mm[0].length<f.data.length)f.splitText(mm[0].length);
    var sp=document.createElement("span");sp.className="lg-field-label";
    host.insertBefore(sp,f);sp.appendChild(f);
  }
}
// Default-collapse a 来源 field with native details/summary. Requires the
// marked leading label (directly in the li or its first <p>); otherwise the
// field is left untouched. Only existing nodes move; text order is unchanged.
function foldSource(li){
  var host=li,f=firstSignificant(li);
  if(f&&f.nodeType===1&&f.tagName==="P"){host=f;f=firstSignificant(f);}
  if(!f||f.nodeType!==1||!f.classList.contains("lg-field-label"))return;
  // Whitespace before the label must stay before it in text order.
  for(var c=host.firstChild;c&&c!==f;c=c.nextSibling){if(c.nodeType===3&&c.data)return;}
  var dt=document.createElement("details");dt.className="lg-source-fold";
  var sm=document.createElement("summary");
  var bd=document.createElement("div");bd.className="lg-source-body";
  sm.appendChild(f);
  while(li.firstChild)bd.appendChild(li.firstChild);
  dt.appendChild(sm);dt.appendChild(bd);
  li.appendChild(dt);
}
// Presentation-only enhancement for an entry body's top-level bullet lists.
// A list is enhanced only when it carries at least two recognized fields;
// unknown bullets inside it keep their ordinary bullet styling.
function enhanceFields(body){
  [].slice.call(body.children).forEach(function(ul){
    if(ul.tagName!=="UL")return;
    var hits=[];
    [].slice.call(ul.children).forEach(function(li){
      if(li.tagName!=="LI"||li.querySelector(FIELD_SKIP))return;
      var m=FIELD_RE.exec(li.textContent||"");
      if(m)hits.push({li:li,label:m[1],kind:FIELD_KIND[m[1]]});
    });
    if(hits.length<2)return;
    ul.classList.add("lg-fields");
    hits.forEach(function(h){
      h.li.classList.add("lg-field");
      h.li.classList.add("lg-field--"+h.kind);
      if(FIELD_COMPACT[h.kind])h.li.classList.add("lg-field--compact");
      try{markLabel(h.li,h.label);}catch(x){}
      if(h.kind==="source"){try{foldSource(h.li);}catch(x){}}
    });
  });
}
function create(root,handlers){
  handlers=handlers||{};
  root.classList.add("lg-workspace");
  root.innerHTML=T;
  var q=function(s){return root.querySelector(s);};
  var qEl=q(".lg-search"),srcEl=q(".lg-source"),resetEl=q(".lg-reset"),
      chapEl=q(".lg-chapters"),resEl=q(".lg-results"),filters={};
  [].slice.call(root.querySelectorAll(".lg-filter")).forEach(function(s){filters[s.getAttribute("data-lg")]=s;});
  var model={},curRows=[],curDisplay=[],chapSig="",listSig="";
  // Pending reveal target recorded by an ordinary click on a generated reference link.
  var pendingRef=null,destroyed=false;
  var SEP=String.fromCharCode(1),SEP2=String.fromCharCode(2);
  // ---- Column layout state: one active grid + its cards at a time ----
  var layoutMq=(typeof window.matchMedia==="function")?window.matchMedia(LAYOUT_MQ):null;
  var layoutRo=null,layoutGridEl=null,layoutItems=[],layoutRaf=0;
  function clearPlacement(grid,items){
    grid.classList.remove("is-masonry");
    grid.style.gridAutoRows="";
    items.forEach(function(el){el.style.gridColumn="";el.style.gridRow="";});
  }
  // Synchronous placement: all reads first, then writes. Item heights are
  // natural (align-self:start), so writing spans never changes what is measured.
  function layoutGrid(){
    if(layoutRaf){cancelAnimationFrame(layoutRaf);layoutRaf=0;}
    var grid=layoutGridEl,items=layoutItems;
    if(destroyed||!grid||!grid.isConnected)return;
    if((layoutMq&&layoutMq.matches)||items.length<2){clearPlacement(grid,items);return;}
    var hs=items.map(function(el){return Math.ceil(el.getBoundingClientRect().height)+LAYOUT_GAP;});
    var tot=[0,0];hs.forEach(function(h,i){tot[i%2]+=h;});
    var unit=Math.max(1,Math.ceil(Math.max(tot[0],tot[1])/LAYOUT_MAXROWS));
    var top=[1,1];
    grid.classList.add("is-masonry");
    var ar=unit+"px";if(grid.style.gridAutoRows!==ar)grid.style.gridAutoRows=ar;
    items.forEach(function(el,i){
      var c=i%2,span=Math.max(1,Math.ceil(hs[i]/unit)),col=String(c+1),row=top[c]+" / span "+span;
      if(el.style.gridColumn!==col)el.style.gridColumn=col;
      if(el.style.gridRow!==row)el.style.gridRow=row;
      top[c]+=span;
    });
  }
  function scheduleLayout(){
    if(destroyed||layoutRaf||!layoutGridEl)return;
    layoutRaf=requestAnimationFrame(function(){layoutRaf=0;layoutGrid();});
  }
  // Drop observation of the obsolete grid/cards before the results are rebuilt.
  function detachLayout(){
    if(layoutRaf){cancelAnimationFrame(layoutRaf);layoutRaf=0;}
    if(layoutRo)layoutRo.disconnect();
    layoutGridEl=null;layoutItems=[];
  }
  function attachLayout(grid){
    layoutGridEl=grid;
    layoutItems=[].slice.call(grid.children).filter(function(c){return c.classList&&c.classList.contains("lg-item");});
    if(!layoutRo&&typeof window.ResizeObserver==="function")layoutRo=new window.ResizeObserver(function(){scheduleLayout();});
    if(layoutRo){layoutRo.observe(grid);layoutItems.forEach(function(el){layoutRo.observe(el);});}
    layoutGrid();
  }
  function onLayoutToggle(e){var t=e.target;if(layoutGridEl&&t&&t.nodeType===1&&layoutGridEl.contains(t))layoutGrid();}
  function onLayoutMedia(e){var t=e.target;if(layoutGridEl&&t&&t.tagName==="IMG"&&layoutGridEl.contains(t))scheduleLayout();}
  function onLayoutMq(){layoutGrid();}
  function onLayoutResize(){scheduleLayout();}
  // ---- Automatic pagination: one observer on the current footer at a time ----
  // Every detach bumps autoTok, so a callback queued by an obsolete observer
  // (render, filter change, media switch, destroy) can never request a page.
  // autoSig records the list/rows/count state that already fired once; a page
  // that adds no rows leaves it unchanged, so it never auto-fires again.
  var autoMq=(typeof window.matchMedia==="function")?window.matchMedia(AUTO_MQ):null;
  var autoIo=null,autoEl=null,autoFooter=null,autoScrollTarget=null,autoRaf=0,autoTok=0,autoSig="";
  function autoDesktop(){return !!(autoMq&&autoMq.matches);}
  function pageSig(){return listSig+SEP2+curRows.length+SEP2+String(model.count||0);}
  function autoAllowed(){
    return !destroyed&&model.hasMore===true&&!model.loading&&!model.loadingMore&&!model.loadingDetail&&!model.error&&!model.loadMoreError&&autoSig!==pageSig();
  }
  function detachAuto(){
    autoTok++;
    if(autoIo){autoIo.disconnect();autoIo=null;}
    if(autoScrollTarget){autoScrollTarget.removeEventListener("scroll",onAutoScroll);autoScrollTarget=null;}
    if(autoRaf){cancelAnimationFrame(autoRaf);autoRaf=0;}
    autoEl=null;
  }
  function fireAuto(tok){
    if(tok!==autoTok||!autoEl||!autoEl.isConnected||!autoAllowed())return;
    autoSig=pageSig();
    detachAuto();
    if(typeof handlers.loadMore==="function")handlers.loadMore();
  }
  // Fallback proximity test when IntersectionObserver is unavailable.
  function nearBottom(el){
    var limit=autoDesktop()?resEl.getBoundingClientRect().bottom:(window.innerHeight||document.documentElement.clientHeight);
    return el.getBoundingClientRect().top<=limit+AUTO_MARGIN;
  }
  function onAutoScroll(){
    if(autoRaf||!autoEl)return;
    var tok=autoTok;
    autoRaf=requestAnimationFrame(function(){autoRaf=0;if(tok===autoTok&&autoEl&&nearBottom(autoEl))fireAuto(tok);});
  }
  function armAuto(el){
    detachAuto();
    if(!el||!autoAllowed())return;
    autoEl=el;
    var tok=autoTok,rootEl=autoDesktop()?resEl:null;
    if(typeof window.IntersectionObserver==="function"){
      autoIo=new window.IntersectionObserver(function(entries){
        for(var i=0;i<entries.length;i++){if(entries[i].isIntersecting){fireAuto(tok);return;}}
      },{root:rootEl,rootMargin:"0px 0px "+AUTO_MARGIN+"px 0px",threshold:0});
      autoIo.observe(el);
    }else{
      autoScrollTarget=rootEl||window;
      autoScrollTarget.addEventListener("scroll",onAutoScroll,{passive:true});
      onAutoScroll();
    }
  }
  // Desktop <-> mobile: rebuild the observer against the right scroll root.
  function onAutoMq(){if(!destroyed&&autoFooter&&autoFooter.isConnected)armAuto(autoFooter);else detachAuto();}
  function call(k,v){if(typeof handlers.change==="function")handlers.change(k,v);}
  function secId(s){return String(s.id||s.key||s.title||s.name||"");}
  function chapterName(id){var f=(model.sections||[]).filter(function(s){return secId(s)===String(id);})[0];
    return f?(f.title||f.name||String(id)):String(id||"");}
  function rowId(r){if(!r||typeof r!=="object")return "";return String((model.view==="docs")?(r.file||r.id||r.docFile||r.path||""):(r.id||""));}
  function detailRoute(){
    var route=model.route||{};
    return String((model.view==="docs")?(route.doc||""):(route.entry||""));
  }
  // Index label from the row's own source data -- never from the loop position.
  function indexLabel(r){
    var route=model.route||{};
    if(model.view==="docs"){
      var f=String(r.file||r.path||r.id||""),docs=model.docs||[];
      for(var i=0;i<docs.length;i++){var d=docs[i]||{},df=String(d.file||d.path||d.id||"");if(df&&df===f)return pad2(i+1);}
      return "—";
    }
    var n=numOf(r.number);
    if(n===null)return "—";
    if(route.chapter)return pad2(n);
    var sid=String(r.sectionId||r.chapter||""),sn=null;
    var sec=(model.sections||[]).filter(function(s){return secId(s)===sid;})[0];
    if(sec&&sec.number!=null&&sec.number!=="")sn=numOf(sec.number);
    if(sn===null)sn=numOf(sid);
    return sn===null?pad2(n):sn+"."+pad2(n);
  }
  function findRow(id){
    if(id==null||id==="")return null;
    var s=String(id);
    for(var i=0;i<curRows.length;i++){var r=curRows[i];if(rowId(r)===s)return r;}
    var sel=model.selected;
    if(sel&&typeof sel==="object"&&rowId(sel)===s)return sel;
    return null;
  }
  // Which title button currently owns keyboard focus (survives a re-render).
  function focusedTitleId(){
    var ae=document.activeElement;
    if(ae&&ae.classList&&ae.classList.contains("lg-title")&&resEl.contains(ae))return ae.getAttribute("data-lg-id")||"";
    return "";
  }
  // Plain, safe URL for links that already sit inside sanitized Markdown.
  function anchorHref(a){
    var raw=a.getAttribute("href")||"";
    if(raw&&raw!=="#")return raw;
    var attr=a.getAttribute("data-href")||a.getAttribute("data-url");
    return (attr&&attr!=="#")?attr:"";
  }
  // ---- Internal Chinese cross-references -------------------------------
  function realId(s){return (s&&typeof s==="object"&&s.id!=null)?String(s.id):"";}
  // A section is usable only when its real id is non-empty and unique.
  function uniqueSection(s){
    var sid=realId(s);if(!sid)return null;
    var c=0;(model.sections||[]).forEach(function(x){if(realId(x)===sid)c++;});
    return c===1?s:null;
  }
  // Chapter N must resolve to exactly one section by number and/or id sN.
  function sectionByNumber(n){
    var hits=[];
    (model.sections||[]).forEach(function(s){
      if(!s||typeof s!=="object")return;
      var byNum=(s.number!=null&&s.number!=="")&&posInt(s.number)===n;
      if((byNum||realId(s)==="s"+n)&&hits.indexOf(s)<0)hits.push(s);
    });
    return hits.length===1?uniqueSection(hits[0]):null;
  }
  function sectionById(id){
    var sid=String(id==null?"":id);if(!sid)return null;
    var hits=(model.sections||[]).filter(function(s){return realId(s)===sid;});
    return hits.length===1?hits[0]:null;
  }
  // Source contract: entry ids are ${section.id}-e${M}, contiguous 1..count.
  function entryIdOf(sec,m){
    var c=countInt(sec.count);
    if(c===null||m===null||m>c)return "";
    return realId(sec)+"-e"+m;
  }
  function currentSpace(){var mm=/[?&]space=(mine|public)(?:&|$)/.exec(String(location.hash||""));return mm?mm[1]:"";}
  // Target route: entries view, real chapter + entry; search/filters/doc cleared.
  function refHref(chapterId,entryId){
    var h="#life-guide?view=entries&chapter="+encodeURIComponent(chapterId);
    if(entryId)h+="&entry="+encodeURIComponent(entryId);
    var sp=currentSpace();if(sp)h+="&space="+sp;
    return h;
  }
  // Same-chapter "第 M 条" is ambiguous when a "第 N 节" appears earlier in
  // the same sentence of the same block (e.g. "第 27 节、第 2 条").
  function ambiguousSameChapter(full,start){
    var i=start,stop="。！？；;!?\n"+REF_BRK;
    while(i>0&&stop.indexOf(full.charAt(i-1))<0)i--;
    return /第\s*\d+\s*节/.test(full.slice(i,start));
  }
  function resolveRef(m,ctx,full){
    var sec,k,eid,after=full.slice(m.index+m[0].length);
    if(m[1]!=null){
      var n=posInt(m[1]);if(n===null)return null;
      if(m[2]==null&&/^\s*第/.test(after))return null; // unsupported entry form: no downgrade
      sec=sectionByNumber(n);if(!sec)return null;
      if(m[2]!=null){
        k=posInt(m[2]);if(k===null)return null;
        eid=entryIdOf(sec,k);
        return eid?{sec:sec,entry:eid,kind:"entry",num:k}:null;
      }
      return {sec:sec,entry:"",kind:"chapter",num:null};
    }
    if(m[3]!=null){
      if(!ctx||!ctx.sectionId)return null;
      if(ambiguousSameChapter(full,m.index))return null;
      sec=sectionById(ctx.sectionId);if(!sec)return null;
      k=posInt(m[3]);if(k===null)return null;
      eid=entryIdOf(sec,k);
      return eid?{sec:sec,entry:eid,kind:"entry",num:k}:null;
    }
    return null;
  }
  function refAnchor(text,t){
    var a=document.createElement("a");
    a.textContent=text;
    a.setAttribute("href",refHref(realId(t.sec),t.entry));
    a.className="lg-ref";
    a.setAttribute("data-lg-ref",t.kind);
    a.setAttribute("data-lg-ref-chapter",realId(t.sec));
    if(t.entry)a.setAttribute("data-lg-ref-entry",t.entry);
    var title=t.sec.title||t.sec.name;
    if(title){
      var num=(t.sec.number!=null&&t.sec.number!=="")?String(t.sec.number)+". ":"";
      a.setAttribute("aria-label",text+"：跳转到“"+num+String(title)+"”"+(t.kind==="entry"?" 第 "+t.num+" 条":""));
    }
    return a;
  }
  // Walk sanitized text nodes only (never inside anchors/code/pre/...). Matches
  // run over the concatenated block text so a reference split by inline markup
  // is refused whole; hits are replaced with DOM-built anchors, textContent unchanged.
  function linkRefs(container,ctx){
    if(!container||!(model.sections||[]).length||typeof document.createTreeWalker!=="function")return;
    var walker=document.createTreeWalker(container,4/*NodeFilter.SHOW_TEXT*/,null);
    var segs=[],full="",lastBlock=null,n;
    while((n=walker.nextNode())){
      var p=n.parentNode;
      if(!p||p.nodeType!==1||typeof p.closest!=="function"||p.closest(REF_SKIP)){full+=REF_BRK;lastBlock=null;continue;}
      var blk=p.closest(REF_BLOCK);
      if(segs.length&&blk!==lastBlock)full+=REF_BRK;
      lastBlock=blk;
      segs.push({node:n,start:full.length,end:full.length+n.data.length,hits:[]});
      full+=n.data;
    }
    if(!segs.length)return;
    var re=new RegExp(REF_RE.source,"g"),m,si=0;
    while((m=re.exec(full))){
      var s=m.index,e=s+m[0].length;
      while(si<segs.length&&segs[si].end<=s)si++;
      var seg=segs[si];
      if(!seg||s<seg.start||e>seg.end){re.lastIndex=s+1;continue;}
      var t=resolveRef(m,ctx,full);
      if(t)seg.hits.push({s:s-seg.start,e:e-seg.start,t:t});
    }
    segs.forEach(function(sg){
      if(!sg.hits.length||!sg.node.parentNode)return;
      var data=sg.node.data,pos=0,frag=document.createDocumentFragment();
      sg.hits.forEach(function(h){
        if(h.s>pos)frag.appendChild(document.createTextNode(data.slice(pos,h.s)));
        frag.appendChild(refAnchor(data.slice(h.s,h.e),h.t));
        pos=h.e;
      });
      if(pos<data.length)frag.appendChild(document.createTextNode(data.slice(pos)));
      sg.node.parentNode.replaceChild(frag,sg.node);
    });
  }
  function routeKey(r){r=r||{};return ROUTE_KEYS.map(function(k){return String(r[k]==null?"":r[k]);}).join(SEP);}
  function routeIsTarget(r,p){
    r=r||{};
    if(!p||r.view==="docs")return false;
    if(String(r.chapter||"")!==p.chapter||String(r.entry||"")!==p.entry)return false;
    return !r.q&&!r.grade&&!r.money&&!r.time&&!r.will&&!r.doc;
  }
  // Reveal the pending target card exactly once, when its route is rendered.
  // A chapter-only target reveals the chapter start (first card).
  function revealPending(){
    if(destroyed||!pendingRef)return;
    var route=model.route||{};
    if(!routeIsTarget(route,pendingRef)){
      // Still on the click's origin route: navigation not applied yet; anything else is stale.
      if(routeKey(route)!==pendingRef.origin||Date.now()-pendingRef.t>10000)pendingRef=null;
      return;
    }
    if(model.loading)return;
    var btns=resEl.querySelectorAll(".lg-title"),btn=null;
    if(!pendingRef.entry){
      pendingRef=null;
      resEl.scrollTop=0;
      if(!btns.length)return;
      btn=btns[0];
    }else{
      for(var i=0;i<btns.length;i++){if(btns[i].getAttribute("data-lg-id")===pendingRef.entry){btn=btns[i];break;}}
      if(!btn){if(!model.loadingDetail)pendingRef=null;return;}
      pendingRef=null;
    }
    // Card positions must be current before scrolling to the target.
    layoutGrid();
    var item=(btn.closest&&btn.closest(".lg-item"))||btn;
    try{item.scrollIntoView({block:"start",inline:"nearest"});}catch(x){try{item.scrollIntoView(true);}catch(y){}}
    try{btn.focus({preventScroll:true});}catch(x){btn.focus();}
  }
  // Generated reference links navigate natively through their hash href, so
  // history, modified clicks, copy and context menu all stay native. The href is
  // refreshed from the current workspace space first, so every native default
  // keeps it. Only an ordinary unmodified primary click records the reveal target.
  function onRefClick(e,a){
    var entry=a.getAttribute("data-lg-ref-entry")||"",chapter=a.getAttribute("data-lg-ref-chapter")||"";
    if(chapter)a.setAttribute("href",refHref(chapter,entry));
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    if(!chapter){pendingRef=null;return;}
    pendingRef={chapter:chapter,entry:entry,origin:routeKey(model.route||{}),t:Date.now()};
    // Already on the target route (same hash): no re-render follows, reveal now.
    if(routeIsTarget(model.route||{},pendingRef))setTimeout(revealPending,0);
  }
  // fields=true only for an entry detail body: recognized field bullets get a
  // presentation-only enhancement after sanitizing and reference linking.
  // Docs, chapter intros and the plain-text fallback never take this path.
  function mdNode(src,keep,ctx,fields){
    var text=String(src==null?"":src);
    if(!keep)text=stripFirst(text);
    var d=document.createElement("div");d.className="lg-body";
    var rich=false;
    if(window.marked&&window.DOMPurify&&typeof window.marked.parse==="function"&&typeof window.DOMPurify.sanitize==="function"){
      d.innerHTML=window.DOMPurify.sanitize(window.marked.parse(text));
      rich=true;
      // Promote any sanitizer-dropped marker hrefs back to real links. The value
      // is scheme-checked, so a javascript:/data: URL can never become one.
      [].slice.call(d.querySelectorAll("a")).forEach(function(a){
        var h=anchorHref(a);
        if(h&&safeUrl(h)){a.setAttribute("href",h);a.target="_blank";a.rel="noopener noreferrer";}
      });
    }else{d.textContent=text;}
    try{linkRefs(d,ctx||null);}catch(x){}
    if(rich&&fields){try{enhanceFields(d);}catch(x){}}
    return d;
  }
  function onSearch(e){call("q",e.target.value);}
  function onFilter(e){call(e.target.getAttribute("data-lg"),e.target.value);}
  function onReset(){["q","chapter","grade","money","time","will"].forEach(function(k){call(k,"");});}
  function onChapClick(e){var b=e.target.closest?e.target.closest("[data-lg-chapter]"):null;if(b)call("chapter",b.getAttribute("data-lg-chapter"));}
  // Title rows toggle the detail (open or close). Only the row button reacts --
  // a click inside the expanded panel does not reach this selector.
  function onResClick(e){
    var b=e.target.closest?e.target.closest("[data-lg-index]"):null;
    if(!b||!resEl.contains(b))return;
    if(typeof handlers.select!=="function")return;
    var r=curDisplay[+b.getAttribute("data-lg-index")];if(!r)return;
    var id=rowId(r);
    if(id)handlers.select(id);
  }
  // Internal document navigation: delegate every link inside a results body.
  // Absolute URLs carrying a scheme (e.g. https://raw.githubusercontent.com/...)
  // or a protocol-relative //host/... href keep the browser default, so an
  // upstream README link can never be mistaken for the local index README.
  function handleLink(e){
    var a=e.target.closest?e.target.closest("a"):null;
    if(!a||!resEl.contains(a))return;
    if(a.hasAttribute("data-lg-ref")){onRefClick(e,a);return;}
    var href=anchorHref(a);
    if(!href)return;
    try{if(new URL(href,location.href).origin!==location.origin)return;}catch(x){return;}
    var raw=String(href).split("#")[0].split("?")[0];
    if(!raw)return;
    var dec;try{dec=decodeURIComponent(raw);}catch(x){dec=raw;}
    var mm=/(?:^|\/)(docs\/.+)$/.exec(dec),path=mm?mm[1]:dec.replace(/^\.?\//,"");
    var basename=path.split("/").pop();
    if(basename==="README.md"&&!/^docs\//.test(path)){e.preventDefault();handlers.back();handlers.change("view","entries");handlers.change("chapter","");return;}
    if(basename==="LICENSE"||basename==="LICENSE-CODE"){e.preventDefault();window.open("/life-guide/"+basename,"_blank","noopener");return;}
    var sec=(model.sections||[]).filter(function(s){var f=String(s.file||"");return f===path||f.split("/").pop()===basename;})[0];
    if(sec){e.preventDefault();handlers.back();handlers.change("view","entries");handlers.change("chapter",sec.id);return;}
    var hit=(model.docs||[]).filter(function(d){
      var f=String(d.file||d.path||d.id||"");
      var fm=/(?:^|\/)(docs\/.+)$/.exec(f);
      return f===path||(fm&&fm[1]===path)||(f&&f.split("/").pop()===path.split("/").pop());
    })[0];
    if(hit){e.preventDefault();if(typeof handlers.openDoc==="function")handlers.openDoc(hit.file||hit.path||hit.id);}
  }
  function onBack(){if(typeof handlers.back==="function")handlers.back();}
  function renderSource(meta){
    meta=meta||{};srcEl.textContent="";
    var bits=[];
    if(meta.date)bits.push("日期 "+meta.date);
    if(meta.commit)bits.push("commit "+String(meta.commit).slice(0,12));
    if(bits.length)srcEl.appendChild(document.createTextNode(bits.join(" · ")));
    var url=blobUrl(meta,meta.file);
    var repoUrl=safeUrl(String(meta.repository||""));
    var link=url?extLink("原始来源",url):(repoUrl?extLink("原作者",repoUrl):null);
    if(link){if(bits.length)srcEl.appendChild(document.createTextNode(" · "));srcEl.appendChild(link);}
    var cc=extLink("CC BY 4.0","https://creativecommons.org/licenses/by/4.0/");
    if(bits.length||link)srcEl.appendChild(document.createTextNode(" · "));
    srcEl.appendChild(cc);
  }
  // Keep the visible mirror (value + chevron) in step with the native select:
  // the select itself is transparent, so its rendered text is never shown.
  function syncMirror(s){
    var lab=(s&&s.parentNode)||null;
    if(!lab||typeof lab.querySelector!=="function")return;
    var v=lab.querySelector(".lg-filter-value");
    if(!v)return;
    var o=s.options?s.options[s.selectedIndex]:null;
    v.textContent=o?String(o.textContent||o.label||""):"";
  }
  function fillFilter(k,route){
    var s=filters[k];if(!s)return;
    var list=(model.filters&&Array.isArray(model.filters[k]))?model.filters[k]:(FALLBACK[k]||[]);
    var opts=[{value:"",label:"全部"}];
    list.forEach(function(o){
      if(Array.isArray(o))opts.push({value:String(o[0]==null?"":o[0]),label:String(o[1]==null?o[0]:o[1])});
      else if(o&&typeof o==="object")opts.push({value:String(o.value==null?"":o.value),label:String(o.label==null?o.value:o.label)});
      else opts.push({value:String(o),label:String(o)});
    });
    var sig=opts.map(function(o){return o.value+SEP+o.label;}).join(SEP2);
    if(s.getAttribute("data-lg-sig")!==sig){
      s.setAttribute("data-lg-sig",sig);s.textContent="";
      opts.forEach(function(o){var op=document.createElement("option");op.value=o.value;op.textContent=o.label;s.appendChild(op);});
    }
    var v=String(route[k]==null?"":route[k]);
    if(s.value!==v)s.value=v;
    syncMirror(s);
  }
  function buildChapters(route){
    var sections=model.sections||[],cur=String(route.chapter||"");
    chapEl.textContent="";
    var sl=filters.chapter;sl.textContent="";
    function addOpt(v,l){var o=document.createElement("option");o.value=v;o.textContent=l;sl.appendChild(o);}
    // Row = [index badge | title | count]. The badge is decorative; a visually
    // hidden "N. " prefix keeps the accessible name identical to "N. 标题" + count.
    function addBtn(id,num,title,count,active){
      var b=document.createElement("button");b.type="button";b.className="lg-chapter"+(active?" is-active":"");
      b.setAttribute("data-lg-chapter",id);
      if(active)b.setAttribute("aria-current","true");
      var ix=document.createElement("span");ix.className="lg-chapter-index";ix.setAttribute("aria-hidden","true");
      if(num!==null){var nn=numOf(num);ix.textContent=nn===null?String(num):pad2(nn);}
      else ix.className+=" is-empty";
      var a=document.createElement("span");a.className="lg-chapter-title";
      if(num!==null){var pre=document.createElement("span");pre.className="lg-sr";pre.textContent=String(num)+". ";a.appendChild(pre);}
      a.appendChild(document.createTextNode(title));
      var c=document.createElement("span");c.className="lg-count";c.textContent=String(count||0);
      b.appendChild(ix);b.appendChild(a);b.appendChild(c);chapEl.appendChild(b);
    }
    addOpt("","全部章节");
    var total=0;sections.forEach(function(s){total+=(s.count!=null?s.count:(s.entries||[]).length);});
    var head=document.createElement("div");head.className="lg-chapters-head";
    head.textContent="章节 · "+sections.length+" 节 · "+total+" 条";
    chapEl.appendChild(head);
    addBtn("",null,"全部",total,cur==="");
    sections.forEach(function(s){
      var id=secId(s),base=s.title||s.name||id,hasNum=(s.number!=null&&s.number!==""),label=hasNum?String(s.number)+". "+base:base,count=(s.count!=null?s.count:(s.entries||[]).length);
      addBtn(id,hasNum?s.number:null,String(base),count,cur===id);
      addOpt(id,label+" ("+count+")");
    });
    if(sl.value!==cur)sl.value=cur;
    syncMirror(sl);
  }
  // Same-chapter references resolve only for an entry detail (or its chapter
  // intro) with a known selected.sectionId -- never docs, never route filter.
  function refContext(sel){
    if(model.view==="docs"||!sel||typeof sel!=="object")return null;
    var sid=sel.sectionId;
    if(sid==null||sid==="")return null;
    return {sectionId:String(sid)};
  }
  // One card button plus (when open) a detail article inside the same column.
  function buildRow(r,i,meta){
    var wrap=document.createElement("div");wrap.className="lg-item";
    var id=rowId(r);
    var b=document.createElement("button");b.type="button";
    b.className="lg-title";
    b.setAttribute("data-lg-index",String(i));
    if(id)b.setAttribute("data-lg-id",id);
    var open=!!detailRoute()&&detailRoute()===id;
    if(open)wrap.classList.add("is-open");
    b.setAttribute("aria-expanded",open?"true":"false");
    var panelId="lg-detail-"+safeIdentity(id||("i"+i));
    b.setAttribute("aria-controls",panelId);
    var ix=document.createElement("span");ix.className="lg-index";ix.setAttribute("aria-hidden","true");ix.textContent=indexLabel(r);
    b.appendChild(ix);
    var t=document.createElement("span");t.className="lg-title-text";t.textContent=String(r.title||"");
    b.appendChild(t);
    var chev=document.createElement("span");chev.className="lg-chevron";chev.setAttribute("aria-hidden","true");chev.textContent="›";
    b.appendChild(chev);
    wrap.appendChild(b);
    if(open){
      var art=document.createElement("article");
      art.className="lg-detail";art.id=panelId;
      var loading=!!model.loadingDetail&&!(model.selected&&rowId(model.selected)===id);
      if(model.error)art.appendChild(errorNode());
      else if(loading)art.appendChild(loadingNode());
      else if(model.selected&&rowId(model.selected)===id){
        var sel=model.selected;
        art.appendChild(mdNode(sel.markdown||sel.body||sel.content||"",false,refContext(sel),model.view!=="docs"));
        art.appendChild(metaNode(meta,sel));
      }else art.appendChild(placeholderNode());
      wrap.appendChild(art);
    }
    return wrap;
  }
  function loadingNode(){
    var d=document.createElement("div");d.className="lg-detail-loading lg-detail-skeleton";
    d.setAttribute("role","status");d.setAttribute("aria-label","加载生活指南");d.setAttribute("aria-busy","true");
    var w=["92%","100%","86%","96%","64%"];
    for(var k=0;k<w.length;k++){var s=document.createElement("span");s.className="lg-skel lg-skel-line";s.setAttribute("aria-hidden","true");s.style.width=w[k];d.appendChild(s);}
    return d;
  }
  function placeholderNode(){
    var p=document.createElement("p");p.className="lg-detail-placeholder";p.textContent="没有匹配的内容，请调整搜索或筛选。";return p;
  }
  function errorNode(){
    var eb=document.createElement("div");eb.className="lg-error";
    var et=document.createElement("p");et.textContent=String(model.error);
    var rb=document.createElement("button");rb.type="button";rb.className="lg-retry";rb.textContent="重试";
    rb.addEventListener("click",function(){if(typeof handlers.retry==="function")handlers.retry();});
    eb.appendChild(et);eb.appendChild(rb);return eb;
  }
  // Source / CC BY attribution for the expanded detail.
  function metaNode(meta,sel){
    var wrap=document.createElement("div");wrap.className="lg-attribution";
    var bits=[];
    if(sel.chapter||sel.sectionId)bits.push(chapterName(sel.chapter||sel.sectionId));
    if(sel.grade)bits.push(String(sel.grade));
    var su=blobUrl(meta,sel.file||sel.path);
    if(bits.length)wrap.appendChild(document.createTextNode(bits.join(" · ")));
    var link=null;
    if(su)link=extLink(sel.file||"原始来源",su);
    else{var repoUrl=safeUrl(String((meta||{}).repository||""));if(repoUrl)link=extLink("原作者",repoUrl);}
    if(link){if(bits.length)wrap.appendChild(document.createTextNode(" · "));wrap.appendChild(link);}
    var cc=extLink("CC BY 4.0","https://creativecommons.org/licenses/by/4.0/");
    if(bits.length||link)wrap.appendChild(document.createTextNode(" · "));
    wrap.appendChild(cc);
    var sec=(model.sections||[]).filter(function(s){return secId(s)===String(sel.chapter||sel.sectionId||"");})[0];
    if(sec&&sec.intro){
      var dt=document.createElement("details");dt.className="lg-notes";
      var sm=document.createElement("summary");sm.textContent="章节说明";dt.appendChild(sm);
      var ictx=refContext(sel);
      if(ictx&&realId(sec)!==ictx.sectionId)ictx=null;
      dt.appendChild(mdNode(sec.intro,true,ictx));wrap.appendChild(dt);
    }
    return wrap;
  }
  // Pagination footer (also the auto-load sentinel). The button stays a quiet
  // keyboard fallback; while a page is in flight it reports a busy, inert state,
  // and a failed page offers an explicit retry instead of re-firing on scroll.
  function loadMoreNode(){
    var box=document.createElement("div");box.className="lg-more";box.setAttribute("aria-live","polite");
    var busy=!!model.loadingMore,failed=!busy&&!!model.loadMoreError;
    if(failed){var et=document.createElement("p");et.className="lg-more-error";et.textContent=String(model.loadMoreError);box.appendChild(et);}
    var lm=document.createElement("button");lm.type="button";lm.className="lg-loadmore";
    lm.textContent=busy?"正在加载…":(failed?"重试加载":"加载更多");
    if(busy){lm.setAttribute("aria-disabled","true");box.setAttribute("aria-busy","true");}
    lm.addEventListener("click",function(e){e.stopPropagation();if(busy)return;if(typeof handlers.loadMore==="function")handlers.loadMore();});
    box.appendChild(lm);
    return box;
  }
  function render(m){
    model=m||{};
    var route=model.route||{},view=model.view||"entries";
    renderSource(model.metadata||{});
    var qv=String(route.q==null?"":route.q);
    if(qEl.value!==qv)qEl.value=qv;
    fillFilter("grade",route);fillFilter("money",route);fillFilter("time",route);fillFilter("will",route);
    var sections=model.sections||[];
    var sig=sections.map(function(s){return secId(s)+"|"+(s.count!=null?s.count:(s.entries||[]).length);}).join(",")+"#"+String(route.chapter||"");
    if(model.loading&&!sections.length){if(chapSig!=="#skel"){chapSig="#skel";chapEl.textContent="";for(var cj=0;cj<7;cj++){var cs=document.createElement("span");cs.className="lg-skel lg-skel-chapter";cs.setAttribute("aria-hidden","true");chapEl.appendChild(cs);}}}
    else if(sig!==chapSig||!chapEl.firstChild){chapSig=sig;buildChapters(route);}
    var nextListSig=[view,String(route.q==null?"":route.q),String(route.chapter==null?"":route.chapter),String(route.grade==null?"":route.grade),String(route.money==null?"":route.money),String(route.time==null?"":route.time),String(route.will==null?"":route.will)].join(SEP);
    var listSigChanged=(nextListSig!==listSig);listSig=nextListSig;
    if(listSigChanged||model.loading)autoSig="";
    var keepFocus=focusedTitleId(),keepScroll=resEl.scrollTop;
    var ae=document.activeElement,keepMore=!!(ae&&ae.classList&&ae.classList.contains("lg-loadmore")&&resEl.contains(ae));
    detachAuto();autoFooter=null;
    detachLayout();
    resEl.textContent="";
    var st=document.createElement("div");st.className="lg-status";
    st.textContent=(model.loading&&!(model.rows||[]).length)?"加载生活指南":(view==="docs"?"配套长文":"条目")+" · "+String(model.count||0)+" 条";
    resEl.appendChild(st);
    curRows=(model.rows||[]).slice();
    var idr=detailRoute(),pin=null;
    if(idr&&!curRows.some(function(r){return rowId(r)===idr;}))pin=findRow(idr);
    curDisplay=pin?[pin].concat(curRows):curRows.slice();
    if(model.error&&(!idr||!curDisplay.some(function(r){return rowId(r)===idr;})))resEl.appendChild(errorNode());
    var meta=model.metadata||{};
    // The footer is built before placement so the pane/document height already
    // includes it when layout is first read (no scroll clamp on append).
    var more=null;
    if(pin&&!model.loading&&!model.error)more=loadMoreNode();
    else if(curRows.length&&(model.hasMore!=null?(model.hasMore||model.loadingMore||!!model.loadMoreError):curRows.length<(model.count||0)))more=loadMoreNode();
    var grid=document.createElement("div");grid.className="lg-grid";
    if(model.loading&&!curDisplay.length){
      grid.className="lg-grid lg-loading lg-skeleton";
      grid.setAttribute("role","status");grid.setAttribute("aria-label","加载生活指南");grid.setAttribute("aria-busy","true");
      for(var k=0;k<8;k++)grid.appendChild(skelCard());
      resEl.appendChild(grid);
    }else if(curDisplay.length){
      curDisplay.forEach(function(r,i){grid.appendChild(buildRow(r,i,meta));});
      resEl.appendChild(grid);
      if(more)resEl.appendChild(more);
      // Place cards synchronously so scroll restore, focus and reveal see final positions.
      attachLayout(grid);
    }else if(!model.error){
      var em=document.createElement("p");em.className="lg-empty";em.textContent="没有匹配的内容，请调整搜索或筛选。";resEl.appendChild(em);
    }
    if(more&&!more.parentNode)resEl.appendChild(more);
    if(listSigChanged)resEl.scrollTop=0;else resEl.scrollTop=keepScroll;
    if(keepFocus){var btns=resEl.querySelectorAll(".lg-title");for(var bi=0;bi<btns.length;bi++){if(btns[bi].getAttribute("data-lg-id")===keepFocus){try{btns[bi].focus({preventScroll:true});}catch(x){btns[bi].focus();}break;}}}
    else if(keepMore&&more){var mb=more.querySelector(".lg-loadmore");if(mb){try{mb.focus({preventScroll:true});}catch(x){mb.focus();}}}
    autoFooter=more;
    if(more)armAuto(more);
    if(pendingRef)revealPending();
  }
  qEl.addEventListener("input",onSearch);
  ["chapter","grade","money","time","will"].forEach(function(k){if(filters[k])filters[k].addEventListener("change",onFilter);});
  resetEl.addEventListener("click",onReset);
  chapEl.addEventListener("click",onChapClick);
  resEl.addEventListener("click",onResClick);
  resEl.addEventListener("click",handleLink);
  // toggle/load/error do not bubble: listen in the capture phase.
  resEl.addEventListener("toggle",onLayoutToggle,true);
  resEl.addEventListener("load",onLayoutMedia,true);
  resEl.addEventListener("error",onLayoutMedia,true);
  window.addEventListener("resize",onLayoutResize);
  if(layoutMq){if(typeof layoutMq.addEventListener==="function")layoutMq.addEventListener("change",onLayoutMq);else if(typeof layoutMq.addListener==="function")layoutMq.addListener(onLayoutMq);}
  if(autoMq){if(typeof autoMq.addEventListener==="function")autoMq.addEventListener("change",onAutoMq);else if(typeof autoMq.addListener==="function")autoMq.addListener(onAutoMq);}
  var fonts=document.fonts||null;
  if(fonts&&typeof fonts.addEventListener==="function")fonts.addEventListener("loadingdone",onLayoutResize);
  if(fonts&&fonts.ready&&typeof fonts.ready.then==="function")fonts.ready.then(function(){scheduleLayout();},function(){});
  function destroy(){
    destroyed=true;pendingRef=null;
    detachAuto();autoFooter=null;
    detachLayout();layoutRo=null;
    resEl.removeEventListener("toggle",onLayoutToggle,true);
    resEl.removeEventListener("load",onLayoutMedia,true);
    resEl.removeEventListener("error",onLayoutMedia,true);
    window.removeEventListener("resize",onLayoutResize);
    if(layoutMq){if(typeof layoutMq.removeEventListener==="function")layoutMq.removeEventListener("change",onLayoutMq);else if(typeof layoutMq.removeListener==="function")layoutMq.removeListener(onLayoutMq);}
    if(autoMq){if(typeof autoMq.removeEventListener==="function")autoMq.removeEventListener("change",onAutoMq);else if(typeof autoMq.removeListener==="function")autoMq.removeListener(onAutoMq);}
    if(fonts&&typeof fonts.removeEventListener==="function")fonts.removeEventListener("loadingdone",onLayoutResize);
    qEl.removeEventListener("input",onSearch);
    Object.keys(filters).forEach(function(k){filters[k].removeEventListener("change",onFilter);});
    resetEl.removeEventListener("click",onReset);
    chapEl.removeEventListener("click",onChapClick);
    resEl.removeEventListener("click",onResClick);
    resEl.removeEventListener("click",handleLink);
    root.textContent="";
    root.classList.remove("lg-workspace");
  }
  return {render:render,destroy:destroy};
}
if(!window.LifeGuideUI)window.LifeGuideUI={};
window.LifeGuideUI.create=create;
})();
