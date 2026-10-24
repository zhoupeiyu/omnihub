import { CLASSIFICATION_VERSION, SUBTOPICS, REPOSITORY_FORMS } from '../public/repository-taxonomy.js';

export const PROMPT_CATEGORIES = ['图像生成', '视频生成', 'Agent 系统', '编程', '自动化', '研究', '社媒内容', '其他'];
const parse = (text, fallback = {}) => { try { return JSON.parse(text); } catch { return fallback; } };
const fail = (status, message) => { throw { status, message }; };

// An overlay keeps editorial decisions separate from immutable source text and automatic imports.
export function createLibraryCuration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_curation (
      user_id INTEGER NOT NULL REFERENCES users(id),
      asset_type TEXT NOT NULL CHECK(asset_type IN ('source','repository')),
      asset_key TEXT NOT NULL,
      data TEXT NOT NULL,
      revision INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('manual','reviewed')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, asset_type, asset_key)
    );
    CREATE TABLE IF NOT EXISTS library_curation_history (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      asset_type TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL,
      origin TEXT NOT NULL,
      before_data TEXT,
      after_data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  function owner(userId) {
    if (!Number.isSafeInteger(userId) || !db.prepare('SELECT id FROM users WHERE id=?').get(userId)) fail(403, '请先登录');
  }
  function source(userId, key) {
    if (!/^[1-9]\d*$/.test(String(key)) || !Number.isSafeInteger(Number(key))) fail(400, '来源编号无效');
    return db.prepare("SELECT * FROM inbox WHERE user_id=? AND id=?").get(userId, Number(key));
  }
  function asset(userId, type, key) {
    const row = type === 'source' ? source(userId, key) : type === 'repository'
      ? db.prepare('SELECT * FROM repository_assets WHERE user_id=? AND repo_key=?').get(userId, key) : null;
    if (!row) fail(404, '内容不存在');
    return row;
  }
  function record(userId, type, key) {
    const row = db.prepare('SELECT * FROM library_curation WHERE user_id=? AND asset_type=? AND asset_key=?').get(userId, type, String(key));
    return row && { data:parse(row.data), revision:row.revision, origin:row.origin, updatedAt:row.updated_at };
  }
  function read(userId, type, key) {
    owner(userId);
    const row = asset(userId, type, key);
    const saved = record(userId, type, key);
    if (type === 'repository') return { title:`${row.owner}/${row.name}`, revision:saved?.revision || 0,
      data:saved?.data || { uses:parse(row.metadata).classification?.uses || [], forms:parse(row.metadata).classification?.forms || [] } };
    const prompt = db.prepare('SELECT * FROM prompts WHERE user_id=? AND source_inbox_id=? ORDER BY id DESC LIMIT 1').get(userId, row.id);
    return { title:row.title, sourceText:row.content, quotedText:parse(row.metrics).quotedTweet?.full_text || '',
      revision:saved?.revision || 0, data:saved?.data || { type:prompt ? 'prompt' : 'source', title:row.title,
        summary:'', body:'', promptText:prompt?.text || '', promptCategory:PROMPT_CATEGORIES.includes(prompt?.category) ? prompt.category : '其他',
        tags:String(prompt?.tags || '').split(',').filter(Boolean), relatedSourceIds:[] } };
  }
  function validate(userId, type, key, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '归类内容无效');
    const array = (value, allowed, max) => {
      if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !allowed(x))) fail(400, '标签无效');
      return [...new Set(value)];
    };
    if (type === 'repository') {
      if (Object.keys(data).some(k => !['uses','forms'].includes(k))) fail(400, '不支持的归类字段');
      const uses = array(data.uses, x => SUBTOPICS.has(x), 12);
      const forms = array(data.forms, x => Object.hasOwn(REPOSITORY_FORMS,x), 6);
      if (!uses.length || !forms.length) fail(400, '请至少选择一个用途和一种形态');
      return { uses, forms };
    }
    const fields = ['type','title','summary','body','promptText','promptCategory','tags','relatedSourceIds'];
    if (Object.keys(data).some(k => !fields.includes(k))) fail(400, '不支持的归类字段');
    if (!['prompt','method','source'].includes(data.type)) fail(400, '请选择提示词、方法技巧或仅保留来源');
    const string = (name, max) => {
      if (typeof data[name] !== 'string' || data[name].length > max) fail(400, `${name} 内容无效或过长`);
      return data[name].trim();
    };
    const clean = { type:data.type, title:string('title',240), summary:string('summary',1000), body:string('body',30000),
      promptText:string('promptText',40000), promptCategory:string('promptCategory',30),
      tags:array(data.tags, x => x.length > 0 && x.length <= 40, 16), relatedSourceIds:[] };
    if (!clean.title) fail(400, '请填写标题');
    if (!PROMPT_CATEGORIES.includes(clean.promptCategory)) fail(400, '提示词用途无效');
    if (clean.type === 'method' && (!clean.body || !clean.summary)) fail(400, '方法技巧需要摘要和整理正文');
    if (clean.type === 'prompt' && !clean.promptText) fail(400, '请填写可复制的提示词');
    if (clean.type === 'prompt' && clean.promptCategory === 'Agent 系统') fail(400, '长期行为规则请选择方法技巧；具体任务请选择相应用途');
    if (!Array.isArray(data.relatedSourceIds) || data.relatedSourceIds.length > 20) fail(400, '关联来源无效');
    clean.relatedSourceIds = [...new Set(data.relatedSourceIds)].filter(id => String(id) !== String(key));
    for (const id of clean.relatedSourceIds) {
      if (!Number.isSafeInteger(id) || id < 1 || !source(userId, id)) fail(404, '关联来源不存在');
    }
    if (clean.type === 'source') { clean.promptText = ''; clean.body = ''; clean.summary = ''; }
    return clean;
  }
  function write(userId, type, key, revision, data, origin = 'manual') {
    owner(userId);
    if (!Number.isSafeInteger(revision) || revision < 0 || !['manual','reviewed'].includes(origin)) fail(400, '归类版本无效');
    asset(userId, type, key);
    const clean = validate(userId, type, key, data);
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = record(userId, type, key);
      if (origin !== 'manual' && previous?.origin === 'manual') fail(409, '已手动归类，不允许自动覆盖');
      if ((previous?.revision || 0) !== revision) fail(409, '归类已被修改，请重新打开后再保存');
      const before = previous?.data || read(userId,type,key).data;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO library_curation VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,asset_type,asset_key)
        DO UPDATE SET data=excluded.data,revision=excluded.revision,origin=excluded.origin,updated_at=excluded.updated_at`)
        .run(userId,type,String(key),JSON.stringify(clean),revision+1,origin,now);
      db.prepare(`INSERT INTO library_curation_history(user_id,asset_type,asset_key,actor_id,revision,origin,before_data,after_data,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(userId,type,String(key),userId,revision+1,origin,
          JSON.stringify(before),JSON.stringify(clean),now);
      db.exec('COMMIT');
      return { revision:revision+1, data:clean };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function sources(userId, data, primaryId, publicOnly) {
    const rows = [primaryId, ...data.relatedSourceIds].map(id => source(userId,id));
    // A derived article cannot remain public if any of its evidence becomes private.
    if (rows.some(row => !row || (publicOnly && (row.visibility !== 'public' || row.status !== 'pending')))) return null;
    return rows;
  }
  function entries(userId) {
    return db.prepare("SELECT * FROM library_curation WHERE user_id=? AND asset_type='source' ORDER BY updated_at DESC,asset_key").all(userId)
      .map(row => ({...row, data:parse(row.data)}));
  }
  function methods(userId, { publicOnly = false } = {}) {
    return entries(userId).filter(row => row.data.type === 'method').flatMap(row => {
      const evidence = sources(userId,row.data,Number(row.asset_key),publicOnly);
      if (!evidence) return [];
      return [{ id:`method-${row.asset_key}`, type:'method', sourceInboxId:Number(row.asset_key), title:row.data.title,
        summary:row.data.summary, body:row.data.body, tags:row.data.tags, status:'ready', verificationStatus:'source_organized',
        version:row.revision, sourceCount:evidence.length, claimCount:0, updatedAt:row.updated_at,
        hasPrompt:Boolean(row.data.promptText) && row.data.promptCategory !== 'Agent 系统', promptText:row.data.promptText, claims:[], repositories:[],
        sources:evidence.map(s => ({id:s.id,externalId:s.external_id,title:s.title,url:s.url,author:s.author,
          excerpt:s.content.slice(0,420),citationKey:`S:${s.external_id}`})) }];
    });
  }
  function prompts(userId, rows, { publicOnly = false } = {}) {
    const overrides = entries(userId);
    const methodFor = new Map();
    for (const row of overrides.filter(r => r.data.type === 'method')) {
      if (!sources(userId,row.data,Number(row.asset_key),publicOnly)) continue;
      for (const id of [Number(row.asset_key),...row.data.relatedSourceIds]) methodFor.set(id,`method-${row.asset_key}`);
    }
    const replaced = new Set(overrides.map(r => Number(r.asset_key)));
    // Unreviewed system rules remain in their original sources, not in the task-prompt library.
    const result = rows.filter(row => !replaced.has(row.sourceInboxId) && row.category !== 'Agent 系统' && row.kind !== 'agent_system');
    for (const row of overrides) {
      if (!row.data.promptText || row.data.type === 'source' || row.data.promptCategory === 'Agent 系统') continue;
      const evidence = sources(userId,row.data,Number(row.asset_key),publicOnly);
      if (!evidence) continue;
      const original = rows.find(p => p.sourceInboxId === Number(row.asset_key));
      const s = evidence[0];
      result.push({ ...original, id:original?.id || `source-${s.id}`, sourceInboxId:s.id,
        title:row.data.title, summary:row.data.summary, text:row.data.promptText, category:row.data.promptCategory,
        tags:row.data.tags, kind:({图像生成:'image_generation',视频生成:'video_generation',编程:'coding',自动化:'automation',研究:'research',社媒内容:'social_content'})[row.data.promptCategory] || 'other',
        facets:original?.facets || {}, sourceUrl:s.url, sourceAuthor:s.author,
        media:original?.media || parse(s.media,[]), updatedAt:row.updated_at, curated:true,
        methodId:methodFor.get(s.id) || null });
    }
    return result;
  }
  function repository(userId, row) {
    if (!row) return row;
    const saved = record(userId,'repository',row.key);
    return saved ? { ...row, metadata:{...row.metadata, classification:{...row.metadata?.classification,
      ...saved.data, version:CLASSIFICATION_VERSION, method:'manual', revision:saved.revision}} } : row;
  }
  return { read, write, methods, prompts, repository, record };
}
