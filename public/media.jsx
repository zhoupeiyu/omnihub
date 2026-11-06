const { useState: useMediaState, useEffect: useMediaEffect, useRef: useMediaRef } = React;

const MEDIA_MODEL_OPTIONS = {
  image: ["nano-banana-pro", "gpt-image-2", "seedream-5.0-pro", "gpt-image-2-flare"],
  seedance: ["seedance2.0", "seedance2.0-mini", "seedance2.5"],
  hh1: ["hh1"],
  wan3: ["wan3.0-video", "wan3.0-video-prime"],
};
const MEDIA_MODES = {
  image: [{ id: "image", label: "生成图片" }],
  seedance: [
    { id: "text_video", label: "文生视频" },
    { id: "first_last_frame", label: "首帧／首尾帧" },
    { id: "reference_images", label: "多素材参考" },
  ],
  // The configured Happy Horse endpoint only accepts text-to-video today.
  // Do not offer modes which look selectable but cannot be submitted.
  hh1: [{ id: "text", label: "文生视频" }],
  wan3: [
    { id: "text_video", label: "文生视频" },
    { id: "first_last_frame", label: "首帧／首尾帧" },
    { id: "reference_images", label: "多素材参考" },
  ],
};
// UI limits mirror normalizeGeneration; interface tests check the boundary values.
function mediaStudioCapabilities(module, model, mode) {
  if (module === 'image') return { kinds: ['image'], maxRefs: model === 'seedream-5.0-pro' ? 10 : model === 'gpt-image-2-flare' ? 16 : 8 };
  const durationMin = module === 'hh1' ? 3 : module === 'seedance' ? 4 : 2;
  const durationMax = module === 'hh1' ? 15 : module === 'seedance' && model !== 'seedance2.5' ? 15 : 30;
  const duration = { durationMin, durationMax };
  if (module === 'hh1' || mode === 'text_video') return { ...duration, kinds: [], maxRefs: 0 };
  if (mode === 'first_last_frame') return { ...duration, kinds: ['image'], minRefs: 1, maxRefs: 2 };
  return { ...duration, kinds: ['image', 'video', 'audio'], maxRefs: module === 'seedance' && model !== 'seedance2.5' ? 15 : 32,
    maxByKind: module === 'wan3' ? { image: 10, video: 5, audio: 5 } : model === 'seedance2.5' ? { image: 30, video: 10, audio: 10 } : { image: 9, video: 3, audio: 3 } };
}
function mediaStudioReferenceIssue(refs, capabilities) {
  if (refs.length < (capabilities.minRefs || 0)) return '请先添加至少一张首帧图片。';
  if (!capabilities.maxRefs && refs.length) return '当前文生视频模式不接受参考素材，请移除素材或切换创作模式。';
  if (refs.some(asset => !capabilities.kinds.includes(asset.kind))) return '当前模式不支持所选素材类型，请移除不兼容的素材。';
  if (refs.length > capabilities.maxRefs) return `当前模式最多使用 ${capabilities.maxRefs} 个参考素材。`;
  for (const [kind, limit] of Object.entries(capabilities.maxByKind || {})) {
    if (refs.filter(asset => asset.kind === kind).length > limit) return `${{ image: '图片', video: '视频', audio: '音频' }[kind]}参考最多 ${limit} 个。`;
  }
  return '';
}
const MEDIA_STATUS = {
  local_queued: "等待本机接单", local_claimed: "本机准备中", cancelled: "已取消",
  submitting: "提交中", init: "已创建", queued: "排队中", generating: "生成中",
  result_pending: "保存作品中", success: "已完成", failed: "失败",
  needs_review: "提交结果待核查",
};
const MEDIA_ACTIVE_STATUSES = new Set(["init", "queued", "generating", "result_pending"]);
const MEDIA_SOURCE_LABELS = { prompt: "提示词", inbox: "X 收藏" };

function formatMediaNextPollAt(value) {
  if (value == null || value === "") return "";
  const numeric = typeof value === "number" ? value : Number(value);
  const date = new Date(Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatMediaCreatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function mediaFileUrl(asset, download = false) {
  return `/api/media/assets/${asset.id}/${download ? "download" : "file"}`;
}

// Keep complete rows aligned without cropping media or stretching the last row.
function MediaJustifiedGallery({ children }) {
  const root = React.useRef(null);
  React.useLayoutEffect(() => {
    const node = root.current;
    let frame;
    const layout = () => {
      const width = node.clientWidth;
      if (!width) return;
      const gap = 16, target = width < 600 ? 180 : 240;
      let row = [], sum = 0;
      const place = (complete) => {
        const height = Math.min(complete ? Infinity : target, (width - gap * (row.length - 1)) / sum);
        row.forEach(({ card, ratio }) => {
          card.style.width = `${ratio * height}px`;
          card.querySelector('.media-card-preview').style.height = `${height}px`;
        });
        row = []; sum = 0;
      };
      for (const card of node.children) {
        const media = card.querySelector('img,video');
        const w = media?.naturalWidth || media?.videoWidth;
        const h = media?.naturalHeight || media?.videoHeight;
        const ratio = w && h ? w / h : media?.tagName === 'VIDEO' ? 16 / 9 : 1;
        row.push({ card, ratio }); sum += ratio;
        if (sum * target + gap * (row.length - 1) >= width) place(true);
      }
      if (row.length) place(false);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    node.addEventListener('load', schedule, true);
    node.addEventListener('loadedmetadata', schedule, true);
    layout();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      node.removeEventListener('load', schedule, true);
      node.removeEventListener('loadedmetadata', schedule, true);
    };
  }, [children]);
  return <div className="media-gallery media-gallery-justified" ref={root}>{children}</div>;
}

// media-workflow:start — pure helpers over existing assets and jobs; no invented versions.
// The newest job that the server reports as success and whose asset is present.
function mediaLatestSuccess(jobs, assets) {
  const byId = new Map((assets || []).map((asset) => [asset.id, asset]));
  const done = (jobs || []).filter((job) => job.status === "success" && job.assetId && byId.has(job.assetId));
  if (!done.length) return null;
  const stamp = (job) => String(job.updatedAt || job.createdAt || "");
  return byId.get(done.reduce((best, job) => stamp(job) > stamp(best) ? job : best).assetId);
}

// Compare keeps at most two picks; a third pick replaces the oldest one.
function mediaToggleCompare(ids, id) {
  if (ids.includes(id)) return ids.filter((value) => value !== id);
  return [...ids, id].slice(-2);
}

function mediaComparePair(ids, assets) {
  const pair = (ids || []).map((id) => (assets || []).find((asset) => asset.id === id)).filter(Boolean);
  return pair.length === 2 ? pair : [];
}

// Oldest ancestor first, ending at the asset itself, following parentAssetId only.
function mediaLineageChain(assetId, assets) {
  const byId = new Map((assets || []).map((asset) => [asset.id, asset]));
  const chain = [];
  const seen = new Set();
  let current = byId.get(assetId);
  while (current && !seen.has(current.id) && chain.length < 50) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentAssetId ? byId.get(current.parentAssetId) : null;
  }
  return chain;
}

function mediaChildren(assetId, assets) {
  return (assets || []).filter((asset) => asset.parentAssetId === assetId);
}

function mediaVersionLabel(asset, assets) {
  if (!asset?.jobId || !asset?.parentAssetId) return "";
  const chain = mediaLineageChain(asset.id, assets);
  return chain.length > 1 && chain[0].id !== asset.id ? `第 ${chain.length} 版` : "";
}

function mediaSafeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
}

// Build a continuation draft from server-stored work only. The browser never
// guesses parameters that the job did not record, and a new parent is attached
// only when the user explicitly continues an image result.
function mediaContinueDraft(asset, job, current = {}, allowExternal = true) {
  const knownModules = MEDIA_MODEL_OPTIONS;
  const stored = job && knownModules[job.module] ? job : null;
  const module = stored?.module === "image" ? "image" : null;
  const model = module && knownModules.image.includes(stored.model) ? stored.model : current.model;
  const args = stored?.args && typeof stored.args === "object" ? stored.args : {};
  const validRatio = ["auto", "adaptive", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
  const aspectRatio = validRatio.includes(args.aspectRatio) ? args.aspectRatio : null;
  let size = ["1k", "2k", "4k"].includes(args.size) ? args.size : null;
  let normalizedRatio = aspectRatio;
  if (model === "seedream-5.0-pro") {
    if (normalizedRatio === "auto") normalizedRatio = "1:1";
    if (size === "4k") size = "2k";
  }
  const sameSource = current.source && asset?.sourceType === current.source.sourceType && String(asset.sourceId || "") === String(current.source.sourceId || "");
  const source = sameSource ? { ...current.source } : asset?.sourceType ? {
    sourceType: asset.sourceType, sourceId: asset.sourceId, url: mediaSafeSourceUrl(asset.sourceUrl), title: asset.title || "",
  } : current.source ? { ...current.source } : null;
  if (source) source.parentAssetId = allowExternal && asset?.kind === "image" ? asset.id : "";
  return {
    module, model, mode: module === "image" ? "image" : null,
    generationRoute: allowExternal && asset?.kind === "image" ? "api" : current.generationRoute,
    aspectRatio: normalizedRatio, size,
    referenceId: allowExternal && asset?.kind === "image" ? asset.id : null,
    prompt: asset?.prompt || stored?.prompt || current.prompt || "", source,
  };
}

// Shows the request exactly as stored on the job; nothing is inferred for uploads.
function mediaJobParams(job) {
  if (!job) return [];
  const rows = [["生成类型", job.module], ["模型", job.model], ["创作模式", job.mode]];
  const args = job.args && typeof job.args === "object" && !Array.isArray(job.args) ? job.args : {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "prompt" || value == null || value === "") continue;
    rows.push([key, (typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 300)]);
  }
  if (Array.isArray(job.referenceAssetIds) && job.referenceAssetIds.length) rows.push(["参考素材", `${job.referenceAssetIds.length} 项`]);
  return rows.filter(([, value]) => value != null && value !== "");
}
// media-workflow:end

function LocalImageDevices() {
  const [rows, setRows] = React.useState([]);
  const [label, setLabel] = React.useState('我的电脑');
  const [pair, setPair] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const deviceStatus = {ready:'可接收任务',credits_confirmation_required:'已暂停：需在本机确认额外 credits',quota_unavailable:'已暂停：无法核实额度',quota_exhausted:'已暂停：Codex 额度不足',login_required:'已暂停：需在本机登录 Codex',worker_error:'已暂停：请检查本机程序',unknown:'尚未报告生图状态'};
  async function load() {
    try {setRows((await api('/api/local-image/devices')).devices); setError('');}
    catch(e) {setError(e.message);} finally {setLoading(false);}
  }
  React.useEffect(() => {void load();}, []);
  React.useEffect(() => {
    if (!pair) return;
    const timer = setTimeout(() => setPair(null), Math.max(0,pair.expiresAt-Date.now()));
    const refresh = setInterval(load,5000);
    return () => {clearTimeout(timer);clearInterval(refresh);};
  }, [pair?.expiresAt]);
  async function action(route, body) {
    setBusy(true);setError('');
    try {
      const next=await api(`/api/local-image/${route}`,{method:'POST',body});
      if(route==='pair') setPair(next); else setRows(next.devices);
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <section className="connection-section local-image-devices">
    <div className="connection-section-heading"><h3>本机 Codex 生图</h3><button className="btn btn-ghost" disabled={busy} onClick={load}>刷新设备</button></div>
    <p>网站只发任务、保存作品。Codex 登录信息留在你的电脑，不上传网站；每个账号只能使用自己配对的设备。</p>
    <p className="muted">Claude 当前不支持照片或插画生成，因此不提供 Claude 生图选项。电脑离线时任务等待，执行结果不明时不会重复生成。</p>
    {error && <p className="connection-error" role="alert">{error}</p>}
    {loading && !rows.length ? <LoadingSkeleton variant="list" count={3} label="正在读取设备" /> : <div className="device-list">{rows.length ? rows.map(d => {
      const active=!d.revokedAt && d.expiresAt>Date.now();
      const online=active && Date.now()-d.lastSeenAt<90_000;
      return <div className="device-row" key={d.id}><div><strong>{d.label}{d.isDefault && active ? ' · 默认' : ''}</strong><p>{!active ? '已失效' : !d.lastSeenAt ? '等待电脑首次连接' : online ? deviceStatus[d.runtimeState] || '已连接' : '接收程序离线'}{d.lastSeenAt ? ` · 最近连接 ${new Date(d.lastSeenAt).toLocaleString('zh-CN')}` : ''}</p></div>{active && <div className="connection-actions">{!d.isDefault && d.lastSeenAt>0 && <button className="btn btn-ghost" disabled={busy} onClick={() => action(`devices/${d.id}/default`,{})}>设为默认</button>}<button className="btn btn-ghost" disabled={busy} onClick={() => {if(confirm('撤销后该设备不能再领取或回传作品；已开始的任务不会自动转交。继续吗？')) void action(`devices/${d.id}/revoke`,{});}}>撤销</button></div>}</div>;
    }) : <p className="muted">还没有配对生图设备。</p>}</div>}
    <div className="device-create"><label className="connection-field">设备名称<input value={label} maxLength="80" onChange={e => setLabel(e.target.value)} /></label><button className="btn" disabled={busy || !label.trim()} onClick={() => action('pair',{label})}>生成配对码</button></div>
    {pair && <div className="local-image-pair" role="status"><strong>一次性配对码 · 十分钟内有效</strong><code>{pair.code}</code><p>仅在自己的电脑终端输入，不要分享。首次连接后才能接收任务，已有默认设备不会被替换；换电脑时重新配对并设为默认，不需要搬运 Codex 登录文件。</p></div>}
    <details className="local-curation-help"><summary>如何在电脑上接收任务</summary><p>在已安装本站代码、并已登录 Codex 的电脑中运行。命令会在本机提示输入配对码，设备配置仅存本地私有文件：</p><code>node scripts/run-local-image.mjs --pair --base-url {location.origin}</code><p>配对后检查连接，再启动接收程序：</p><code>node scripts/run-local-image.mjs --check</code><code>node scripts/run-local-image.mjs --watch</code><p>停止接收程序不会删除作品。此功能不启用付费 API 或自动充值；Codex 用量检查未通过时会暂停。</p></details>
  </section>;
}

function mediaSourceImages(draft) {
  if (!draft) return [];
  if (draft.sourceType === "inbox") {
    let entries = draft.media;
    if (typeof entries === "string") { try { entries = JSON.parse(entries); } catch { entries = []; } }
    return Array.isArray(entries) ? entries.map((entry) =>
      entry.type === "photo" ? entry.url : entry.preview_image_url || entry.url).filter(Boolean) : [];
  }
  if (draft.sourceType === "prompt") {
    let entries = draft.media;
    if (typeof entries === "string") { try { entries = JSON.parse(entries); } catch { entries = []; } }
    return [draft.image, ...(Array.isArray(entries) ? entries.map((entry) => entry.url) : [])].filter(Boolean);
  }
  return [];
}

async function uploadMediaFile(file, details = {}) {
  const params = new URLSearchParams();
  params.set("title", details.title || file.name);
  if (details.sourceType) params.set("sourceType", details.sourceType);
  if (details.sourceId) params.set("sourceId", String(details.sourceId));
  if (details.parentAssetId) params.set("parentAssetId", details.parentAssetId);
  const response = await fetch(`/api/media/assets/upload?${params}`, {
    method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file, credentials: "same-origin",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "上传失败");
  return result;
}

// Display-only labels for the six screenshot-inspired style capsules. Kept
// separate from STUDIO_STYLES' internal zh/en template wording (in
// public/studio-draft.js) so the exact on-screen copy can be specified
// independently of the sentence embedded in the generated prompt.
const STUDIO_STYLE_UI_LABELS = {
  photo: '照片质感', studio: '影棚大片', street: '城市街拍',
  ecommerce: '电商白底', film: '胶片氛围', anime: '动漫插画',
};
const STUDIO_ROLE_SELECT_OPTIONS = [['', '不指定角色'], ['face', '人物'], ['costume', '服装'], ['pose', '姿势']];

function MediaStudioView({ userId, canCollect, draft, assets, jobs, configVersion, allowExternal = true, onAssetsChanged, onJobsChanged, onOpenSettings, onShowAsset, showToast }) {
  const [initial] = useMediaState(() => resolveStudioDraft(readStudioDraft(userId), draft, allowExternal));
  const [consumedKey, setConsumedKey] = useMediaState(initial.consumedKey);
  const [draftSaved, setDraftSaved] = useMediaState(true);
  const [submittedJobId, setSubmittedJobId] = useMediaState(initial.submittedJobId);
  const mounted = useMediaRef(true);
  useMediaEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [generationRoute, setGenerationRoute] = useMediaState(initial.generationRoute);
  const [localDevices, setLocalDevices] = useMediaState([]);
  const [localError, setLocalError] = useMediaState('');
  const [deviceId, setDeviceId] = useMediaState(initial.deviceId);
  const [module, setModule] = useMediaState(initial.module);
  const [model, setModel] = useMediaState(initial.model);
  const [mode, setMode] = useMediaState(initial.mode);
  const [title, setTitle] = useMediaState(initial.title);
  const [prompt, setPrompt] = useMediaState(initial.prompt);
  const [promptMentions, setPromptMentions] = useMediaState(initial.promptMentions);
  const [aspectRatio, setAspectRatio] = useMediaState(initial.aspectRatio);
  const [size, setSize] = useMediaState(initial.size);
  const [duration, setDuration] = useMediaState(initial.duration);
  const [resolution, setResolution] = useMediaState(initial.resolution);
  const [faceProcessing, setFaceProcessing] = useMediaState(initial.faceProcessing);
  const [referenceIds, setReferenceIds] = useMediaState(initial.referenceIds);
  // Screenshot-inspired controls: style preset, prompt language, free-text
  // supplemental requirements, whether the user has hand-edited the prompt
  // (so style/role/language changes stop silently overwriting it), per-image
  // role assignments (face/costume/pose), API-image-only quantity, and the
  // persisted sequential-batch submission state.
  const [style, setStyle] = useMediaState(initial.style);
  const [language, setLanguage] = useMediaState(initial.language);
  const [extras, setExtras] = useMediaState(initial.extras);
  const [promptDirty, setPromptDirty] = useMediaState(initial.promptDirty);
  const [count, setCount] = useMediaState(initial.count);
  const [referenceRoles, setReferenceRoles] = useMediaState(initial.referenceRoles);
  const [batch, setBatch] = useMediaState(initial.batch);
  const [acceptedCost, setAcceptedCost] = useMediaState(false);
  const [busy, setBusy] = useMediaState(false);
  const [uploading, setUploading] = useMediaState(false);
  const [source, setSource] = useMediaState(initial.source);
  const [config, setConfig] = useMediaState(null);
  const [submitError, setSubmitError] = useMediaState("");
  const [jobErrors, setJobErrors] = useMediaState({});
  const [previewId, setPreviewId] = useMediaState("");
  const [referencePickerOpen, setReferencePickerOpen] = useMediaState(false);
  const [referenceSearch, setReferenceSearch] = useMediaState('');
  const [referencePreviewId, setReferencePreviewId] = useMediaState('');
  const [canvasSource, setCanvasSource] = useMediaState('result');
  const getLinkedView = () => {
    const view = new URLSearchParams(location.hash.split('?')[1]).get('view');
    return ['input', 'content', 'materials', 'jobs', 'result'].includes(view) ? view : 'input';
  };
  const [studioView, setStudioView] = useMediaState(getLinkedView);
  useMediaEffect(() => {
    const sync = () => {
      if (location.hash.startsWith('#studio?')) setStudioView(getLinkedView());
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('omnihub:creator-source', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('omnihub:creator-source', sync);
    };
  }, []);
  const uploadInput = useMediaRef(null);
  const submitKey = useMediaRef(initial.requestKey || null);
  // Guards the auto-rebuild-while-not-dirty effect below so it never fires
  // on first mount (which would overwrite a prompt that was legitimately
  // loaded from a saved draft or an incoming source/continue-from-result).
  const templateEffectReady = useMediaRef(false);

  useMediaEffect(() => {
    if (allowExternal) api("/api/media/config").then(setConfig).catch(() => {});
  }, [configVersion, allowExternal]);
  async function loadLocalDevices() {
    try {
      const next = await api('/api/local-image/devices');
      setLocalDevices(next.devices.filter(item => !item.revokedAt && item.expiresAt > Date.now() && item.lastSeenAt>0));
      setLocalError('');
    } catch(error) { setLocalError(error.message); }
  }
  useMediaEffect(() => { void loadLocalDevices(); }, [configVersion]);
  function applyDraft(next) {
    setConsumedKey(next.consumedKey); setGenerationRoute(next.generationRoute); setDeviceId(next.deviceId);
    setModule(next.module); setModel(next.model); setMode(next.mode); setTitle(next.title); setPrompt(next.prompt);
    setPromptMentions(next.promptMentions);
    setAspectRatio(next.aspectRatio); setSize(next.size); setDuration(next.duration); setResolution(next.resolution);
    setFaceProcessing(next.faceProcessing); setReferenceIds(next.referenceIds); setSource(next.source);
    setStyle(next.style); setLanguage(next.language); setExtras(next.extras); setPromptDirty(next.promptDirty);
    setCount(next.count); setReferenceRoles(next.referenceRoles); setBatch(next.batch);
    setAcceptedCost(false); setSubmitError(""); setSubmittedJobId(next.submittedJobId);
    submitKey.current = next.requestKey || null;
    // The next draft's prompt (if any) is authoritative; do not let the
    // auto-template effect immediately overwrite it on the next render.
    templateEffectReady.current = false;
  }
  useMediaEffect(() => {
    if (draft?.key && draft.key !== consumedKey) applyDraft(resolveStudioDraft(null,draft,allowExternal));
  }, [draft?.key]);
  const editableDraft = {consumedKey,generationRoute,deviceId,module,model,mode,title,prompt,promptMentions,aspectRatio,size,duration,resolution,faceProcessing,referenceIds,source,style,language,extras,count,referenceRoles};
  const fingerprint = JSON.stringify(editableDraft);
  const previousFingerprint = useMediaRef(fingerprint);
  React.useLayoutEffect(() => {
    const changed = previousFingerprint.current !== fingerprint;
    if (changed) {
      submitKey.current = null; setSubmittedJobId(''); setAcceptedCost(false); setSubmitError(''); setBatch(null);
      previousFingerprint.current = fingerprint;
    }
    setDraftSaved(writeStudioDraft(userId,{...editableDraft,promptDirty,batch:changed ? null : batch,requestKey:submitKey.current || '',submittedJobId:changed ? '' : submittedJobId}));
  }, [fingerprint,submittedJobId,userId,promptDirty,batch]);
  function newDraft() {
    if (studioDraftHasContent(editableDraft) && !confirm('新建会清空当前草稿，已保存的作品不受影响。继续吗？')) return;
    applyDraft(normalizeStudioDraft({consumedKey},allowExternal));
  }

  function changeModule(next) {
    setModule(next);
    setModel(MEDIA_MODEL_OPTIONS[next][0]);
    setMode(next !== 'image' && next !== 'hh1' && referenceIds.length ? 'reference_images' : MEDIA_MODES[next][0].id);
    setAspectRatio(current => next === 'image' ? (current === 'adaptive' ? 'auto' : current) : ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(current) ? current : 'adaptive');
    setReferencePickerOpen(false);
    setAcceptedCost(false);
    submitKey.current = null;
  }

  function toggleReference(id) {
    setReferenceIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      setReferenceRoles((roles) => filterStudioRolesByReferenceIds(roles, next));
      return next;
    });
    submitKey.current = null;
  }

  function setReferenceRole(assetId, kind) {
    setReferenceRoles((current) => {
      const withoutAsset = current.filter((role) => role.assetId !== assetId);
      const withoutKind = kind ? withoutAsset.filter((role) => role.kind !== kind) : withoutAsset;
      return kind ? [...withoutKind, { kind, assetId }] : withoutKind;
    });
  }

  function templateOptions() { return { roles: referenceRoles, referenceIds, style, language, extras }; }
  // Explicit, user-triggered (re)build of the prompt from the current
  // style/roles/language/extras. When the prompt has been hand-edited this
  // always requires confirmation before overwriting it; the automatic
  // effect below only ever calls the non-dirty path.
  function applyPromptTemplate({ requireConfirm } = {}) {
    if (requireConfirm && !confirm('重新生成模板会覆盖当前已编辑的提示词，继续吗？')) return;
    setPrompt(buildStudioTemplate(templateOptions()));
    setPromptDirty(false);
    submitKey.current = null;
  }
  // Auto-rebuild the prompt whenever style/language/extras/roles/references
  // change, but only while the prompt has not been hand-edited (promptDirty
  // === false) and never on first mount — so a prompt loaded from a saved
  // draft or an incoming source is never silently discarded.
  useMediaEffect(() => {
    if (!templateEffectReady.current) { templateEffectReady.current = true; return; }
    if (module === "image" && shouldAutoApplyStudioTemplate({ promptDirty })) {
      setPrompt(buildStudioTemplate(templateOptions()));
      submitKey.current = null;
    }
  }, [style, language, extras, JSON.stringify(referenceRoles), JSON.stringify(referenceIds)]);
  // Count is only meaningful for the API image route; keep it pinned to 1
  // the instant the module/route no longer qualifies, mirroring the server
  // contract enforced in normalizeStudioCount.
  useMediaEffect(() => {
    setCount((current) => normalizeStudioCount(current, { module, generationRoute }));
  }, [module, generationRoute]);

  // Continue from a saved result inside the studio. The result becomes the parent
  // (sent as parentAssetId on submit) and, where references are supported, the reference.
  function continueFromResult(asset) {
    if (!asset || busy) return;
    const job = assets && asset.jobId ? jobs.find((row) => row.id === asset.jobId) : null;
    const next = mediaContinueDraft(asset, job, { module, model, mode, generationRoute, prompt, source }, allowExternal);
    if (next.module) { setModule(next.module); setMode(next.mode); }
    if (next.model && MEDIA_MODEL_OPTIONS.image.includes(next.model)) setModel(next.model);
    if (next.aspectRatio) setAspectRatio(next.aspectRatio);
    if (next.size) setSize(next.size);
    if (next.prompt) { setPrompt(next.prompt); setPromptDirty(true); }
    if (next.generationRoute) setGenerationRoute(next.generationRoute);
    if (next.referenceId) setReferenceIds((current) => current.includes(next.referenceId) ? current : [...current, next.referenceId]);
    setSource(next.source);
    submitKey.current = null;
    setStudioView("input");
  }

  async function importSource(index) {
    if (!source?.sourceType || !source?.sourceId) return;
    setUploading(true);
    try {
      const asset = await api("/api/media/assets/import-source", {
        method: "POST", body: {
          sourceType: source.sourceType, sourceId: source.sourceId,
          mediaIndex: index, title: `${source.title || "来源"} · 参考图 ${index + 1}`,
        },
      });
      await onAssetsChanged();
      setReferenceIds((current) => current.includes(asset.id) ? current : [...current, asset.id]);
      showToast("参考图已保存并选中");
    } catch (error) { showToast(error.message); }
    finally { setUploading(false); }
  }

  async function uploadFiles(files) {
    if (!files?.length) return;
    if (referenceIds.length + files.length > capabilities.maxRefs) {
      showToast(`当前模式最多使用 ${capabilities.maxRefs} 个参考素材，请减少选择数量。`);
      if (uploadInput.current) uploadInput.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const ids = [];
      for (const file of files) {
        const asset = await uploadMediaFile(file, {
          sourceType: source?.sourceType, sourceId: source?.sourceId,
        });
        ids.push(asset.id);
      }
      await onAssetsChanged();
      setReferenceIds((current) => [...new Set([...current, ...ids])]);
      showToast(`已上传 ${ids.length} 个参考素材`);
    } catch (error) { showToast(error.message); }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ""; }
  }

  async function submit() {
    if (busy || !acceptedCost || !prompt.trim() || submittedJobId) return;
    const mentioned = resolveStudioMentions(prompt, promptMentions, referenceIds, assets);
    if (mentioned.error) { setSubmitError(mentioned.error); return; }
    if (useLocal && (referenceIds.length || source?.parentAssetId)) {
      setSubmitError('本机生图暂不支持参考图编辑。请明确改为仅使用文字，或选择支持参考图的媒体 API。'); return;
    }
    // Quantity only applies to the API image route; local and every video
    // module always submit exactly one job, same as before.
    const effectiveCount = useLocal || isVideo ? 1 : count;
    const baseKey = submitKey.current || crypto.randomUUID();
    submitKey.current = baseKey;
    // Resume the persisted batch for this exact base key when one exists
    // (e.g. after a partial submission or a reload); otherwise start fresh.
    let working = batch && batch.baseRequestKey === baseKey && batch.count === effectiveCount ? batch : initStudioBatch(baseKey, effectiveCount);
    setBatch(working);
    setDraftSaved(writeStudioDraft(userId,{...editableDraft,promptDirty,batch:working,requestKey:baseKey}));
    setBusy(true);
    setSubmitError("");
    const faceProcessingList = faceProcessing ? referenceIds.map((id) => assets.find((a) => a.id === id))
      .filter(Boolean).reduce((all, asset) => {
        const countSoFar = referenceIds.slice(0, referenceIds.indexOf(asset.id) + 1)
          .map((ref) => assets.find((a) => a.id === ref)).filter((row) => row?.kind === asset.kind).length;
        if (asset.kind === "image") all.push(`图片${countSoFar}`);
        if (asset.kind === "video") all.push(`视频${countSoFar}`);
        return all;
      }, []) : [];
    let lastJob = null;
    try {
      while (!studioBatchComplete(working)) {
        const childKey = effectiveCount === 1 ? baseKey : studioBatchNextKey(working);
        if (!childKey) break;
        const job = await api(useLocal ? '/api/local-image/jobs' : "/api/media/jobs", { method: "POST", body: {
          requestKey: childKey, module, model, mode, title: title.trim(), prompt: mentioned.prompt.trim(),
          aspectRatio, size, duration: Number(duration), resolution,
          faceProcessing: Number(faceProcessing), faceProcessingList,
          referenceAssetIds: referenceIds,
          sourceType: source?.sourceType || "", sourceId: source?.sourceId || null,
          parentAssetId: source?.parentAssetId || "",
          acceptUnknownCost: true,
          ...(useLocal ? {acceptCodexUsage:true, deviceId} : {}),
        } });
        lastJob = job;
        // Advance the batch the instant the server has accepted the job
        // (even if its terminal status is failed/needs_review) so a retry
        // never resubmits the same slot and creates a duplicate job.
        working = recordStudioBatchAccepted(working, job.id);
        if (mounted.current) setBatch(working);
        const current = readStudioDraft(userId);
        if (current?.requestKey === baseKey) {
          writeStudioDraft(userId,{...current, batch: working, submittedJobId: studioBatchComplete(working) ? job.id : current.submittedJobId});
        }
        if (job.status === "failed" || job.status === "needs_review") break; // stop the sequence; other slots can still be retried later
      }
      if (studioBatchComplete(working) && mounted.current) { setSubmittedJobId(lastJob?.id || working.submittedJobIds.at(-1)); setAcceptedCost(false); }
      await onJobsChanged().catch(() => showToast('任务已创建，任务列表暂未刷新，请稍后查看。'));
      if (mounted.current) setStudioView("jobs");
      if (lastJob) {
        showToast(lastJob.status === "failed" || lastJob.status === "needs_review" ? lastJob.error
          : studioBatchComplete(working) ? `已创建 ${studioBatchPartialCount(working)} 个生成任务` : "生成任务已创建");
      }
    } catch (error) {
      // Keep the request key until the user changes the draft: a network timeout may have created the upstream task.
      setSubmitError(`${error.message}。可再次提交；系统会使用同一批次的请求标识核对是否已创建任务。`);
      showToast(error.message);
    } finally { setBusy(false); }
  }

  async function refresh(job) {
    try {
      const updated = await api(job.module === 'codex-local' ? `/api/media/jobs/${job.id}` : `/api/media/jobs/${job.id}/refresh`, { method: job.module === 'codex-local' ? 'GET' : "POST" });
      await onJobsChanged();
      if (updated.status === "success") await onAssetsChanged();
      setJobErrors((current) => { const next = { ...current }; delete next[job.id]; return next; });
      showToast(MEDIA_STATUS[updated.status] || updated.status);
    } catch (error) {
      setJobErrors((current) => ({ ...current, [job.id]: `${error.message}。请稍后重新查询。` }));
      showToast(error.message);
    }
  }

  const sourceImages = mediaSourceImages(source);
  const refs = referenceIds.map(id => assets.find(asset => asset.id === id)).filter(Boolean);
  const isVideo = module !== "image";
  const useLocal = !isVideo && generationRoute === 'local';
  const localReferenceBlocked = useLocal && (referenceIds.length > 0 || Boolean(source?.parentAssetId));
  const defaultDevice = localDevices.find(d => d.isDefault) || localDevices[0];
  const capabilities = mediaStudioCapabilities(module, model, mode);
  const mentioned = resolveStudioMentions(prompt, promptMentions, referenceIds, assets);
  const referenceIssue = mentioned.error || mediaStudioReferenceIssue(refs, capabilities);
  const durationIssue = isVideo && (!Number.isInteger(Number(duration)) || Number(duration) < capabilities.durationMin || Number(duration) > capabilities.durationMax)
    ? `当前模型支持 ${capabilities.durationMin}–${capabilities.durationMax} 秒，请调整时长。` : '';
  const recentJobs = jobs.slice(0, 12);
  const mediaConfigured = Boolean(config?.hasAuthentication && config?.baseUrl);
  const latestAsset = mediaLatestSuccess(jobs, assets);
  const pickedAsset = previewId ? assets.find((asset) => asset.id === previewId) : null;
  const previewAsset = pickedAsset || latestAsset;
  const previewJob = previewAsset ? jobs.find((job) => job.assetId === previewAsset.id) : null;
  const canvasReference = refs.find(asset => asset.id === referencePreviewId) || refs[0] || null;
  const previewingReference = studioView === 'input' && canvasReference && (canvasSource === 'reference' || !previewAsset);
  const canvasAsset = previewingReference ? canvasReference : previewAsset;
  const activeJobCount = recentJobs.filter((job) => MEDIA_ACTIVE_STATUSES.has(job.status) || ["local_queued", "local_claimed", "submitting"].includes(job.status)).length;
  function useLibraryItems(items, { newDraft: replace = false } = {}) {
    if (busy || uploading) throw new Error('请等当前操作完成后再添加素材。');
    const ids = [...new Set(items.map(item => item.id))];
    const needsVideo = items.some(item => item.kind !== 'image');
    if (needsVideo && (!allowExternal || (!replace && module === 'image'))) {
      throw new Error('视频和音频需要视频草稿。请先切换创作类型，或选择新建草稿。');
    }
    if (new Set([...(replace ? [] : referenceIds), ...ids]).size > 32) {
      throw new Error('一个草稿最多保存 32 个参考素材。');
    }
    if (replace) {
      if (studioDraftHasContent(editableDraft) && !confirm('用所选素材新建草稿？这会替换当前草稿。')) return false;
      applyDraft(normalizeStudioDraft({ consumedKey, ...(needsVideo ? { module: 'seedance', generationRoute: 'api' } : {}) }, allowExternal));
    }
    setReferenceIds(current => [...new Set([...(replace ? [] : current), ...ids])]);
    if (!replace) setPromptDirty(true);
    setStudioView('input');
    showToast(`已将 ${ids.length} 项素材加入草稿`);
    return true;
  }

  const studioTabs = [["input", "图片与视频"], ["materials", "素材"], ["content", "内容创作"], ["jobs", `生成记录${activeJobCount ? ` · ${activeJobCount}` : ""}`], ["result", "结果"]];
  const showQuantity = module === "image" && generationRoute === "api";
  return (
    <div className={"media-studio" + (studioView === "materials" ? " is-materials" : "")}>
      <div className="media-studio-tabs" role="tablist" aria-label="创作台视图">
        {studioTabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={studioView === id}
          className={studioView === id ? "active" : ""} onClick={() => setStudioView(id)}>{label}</button>)}
      </div>
      {studioView !== "materials" && <div className="media-page-head">
        <h1>{studioTabs.find(([id]) => id === studioView)?.[1] || "创作台"}</h1>
        {studioView === 'input' && <div className="media-draft-actions"><button className="btn btn-ghost" disabled={busy || uploading} onClick={newDraft}>新建草稿</button><button className="btn" onClick={() => onOpenSettings("devices")}><IconSettings />设置</button></div>}
      </div>}
      {studioView === 'content' && <CreatorWorkbench key={userId} userId={userId} onSettings={() => onOpenSettings('ai')} onImage={image => {changeModule('image');setPrompt(image.prompt);setTitle(image.title);setAspectRatio(image.ratio);setCount(1);setPromptDirty(true);setStudioView('input');}} />}
      {studioView === 'materials' && <CreativeLibraryWorkspace key={userId} userId={userId}
        assets={assets} canCollect={canCollect} onAssetsChanged={onAssetsChanged} onUse={useLibraryItems} showToast={showToast} />}
      {!['content', 'materials'].includes(studioView) && <div className="media-studio-layout has-result" data-view={studioView}>
        {studioView === 'input' && <section className="media-compose" aria-label="生成编辑器">
          <div className="studio-editor">
            <fieldset className="studio-fields" disabled={busy}>
              <div className="studio-editor-head">
                <div className="studio-type-switch" role="group" aria-label="创作类型">
                  <button type="button" aria-pressed={!isVideo} onClick={() => { if (isVideo) changeModule('image'); }}>图片</button>
                  <button type="button" aria-pressed={isVideo} disabled={!allowExternal} title={!allowExternal ? '当前账号未开放视频服务' : undefined} onClick={() => { if (!isVideo) changeModule('seedance'); }}>视频</button>
                </div>
                <span className="studio-save-state" role="status">{draftSaved ? '草稿已保存' : '草稿未保存'}</span>
              </div>
              <div className="studio-description">
                <div className="studio-field-head"><label htmlFor="studio-prompt">{isVideo ? '镜头描述' : '画面描述'}</label>
                  <button type="button" className="studio-text-button" disabled={!prompt.trim()} onClick={async () => { try { await navigator.clipboard.writeText(prompt); showToast('提示词已复制'); } catch { showToast('无法访问剪贴板，请手动复制提示词'); } }}>复制</button>
                </div>
                <StudioPromptInput value={prompt} mentions={promptMentions} assets={assets} references={refs} capabilities={capabilities} isVideo={isVideo} disabled={busy || uploading}
                  onChange={value => { setPrompt(value); setPromptDirty(true); submitKey.current = null; }}
                  onMention={(asset, next) => { setPrompt(next.prompt); setPromptMentions(next.mentions); setPromptDirty(true); setReferenceIds(current => current.includes(asset.id) ? current : [...current, asset.id]); setReferencePreviewId(asset.id); setCanvasSource('reference'); submitKey.current = null; }} />
                {mentioned.mentions.length > 0 && <div className="studio-prompt-bindings" aria-label="提示词引用图片">{mentioned.mentions.map(item => <button key={item.alias} type="button" title={assets.find(asset => asset.id === item.assetId)?.title} onClick={() => { setReferencePreviewId(item.assetId); setCanvasSource('reference'); }}>@{item.alias}<span>{assets.find(asset => asset.id === item.assetId)?.title}</span></button>)}</div>}
              </div>
              <div className="studio-references">
                <div className="studio-field-head"><span>参考素材{refs.length > 0 && <small>{refs.length} / {capabilities.maxRefs || 0}</small>}</span>
                  <div><button type="button" className="studio-text-button" onClick={() => uploadInput.current?.click()} disabled={uploading || !capabilities.maxRefs || refs.length >= capabilities.maxRefs}>{uploading ? '上传中…' : '上传'}</button>
                    <button type="button" className="studio-text-button" aria-haspopup="dialog" aria-expanded={referencePickerOpen} aria-controls="studio-reference-picker" disabled={!capabilities.maxRefs} onClick={() => setReferencePickerOpen(true)}>选择素材</button></div>
                </div>
                <input ref={uploadInput} type="file" aria-label="上传参考素材" accept={isVideo ? 'image/*,video/mp4,audio/mpeg,audio/wav' : 'image/*'} multiple hidden onChange={event => uploadFiles(event.target.files)} />
                {refs.length > 0 ? <div className="studio-reference-strip">
                  {refs.map((asset, index) => <div className={'studio-reference' + (canvasReference?.id === asset.id && previewingReference ? ' is-previewed' : '')} key={asset.id}>
                    <button type="button" className="studio-reference-preview" title={asset.title} aria-label={'预览参考 ' + asset.title} onClick={() => { setReferencePreviewId(asset.id); setCanvasSource('reference'); }}>
                      {asset.kind === 'image' ? <img src={`/api/media/assets/${asset.id}/preview`} alt="" decoding="async" /> : asset.kind === 'video' ? <video src={mediaFileUrl(asset) + '#t=0.1'} muted playsInline preload="metadata" aria-hidden="true" /> : <span>音频</span>}
                      {asset.kind === 'image' && promptMentions.some(item => item.assetId === asset.id) && <small className="studio-reference-mention-label">@{promptMentions.find(item => item.assetId === asset.id).alias}</small>}
                    </button>
                    <button type="button" className="studio-reference-remove" aria-label={'移除参考 ' + asset.title} onClick={() => toggleReference(asset.id)}><IconX /></button>
                    {isVideo && mode === 'first_last_frame' && <small className="studio-frame-label">{index === 0 ? '首帧' : index === 1 ? '尾帧' : '多余参考'}</small>}
                  </div>)}
                </div> : !capabilities.maxRefs ? <p className="studio-input-note">此模式使用文字描述，无需参考素材。</p> : <button type="button" className="studio-reference-add" aria-haspopup="dialog" aria-controls="studio-reference-picker" onClick={() => setReferencePickerOpen(true)}><IconPlus /><span>{isVideo && mode === 'first_last_frame' ? '添加首帧或首尾帧' : '添加图片' + (isVideo ? '、视频或音频参考' : '参考，可选')}</span></button>}

              </div>
              <div className="studio-service-fields">
                {!isVideo ? <label>生成服务<InlineSelect className="select" aria-label="生成服务" value={generationRoute} onChange={e => { setGenerationRoute(e.target.value); setAcceptedCost(false); }}><option value="local">本机 Codex</option>{allowExternal && <option value="api">媒体 API</option>}</InlineSelect></label>
                  : <label>视频服务<InlineSelect className="select" value={module} onChange={e => changeModule(e.target.value)}><option value="seedance">Seedance</option><option value="hh1">Happy Horse</option><option value="wan3">Wan 3</option></InlineSelect></label>}
                {useLocal ? <label>模型<input className="input studio-fixed-model" aria-label="生图模型" readOnly value="Codex 原生生图" /></label>
                  : <label>模型<InlineSelect className="select" value={model} onChange={e => { const next = e.target.value; setModel(next); if (next === 'seedream-5.0-pro') { if (['auto', '5:4', '4:5'].includes(aspectRatio)) setAspectRatio('1:1'); if (size === '4k') setSize('2k'); } }}>{MEDIA_MODEL_OPTIONS[module].map(name => <option key={name} value={name}>{name}</option>)}</InlineSelect></label>}
              </div>
              {useLocal && <div className="studio-local-device">
                <p className="studio-input-note">本机通道未回传具体型号，当前不支持切换生图模型。</p>
                <label>执行设备<InlineSelect className="select" aria-label="执行设备" disabled={!localDevices.length} value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">{localDevices.length ? `默认设备${defaultDevice?.label ? ` · ${defaultDevice.label}` : ''}` : '未连接设备'}</option>{localDevices.map(device => <option value={device.id} key={device.id}>{device.label}</option>)}</InlineSelect></label>
              </div>}
              {isVideo && <label className="studio-mode-field">创作模式<InlineSelect className="select" value={mode} onChange={e => { setMode(e.target.value); submitKey.current = null; }}>{MEDIA_MODES[module].map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</InlineSelect></label>}
              <div className="studio-output-fields">
                <label>画面比例<InlineSelect className="select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                  {(isVideo ? ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'] : ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']).filter(ratio => !(module === 'image' && model === 'seedream-5.0-pro' && ratio === 'auto')).map(ratio => <option key={ratio} value={ratio}>{ratio === 'auto' || ratio === 'adaptive' ? '自动' : ratio}</option>)}
                </InlineSelect></label>
                {!isVideo && <label>数量<InlineSelect className="select" aria-label="生成数量" value={showQuantity ? count : 1} disabled={!showQuantity} onChange={e => setCount(Number(e.target.value))}>{(showQuantity ? [1, 2, 3, 4] : [1]).map(n => <option key={n} value={n}>{n} 张</option>)}</InlineSelect></label>}
                {!isVideo && !useLocal && model !== 'gpt-image-2' && <label>清晰度<InlineSelect className="select" value={size} onChange={e => setSize(e.target.value)}><option value="1k">1K</option><option value="2k">2K</option>{model !== 'seedream-5.0-pro' && <option value="4k">4K</option>}</InlineSelect></label>}
                {isVideo && mode !== 'video_edit' && <label>时长（秒）<input className="input" type="number" min={capabilities.durationMin} max={capabilities.durationMax} step="1" value={duration} onChange={e => setDuration(e.target.value)} /></label>}
                {isVideo && module !== 'hh1' && <label>分辨率<InlineSelect className="select" value={resolution} onChange={e => setResolution(e.target.value)}><option>480p</option><option>720p</option>{module === 'wan3' && <option>1080p</option>}</InlineSelect></label>}
              </div>
              <details className="studio-options">
                <summary>{isVideo ? '更多设置' : '角色、风格与更多设置'}</summary>
                <div className="studio-options-body">
                  {module === 'image' && <React.Fragment>
                    <div className="studio-role-links">{STUDIO_ROLE_ORDER.map(role => <a key={role} href={`#ai-art?space=mine&kind=${role}`}>{STUDIO_ROLE_LABELS[role].zh}素材</a>)}</div>
                    {refs.length > 0 && <div className="studio-role-fields">{refs.filter(asset => asset.kind === 'image').map(asset => <label key={asset.id}><span title={asset.title}>{asset.title}</span><InlineSelect className="select" aria-label={'参考角色 ' + asset.title} value={referenceRoles.find(role => role.assetId === asset.id)?.kind || ''} onChange={e => setReferenceRole(asset.id, e.target.value)}>{STUDIO_ROLE_SELECT_OPTIONS.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}</InlineSelect></label>)}</div>}
                    <label>风格<InlineSelect className="select" value={style} onChange={e => setStyle(e.target.value)}>{STUDIO_STYLE_IDS.map(id => <option key={id} value={id}>{STUDIO_STYLE_UI_LABELS[id]}</option>)}</InlineSelect></label>
                    <label>提示词语言<InlineSelect className="select" value={language} onChange={e => setLanguage(e.target.value)}><option value="en">英文</option><option value="zh">中文</option></InlineSelect></label>
                    <label className="studio-options-wide">补充要求<textarea className="input" rows="2" value={extras} placeholder="例如：海边日落、半身构图、手拿咖啡…" onChange={e => setExtras(e.target.value)} /></label>
                    <div className="studio-template-note"><span>{promptDirty ? '手写提示词会保留；应用模板将覆盖当前内容。' : '按角色、风格和补充要求生成提示词。'}</span><button type="button" className="btn" onClick={() => applyPromptTemplate({ requireConfirm: Boolean(prompt.trim()) })}>应用模板</button></div>
                  </React.Fragment>}
                  {module === 'seedance' && mode !== 'text_video' && <label className="studio-options-wide">含人脸素材的处理方式<InlineSelect className="select" value={faceProcessing} onChange={e => setFaceProcessing(Number(e.target.value))}><option value="0">不含人脸／不开启</option><option value="1">快速处理</option><option value="2">精细处理</option><option value="3">最大程度还原</option></InlineSelect></label>}
                  <label className="studio-options-wide">作品标题<input className="input" value={title} maxLength="160" placeholder="可选，便于以后查找" onChange={e => { setTitle(e.target.value); submitKey.current = null; }} /></label>
                </div>
              </details>
              {source && <details className="studio-options"><summary>来源 · {source.title || '未命名内容'}</summary><div className="studio-source-details">{source.url && <a href={source.url} target="_blank" rel="noopener noreferrer">打开原链接</a>}{source.parentAssetId && <span>基于已有作品继续创作</span>}</div></details>}
              {sourceImages.length > 0 && <details className="studio-options"><summary>原帖效果图 · {sourceImages.length} 张</summary><div className="studio-source-images">{sourceImages.map((url, index) => <div key={index}><img src={url} alt={`效果图 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" />{!useLocal && <button type="button" className="btn" onClick={() => importSource(index)} disabled={uploading}>用作参考图</button>}</div>)}</div></details>}
              <div className="studio-submit">
                {(referenceIssue || durationIssue) && <p className="studio-warning" role="alert">{referenceIssue || durationIssue}</p>}
                {!draftSaved && <p className="studio-warning" role="alert">浏览器存储不可用，刷新前请复制提示词。</p>}
                {submittedJobId && <p role="status">这份草稿已提交。修改内容后可再次生成。</p>}
                {batch && !studioBatchComplete(batch) && studioBatchPartialCount(batch) > 0 && !submittedJobId && <p role="status">已提交 {studioBatchPartialCount(batch)} / {batch.count} 张，可继续生成剩余数量。</p>}
                {useLocal ? <React.Fragment>
                  {localReferenceBlocked && <div className="studio-warning" role="alert"><p>本机暂不支持参考素材，请先移除或切换服务。</p>{allowExternal && <button type="button" className="studio-text-button" onClick={() => { setGenerationRoute('api'); setAcceptedCost(false); }}>改用媒体 API</button>}<button type="button" className="studio-text-button" onClick={() => { setReferenceIds([]); setReferenceRoles([]); setPrompt(current => current.replace(/@图片[1-9]\d*/g, '')); setPromptMentions([]); setPromptDirty(true); setSource(previous => previous ? { ...previous, parentAssetId: '' } : previous); setAcceptedCost(false); }}>仅保留文字</button></div>}
                  {localError && <p className="studio-warning" role="alert">{localError}<button type="button" className="studio-text-button" onClick={loadLocalDevices}>重试</button></p>}
                  {localDevices.length > 0 ? <React.Fragment><label className="studio-consent"><input type="checkbox" checked={acceptedCost} onChange={e => setAcceptedCost(e.target.checked)} /><span>确认使用自己的本机 Codex 用量生成 1 张</span></label><button type="button" className="btn btn-primary" disabled={busy || uploading || !acceptedCost || !prompt.trim() || localReferenceBlocked || Boolean(submittedJobId)} onClick={submit}>{busy ? '提交中…' : '交给本机生成'}</button></React.Fragment>
                    : <React.Fragment><p>配对在线电脑后，使用你的本机 Codex 用量生成图片。</p><button type="button" className="btn" onClick={() => onOpenSettings('devices')}>配对我的电脑</button></React.Fragment>}
                </React.Fragment> : !mediaConfigured ? <React.Fragment><p>尚未配置可用的媒体服务。草稿会保留，可继续编辑。</p><button type="button" className="btn" onClick={onOpenSettings}>配置媒体服务</button></React.Fragment> : <React.Fragment>
                  <p>{config.baseUrl === 'http://39.96.116.239:9001' ? '当前服务使用明文 HTTP 传输认证信息。生成可能消耗第三方额度，接口未提供价格。' : '生成可能消耗第三方服务额度，当前接口未提供价格。'}</p>
                  <label className="studio-consent"><input type="checkbox" checked={acceptedCost} onChange={e => setAcceptedCost(e.target.checked)} /><span>确认提交{showQuantity && count > 1 ? ` ${count} 张图片` : '本次生成'}，费用或额度消耗暂未公布</span></label>
                  <button type="button" className="btn btn-primary" disabled={busy || uploading || !acceptedCost || !prompt.trim() || Boolean(referenceIssue || durationIssue) || Boolean(submittedJobId)} onClick={submit}>{busy ? '提交中…' : module === 'image' ? (showQuantity && count > 1 ? `生成 ${count} 张图片` : '生成图片') : '生成视频'}</button>
                </React.Fragment>}
                {submitError && <p className="studio-warning" role="alert">{submitError}</p>}
              </div>
            </fieldset>
          </div>
        </section>}
        {['input', 'result'].includes(studioView) && <section className={'media-result-preview' + (studioView === 'input' ? ' studio-viewer' : '')} aria-label="预览工作区">
          <div className="media-job-head"><h2>{previewingReference ? '参考预览' : pickedAsset ? '所选结果' : '生成结果'}</h2>
            {studioView === 'input' && refs.length > 0 && <div className="studio-preview-switch" role="group" aria-label="预览内容"><button type="button" aria-pressed={Boolean(previewingReference)} onClick={() => setCanvasSource('reference')}>参考</button><button type="button" aria-pressed={!previewingReference} disabled={!previewAsset} onClick={() => setCanvasSource('result')}>结果</button></div>}
            {pickedAsset && !previewingReference && <button type="button" className="btn btn-ghost" onClick={() => setPreviewId('')}>回到最新</button>}</div>
          {canvasAsset ? <React.Fragment>
            <div className={studioView === 'input' ? 'studio-canvas' : 'media-result-stage'}><MediaAssetPreview key={canvasAsset.id} asset={canvasAsset} preload={studioView === 'input' ? 'metadata' : 'none'} /></div>
            <strong className="media-result-title">{canvasAsset.title}</strong>
            <small className="media-result-meta">{previewingReference ? ({ image: '图片参考', video: '视频参考', audio: '音频参考' }[canvasAsset.kind] || '参考素材') : `${previewJob ? (previewJob.module === 'codex-local' ? '本机 Codex' : `${previewJob.module} · ${previewJob.model}`) : canvasAsset.model || '作品'} · ${canvasAsset.createdAt}`}</small>
            {!previewingReference && canvasAsset.prompt && <p className="media-result-prompt">{canvasAsset.prompt}</p>}
            {previewingReference ? <div className="media-job-actions"><button type="button" className="btn" onClick={() => setReferencePickerOpen(true)}>选择参考素材</button><button type="button" className="btn btn-ghost" onClick={() => toggleReference(canvasAsset.id)}>从草稿移除</button></div> : <div className="media-job-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => continueFromResult(previewAsset)}>{allowExternal && previewAsset.kind === "image" ? "基于此结果继续" : "复用提示词"}</button>
              <button type="button" className="btn" onClick={() => onShowAsset(previewAsset.id)}>查看作品</button>
              <a className="btn btn-ghost" href={mediaFileUrl(previewAsset, true)}>下载</a>
            </div>}
          </React.Fragment> : <div className={studioView === 'input' ? 'studio-canvas studio-canvas-empty' : 'media-result-empty'}><div>{studioView === 'input' && <IconPalette />}<h3>{activeJobCount ? '正在生成' : '生成结果会显示在这里'}</h3><p>{activeJobCount ? `有 ${activeJobCount} 个任务进行中，完成并保存后即可预览。` : studioView === 'input' ? '写下描述开始创作，或先添加参考素材检查画面。' : '还没有已保存的结果。成功的任务会自动显示在这里。'}</p>{studioView === 'input' ? <button type="button" className="btn" onClick={() => setReferencePickerOpen(true)}>选择参考素材</button> : <button type="button" className="btn" onClick={() => setStudioView(activeJobCount ? 'jobs' : 'input')}>{activeJobCount ? '查看生成进度' : '开始创作'}</button>}</div></div>}
          {studioView === 'input' && <div className="studio-activity"><div><span>{activeJobCount ? `${activeJobCount} 个任务进行中` : '生成记录'}</span><button type="button" className="studio-text-button" onClick={() => setStudioView('jobs')}>查看全部</button></div>{recentJobs.slice(0, 2).map(job => <div className="studio-activity-row" key={job.id}><span title={job.title}>{job.title || '未命名任务'}</span><small>{MEDIA_STATUS[job.status] || job.status}</small></div>)}</div>}
        </section>}
        {studioView === 'jobs' && <aside className="media-job-list">
          <div className="media-job-head"><h2>最近任务</h2><button className="btn btn-ghost" onClick={onJobsChanged}><IconRefresh />刷新</button></div>
          {recentJobs.length === 0 ? <div className="media-job-empty"><p>还没有生成记录。提交生成后，任务会显示在这里。</p><button className="btn" onClick={() => setStudioView('input')}>开始创作</button></div> : <div className="media-job-grid">
          {recentJobs.map((job) => <div className={"media-job" + (previewAsset && job.assetId === previewAsset.id ? " is-previewed" : "")} key={job.id}>
            <div><strong>{job.title}</strong><span aria-live="polite">{MEDIA_STATUS[job.status] || job.status}</span></div>
            <small>{job.module === 'codex-local' ? '本机 Codex' : `${job.module} · ${job.model}`} · {job.createdAt}</small>
            {job.assetId && job.module === 'codex-local' && <a href={`/api/media/assets/${job.assetId}/file`} target="_blank" rel="noopener noreferrer"><img className="local-image-result" src={`/api/media/assets/${job.assetId}/file`} alt={job.title} /></a>}
            {job.error && <p>{job.error}</p>}
            {jobErrors[job.id] && <p className="media-error" role="alert">{jobErrors[job.id]}</p>}
            {MEDIA_ACTIVE_STATUSES.has(job.status) && formatMediaNextPollAt(job.nextPollAt) && <small>下次查询：{formatMediaNextPollAt(job.nextPollAt)}{job.pollAttempts != null ? ` · 已查询 ${job.pollAttempts} 次` : ""}</small>}
            <div className="media-job-actions">
              {job.assetId && assets.some((asset) => asset.id === job.assetId) && <button className="btn btn-ghost" onClick={() => { setPreviewId(job.assetId); setStudioView("result"); }}>预览</button>}
              {job.assetId && <button className="btn" onClick={() => onShowAsset(job.assetId)}>查看作品</button>}
              {MEDIA_ACTIVE_STATUSES.has(job.status) &&
                <button className="btn btn-ghost" onClick={() => refresh(job)}>查询进度</button>}
              {['local_queued','local_claimed'].includes(job.status) && <button className="btn btn-ghost" onClick={async () => {try {await api(`/api/local-image/jobs/${job.id}/cancel`,{method:'POST',body:{}}); await onJobsChanged();} catch(error) {showToast(error.message);}}}>取消等待</button>}
            </div>
          </div>)}
          </div>}
        </aside>}
      </div>}
      {referencePickerOpen && studioView === 'input' && <StudioReferencePicker
        assets={assets} references={refs} capabilities={capabilities} search={referenceSearch} disabled={busy || uploading}
        onSearch={setReferenceSearch} onClose={() => setReferencePickerOpen(false)}
        onToggle={asset => { toggleReference(asset.id); setReferencePreviewId(asset.id); setCanvasSource('reference'); }} />}
    </div>
  );
}

function StudioPromptInput({ value, mentions, assets, references, capabilities, isVideo, disabled, onChange, onMention }) {
  const input = React.useRef(null), composing = React.useRef(false), pendingCaret = React.useRef(null), dismissed = React.useRef(null);
  const [query, setQuery] = React.useState(null), [active, setActive] = React.useState(0);
  const supportsImages = capabilities.kinds.includes('image');
  const options = assets.filter(asset => asset.kind === 'image' && (!query?.query || (asset.title || '').toLowerCase().includes(query.query.toLowerCase()) || (mentions.find(item => item.assetId === asset.id)?.alias || '图片').includes(query.query)));
  const full = references.length >= capabilities.maxRefs || references.filter(asset => asset.kind === 'image').length >= (capabilities.maxByKind?.image ?? Infinity);
  const available = options.filter(asset => supportsImages && (!full || references.some(ref => ref.id === asset.id)));
  const current = available[Math.min(active, Math.max(0, available.length - 1))];
  const open = Boolean(query) && !disabled;
  function updateQuery(node) {
    const closed = dismissed.current;
    const next = composing.current || document.activeElement !== node || (closed?.value === node.value && closed.start === node.selectionStart && closed.end === node.selectionEnd) ? null : studioMentionQuery(node.value, node.selectionStart, node.selectionEnd);
    if (next?.start !== query?.start || next?.end !== query?.end || next?.query !== query?.query) { setQuery(next); setActive(0); }
  }
  function insert(asset) {
    const next = insertStudioMention(value, query, asset.id, mentions);
    pendingCaret.current = next.caret;
    onMention(asset, next); setQuery(null);
  }
  React.useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    const caret = pendingCaret.current; pendingCaret.current = null;
    input.current?.focus(); input.current?.setSelectionRange(caret, caret);
  }, [value]);
  React.useEffect(() => {
    if (open && current) document.getElementById('studio-mention-' + current.id)?.scrollIntoView({ block: 'nearest' });
  }, [open, current?.id]);
  return <div className="studio-prompt-input">
    <textarea ref={input} id="studio-prompt" className="input" value={value} disabled={disabled} rows="6"
      placeholder={isVideo ? '描述画面、主体动作和镜头运动…' : '描述主体、场景、构图和光线…'}
      aria-describedby="studio-mention-hint" aria-autocomplete="list" aria-controls={open ? 'studio-mention-list' : undefined} aria-expanded={open}
      aria-activedescendant={open && current ? 'studio-mention-' + current.id : undefined}
      onChange={event => { dismissed.current = null; onChange(event.target.value); updateQuery(event.target); }}
      onSelect={event => updateQuery(event.target)} onBlur={() => setQuery(null)}
      onCompositionStart={() => { composing.current = true; setQuery(null); }} onCompositionEnd={event => { composing.current = false; updateQuery(event.target); }}
      onKeyDown={event => {
        if (!open || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissed.current = { value, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; setQuery(null); }
        else if (available.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length); }
        else if (event.key === 'Enter' && current) { event.preventDefault(); insert(current); }
      }} />
    <p id="studio-mention-hint" className="studio-mention-hint">输入 @ 引用图片，所选图片会自动加入参考素材。</p>
    {open && <div className="studio-mention-popover">
      <div className="studio-mention-heading">引用图片<span>↑ ↓ 选择 · Enter 插入 · Esc 关闭</span></div>
      <div id="studio-mention-list" role="listbox" aria-label="可引用图片" className="studio-mention-list">
        {supportsImages && options.map(asset => {
          const added = references.some(ref => ref.id === asset.id), locked = full && !added;
          return <button type="button" role="option" id={'studio-mention-' + asset.id} key={asset.id} aria-selected={current?.id === asset.id} disabled={locked}
            onMouseDown={event => event.preventDefault()} onClick={() => insert(asset)}>
            <img src={`/api/media/assets/${asset.id}/preview`} alt="" loading="lazy" />
            <span>{asset.title || '未命名图片'}</span><small>{locked ? '参考已满' : added ? '已添加' : '加入参考'}</small>
          </button>;
        })}
      </div>
      {(!supportsImages || !options.length) && <p className="studio-mention-empty">{!supportsImages ? '此模式仅支持文字，请先切换到支持参考图片的模式。' : '没有匹配的图片，可先上传图片，或更换关键词。'}</p>}
    </div>}
  </div>;
}

function StudioReferencePicker({ assets, references, capabilities, search, onSearch, onToggle, onClose, disabled = false }) {
  const [previewId, setPreviewId] = React.useState('');
  const kinds = { image: '图片', video: '视频', audio: '音频' };
  const available = assets.filter(asset => capabilities.kinds.includes(asset.kind));
  const filtered = available.filter(asset => (asset.title || '').toLowerCase().includes(search.trim().toLowerCase()));
  const preview = available.find(asset => asset.id === previewId);
  const selectedIds = new Set(references.map(asset => asset.id));
  return <DetailDrawer id="studio-reference-picker" title="选择参考素材" className="studio-reference-drawer" onClose={onClose}>
    <div className="studio-material-tools">
      <div className="studio-material-toolbar">
        <label className="sr-only" htmlFor="studio-reference-search">搜索参考素材</label>
        <input id="studio-reference-search" className="input" type="search" autoFocus placeholder="搜索素材名称" value={search} onChange={event => onSearch(event.target.value)} />
      </div>
      <p className="studio-material-hint">选择后直接加入当前草稿，可继续选择或预览素材。</p>
    </div>
      {preview && <section className={'studio-material-preview is-' + preview.kind} aria-label="素材预览">
        <div className="studio-material-preview-head"><strong>{preview.title || '未命名素材'}</strong><button type="button" className="btn btn-ghost" onClick={() => setPreviewId('')}>关闭素材预览</button></div>
        <div className="studio-material-stage"><MediaAssetPreview key={preview.id} asset={preview} preload="metadata" /></div>
      </section>}
    <div className="detail-drawer-body studio-material-body">
      <div className="studio-material-groups">
        {Object.entries(kinds).map(([kind, label]) => {
          const group = filtered.filter(asset => asset.kind === kind);
          return group.length ? <section key={kind} className={'studio-material-group is-' + kind} aria-label={label + '素材'}>
            <header className="studio-material-group-head"><h3>{label}</h3><span>{group.length} 项</span></header>
            <div className="studio-material-grid">{group.map(asset => {
          const selected = selectedIds.has(asset.id);
          const full = references.length >= capabilities.maxRefs || (capabilities.maxByKind?.[asset.kind] != null && references.filter(ref => ref.kind === asset.kind).length >= capabilities.maxByKind[asset.kind]);
          const title = asset.title || '未命名素材';
          return <article className={'studio-material-card' + (selected ? ' is-selected' : '')} key={asset.id}>
            <button type="button" className="studio-material-select" aria-label={'选择参考 ' + title} aria-pressed={selected} disabled={disabled || (!selected && full)} onClick={() => onToggle(asset)}>
              <span className="studio-material-thumb">
                {asset.kind === 'image' ? <img src={`/api/media/assets/${asset.id}/preview`} alt="" loading="lazy" decoding="async" />
                  : asset.kind === 'video' ? <video src={mediaFileUrl(asset) + '#t=0.1'} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1} /> : <span className="studio-material-audio" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 13v6m5-11v16m5-20v24m5-19v14m5-10v6" /></svg></span>}
                <span className="studio-material-check" aria-hidden="true">{selected ? '✓' : ''}</span>
              </span>
              <span className="studio-material-name" title={title}>{title}</span>
            </button>
            <button type="button" className="btn btn-ghost studio-material-preview-button" aria-label={'预览素材 ' + title} onClick={() => setPreviewId(asset.id)}>预览</button>
          </article>;
        })}</div>
          </section> : null;
        })}
      </div>
      {!filtered.length && <div className="studio-material-empty" role="status">
        <strong>{search.trim() ? '没有找到匹配的素材' : '还没有可用素材'}</strong>
        <p>{search.trim() ? '试试其他关键词。' : '关闭此面板后，可在当前编辑区上传参考文件。'}</p>
        {search.trim() && <button type="button" className="btn" onClick={() => onSearch('')}>清除筛选</button>}
      </div>}
    </div>
    <footer className="studio-material-footer"><span role="status">已选 <strong>{references.length}</strong> / {capabilities.maxRefs} 项</span><button type="button" className="btn btn-primary" onClick={onClose}>完成选择</button></footer>
  </DetailDrawer>;
}

function MediaAssetPreview({ asset, preload = "none" }) {
  const [originalId, setOriginalId] = React.useState('');
  if (asset.kind === "image") return <div style={{position:'relative',width:'100%',height:'inherit',maxHeight:'inherit',minHeight:0}}>
    <img src={originalId === asset.id ? mediaFileUrl(asset) : `/api/media/assets/${asset.id}/preview`} alt={asset.title} decoding="async" />
    <button type="button" className="btn media-original-toggle" data-glass="lens" style={{position:'absolute',right:12,bottom:12}} onClick={() => setOriginalId(originalId === asset.id ? '' : asset.id)}>{originalId === asset.id ? '返回预览图' : '查看原图'}</button>
  </div>;
  if (asset.kind === "video") return <video src={mediaFileUrl(asset) + (preload === "metadata" ? "#t=0.1" : "")} controls playsInline preload={preload} />;
  return <audio src={mediaFileUrl(asset)} controls preload={preload} />;
}

// Whether a server-side file has been backed up to cloud storage.
const MEDIA_STORAGE_LABELS = { local: "已保存到服务器", pending: "正在保存到云端…", stored: "已保存到云端", failed: "云端保存失败" };
function mediaStorageState(asset) {
  const state = asset?.storageState ?? asset?.storage?.state;
  return MEDIA_STORAGE_LABELS[state] ? state : null;
}

function MediaAssetsView({ assets, jobs, query, onCreate, onContinue, onUpdated, showToast, openAssetId, onOpenAssetHandled, allowExternal = true }) {
  const [selected, setSelected] = useMediaState(null);
  const [retryingIds, setRetryingIds] = useMediaState([]);
  useMediaEffect(() => {
    if (!assets.some(asset => asset.origin !== "reference" && mediaStorageState(asset) === "pending")) return;
    const timer = setInterval(() => { Promise.resolve(onUpdated()).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [assets, onUpdated]);
  const [filter, setFilter] = useMediaState("all");
  const [sort, setSort] = useMediaState("newest");
  const [editing, setEditing] = useMediaState(false);
  const [form, setForm] = useMediaState({ title: "", note: "", tags: "", rating: 0 });
  const [compareIds, setCompareIds] = useMediaState([]);
  const [compareOpen, setCompareOpen] = useMediaState(false);
  const [jobDetails, setJobDetails] = useMediaState({});
  const uploadInput = useMediaRef(null);
  useMediaEffect(() => {
    if (!openAssetId) return;
    const asset = assets.find((item) => item.id === openAssetId);
    if (asset) { setSelected(asset); onOpenAssetHandled?.(); }
  }, [openAssetId, assets]);
  useMediaEffect(() => {
    if (!selected) return;
    const newer = assets.find((asset) => asset.id === selected.id);
    if (newer) setSelected(newer);
  }, [assets]);
  useMediaEffect(() => {
    if (selected) setForm({ title: selected.title, note: selected.note, tags: selected.tags, rating: selected.rating });
    setEditing(false);
  }, [selected?.id]);
  useMediaEffect(() => {
    // Removed works cannot stay in the comparison.
    setCompareIds((ids) => ids.filter((id) => assets.some((asset) => asset.id === id)));
  }, [assets]);
  const jobFor = (asset) => asset?.jobId ? (jobs || []).find((job) => job.id === asset.jobId) || jobDetails[asset.jobId] || null : null;
  // A failed read is remembered as null so it is not retried in a loop.
  const wantedJobIds = [selected, ...(compareOpen ? mediaComparePair(compareIds, assets) : [])]
    .filter((asset) => asset?.jobId && !jobFor(asset) && !(asset.jobId in jobDetails)).map((asset) => asset.jobId);
  useMediaEffect(() => {
    // Read the stored request through the owner-scoped GET /api/media/jobs/:id route.
    let cancelled = false;
    for (const jobId of new Set(wantedJobIds)) {
      api(`/api/media/jobs/${jobId}`).then((job) => {
        if (!cancelled) setJobDetails((current) => ({ ...current, [jobId]: job }));
      }).catch(() => { if (!cancelled) setJobDetails((current) => ({ ...current, [jobId]: null })); });
    }
    return () => { cancelled = true; };
  }, [wantedJobIds.join(",")]);
  async function upload(files) {
    if (!files?.length) return;
    try {
      for (const file of files) await uploadMediaFile(file);
      await onUpdated();
      showToast(`已上传 ${files.length} 个文件`);
    } catch (error) { showToast(error.message); }
    finally { if (uploadInput.current) uploadInput.current.value = ""; }
  }
  async function save() {
    try {
      const asset = await api(`/api/media/assets/${selected.id}`, { method: "PATCH", body: form });
      setSelected(asset);
      setEditing(false);
      await onUpdated();
      showToast("作品信息已保存");
    } catch (error) { showToast(error.message); }
  }
  async function retryStorage(asset) {
    // Only retries cloud storage for the existing server-side file; nothing is generated.
    if (retryingIds.includes(asset.id)) return;
    setRetryingIds((ids) => [...ids, asset.id]);
    try {
      await api(`/api/media/assets/${asset.id}/storage/retry`, { method: "POST" });
      await onUpdated();
      showToast(`已安排上传云端：${asset.title}`);
    } catch (error) { showToast(error.message); }
    finally { setRetryingIds((ids) => ids.filter((id) => id !== asset.id)); }
  }
  const storageRetry = (asset) => ["local", "failed"].includes(mediaStorageState(asset)) &&
    <button type="button" className="btn btn-ghost media-storage-retry" disabled={retryingIds.includes(asset.id)}
      aria-label={`重试云端保存：${asset.title}`} onClick={() => retryStorage(asset)}>{retryingIds.includes(asset.id) ? "上传中…" : "上传云端"}</button>;
  function continueWith(asset, targetModule) {
    const job = jobFor(asset);
    // The third argument is the owner-scoped stored request. App routing can
    // preserve it while moving to the studio; no generation parameter is
    // reconstructed from the rendered asset.
    onContinue(asset, targetModule, job || null);
    setSelected(null);
    setCompareOpen(false);
  }
  const works = assets.filter((asset) => asset.origin !== "reference");
  const visible = works.filter((asset) => {
    if (filter === "image" && asset.kind !== "image") return false;
    if (filter === "video" && asset.kind !== "video") return false;
    if (filter === "upload" && asset.origin !== "upload") return false;
    const q = String(query || "").trim().toLowerCase();
    return !q || `${asset.title} ${asset.note} ${asset.tags} ${asset.prompt} ${asset.model}`.toLowerCase().includes(q);
  }).sort((a, b) => sort === "rating"
    ? b.rating - a.rating || b.createdAt.localeCompare(a.createdAt)
    : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const comparePair = mediaComparePair(compareIds, assets);
  const lineage = selected ? mediaLineageChain(selected.id, assets) : [];
  const children = selected ? mediaChildren(selected.id, assets) : [];
  const selectedJob = jobFor(selected);
  const continueActions = (asset) => asset.kind === "image" ? <React.Fragment>
    <button className="btn btn-primary" onClick={() => continueWith(asset, "image")}>{allowExternal ? '以图改图' : '复用文字提示词'}</button>
    {allowExternal && <button className="btn" onClick={() => continueWith(asset, "seedance")}>用此图生成视频</button>}
  </React.Fragment> : <button className="btn btn-primary" onClick={() => continueWith(asset, "seedance")}>继续创作</button>;
  const paramList = (job) => <dl className="media-param-list">{mediaJobParams(job).map(([key, value]) =>
    <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
  return (
    <div className="media-library">
      <div className="media-library-toolbar">
        <div className="media-filter-row">
          {[["all", "全部"], ["image", "图片"], ["video", "视频"], ["upload", "上传"]].map(([id, label]) =>
            <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}
          <InlineSelect className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">按时间</option><option value="rating">按评分</option>
          </InlineSelect>
        </div>
        <div className="media-library-actions">{works.some(a => ["local","failed"].includes(mediaStorageState(a))) && <button className="btn" disabled={retryingIds.length > 0} onClick={async () => { for (const asset of works.filter(a => ["local","failed"].includes(mediaStorageState(a)))) await retryStorage(asset); }}>{retryingIds.length ? "正在上传…" : "批量上传云端"}</button>}{allowExternal && <button className="btn" onClick={() => uploadInput.current?.click()}>导入文件</button>}</div>
        <input ref={uploadInput} hidden type="file" multiple accept="image/*,video/mp4,audio/mpeg,audio/wav"
          onChange={(e) => upload(e.target.files)} />
      </div>
      {compareIds.length > 0 && <div className="media-compare-bar" role="status">
        <span>{compareIds.length === 2 ? "已选 2 个结果" : "再选 1 个结果即可并排对比"}</span>
        <button type="button" className="btn btn-primary" disabled={comparePair.length !== 2} onClick={() => setCompareOpen(true)}>并排对比</button>
        <button type="button" className="btn btn-ghost" onClick={() => { setCompareIds([]); setCompareOpen(false); }}>清除</button>
      </div>}
      {visible.length === 0 ? <EmptyState message="还没有匹配的作品"
        hint={allowExternal ? "上传已有图片或视频，也可以从提示词与 X 收藏进入创作台" : '从创作台提交本机生图任务，完成后会出现在这里'} /> :
        <MediaJustifiedGallery>{visible.map((asset) => <div key={asset.id} className={"media-card-wrap" + (compareIds.includes(asset.id) ? " is-compared" : "")}>
          <button className="media-card" onClick={() => setSelected(asset)}>
          <div className="media-card-preview">
            {asset.kind === "image" ? <img src={`/api/media/assets/${asset.id}/preview`} alt={asset.title} loading="lazy" decoding="async" /> :
              asset.kind === "video" ? <span aria-label="视频，点击查看">视频</span> :
                <span>音频</span>}
            {asset.kind === "video" && <span className="media-play-marker">▶</span>}
          </div>
          <strong>{asset.title}</strong>
          {asset.prompt && <small className="media-card-prompt">{asset.prompt}</small>}
          {mediaVersionLabel(asset, assets) && <small className="media-card-lineage">{mediaVersionLabel(asset, assets)}</small>}
          {mediaStorageState(asset) === "pending" && <small className="media-card-storage">正在上传云端…</small>}
          </button>
          <label className="media-compare-pick">
            <input type="checkbox" checked={compareIds.includes(asset.id)} onChange={() => setCompareIds((ids) => mediaToggleCompare(ids, asset.id))}
              aria-label={`加入对比：${asset.title}`} />对比
          </label>
          {storageRetry(asset)}
        </div>)}</MediaJustifiedGallery>}
      {compareOpen && comparePair.length === 2 && <DetailDrawer title="并排对比" className="media-compare-drawer" onClose={() => setCompareOpen(false)}>
        <div className="detail-drawer-body media-compare-grid">
          {comparePair.map((asset) => {
            const job = jobFor(asset);
            return <section key={asset.id} className="media-compare-item">
              <div className="media-detail-preview"><MediaAssetPreview asset={asset} /></div>
              <strong>{asset.title}</strong>
              <small>{asset.origin === "generated" ? asset.model : "手动上传"} · {asset.createdAt}</small>
              {asset.prompt && <p className="media-result-prompt">{asset.prompt}</p>}
              {job && paramList(job)}
              <div className="media-detail-actions">
                <a className="btn" href={mediaFileUrl(asset, true)}>下载</a>
                {continueActions(asset)}
              </div>
            </section>;
          })}
        </div>
      </DetailDrawer>}
      {selected && <DetailDrawer title="素材详情" className="media-asset-detail" onClose={() => setSelected(null)}>
          <div className="detail-drawer-body">
            <h2>{selected.title}</h2>
            <div className="media-detail-preview"><MediaAssetPreview asset={selected} /></div>
            <div className="media-detail-actions">
              <a className="btn" href={mediaFileUrl(selected)} target="_blank" rel="noopener noreferrer">原尺寸查看</a>
              <a className="btn" href={mediaFileUrl(selected, true)}>下载文件</a>
              {continueActions(selected)}
              <button className="btn btn-ghost" onClick={() => setCompareIds((ids) => mediaToggleCompare(ids, selected.id))}>{compareIds.includes(selected.id) ? "移出对比" : "加入对比"}</button>
            </div>
            {editing ? <div className="media-edit-fields">
              <label>标题<input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <label>标签<input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
              <label>评分<InlineSelect className="select" value={form.rating} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })}>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "未评分" : `${n} 星`}</option>)}
              </InlineSelect></label>
              <label>备注<textarea className="input" rows="4" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
              <button className="btn btn-primary" onClick={save}>保存</button>
            </div> : <div className="media-detail-meta">
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>编辑标题、标签和评分</button>
              {mediaStorageState(selected) && <p className="media-storage-status" data-state={mediaStorageState(selected)}>{MEDIA_STORAGE_LABELS[mediaStorageState(selected)]} {storageRetry(selected)}</p>}
              {selected.rating > 0 && <p>评分：{selected.rating} 星</p>}
              {selected.tags && <p>标签：{selected.tags}</p>}
              {selected.note && <p>备注：{selected.note}</p>}
            </div>}
            {selected.prompt && <div className="media-detail-section"><strong>本次提示词</strong><p>{selected.prompt}</p></div>}
            {selected.model && <div className="media-detail-section"><strong>使用模型</strong><p>{selected.model}</p></div>}
            {selected.jobId && <div className="media-detail-section"><strong>生成参数</strong>
              {selectedJob ? paramList(selectedJob)
                : jobDetails[selected.jobId] === null ? <p>生成任务记录暂时无法读取</p> : <LoadingSkeleton variant="compact" count={2} label="正在读取生成任务记录" />}
            </div>}
            {mediaSafeSourceUrl(selected.sourceUrl) && <div className="media-detail-section"><strong>原始来源</strong>
              <a href={mediaSafeSourceUrl(selected.sourceUrl)} target="_blank" rel="noopener noreferrer">{mediaSafeSourceUrl(selected.sourceUrl)}</a></div>}
            {lineage.length > 1 && <div className="media-detail-section"><strong>版本链 · {lineage.length} 版</strong>
              <ol className="media-lineage">{lineage.map((asset, index) => <li key={asset.id}>
                {asset.id === selected.id ? <span aria-current="true">第 {index + 1} 版 · 当前</span>
                  : <button className="btn btn-ghost" onClick={() => setSelected(asset)}>第 {index + 1} 版 · {asset.title}</button>}
              </li>)}</ol></div>}
            {selected.parentAssetId && lineage.length < 2 && <div className="media-detail-section"><strong>上一版本</strong>
              <p>上一版本已不在作品库中。</p></div>}
            {children.length > 0 && <div className="media-detail-section"><strong>后续版本</strong>
              <div>{children.map((child) =>
                <button key={child.id} className="btn" onClick={() => setSelected(child)}>{child.title}</button>)}</div>
            </div>}
          </div>
      </DetailDrawer>}
    </div>
  );
}
