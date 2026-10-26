// Persist only editable draft fields, never credentials or permission to spend.
const studioDraftMemory = new Map();
function studioDraftKey(userId) { return userId ? `omnihub:studio-draft:v1:${userId}` : null; }
function normalizeStudioDraft(value = {}, allowExternal = true) {
  const modules = {image:['image'], seedance:['text_video','first_last_frame','reference_images'], hh1:['text'], wan3:['text_video','first_last_frame','reference_images']};
  const models = {image:['nano-banana-pro','gpt-image-2','seedream-5.0-pro','gpt-image-2-flare'], seedance:['seedance2.0','seedance2.0-mini','seedance2.5'], hh1:['hh1'], wan3:['wan3.0-video','wan3.0-video-prime']};
  const text = (key, max = 160) => typeof value[key] === 'string' ? value[key].slice(0,max) : '';
  const module = allowExternal && modules[value.module] ? value.module : 'image';
  const source = value.source && typeof value.source === 'object' ? Object.fromEntries(
    ['sourceType','sourceId','title','url','parentAssetId','image','media'].filter(key => value.source[key] != null).map(key => [key,value.source[key]])) : null;
  return {
    version:1, consumedKey:text('consumedKey'), module,
    generationRoute:allowExternal && (value.generationRoute === 'api' || module !== 'image') ? 'api' : 'local',
    model:models[module].includes(value.model) ? value.model : models[module][0],
    mode:modules[module].includes(value.mode) ? value.mode : modules[module][0],
    title:text('title'), prompt:text('prompt',100000), deviceId:text('deviceId'),
    aspectRatio:['auto','adaptive','1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'].includes(value.aspectRatio) ? value.aspectRatio : module === 'image' ? 'auto' : 'adaptive',
    size:['1k','2k','4k'].includes(value.size) ? value.size : '1k',
    duration:Number.isFinite(Number(value.duration)) && Number(value.duration) >= 2 && Number(value.duration) <= 30 ? Number(value.duration) : 5,
    resolution:['480p','720p','1080p'].includes(value.resolution) ? value.resolution : '720p',
    faceProcessing:[0,1,2,3].includes(Number(value.faceProcessing)) ? Number(value.faceProcessing) : 0,
    referenceIds:Array.isArray(value.referenceIds) ? [...new Set(value.referenceIds.filter(id => typeof id === 'string' && id.length <= 160))].slice(0,32) : [],
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
function resolveStudioDraft(saved, incoming, allowExternal = true) {
  if (!incoming?.key || incoming.key === saved?.consumedKey) return normalizeStudioDraft(saved || {},allowExternal);
  return normalizeStudioDraft({consumedKey:incoming.key, module:incoming.targetModule || 'image', mode:incoming.targetMode,
    generationRoute:incoming.referenceAssetId || incoming.targetModule && incoming.targetModule !== 'image' ? 'api' : 'local',
    title:incoming.title || '', prompt:incoming.prompt || '', source:incoming.sourceType || incoming.parentAssetId ? incoming : null,
    referenceIds:incoming.referenceAssetId ? [incoming.referenceAssetId] : []}, allowExternal);
}
