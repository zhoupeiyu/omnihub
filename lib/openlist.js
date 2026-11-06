import {createResourcePresentation} from './drive-resource-presentation.js';
import {readIndexedCollections} from './drive-catalog.js';
import {createDriveView} from './drive-view.js';
import http from 'node:http';
import { createDriveScanner } from './drive-scan.js';
import { DRIVE_COLLECTIONS, driveCollection, driveKind, createDriveIndex } from './openlist-library.js';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isPublicAddress } from './media-download.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
export function coursePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\x00-\x1f]/.test(value) || value.split('/').some(p => p === '..' || p === '.')) throw fail(400, '目录路径无效');
  return value.replace(/\/+$/, '') || '/';
}
function inside(root, target) { return root === '/' || target === root || target.startsWith(root + '/'); }

// Pin DNS on every request and redirect; only explicitly configured internal origins are allowed.
export function createOpenListTransport({ internalOrigins = [] } = {}) {
  return async function request(value, { method = 'GET', headers = {}, body, signal, redirects = 0 } = {}) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail(400, '服务地址无效');
    const internal = internalOrigins.includes(url.origin);
    if (url.protocol !== 'https:' && !internal) throw fail(400, '请使用 HTTPS 服务地址');
    const records = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!records.length || (!internal && records.some(r => !isPublicAddress(r.address)))) throw fail(400, '此服务地址不允许访问');
    const record = records[0];
    const response = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers, signal, lookup: (_host, opts, cb) => opts.all ? cb(null, [record]) : cb(null, record.address, record.family),
      }, resolve);
      req.setTimeout(30000, () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(fail(502, 'OpenList 连接中断或超时')));
      req.end(body);
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.resume();
      // API credentials must never follow a redirect, even within the same origin.
      if (headers.Authorization || redirects >= 4 || !response.headers.location) throw fail(502, 'OpenList 地址发生重定向，请填写最终服务地址');
      return request(new URL(response.headers.location, url), { method, headers, signal, redirects: redirects + 1 });
    }
    return response;
  };
}

export function createOpenListService({ db, directory, internalOrigins = [], transport = createOpenListTransport({ internalOrigins }) }) {
  db.exec(`CREATE TABLE IF NOT EXISTS openlist_connections (user_id INTEGER PRIMARY KEY, base_url TEXT NOT NULL, secret TEXT NOT NULL, root TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const libraryIndex = createDriveIndex(db);
  const driveView = createDriveView(db,id=>{
    try{return JSON.parse(readFileSync(path.join(directory,'drive-layouts',String(id)+'.json'),'utf8'));}
    catch(e){if(e.code==='ENOENT')return {};throw e;}
  });
  let key;
  function encryptionKey() {
    if (key) return key;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'openlist.key');
    try { key = readFileSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      key = readFileSync(file);
    }
    if (key.length !== 32) throw fail(500, '网盘凭证加密配置异常');
    return key;
  }
  function seal(token) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    return Buffer.concat([iv, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  function unseal(value) {
    const b = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', encryptionKey(), b.subarray(0,12));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12,-16)), d.final()]).toString('utf8');
  }
  const row = id => db.prepare('SELECT * FROM openlist_connections WHERE user_id=?').get(id);
  function status(id) { const c = row(id); return c ? { connected:true, baseUrl:c.base_url, root:c.root, hasToken:true } : { connected:false, baseUrl:'', root:'/', hasToken:false }; }
  function saved(id) { const c = row(id); if (!c) throw fail(409, '请先绑定 OpenList'); return { baseUrl:c.base_url, token:unseal(c.secret), root:c.root }; }
  function candidate(id, body) {
    const previous = row(id);
    let url;
    try { url = new URL(body.baseUrl); } catch { throw fail(400, '请填写有效的 OpenList 地址'); }
    if (url.search || url.hash || url.username || url.password) throw fail(400, '服务地址不能包含凭证或查询参数');
    const baseUrl = url.href.replace(/\/+$/, '');
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim()
      : previous?.base_url === baseUrl ? unseal(previous.secret) : '';
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw fail(400, '请填写 OpenList 访问令牌');
    return { baseUrl, token, root:coursePath(body.root || '/') };
  }
  async function api(c, endpoint, payload) {
    const response = await transport(c.baseUrl + endpoint, { method:payload === undefined ? 'GET':'POST', headers:{ Authorization:c.token, 'Content-Type':'application/json' }, body:payload === undefined ? undefined:JSON.stringify(payload) });
    if (response.statusCode !== 200) { response.resume(); throw fail(502, `OpenList 请求失败（HTTP ${response.statusCode}）`); }
    let length = 0; const chunks = [];
    for await (const chunk of response) { length += chunk.length; if (length > 4*1024*1024) { response.destroy(); throw fail(502, 'OpenList 返回内容过大'); } chunks.push(chunk); }
    let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { throw fail(502, '服务未返回 OpenList 数据，请检查地址'); }
    if (result.code !== 200) throw fail(502, [401,403].includes(result.code) ? 'OpenList 授权失效或目录无权限，请更新令牌' : `OpenList 无法读取此目录或文件（${Number(result.code) || '未知状态'}）`);
    return result.data;
  }
  async function list(c, target, page = 1) {
    target = coursePath(target);
    const data = await api(c, '/api/fs/list', { path:target, password:'', page, per_page:100, refresh:false });
    return { path:target, page, total:data.total, items:(data.content || []).filter(i => typeof i.name === 'string' && !/[\/\\\x00-\x1f]/.test(i.name) && !['.','..'].includes(i.name)).map(i => ({ name:i.name, isDir:Boolean(i.is_dir), size:i.size, video:/\.(mp4|webm|m4v|mov|mkv)$/i.test(i.name), path:(target === '/' ? '' : target)+'/'+i.name })) };
  }
  function libraryPath(target) { target=coursePath(target); if (!driveCollection(target)) throw fail(403,'此目录未映射到我的网盘'); return target; }
  const scanner=createDriveScanner(db,{list:(id,target,page)=>list(saved(id),libraryPath(target),page),remember:libraryIndex.remember});
  queueMicrotask(()=>scanner.resume());
  async function quarkStorage(c) {
    const data = await api(c, '/api/admin/storage/list');
    const storage = (data.content || []).find(s => s.driver === 'QuarkTV' && s.mount_path === '/夸克网盘');
    if (!storage) throw fail(409, '请先在 OpenList 中添加名为“夸克网盘”的 QuarkTV 挂载');
    return storage;
  }
  const resourcePresentationCache=new Map();
  function withCovers(id,data,allowedCategories){
    let covers=[];
    try{covers=JSON.parse(readFileSync(path.join(directory,'drive-covers',String(id),'manifest.json'),'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const signature=JSON.stringify(covers);
    const allowed=allowedCategories ? new Set(allowedCategories) : null;
    const scope=allowed ? [...allowed].sort().join(',') : '*';
    const cacheKey=`${id}:${scope}`, cached=resourcePresentationCache.get(cacheKey);
    if(!cached || cached.signature!==signature || Date.now()-cached.at>15000){
      const rows=db.prepare('SELECT path,parent,name,kind,size FROM drive_index WHERE user_id=?').all(id)
        .filter(r=>{const category=driveCollection(r.path)?.id;return category&&(!allowed||allowed.has(category));});
      resourcePresentationCache.set(cacheKey,{signature,at:Date.now(),decorate:createResourcePresentation(rows,covers)});
    }
    return {...data,items:data.items.map(resourcePresentationCache.get(cacheKey).decorate)};
  }

  function quarkView(storage) {
    const match = String(storage.status || '').match(/data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+/);
    return { ready:storage.status === 'work' && !storage.disabled, qr:match && match[0].length < 300000 ? match[0] : null };
  }
  return {
    libraryOwnerId(username) { return Number(db.prepare('SELECT id FROM users WHERE username=?').get(username)?.id || 0); },
    status,
    libraryCover(id,target){
      saved(id);target=libraryPath(target);
      if(!db.prepare('SELECT 1 FROM drive_index WHERE user_id=? AND path=?').get(id,target))throw fail(404,'封面不存在');
      const key=createHash('sha256').update(target).digest('hex').slice(0,16);
      try{return readFileSync(path.join(directory,'drive-covers',String(id),key+'.jpg'));}
      catch(e){if(e.code==='ENOENT')throw fail(404,'封面尚未生成');throw e;}
    },
    libraryShelf(id,target,page,viewerId=id,allowedCategories){saved(id);return withCovers(id,driveView.shelf(id,libraryPath(target),page,allowedCategories),allowedCategories);},
    libraryCourse(id,target,source,viewerId=id,allowedCategories){
      saved(id);
      const data=driveView.course(id,libraryPath(target),source?libraryPath(source):null,viewerId,allowedCategories);
      const [presentation]=withCovers(id,{items:[{path:data.path,name:data.name,kind:'folder',isDir:true,
        viewKind:data.viewKind,preferredPath:data.sourcePath}]},allowedCategories).items;
      return {...data,contentType:presentation.contentType,displayType:presentation.displayType,viewKind:presentation.viewKind};
    },
    materials(id,target,page,chapter){saved(id);return libraryIndex.materials(id,libraryPath(target),page,chapter?libraryPath(chapter):null);},
    reading(id,target,body,viewerId=id){saved(id);target=libraryPath(target);const value=libraryIndex.reading(viewerId,target,body);if(body)libraryIndex.progress(viewerId,target,0,0);return value;},
    scanStatus(id){saved(id);return scanner.status(id);},
    scanStart(id,body){saved(id);return scanner.start(id,body);},
    async libraryCatalog(id,viewerId=id,allowedCategories) {
      saved(id);
      const indexedCollections=readIndexedCollections(db,id);
      const allowed=allowedCategories ? new Set(allowedCategories) : null;
      const available=collection=>!allowed||allowed.has(collection.id);
      const scopedRecent=libraryIndex.recent(id,viewerId).filter(item=>available(driveCollection(item.path)));
      const indexedCount=allowed ? db.prepare('SELECT path FROM drive_index WHERE user_id=?').all(id)
        .filter(row=>allowed.has(driveCollection(row.path)?.id)).length : libraryIndex.search(id,'').indexed;
      if(indexedCollections)return {collections:indexedCollections.filter(available),recent:scopedRecent,indexed:indexedCount};
      const c=saved(id), collections=[];
      for(const collection of DRIVE_COLLECTIONS) {
        try {const data=await list(c,collection.root);libraryIndex.remember(id,data);collections.push({...collection,total:data.total,available:true});}
        catch {collections.push({...collection,total:null,available:false});}
      }
      return {collections:collections.filter(available),recent:scopedRecent,indexed:indexedCount};
    },
    async libraryList(id,target,page) {
      const data=await list(saved(id),libraryPath(target),Math.max(1,Math.min(100000,Number(page)||1)));
      libraryIndex.remember(id,data);return {...data,items:data.items.map(r=>({...r,kind:driveKind(r.name,r.isDir)}))};
    },
    async libraryOutline(id,target,page=1) {
      target=libraryPath(target);const c=saved(id),collapsed=[];
      let data=await list(c,target,Math.max(1,Number(page)||1));libraryIndex.remember(id,data);
      for(let depth=0;depth<6 && data.total===1 && data.items[0]?.isDir;depth++) {
        const child=data.items[0],name=child.name.trim(),parent=data.path.split('/').at(-1).trim();
        if(!/^\d+$/.test(name) && !['课程','课程资料','视频','视频课程','文件','资料','完整版',parent].includes(name))break;
        collapsed.push(child.path);data=await list(c,libraryPath(child.path));libraryIndex.remember(id,data);
      }
      if(data.total<=100) {
        let budget=40;
        const expand=async(item,depth=0)=>{
          if(!item.isDir || !/^\d+$/.test(item.name.trim()) || depth>=4 || budget--<=0)return [item];
          try {
            const nested=await list(c,libraryPath(item.path));libraryIndex.remember(id,nested);
            if(nested.total>100 || !nested.items.length)return [item];
            collapsed.push(item.path);const result=[];
            for(const child of nested.items)result.push(...await expand(child,depth+1));
            return result;
          } catch {return [item];}
        };
        const flattened=[];
        for(let i=0;i<data.items.length;i+=2)for(const rows of await Promise.all(data.items.slice(i,i+2).map(item=>expand(item))))flattened.push(...rows);
        data={...data,items:flattened,total:flattened.length};
      }
      return {...data,collapsed,items:data.items.map(r=>({...r,kind:driveKind(r.name,r.isDir)}))};
    },
    librarySearch(id,q,category,allowedCategories) {saved(id);return withCovers(id,libraryIndex.search(id,q,category,allowedCategories),allowedCategories);},
    libraryProgress(id,body,viewerId=id) {saved(id);return libraryIndex.progress(viewerId,libraryPath(body.path),body.position,body.duration);},
    libraryPosition(id,target,viewerId=id) {saved(id);return libraryIndex.position(viewerId,libraryPath(target));},
    async quark(id, operation) {
      const c = saved(id), storage = await quarkStorage(c);
      let operationError;
      try {
      if (operation === 'connect') {
        const addition = JSON.parse(storage.addition);
        addition.refresh_token = ''; addition.query_token = '';
        await api(c, '/api/admin/storage/update', {...storage, disabled:false, addition:JSON.stringify(addition)});
      } else if (operation === 'confirm') {
        await api(c, '/api/admin/storage/disable?id='+encodeURIComponent(storage.id), {});
        await api(c, '/api/admin/storage/enable?id='+encodeURIComponent(storage.id), {});
      }
      } catch (error) { operationError = error; }
      const view = quarkView(await quarkStorage(c));
      // OpenList reports a pending QR challenge as an initialization error.
      if (operationError && !view.ready && (operation !== 'connect' || !view.qr)) throw operationError;
      return view;
    },
    async browse(id, body) { return list(candidate(id, body), body.path || '/', Math.max(1, Math.min(100000, Number(body.page) || 1))); },
    async save(id, body) {
      const c = candidate(id, body); await list(c, c.root);
      db.prepare('INSERT INTO openlist_connections VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url,secret=excluded.secret,root=excluded.root,updated_at=excluded.updated_at').run(id,c.baseUrl,seal(c.token),c.root,Date.now());
      return status(id);
    },
    disconnect(id) { db.prepare('DELETE FROM openlist_connections WHERE user_id=?').run(id); return status(id); },
    async courses(id, target, page) { const c = saved(id); target = coursePath(target || c.root); if (!inside(c.root,target)) throw fail(403,'只能访问绑定的课程目录'); return list(c,target,Math.max(1,Number(page)||1)); },
    async stream(id, target, req, res, options = {}) {
      const c = saved(id); target = coursePath(target);
      if (options.library) libraryPath(target);
      else if (!inside(c.root,target) || !/\.(mp4|webm|m4v|mov|mkv)$/i.test(target)) throw fail(403,'只能播放课程目录中的视频');
      const range = req.headers.range;
      if (range && !/^bytes=\d*-\d*$/.test(range)) throw fail(416,'不支持此 Range 请求');
      const started = Date.now();
      const info = await api(c,'/api/fs/get',{path:target,password:''});
      if (info.is_dir || !info.raw_url) throw fail(502,'OpenList 未返回视频地址');
      const controller = new AbortController();
      const abort = () => controller.abort(); res.on('close',abort);
      try {
        let source = new URL(info.raw_url,c.baseUrl);
        const endpoint = new URL(c.baseUrl);
        const prefix = endpoint.pathname.replace(/\/+$/, '');
        // A local OpenList may advertise its public reverse-proxy address.
        // Keep its signed proxy path on the configured internal connection.
        if (internalOrigins.includes(endpoint.origin) && ['p','d'].some(kind => source.pathname.startsWith(prefix+'/'+kind+'/'))) {
          source = new URL(source.pathname+source.search, endpoint.origin);
        }
        const upstream = await transport(source, { method:req.method, headers:{ ...(range ? { Range:range } : {}), 'Accept-Encoding':'identity' }, signal:controller.signal });
        console.info('[openlist-playback] response',upstream.statusCode,Date.now()-started);
        if (![200,206,416].includes(upstream.statusCode)) { upstream.resume(); throw fail(502,`视频源拒绝播放（HTTP ${upstream.statusCode}），请检查 OpenList 驱动授权`); }
        const headers = { 'Cache-Control':'private, no-store', 'X-Accel-Buffering':'no', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
        for (const name of ['content-type','content-length','content-range','accept-ranges']) if (upstream.headers[name]) headers[name] = upstream.headers[name];
        if (options.library) {
          const kind=driveKind(target), extension=target.split('.').at(-1).toLowerCase();
          const types={pdf:'application/pdf',text:'text/plain; charset=utf-8'};
          if (types[kind]) headers['content-type']=types[kind];
          if (kind==='image') headers['content-type']=extension==='jpg'?'image/jpeg':'image/'+extension;
          const download=options.download || ['epub','file'].includes(kind);
          headers['Content-Disposition']=(download?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(target.split('/').at(-1)).replace(/'/g,'%27');
          if(download)headers['content-type']='application/octet-stream';
          headers['Content-Security-Policy']="sandbox; default-src 'none'";
        }
        res.writeHead(upstream.statusCode,headers);
        // Backpressure and cancellation bound memory. No video file or disk cache is created.
        await pipeline(upstream,res);
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        throw error;
      } finally { res.off('close',abort); controller.abort(); }
    },
  };
}

export function createOpenListHandler({ service, getUser, access, ownerName='zane', readBody, send }) {
  return async (req,res,pathname) => {
    const query = new URL(req.url,'http://localhost').searchParams;
    const libraryRoute=pathname.startsWith('/api/openlist/library') || pathname==='/api/openlist/file';
    const writing=!['GET','HEAD'].includes(req.method);
    const user=getUser(req,writing);
    const ownerId=service.libraryOwnerId(ownerName);
    const own=access.isAdmin(user);
    const categoryFor=target=>driveCollection(coursePath(target))?.id || '';
    const allowPath=target=>{
      const category=categoryFor(target);
      if(!category || (!own && !access.canDrive(user,category))) throw fail(403,'该网盘分类尚未向此账号开放');
      return category;
    };
    if(libraryRoute && !ownerId) throw fail(503,'共享网盘尚未配置');
    const libraryId=own ? user.id : ownerId;
    let requestBody;
    if(libraryRoute && pathname!=='/api/openlist/library' && pathname!=='/api/openlist/library/search') {
      requestBody=writing ? await readBody(req) : undefined;
      const target=query.get('path') || requestBody?.path || '';
      if(target) allowPath(target);
    }
    if (pathname === '/api/openlist/library/cover' && ['GET','HEAD'].includes(req.method)) {
      const image=service.libraryCover(libraryId,query.get('path'));
      res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':image.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:image);return true;
    }
    const allowedCategories=own ? undefined : access.access(user).driveCategories;
    if (pathname === '/api/openlist/library/shelf' && req.method === 'GET') return send(res,200,service.libraryShelf(libraryId,query.get('path'),query.get('page'),user.id,allowedCategories));
    if (pathname === '/api/openlist/library/course' && req.method === 'GET') { if(query.get('source'))allowPath(query.get('source'));return send(res,200,service.libraryCourse(libraryId,query.get('path'),query.get('source'),user.id,allowedCategories)); }
    if (pathname === '/api/openlist/library/materials' && req.method === 'GET') {if(query.get('chapter'))allowPath(query.get('chapter'));return send(res,200,service.materials(libraryId,query.get('path'),query.get('page'),query.get('chapter')));}
    if (pathname === '/api/openlist/library/reading' && req.method === 'GET') return send(res,200,service.reading(libraryId,query.get('path'),undefined,user.id));
    if (pathname === '/api/openlist/library/reading' && req.method === 'POST') {const body=requestBody||await readBody(req);allowPath(body.path);return send(res,200,service.reading(libraryId,body.path,body,user.id));}
    if (pathname === '/api/openlist/library/scan' && own && req.method === 'GET') return send(res,200,service.scanStatus(user.id));
    if (pathname === '/api/openlist/library/scan' && own && req.method === 'POST') return send(res,200,service.scanStart(user.id,requestBody||await readBody(req)));
    if (pathname === '/api/openlist/library' && req.method === 'GET') return send(res,200,await service.libraryCatalog(libraryId,user.id,allowedCategories));
    if (pathname === '/api/openlist/library/list' && req.method === 'GET') return send(res,200,await service.libraryList(libraryId,query.get('path'),query.get('page')));
    if (pathname === '/api/openlist/library/outline' && req.method === 'GET') return send(res,200,await service.libraryOutline(libraryId,query.get('path'),query.get('page')));
    if (pathname === '/api/openlist/library/search' && req.method === 'GET') {const category=query.get('category');if(category&&!access.canDrive(user,category)&&!own)throw fail(403,'该网盘分类尚未向此账号开放');return send(res,200,service.librarySearch(libraryId,query.get('q'),category,allowedCategories));}
    if (pathname === '/api/openlist/library/progress' && req.method === 'POST') {const body=requestBody||await readBody(req);allowPath(body.path);return send(res,200,service.libraryProgress(libraryId,body,user.id));}
    if (pathname === '/api/openlist/library/progress' && req.method === 'GET') return send(res,200,service.libraryPosition(libraryId,query.get('path'),user.id));
    if (pathname === '/api/openlist/file' && ['GET','HEAD'].includes(req.method)) {await service.stream(libraryId,query.get('path'),req,res,{library:true,download:query.get('download')==='1'});return true;}
    if(libraryRoute) throw fail(404,'接口不存在');
    if (!own) throw fail(403,'此网盘管理操作仅管理员可用');
    if (pathname === '/api/openlist' && req.method === 'GET') return send(res,200,service.status(user.id));
    if (pathname === '/api/openlist' && req.method === 'PUT') return send(res,200,await service.save(user.id,await readBody(req)));
    if (pathname === '/api/openlist' && req.method === 'DELETE') return send(res,200,service.disconnect(user.id));
    if (pathname === '/api/openlist/browse' && req.method === 'POST') return send(res,200,await service.browse(user.id,await readBody(req)));
    if (pathname === '/api/openlist/quark' && req.method === 'GET') return send(res,200,await service.quark(user.id));
    if (['/api/openlist/quark/connect','/api/openlist/quark/confirm'].includes(pathname) && req.method === 'POST') return send(res,200,await service.quark(user.id,pathname.split('/').at(-1)));
    if (pathname === '/api/openlist/courses' && req.method === 'GET') return send(res,200,await service.courses(user.id,query.get('path'),query.get('page')));
    if (pathname === '/api/openlist/video' && ['GET','HEAD'].includes(req.method)) { await service.stream(user.id,query.get('path'),req,res); return true; }
    return send(res,404,{error:'接口不存在'});
  };
}
