import {driveCollection} from './openlist-library.js';

// Match titles conservatively: version numbers and lesson counts remain significant.
export function sourceKey(name) {
  return String(name).normalize('NFKC').toLowerCase().replace(/^\s*\d+[.、_-]\s*/, '')
    .replace(/\s*\([1-9]\d?\)\s*$/, '').replace(/\s+/g, '').trim();
}
// Broad subject shelves are collections; chapter-numbered folders remain one course.
export function driveViewKind(name,children){
  const folders=children.filter(n=>n.isDir||n.kind==='folder');
  if(folders.length<2)return 'course';
  if(children.some(n=>['video','audio'].includes(n.kind)))return 'course';
  if(folders.some(n=>/^(?:\{\d+\}|第[\d一二三四五六七八九十]+章)/.test(n.name)))return 'course';
  const subjectShelves=['摄影剪辑','学习方法','社交人际','数学纪录片合集','有声书','听书解读','人文与社会','思维与逻辑','合集与杂文','商业与财经','心理与成长','生活与健康','社科人文','股票投资','金融理财','商业思维','财经时事','币圈Web3','经济学'];
  if(subjectShelves.includes(name.trim()) || /书目|音效库|背景音乐|BGM|高品质歌曲|挣钱攻略合集/.test(name))return 'collection';
  // Distinct named works form a shelf; repeated volumes of one title do not.
  const works=new Set(folders.map(n=>n.name.match(/《([^》]+)》/)?.[1]).filter(Boolean));
  if(works.size>=2)return 'collection';
  return folders.filter(n=>/第[一二三四五六七八九十]+套|训练营|完整课程|系列课程|教程|摄影课|实战课/.test(n.name)).length>=2?'collection':'course';
}
export function createDriveView(db, readLayouts = () => ({})) {
  const cached=new Map();
  function graph(id, allowedCategories) {
    const allowed=allowedCategories ? new Set(allowedCategories) : null;
    const scope=allowed ? [...allowed].sort().join(',') : '*';
    const previous=cached.get(`${id}:${scope}`);
    if(previous && Date.now()-previous.at<15000)return previous;
    const rows=db.prepare('SELECT path,parent,name,kind,size FROM drive_index WHERE user_id=?').all(id)
      .filter(r=>{const category=driveCollection(r.path)?.id;return category && (!allowed||allowed.has(category));});
    const byPath=new Map(),children=new Map(),names=new Map();
    for(const r of rows){const node={...r,isDir:r.kind==='folder',counts:{files:0,video:0,audio:0,pdf:0,epub:0,image:0,other:0}};byPath.set(r.path,node);if(!children.has(r.parent))children.set(r.parent,[]);children.get(r.parent).push(node);if(node.isDir){const key=sourceKey(r.name);if(key.length>=8){if(!names.has(key))names.set(key,[]);names.get(key).push(node);}}}
    for(const node of byPath.values())if(!node.isDir){node.counts.files=1;node.counts[node.kind in node.counts?node.kind:'other']=1;let parent=node.parent;while(driveCollection(parent)){const p=byPath.get(parent);if(p){p.counts.files++;p.counts[node.kind in p.counts?node.kind:'other']++;}parent=parent.slice(0,parent.lastIndexOf('/'));}}
    for(const items of children.values())items.sort((a,b)=>Number(b.isDir)-Number(a.isDir)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
    const layouts=readLayouts(id);
    const result={id,at:Date.now(),byPath,children,names,layouts};cached.set(`${id}:${scope}`,result);return result;
  }
  const options=(g,node)=>node.isDir?(g.names.get(sourceKey(node.name))||[node]).map(n=>({path:n.path,name:n.name,counts:n.counts,category:driveCollection(n.path)?.label})).sort((a,b)=>b.counts.files-a.counts.files||a.path.localeCompare(b.path)):[];
  function effective(g,node,seen=new Set()) {
    if(!node.isDir)return node.counts;
    const best=options(g,node)[0];const target=!node.counts.files&&best?.counts.files?g.byPath.get(best.path):node;
    if(seen.has(target.path))return {files:0,video:0,audio:0,pdf:0,epub:0,image:0,other:0};
    const next=new Set(seen);next.add(target.path);const counts={files:0,video:0,audio:0,pdf:0,epub:0,image:0,other:0};
    for(const child of g.children.get(target.path)||[])for(const [key,value] of Object.entries(effective(g,child,next)))counts[key]+=value;
    return counts;
  }
  function viewKind(g,node,actual=node){
    const reviewed=g.layouts?.[node.path]??g.layouts?.[actual.path];
    return ['collection','course'].includes(reviewed)?reviewed:driveViewKind(node.name,g.children.get(actual.path)||[]);
  }
  function decorate(g,node){const sources=options(g,node),preferred=sources[0];return {...node,sources,preferredPath:preferred?.path||node.path,availableCounts:effective(g,g.byPath.get(preferred?.path)||node),viewKind:viewKind(g,node,g.byPath.get(preferred?.path)||node)};}
  return {
    shelf(id,path,page=1,allowedCategories){const g=graph(id,allowedCategories);const items=g.children.get(path)||[];const groups=new Map();for(const node of items){const key=node.isDir && sourceKey(node.name).length>=8?'folder:'+sourceKey(node.name):node.path;if(!groups.has(key))groups.set(key,decorate(g,node));}
      const rows=[...groups.values()];const p=Math.max(1,Math.floor(Number(page)||1));return {path,page:p,total:rows.length,items:rows.slice((p-1)*60,p*60)};},
    course(id,path,source,viewerId=id,allowedCategories){const g=graph(id,allowedCategories),root=g.byPath.get(path);if(!root?.isDir)throw Object.assign(new Error('未找到已索引的课程目录，请先同步目录'),{status:404});
      const choices=options(g,root);if(source && !choices.some(s=>s.path===source))throw Object.assign(new Error('此来源不属于当前同名课程'),{status:400});
      const actual=g.byPath.get(source||choices[0]?.path||path);const substituted=[];
      function tree(node,ancestors=new Set(),isRoot=false){
        if(!node.isDir)return {...node};
        const sources=options(g,node),best=sources[0];let target=node;
        if(!(isRoot&&source) && !node.counts.files && best?.counts.files>0){target=g.byPath.get(best.path);substituted.push({from:node.path,to:target.path,name:node.name});}
        if(ancestors.has(target.path))return {...node,children:[],sources,cycle:true};
        const next=new Set(ancestors);next.add(target.path);
        let children=(g.children.get(target.path)||[]).map(child=>tree(child,next));
        while(children.length===1&&children[0].isDir&&children[0].children?.length&&(/^[0-9]+$/.test(children[0].name)||['视频','课程','视频课程',node.name].includes(children[0].name)))children=children[0].children;
        return {...node,sourcePath:target.path,sources,children};
      }
      const outline=tree(actual,new Set(),true),files=[];function walk(n,chapter){if(n.isDir){for(const child of n.children||[])walk(child,n.name);}else files.push({...n,chapter});}walk(outline,root.name);
      const recent=db.prepare('SELECT path,position,duration,opened_at FROM drive_recent WHERE user_id=? ORDER BY opened_at DESC').all(viewerId);const fileSet=new Set(files.map(f=>f.path));
      return {path,name:root.name,viewKind:viewKind(g,root,actual),sourcePath:actual.path,sources:choices,substituted,outline,files,recent:recent.find(r=>fileSet.has(r.path))||null};
    },
  };
}
