// Persist only editable draft fields, never credentials or permission to spend.
const studioDraftMemory = new Map();
function studioDraftKey(userId) { return userId ? `omnihub:studio-draft:v1:${userId}` : null; }

// --- Screenshot-inspired generation controls: styles, roles, templates ----
// Six original styles (photo/studio/street/ecommerce/film/anime), each with
// a bilingual (zh/en) label and a short bilingual description fragment used
// to build the FINAL prompt. These are original wording, not euphemisms for
// bypassing any safety or moderation step.
const STUDIO_STYLES = {
  photo: { zh: '真实人像摄影', en: 'realistic portrait photography', zhDetail: '自然光线、真实质感、清晰五官细节', enDetail: 'natural lighting, authentic texture, crisp facial detail' },
  studio: { zh: '影棚人像', en: 'studio portrait', zhDetail: '柔光箱布光、干净背景、专业人像构图', enDetail: 'softbox lighting, clean backdrop, professional portrait composition' },
  street: { zh: '街拍写真', en: 'street style photography', zhDetail: '城市街道背景、自然抓拍感、现代穿搭', enDetail: 'urban street backdrop, candid street-style framing, contemporary outfit' },
  ecommerce: { zh: '电商产品图', en: 'e-commerce product photography', zhDetail: '干净白底或场景图、商品细节清晰、适合详情页展示', enDetail: 'clean white or lifestyle background, sharp product detail, suited for listing pages' },
  film: { zh: '胶片氛围', en: 'film photography', zhDetail: '35mm 胶片质感、柔和暖色、细微颗粒与自然光', enDetail: '35mm film texture, soft warm tones, subtle grain and natural light' },
  anime: { zh: '二次元插画', en: 'anime illustration', zhDetail: '日系二次元画风、干净线条与色块、保留人物设定', enDetail: 'Japanese-anime illustration style, clean linework and flat shading, preserving character design' },
};
const STUDIO_STYLE_IDS = Object.keys(STUDIO_STYLES);

// Role labels used for bilingual, role-aware prompt lines. The order below
// (face, costume, pose) only controls which description line comes first
// when several roles are present; it never decides which uploaded image
// plays which role, and it never decides the "图N" / "Image N" number used
// in the prompt — that number always comes from the role's actual position
// inside the real reference list (see buildStudioTemplate below).
const STUDIO_ROLE_LABELS = {
  face: { zh: '人物', en: 'subject / face' },
  costume: { zh: '服装', en: 'costume / outfit' },
  pose: { zh: '姿势', en: 'pose' },
};
const STUDIO_ROLE_ORDER = ['face', 'costume', 'pose'];

// Sanitizes an incoming list of {kind, assetId} role hints. Only known
// kinds are kept, each kind keeps its first valid assetId, and any assetId
// reused under a second kind is dropped. Order of the *input* is irrelevant:
// output order always follows STUDIO_ROLE_ORDER so description lines stay
// consistent, and nothing here ever assumes the first supplied image is the
// face — a role is only assigned when explicitly labelled.
function sanitizeStudioReferenceRoles(input) {
  if (!Array.isArray(input)) return [];
  const seenAsset = new Set();
  const byKind = {};
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind;
    if (!Object.hasOwn(STUDIO_ROLE_LABELS, kind)) continue;
    const assetId = typeof item.assetId === 'string' ? item.assetId.slice(0, 160) : '';
    if (!assetId || seenAsset.has(assetId) || byKind[kind]) continue;
    byKind[kind] = assetId; seenAsset.add(assetId);
  }
  return STUDIO_ROLE_ORDER.filter((kind) => byKind[kind]).map((kind) => ({ kind, assetId: byKind[kind] }));
}

// Keeps only role hints whose asset is still part of the actual reference
// list. When a reference image is removed from the attachment list, its
// role hint must not linger and silently keep pointing at a now-missing
// image in the prompt.
function filterStudioRolesByReferenceIds(roles, referenceIds) {
  const ids = new Set(Array.isArray(referenceIds) ? referenceIds : []);
  return (Array.isArray(roles) ? roles : []).filter((role) => role && ids.has(role.assetId));
}

function studioRolePromptLine(role, index, language) {
  const label = STUDIO_ROLE_LABELS[role.kind];
  return language === 'en' ? `Image ${index + 1} is the ${label.en} reference.` : `图${index + 1}是${label.zh}参考。`;
}

// Builds the FINAL prompt text from style + language + optional role list +
// optional supplemental ("extras") requirements. Always asks to preserve
// identity, garment detail and pose faithfully, and explicitly asks to NOT
// draw any mannequin or pose/guide lines — with no safety-bypass wording or
// moderation-neutralizing language anywhere.
//
// The "图N" / "Image N" number for each role always reflects that role's
// actual position inside options.referenceIds — the real, ordered list of
// attachments that will be sent to the server — never the canonical
// face/costume/pose sort order used only to pick which description line
// comes first. When referenceIds is not supplied (e.g. unit tests that only
// care about role wording) the sanitized role order is used as a fallback.
// A role whose asset is no longer present in referenceIds is dropped
// instead of pointing at a stale/incorrect image index.
function buildStudioTemplate(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const styleId = STUDIO_STYLES[opts.style] ? opts.style : 'photo';
  const def = STUDIO_STYLES[styleId];
  const language = opts.language === 'en' ? 'en' : 'zh';
  const referenceIds = Array.isArray(opts.referenceIds) ? opts.referenceIds : null;
  const sanitizedRoles = sanitizeStudioReferenceRoles(opts.roles);
  const roles = referenceIds ? filterStudioRolesByReferenceIds(sanitizedRoles, referenceIds) : sanitizedRoles;
  const extras = typeof opts.extras === 'string' ? opts.extras.trim().slice(0, 2000) : '';
  const indexed = roles
    .map((role) => ({ role, index: referenceIds ? referenceIds.indexOf(role.assetId) : roles.indexOf(role) }))
    .filter((entry) => entry.index >= 0);
  const lines = [];
  if (language === 'en') {
    if (indexed.length) {
      lines.push(`Create using the ${referenceIds?.length || indexed.length} reference image${(referenceIds?.length || indexed.length) > 1 ? 's' : ''} provided, in this order:`);
      indexed.forEach(({ role, index }) => lines.push(studioRolePromptLine(role, index, 'en')));
      lines.push('Combine only the described part from each reference into one consistent subject. Keep the identity, garment details and pose faithful to the references, and do not draw any mannequin, pose skeleton or guide lines.');
    } else {
      lines.push('Create an original image with one consistent subject. Keep identity, garment details and pose natural and faithful, and do not draw any mannequin, pose skeleton or guide lines.');
    }
    lines.push(`Style: ${def.en} — ${def.enDetail}.`);
    if (extras) lines.push(`Additional requirements: ${extras}`);
  } else {
    if (indexed.length) {
      lines.push(`请依据我按顺序提供的 ${referenceIds?.length || indexed.length} 张参考图创作：`);
      indexed.forEach(({ role, index }) => lines.push(studioRolePromptLine(role, index, 'zh')));
      lines.push('把以上参考合成为同一个人物，各图只取所述部分；保留人物身份、服装细节和姿势的真实感，不要画出人体模型、姿势骨架或引导线。');
    } else {
      lines.push('请创作一张风格统一、人物形象一致的原创图像；保留人物身份、服装细节和姿势的自然真实感，不要画出人体模型、姿势骨架或引导线。');
    }
    lines.push(`风格：${def.zh}——${def.zhDetail}。`);
    if (extras) lines.push(`补充要求：${extras}`);
  }
  return lines.join('\n');
}

// A stable signature of "what would generate this prompt"; used both to
// decide whether a saved prompt still matches the current controls (so a
// non-dirty prompt can be quietly refreshed) and to invalidate cost consent
// whenever any of these inputs change. Includes the actual referenceIds
// order (and each kept role's position within it) since that order changes
// the built text even when the same roles/style/language/extras are used.
function studioTemplateSignature(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const referenceIds = Array.isArray(opts.referenceIds) ? opts.referenceIds : [];
  const sanitizedRoles = sanitizeStudioReferenceRoles(opts.roles);
  const roles = referenceIds.length ? filterStudioRolesByReferenceIds(sanitizedRoles, referenceIds) : sanitizedRoles;
  const roleSig = roles.map((role) => `${role.kind}:${role.assetId}:${referenceIds.indexOf(role.assetId)}`);
  return JSON.stringify({
    roles: roleSig, referenceIds,
    style: STUDIO_STYLES[opts.style] ? opts.style : 'photo',
    language: opts.language === 'en' ? 'en' : 'zh',
    extras: typeof opts.extras === 'string' ? opts.extras.trim() : '',
  });
}

// Explicit apply/reset: always overwrites the prompt with the freshly built
// template and clears the dirty flag. The caller (UI) decides when this is
// allowed to run automatically (only while not dirty) versus only on an
// explicit user confirmation once the prompt has been hand-edited.
function applyStudioTemplate(draft, options) {
  const base = draft && typeof draft === 'object' ? draft : {};
  return { ...base, prompt: buildStudioTemplate(options), promptDirty: false, templateSignature: studioTemplateSignature(options) };
}
// Alias kept distinct for readability at call sites ("reset" button).
function resetStudioPromptToTemplate(draft, options) { return applyStudioTemplate(draft, options); }

// Marks the prompt dirty only when the text actually changed from what is
// currently stored, so merely re-saving the same text never trips the
// "edited" guard and silently blocks future non-dirty auto-refreshes.
function markStudioPromptEdited(draft, prompt) {
  const base = draft && typeof draft === 'object' ? draft : {};
  const text = typeof prompt === 'string' ? prompt : '';
  return { ...base, prompt: text, promptDirty: text !== (base.prompt || '') ? true : Boolean(base.promptDirty) };
}
// Whether the style/language/extras controls may rebuild the prompt without
// an explicit confirmation — true only while the user has not hand-edited it.
function shouldAutoApplyStudioTemplate(draft) { return !draft || !draft.promptDirty; }

// Aliases stay bound to asset IDs, independently of filenames and attachment order.
function sanitizeStudioMentions(value) {
  const aliases = new Set(), ids = new Set();
  return (Array.isArray(value) ? value : []).filter(item => {
    if (!item || !/^图片[1-9]\d{0,3}$/.test(item.alias) || typeof item.assetId !== 'string' || !item.assetId || item.assetId.length > 160 || aliases.has(item.alias) || ids.has(item.assetId)) return false;
    aliases.add(item.alias); ids.add(item.assetId); return true;
  }).slice(0, 128).map(({ alias, assetId }) => ({ alias, assetId }));
}
function studioMentionQuery(prompt, start, end = start) {
  if (start !== end) return null;
  const before = prompt.slice(0, start), at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && /[A-Za-z0-9_@]/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  return /[\s@，。！？、；：()[\]{}]/u.test(query) || query.length > 80 ? null : { start: at, end: start, query };
}
function insertStudioMention(prompt, range, assetId, bindings) {
  const mentions = sanitizeStudioMentions(bindings);
  let mention = mentions.find(item => item.assetId === assetId);
  if (!mention) {
    const number = Math.max(0, ...mentions.map(item => Number(item.alias.slice(2)))) + 1;
    if (number > 9999 || mentions.length >= 128) throw new Error('当前草稿引用记录已满，请新建草稿。');
    mention = { alias: `图片${number}`, assetId }; mentions.push(mention);
  }
  const token = `@${mention.alias} `;
  return { prompt: prompt.slice(0, range.start) + token + prompt.slice(range.end), caret: range.start + token.length, mentions };
}
function resolveStudioMentions(prompt, bindings, referenceIds, assets) {
  const mentions = sanitizeStudioMentions(bindings), active = [];
  let error = '';
  const images = referenceIds.map(id => assets.find(asset => asset.id === id)).filter(asset => asset?.kind === 'image');
  const resolved = prompt.replace(/@图片[1-9]\d{0,3}(?!\d)/g, token => {
    const mention = mentions.find(item => '@' + item.alias === token);
    const index = mention ? images.findIndex(asset => asset.id === mention.assetId) : -1;
    if (index < 0) { error = `${token} 的参考图已移除或不可用，请输入 @ 重新选择图片。`; return token; }
    if (!active.some(item => item.assetId === mention.assetId)) active.push(mention);
    return `图片${index + 1}`;
  });
  return { prompt: resolved, mentions: active, error };
}

const STUDIO_VISIBLE_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
function normalizeStudioAspect(value) { return STUDIO_VISIBLE_ASPECTS.includes(value) ? value : STUDIO_VISIBLE_ASPECTS[0]; }
// Count is only selectable (1-4) for the API image route; local generation
// and every video module stay fixed at one, matching unchanged behavior.
function normalizeStudioCount(value, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  if (ctx.module !== 'image' || ctx.generationRoute !== 'api') return 1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

// --- Cost consent: explicit, includes the chosen quantity, and is tied to a
// signature of the current draft so any edit (prompt, style, aspect, count,
// model, mode...) invalidates it rather than silently carrying it forward.
function studioConsentSignature(draft) {
  const base = draft && typeof draft === 'object' ? draft : {};
  return [base.module, base.model, base.mode, base.aspectRatio, base.count, base.prompt, base.style, base.language].join('|');
}
function normalizeStudioConsent(value, signature) {
  if (!value || typeof value !== 'object' || value.signature !== signature) return null;
  const quantity = Number(value.quantity);
  if (!(Number.isInteger(quantity) && quantity >= 1 && quantity <= 4)) return null;
  return { signature, quantity, acceptedAt: typeof value.acceptedAt === 'string' ? value.acceptedAt.slice(0, 40) : '' };
}

// --- Sequential batch submission with stable, retry-safe child keys -------
// Each child request key is derived deterministically from the base
// requestKey and its position, so re-submitting after a timeout/reload
// reuses the exact same key instead of risking a duplicate accepted job.
// Uses a hyphen (never a colon) so the key always matches the server's
// /^[a-zA-Z0-9_-]{8,100}$/ requestKey pattern.
function studioChildRequestKey(baseRequestKey, index) { return `${baseRequestKey}-${index + 1}`; }
function initStudioBatch(baseRequestKey, count) {
  const n = Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1;
  return { baseRequestKey: String(baseRequestKey || ''), count: n, submittedJobIds: [], nextIndex: 0, done: false };
}
// The next key to submit, or null once the batch is complete; stops on the
// first error because the caller simply does not advance nextIndex.
function studioBatchNextKey(batch) {
  if (!batch || batch.done || batch.nextIndex >= batch.count) return null;
  return studioChildRequestKey(batch.baseRequestKey, batch.nextIndex);
}
function recordStudioBatchAccepted(batch, jobId) {
  const base = batch && typeof batch === 'object' ? batch : initStudioBatch('', 1);
  const submittedJobIds = [...base.submittedJobIds, String(jobId || '')];
  const nextIndex = base.nextIndex + 1;
  return { ...base, submittedJobIds, nextIndex, done: nextIndex >= base.count };
}
function studioBatchPartialCount(batch) { return batch && Array.isArray(batch.submittedJobIds) ? batch.submittedJobIds.length : 0; }
function studioBatchComplete(batch) { return Boolean(batch && batch.done && batch.submittedJobIds.length === batch.count); }

function normalizeStudioBatch(value) {
  if (!value || typeof value !== 'object' || !value.baseRequestKey) return null;
  const count = Number.isInteger(Number(value.count)) && Number(value.count) >= 1 && Number(value.count) <= 4 ? Number(value.count) : 1;
  const submittedJobIds = Array.isArray(value.submittedJobIds) ? value.submittedJobIds.filter((id) => typeof id === 'string' && id.length <= 160).slice(0, count) : [];
  // nextIndex is always derived strictly from how many child jobs were
  // actually accepted — the stored/incoming nextIndex is never trusted —
  // so a corrupted or stale persisted value can never cause a remaining
  // job in the batch to be silently skipped.
  const nextIndex = submittedJobIds.length;
  return { baseRequestKey: String(value.baseRequestKey).slice(0, 160), count, submittedJobIds, nextIndex, done: nextIndex >= count };
}

function normalizeStudioDraft(value = {}, allowExternal = true) {
  const modules = {image:['image'], seedance:['text_video','first_last_frame','reference_images'], hh1:['text'], wan3:['text_video','first_last_frame','reference_images']};
  const models = {image:['nano-banana-pro','gpt-image-2','seedream-5.0-pro','gpt-image-2-flare'], seedance:['seedance2.0','seedance2.0-mini','seedance2.5'], hh1:['hh1'], wan3:['wan3.0-video','wan3.0-video-prime']};
  const text = (key, max = 160) => typeof value[key] === 'string' ? value[key].slice(0,max) : '';
  const module = allowExternal && modules[value.module] ? value.module : 'image';
  const source = value.source && typeof value.source === 'object' ? Object.fromEntries(
    ['sourceType','sourceId','title','url','parentAssetId','image','media'].filter(key => value.source[key] != null).map(key => [key,value.source[key]])) : null;
  const generationRoute = allowExternal && (value.generationRoute === 'api' || module !== 'image') ? 'api' : 'local';
  return {
    version:1, consumedKey:text('consumedKey'), module,
    generationRoute,
    model:models[module].includes(value.model) ? value.model : models[module][0],
    mode:modules[module].includes(value.mode) ? value.mode : modules[module][0],
    title:text('title'), prompt:text('prompt',100000), promptMentions:sanitizeStudioMentions(value.promptMentions), deviceId:text('deviceId'),
    aspectRatio:['auto','adaptive','1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'].includes(value.aspectRatio) ? value.aspectRatio : module === 'image' ? 'auto' : 'adaptive',
    size:['1k','2k','4k'].includes(value.size) ? value.size : '1k',
    duration:Number.isFinite(Number(value.duration)) && Number(value.duration) >= 2 && Number(value.duration) <= 30 ? Number(value.duration) : 5,
    resolution:['480p','720p','1080p'].includes(value.resolution) ? value.resolution : '720p',
    faceProcessing:[0,1,2,3].includes(Number(value.faceProcessing)) ? Number(value.faceProcessing) : 0,
    referenceIds:Array.isArray(value.referenceIds) ? [...new Set(value.referenceIds.filter(id => typeof id === 'string' && id.length <= 160))].slice(0,32) : [],
    // Screenshot-inspired controls. referenceRoles is the ordered
    // face/costume/pose -> assetId mapping handed from the reference
    // library via app.jsx's openStudio, kept distinct from referenceIds so
    // the template builder can stay role-aware without guessing order.
    referenceRoles: sanitizeStudioReferenceRoles(value.referenceRoles),
    style: STUDIO_STYLE_IDS.includes(value.style) ? value.style : 'photo',
    language: value.language === 'en' ? 'en' : 'zh',
    extras: text('extras', 2000),
    promptDirty: Boolean(value.promptDirty),
    templateSignature: text('templateSignature', 4000),
    count: normalizeStudioCount(value.count, { module, generationRoute }),
    batch: normalizeStudioBatch(value.batch),
    source, requestKey:text('requestKey'), submittedJobId:text('submittedJobId'),
  };
}
function readStudioDraft(userId, storage) {
  const key = studioDraftKey(userId);
  if (!key) return null;
  if (studioDraftMemory.has(key)) return studioDraftMemory.get(key);
  try {
    const saved = JSON.parse((storage || globalThis.localStorage).getItem(key));
    return saved?.version === 1 ? normalizeStudioDraft(saved) : null;
  } catch { return null; }
}
function writeStudioDraft(userId, draft, storage) {
  const key = studioDraftKey(userId);
  if (!key) return false;
  const value = normalizeStudioDraft(draft);
  studioDraftMemory.set(key,value);
  try { (storage || globalThis.localStorage).setItem(key,JSON.stringify(value)); return true; } catch { return false; }
}
function studioDraftHasContent(draft) {
  return Boolean(draft && (draft.prompt?.trim() || draft.title?.trim() || draft.referenceIds?.length));
}
// A reference combination arrives as an ordered list (face, costume, pose);
// the order is kept so the prompt's 图1/图2/图3 match the attached images.
function studioIncomingReferenceIds(incoming) {
  if (Array.isArray(incoming.referenceAssetIds) && incoming.referenceAssetIds.length) return incoming.referenceAssetIds;
  return incoming.referenceAssetId ? [incoming.referenceAssetId] : [];
}
// References metadata already available from reference-library's onCreate
// (kind/id/title/assetId/originalReady, in face/costume/pose order) is
// turned into the role hints the template builder needs. Only entries with
// both a known kind and an assetId are kept; nothing here assumes order.
function studioIncomingReferenceRoles(incoming) {
  if (!Array.isArray(incoming.references)) return [];
  return incoming.references.map((item) => ({ kind: item?.kind, assetId: item?.assetId }));
}
function resolveStudioDraft(saved, incoming, allowExternal = true) {
  if (!incoming?.key || incoming.key === saved?.consumedKey) return normalizeStudioDraft(saved || {},allowExternal);
  const args=incoming.generationArgs&&typeof incoming.generationArgs==='object'&&!Array.isArray(incoming.generationArgs)?incoming.generationArgs:{};
  const referenceIds=studioIncomingReferenceIds(incoming);
  return normalizeStudioDraft({consumedKey:incoming.key, module:incoming.targetModule || 'image', mode:incoming.targetMode,
    generationRoute:referenceIds.length || incoming.targetModule && incoming.targetModule !== 'image' ? 'api' : 'local',
    model:incoming.model, title:incoming.title || '', prompt:incoming.prompt || '', source:incoming.sourceType || incoming.parentAssetId ? incoming : null,
    aspectRatio:args.aspectRatio, size:args.size, duration:args.duration, resolution:args.resolution, faceProcessing:args.faceProcessing,
    referenceIds, referenceRoles: studioIncomingReferenceRoles(incoming)}, allowExternal);
}
