import { DRIVE_COLLECTIONS } from './openlist-library.js';

export const ACCESS_ADMIN = 'zane';
export const ACCESS_TOOL_CATALOG = Object.freeze([
  { id:'media', label:'媒体工具', description:'下载解析、视频处理、音频处理、图片处理、文字与字幕、作者与收藏、内容发现、素材库' },
  { id:'camera', label:'运镜与镜头配方', description:'运镜参考、镜头提示词与短片配方' },
  { id:'omniget', label:'OmniGet 下载', description:'作品解析、下载队列与个人站点登录凭据' },
  { id:'markdown', label:'Markdown 排版' },
  { id:'ai-art', label:'AI 作图与参考库' },
  { id:'pdf', label:'PDF 压缩' },
]);
export const ACCESS_DRIVE_CATALOG = Object.freeze(DRIVE_COLLECTIONS.map(({id,label})=>({id,label})));
const driveIds = new Set(ACCESS_DRIVE_CATALOG.map(item=>item.id));
const toolIds = new Set(ACCESS_TOOL_CATALOG.map(item=>item.id));
// Keep the established non-admin toolbox available until an administrator
// explicitly saves a per-user override. Drive content remains opt-in.
const DEFAULT_ACCESS = Object.freeze({ driveCategories: [], tools: ['media', 'markdown', 'camera', 'omniget'] });

function normalize(values, allowed) {
  return [...new Set(Array.isArray(values) ? values : [])].filter(value=>typeof value==='string' && allowed.has(value)).sort();
}
export function cleanAccess(value) {
  return { driveCategories:normalize(value?.driveCategories,driveIds), tools:normalize(value?.tools,toolIds) };
}
export function createUserAccessStore(db, { adminName=ACCESS_ADMIN }={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_access (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    permissions TEXT NOT NULL DEFAULT '{"driveCategories":[],"tools":[]}',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  const admin = user=>String(user?.username||'')===adminName;
  const record = user=>{
    if (admin(user)) return {driveCategories:ACCESS_DRIVE_CATALOG.map(item=>item.id),tools:ACCESS_TOOL_CATALOG.map(item=>item.id)};
    const row=db.prepare('SELECT permissions,revision FROM user_access WHERE user_id=?').get(user?.id);
    if (!row) return { ...DEFAULT_ACCESS, tools: [...DEFAULT_ACCESS.tools] };
    let parsed={};try{parsed=JSON.parse(row.permissions||'{}');}catch{}
    // Before version 2, media also granted the two standalone tools.
    // Expand only legacy records; an explicit new save can revoke each tool.
    if (parsed?.version !== 2 && Array.isArray(parsed?.tools) && parsed.tools.includes('media')) {
      parsed = {...parsed, tools:[...parsed.tools, 'camera', 'omniget']};
    }
    return cleanAccess(parsed);
  };
  const revision = user=>admin(user) ? 0 : Number(db.prepare('SELECT revision FROM user_access WHERE user_id=?').get(user?.id)?.revision||0);
  const publicUser = user=>({id:user.id,username:user.username,createdAt:user.created_at||'',isAdmin:admin(user),revision:revision(user),permissions:record(user)});
  return {
    isAdmin:admin,
    access:user=>record(user),
    revision,
    canDrive(user, category) { return Boolean(user) && (admin(user)||record(user).driveCategories.includes(category)); },
    canTool(user, tool) { return Boolean(user) && (admin(user)||record(user).tools.includes(tool)); },
    publicUser,
    list() { return db.prepare('SELECT id,username,created_at FROM users ORDER BY id').all().map(publicUser); },
    update(userId, incoming, expectedRevision) {
      const user=db.prepare('SELECT id,username,created_at FROM users WHERE id=?').get(userId);
      if(!user) throw Object.assign(new Error('账号不存在'),{status:404});
      if(admin(user)) throw Object.assign(new Error('管理员权限不可在此修改'),{status:400});
      if(!incoming || typeof incoming !== 'object' || Array.isArray(incoming)
        || !Array.isArray(incoming.driveCategories) || !Array.isArray(incoming.tools)) throw Object.assign(new Error('权限数据格式不正确'),{status:400});
      if(!Number.isInteger(expectedRevision)||expectedRevision<0) throw Object.assign(new Error('权限版本不正确'),{status:409});
      const permissions=cleanAccess(incoming);
      const updated=db.prepare('UPDATE user_access SET permissions=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?')
        .run(JSON.stringify({...permissions, version:2}),Date.now(),user.id,expectedRevision).changes;
      if(updated!==1) {
        if(expectedRevision!==0 || db.prepare('INSERT INTO user_access(user_id,permissions,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO NOTHING')
          .run(user.id,JSON.stringify({...permissions, version:2}),Date.now()).changes!==1) throw Object.assign(new Error('权限已被其他管理员修改，请刷新后重试'),{status:409});
      }
      return publicUser(user);
    },
  };
}
