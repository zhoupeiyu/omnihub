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

function mediaFileUrl(asset, download = false) {
  return `/api/media/assets/${asset.id}/${download ? "download" : "file"}`;
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
    {loading ? <p>正在读取设备…</p> : <div className="device-list">{rows.length ? rows.map(d => {
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

function MediaStudioView({ userId, draft, assets, jobs, configVersion, allowExternal = true, onAssetsChanged, onJobsChanged, onOpenSettings, onShowAsset, showToast }) {
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
  const [aspectRatio, setAspectRatio] = useMediaState(initial.aspectRatio);
  const [size, setSize] = useMediaState(initial.size);
  const [duration, setDuration] = useMediaState(initial.duration);
  const [resolution, setResolution] = useMediaState(initial.resolution);
  const [faceProcessing, setFaceProcessing] = useMediaState(initial.faceProcessing);
  const [referenceIds, setReferenceIds] = useMediaState(initial.referenceIds);
  const [acceptedCost, setAcceptedCost] = useMediaState(false);
  const [busy, setBusy] = useMediaState(false);
  const [uploading, setUploading] = useMediaState(false);
  const [source, setSource] = useMediaState(initial.source);
  const [config, setConfig] = useMediaState(null);
  const [submitError, setSubmitError] = useMediaState("");
  const [jobErrors, setJobErrors] = useMediaState({});
  const [previewId, setPreviewId] = useMediaState("");
  const [studioView, setStudioView] = useMediaState("input");
  const uploadInput = useMediaRef(null);
  const submitKey = useMediaRef(initial.requestKey || null);

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
    setAspectRatio(next.aspectRatio); setSize(next.size); setDuration(next.duration); setResolution(next.resolution);
    setFaceProcessing(next.faceProcessing); setReferenceIds(next.referenceIds); setSource(next.source);
    setAcceptedCost(false); setSubmitError(""); setSubmittedJobId(next.submittedJobId);
    submitKey.current = next.requestKey || null;
  }
  useMediaEffect(() => {
    if (draft?.key && draft.key !== consumedKey) applyDraft(resolveStudioDraft(null,draft,allowExternal));
  }, [draft?.key]);
  const editableDraft = {consumedKey,generationRoute,deviceId,module,model,mode,title,prompt,aspectRatio,size,duration,resolution,faceProcessing,referenceIds,source};
  const fingerprint = JSON.stringify(editableDraft);
  const previousFingerprint = useMediaRef(fingerprint);
  React.useLayoutEffect(() => {
    const changed = previousFingerprint.current !== fingerprint;
    if (changed) {
      submitKey.current = null; setSubmittedJobId(''); setAcceptedCost(false); setSubmitError('');
      previousFingerprint.current = fingerprint;
    }
    setDraftSaved(writeStudioDraft(userId,{...editableDraft,requestKey:submitKey.current || '',submittedJobId:changed ? '' : submittedJobId}));
  }, [fingerprint,submittedJobId,userId]);
  function newDraft() {
    if (studioDraftHasContent(editableDraft) && !confirm('新建会清空当前草稿，已保存的作品不受影响。继续吗？')) return;
    applyDraft(normalizeStudioDraft({consumedKey},allowExternal));
  }

  function changeModule(next) {
    setModule(next);
    setModel(MEDIA_MODEL_OPTIONS[next][0]);
    setMode(MEDIA_MODES[next][0].id);
    setAspectRatio(next === "image" ? "auto" : "adaptive");
    setReferenceIds([]);
    setAcceptedCost(false);
    submitKey.current = null;
  }

  function toggleReference(id) {
    setReferenceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    submitKey.current = null;
  }

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
    if (next.prompt) setPrompt(next.prompt);
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
    if (useLocal && (referenceIds.length || source?.parentAssetId)) {
      setSubmitError('本机生图暂不支持参考图编辑。请明确改为仅使用文字，或选择支持参考图的媒体 API。'); return;
    }
    const key = submitKey.current || crypto.randomUUID();
    submitKey.current = key;
    setDraftSaved(writeStudioDraft(userId,{...editableDraft,requestKey:key}));
    setBusy(true);
    setSubmitError("");
    try {
      const faceProcessingList = faceProcessing ? referenceIds.map((id) => assets.find((a) => a.id === id))
        .filter(Boolean).reduce((all, asset) => {
          const count = referenceIds.slice(0, referenceIds.indexOf(asset.id) + 1)
            .map((ref) => assets.find((a) => a.id === ref)).filter((row) => row?.kind === asset.kind).length;
          if (asset.kind === "image") all.push(`图片${count}`);
          if (asset.kind === "video") all.push(`视频${count}`);
          return all;
        }, []) : [];
      const job = await api(useLocal ? '/api/local-image/jobs' : "/api/media/jobs", { method: "POST", body: {
        requestKey: key, module, model, mode, title: title.trim(), prompt: prompt.trim(),
        aspectRatio, size, duration: Number(duration), resolution,
        faceProcessing: Number(faceProcessing), faceProcessingList,
        referenceAssetIds: referenceIds,
        sourceType: source?.sourceType || "", sourceId: source?.sourceId || null,
        parentAssetId: source?.parentAssetId || "",
        acceptUnknownCost: true,
        ...(useLocal ? {acceptCodexUsage:true, deviceId} : {}),
      } });
      // Keep the accepted request identity so remount/reload cannot create a duplicate task.
      const current = readStudioDraft(userId);
      if (current?.requestKey === key) {
        writeStudioDraft(userId,{...current,submittedJobId:job.id});
        if (mounted.current) { setSubmittedJobId(job.id); setAcceptedCost(false); }
      }
      await onJobsChanged().catch(() => showToast('任务已创建，任务列表暂未刷新，请稍后查看。'));
      if (mounted.current) setStudioView("jobs");
      showToast(job.status === "failed" || job.status === "needs_review" ? job.error : "生成任务已创建");
    } catch (error) {
      // Keep the request key until the user changes the draft: a network timeout may have created the upstream task.
      setSubmitError(`${error.message}。可再次提交；系统会使用同一个请求标识核对是否已创建任务。`);
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
  const refs = assets.filter((asset) => referenceIds.includes(asset.id));
  const isVideo = module !== "image";
  const useLocal = !isVideo && generationRoute === 'local';
  const localReferenceBlocked = useLocal && (referenceIds.length > 0 || Boolean(source?.parentAssetId));
  const defaultDevice = localDevices.find(d => d.isDefault) || localDevices[0];
  const relevantAssets = assets.filter((asset) => asset.kind === "image" || (isVideo && ["video", "audio"].includes(asset.kind)));
  const recentJobs = jobs.slice(0, 12);
  const mediaConfigured = Boolean(config?.hasAuthentication && config?.baseUrl);
  const latestAsset = mediaLatestSuccess(jobs, assets);
  const pickedAsset = previewId ? assets.find((asset) => asset.id === previewId) : null;
  const previewAsset = pickedAsset || latestAsset;
  const previewJob = previewAsset ? jobs.find((job) => job.assetId === previewAsset.id) : null;
  const activeJobCount = recentJobs.filter((job) => MEDIA_ACTIVE_STATUSES.has(job.status) || ["local_queued", "local_claimed", "submitting"].includes(job.status)).length;
  const studioTabs = [["input", "输入"], ["jobs", `任务${activeJobCount ? ` · ${activeJobCount}` : ""}`], ["result", "结果"]];
  return (
    <div className="media-studio">
      <div className="media-page-head">
        <div><h1>创作台</h1><p>从收藏或提示词开始生成，结果自动回到作品库。</p></div>
        <div className="media-draft-actions"><button className="btn btn-ghost" disabled={busy || uploading} onClick={newDraft}>新建草稿</button><button className="btn" onClick={() => onOpenSettings("devices")}><IconSettings />设置</button></div>
      </div>
      <div className="media-studio-tabs" role="tablist" aria-label="创作台视图">
        {studioTabs.filter(([id]) => id !== "jobs" || recentJobs.length > 0).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={studioView === id}
          className={studioView === id ? "active" : ""} onClick={() => setStudioView(id)}>{label}</button>)}
      </div>
      <div className="media-studio-layout has-result" data-view={studioView}>
        <section className="media-compose">
          <p className="media-draft-status" role="status">{draftSaved ? '草稿自动保存在当前浏览器 · 仅当前账号可见' : '浏览器存储不可用，草稿暂存于本次页面；刷新前请复制提示词。'}</p>
          <fieldset className="media-draft-fields" disabled={busy}>
          {source && <details className="media-source-box">
            <summary><span>{MEDIA_SOURCE_LABELS[source.sourceType] || "作品"} · 来源</span><strong>{source.title || "未命名内容"}</strong></summary>
            <div>{source.url && <a href={source.url} target="_blank" rel="noopener noreferrer">打开原链接 ↗</a>}
              {source.parentAssetId && <span className="media-lineage-note">基于作品继续：生成结果会记录上一版本</span>}</div>
          </details>}
          {sourceImages.length > 0 && <details className="media-source-gallery">
            <summary>原帖效果图 · {sourceImages.length} 张</summary>
            <div>{sourceImages.map((url, index) => <div key={index}>
              <img src={url} alt={`效果图 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" />
              {!useLocal && <button className="btn" onClick={() => importSource(index)} disabled={uploading}>用作参考图</button>}
            </div>)}</div>
          </details>}
          <label className="media-field media-prompt-field">提示词<textarea className="input" rows="8" value={prompt} placeholder="描述希望生成的画面或视频；未配置服务时也可以先在这里整理草稿"
            onChange={(e) => { setPrompt(e.target.value); submitKey.current = null; }} /></label>
          <div className="media-tool-row" role="group" aria-label="生成工具">
            {!isVideo && allowExternal && <label>生成方式<select className="select" value={generationRoute} onChange={e => setGenerationRoute(e.target.value)}><option value="local">本机 Codex</option><option value="api">第三方媒体 API（单独计费）</option></select></label>}
            <label>生成类型<select className="select" value={module} onChange={(e) => changeModule(e.target.value)}>
              <option value="image">图片</option>{allowExternal && <><option value="seedance">视频 · Seedance</option>
              <option value="hh1">视频 · Happy Horse</option><option value="wan3">视频 · Wan 3</option></>}
            </select></label>
            {!useLocal && <label>模型<select className="select" value={model} onChange={(e) => {
              const next = e.target.value;
              setModel(next);
              if (next === "seedream-5.0-pro") {
                if (["auto", "5:4", "4:5"].includes(aspectRatio)) setAspectRatio("1:1");
                if (size === "4k") setSize("2k");
              }
            }}>
              {MEDIA_MODEL_OPTIONS[module].map((name) => <option key={name} value={name}>{name}</option>)}
            </select></label>}
            {useLocal && <label>执行设备<select className="select" value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">默认设备{defaultDevice?.label ? ` · ${defaultDevice.label}` : ''}</option>{localDevices.map(d => <option value={d.id} key={d.id}>{d.label}</option>)}</select></label>}
            {isVideo && <label>创作模式<select className="select" value={mode} onChange={(e) => { setMode(e.target.value); submitKey.current = null; }}>
              {MEDIA_MODES[module].map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select></label>}
          </div>
          <details className="media-advanced">
            <summary>高级设置<span>比例、清晰度与输出参数</span></summary>
            <div className="media-form-grid">
            <label>画面比例<select className="select" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {(module === "image" ? ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
                : ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"]).map((ratio) => <option key={ratio}>{ratio}</option>)}
            </select></label>
            {module === "image" ? (!useLocal && model !== "gpt-image-2" && <label>清晰度<select className="select" value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="1k">1K</option><option value="2k">2K</option>
              {model !== "seedream-5.0-pro" && <option value="4k">4K</option>}
            </select></label>) : <React.Fragment>
              {mode !== "video_edit" && <label>时长（秒）<input className="input" type="number" min="2" max="30" value={duration}
                onChange={(e) => setDuration(e.target.value)} /></label>}
              {module !== "hh1" && <label>分辨率<select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option>480p</option><option>720p</option>{module === "wan3" && <option>1080p</option>}
              </select></label>}
            </React.Fragment>}
            </div>
          </details>
          <details className="media-title-field">
            <summary>作品标题 <span>可选</span></summary>
            <label className="media-field"><span className="sr-only">作品标题</span><input className="input" value={title} maxLength="160" placeholder="给这次生成取个容易找回的名字"
            onChange={(e) => { setTitle(e.target.value); submitKey.current = null; }} /></label>
          </details>
          {(!useLocal || referenceIds.length > 0) && <details key={consumedKey} className="media-reference-panel" open={referenceIds.length > 0 || undefined}>
            <summary>参考素材 <span>{referenceIds.length ? `已选 ${referenceIds.length} 项` : "按需添加"}</span></summary>
            <div className="media-reference-head">
              <strong>已选素材会随这次任务保存</strong>
              <button className="btn" onClick={() => uploadInput.current?.click()} disabled={uploading}>+ 上传图片／视频／音频</button>
            </div>
            <input ref={uploadInput} type="file" accept="image/*,video/mp4,audio/mpeg,audio/wav" multiple hidden
              onChange={(e) => uploadFiles(e.target.files)} />
          <div className="media-reference-picker">
            {relevantAssets.length === 0 && <p>还没有参考素材。可上传文件，或从上方效果图导入。</p>}
            {relevantAssets.map((asset) => <button key={asset.id} type="button"
              className={referenceIds.includes(asset.id) ? "selected" : ""}
              onClick={() => toggleReference(asset.id)} title={asset.title}>
              {asset.kind === "image" ? <img src={mediaFileUrl(asset)} alt="" loading="lazy" /> : <span>{asset.kind === "video" ? "视频" : "音频"}</span>}
              <small>{asset.title}</small>
            </button>)}
          </div>
          </details>}
          {module === "seedance" && mode !== "text_video" && <label className="media-field">含人脸素材的处理方式
            <select className="select" value={faceProcessing} onChange={(e) => setFaceProcessing(Number(e.target.value))}>
              <option value="0">不含人脸／不开启</option><option value="1">快速处理</option>
              <option value="2">精细处理</option><option value="3">最大程度还原</option>
            </select>
          </label>}
          <div className="media-submit">
            {submittedJobId && <p role="status">这份草稿已提交。修改内容后可再次生成，或新建草稿。</p>}
            {useLocal ? <React.Fragment>
              {localReferenceBlocked && <div className="media-config-callout" role="alert"><div><strong>当前草稿带有参考图，暂不能交给本机生成</strong><p>本机文字生图不会读取参考图。你可以明确只复用文字，或选择支持参考图的媒体 API。</p></div><button className="btn" onClick={() => {setReferenceIds([]);setSource(previous => previous ? {...previous,parentAssetId:''} : previous);setAcceptedCost(false);}}>仅使用文字，不使用参考图</button></div>}
              <p>电脑在线并运行接收程序后生成 1 张图片，结果自动存入私有作品库。当前支持文字生成，不会把来源效果图当作输入，也不支持参考图编辑。</p>
              <p className="muted">使用本机 Codex 用量，不是 ChatGPT 网页生图额度。不切换付费 API；套餐及 credits 的限制由本机检查，不满足条件时任务暂停。</p>
              {localError && <p className="media-error" role="alert">{localError}<button className="btn btn-ghost" onClick={loadLocalDevices}>重试</button></p>}
              {!localDevices.length ? <button className="btn" onClick={() => onOpenSettings("devices")}>配对我的电脑</button> : <React.Fragment>
                <label className="media-inline-check"><input type="checkbox" checked={acceptedCost} onChange={e => setAcceptedCost(e.target.checked)} />确认使用我自己的本机 Codex 用量生成 1 张</label>
                <button className="btn btn-primary" disabled={busy || !acceptedCost || !prompt.trim() || localReferenceBlocked || Boolean(submittedJobId)} onClick={submit}>{busy ? '提交中…' : '交给本机生成'}</button>
              </React.Fragment>}
              {submitError && <p className="media-error" role="alert">{submitError}</p>}
            </React.Fragment> : !mediaConfigured ? <div className="media-config-callout"><div><strong>还没有可用的媒体服务</strong><p>可以继续编辑草稿、上传和整理素材。第三方 API 服务与 ChatGPT 授权额度互不相通。</p></div><button className="btn" onClick={onOpenSettings}>去配置</button></div> : <React.Fragment>
            <p>{config.baseUrl === "http://39.96.116.239:9001"
              ? "已连接媒体服务。认证将通过明文 HTTP 发送；生成可能消耗第三方服务额度，当前接口未提供价格。"
              : "已连接媒体服务。生成可能消耗第三方服务额度，当前接口未提供价格。"}</p>
            <label className="media-inline-check"><input type="checkbox" checked={acceptedCost}
              onChange={(e) => setAcceptedCost(e.target.checked)} />我确认提交本次生成，费用或额度消耗暂未公布</label>
            <button className="btn btn-primary" disabled={busy || !acceptedCost || !prompt.trim() || Boolean(submittedJobId)}
              onClick={submit}>{busy ? "提交中…" : module === "image" ? "生成图片" : "生成视频"}</button>
            {submitError && <p className="media-error" role="alert">{submitError}</p>}
            </React.Fragment>}
          </div>
          </fieldset>
        </section>
        <section className="media-result-preview" aria-label="结果预览">
          <div className="media-job-head"><h2>{pickedAsset ? "所选结果" : "最新结果"}</h2>
            {pickedAsset && <button type="button" className="btn btn-ghost" onClick={() => setPreviewId("")}>回到最新</button>}</div>
          {previewAsset ? <React.Fragment>
            <div className="media-result-stage"><MediaAssetPreview key={previewAsset.id} asset={previewAsset} /></div>
            <strong className="media-result-title">{previewAsset.title}</strong>
            <small className="media-result-meta">{previewJob ? (previewJob.module === 'codex-local' ? '本机 Codex' : `${previewJob.module} · ${previewJob.model}`) : previewAsset.model || "作品"} · {previewAsset.createdAt}</small>
            {previewAsset.prompt && <p className="media-result-prompt">{previewAsset.prompt}</p>}
            <div className="media-job-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => continueFromResult(previewAsset)}>{allowExternal && previewAsset.kind === "image" ? "基于此结果继续" : "复用提示词"}</button>
              <button type="button" className="btn" onClick={() => onShowAsset(previewAsset.id)}>查看作品</button>
              <a className="btn btn-ghost" href={mediaFileUrl(previewAsset, true)}>下载</a>
            </div>
          </React.Fragment> : <p className="media-result-empty">{activeJobCount ? `有 ${activeJobCount} 个任务进行中，完成并保存后会在这里显示。` : "还没有已保存的结果。成功的任务会自动显示在这里。"}</p>}
        </section>
        {recentJobs.length > 0 && <aside className="media-job-list">
          <div className="media-job-head"><h2>生成任务</h2><button className="btn btn-ghost" onClick={onJobsChanged}><IconRefresh />刷新</button></div>
          <div className="media-job-grid">
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
          </div>
        </aside>}
      </div>
    </div>
  );
}

function MediaAssetPreview({ asset }) {
  if (asset.kind === "image") return <img src={mediaFileUrl(asset)} alt={asset.title} />;
  if (asset.kind === "video") return <video src={mediaFileUrl(asset)} controls playsInline preload="metadata" />;
  return <audio src={mediaFileUrl(asset)} controls />;
}

function MediaAssetsView({ assets, jobs, query, onCreate, onContinue, onUpdated, showToast, openAssetId, onOpenAssetHandled, allowExternal = true }) {
  const [selected, setSelected] = useMediaState(null);
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
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">按时间</option><option value="rating">按评分</option>
          </select>
        </div>
        <div>{allowExternal && <button className="btn" onClick={() => uploadInput.current?.click()}>上传作品</button>}
          <button className="btn btn-primary" onClick={onCreate}>新建创作</button></div>
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
        <div className="media-gallery">{visible.map((asset) => <div key={asset.id} className={"media-card-wrap" + (compareIds.includes(asset.id) ? " is-compared" : "")}>
          <button className="media-card" onClick={() => setSelected(asset)}>
          <div className="media-card-preview">
            {asset.kind === "image" ? <img src={mediaFileUrl(asset)} alt={asset.title} loading="lazy" /> :
              asset.kind === "video" ? <video src={mediaFileUrl(asset)} preload="metadata" muted playsInline /> :
                <span>音频</span>}
            {asset.kind === "video" && <span className="media-play-marker">▶</span>}
          </div>
          <strong>{asset.title}</strong>
          <small>{asset.origin === "generated" ? asset.model : "手动上传"} · {asset.createdAt}</small>
          {asset.prompt && <small className="media-card-prompt">{asset.prompt}</small>}
          {mediaVersionLabel(asset, assets) && <small className="media-card-lineage">{mediaVersionLabel(asset, assets)}</small>}
          </button>
          <label className="media-compare-pick">
            <input type="checkbox" checked={compareIds.includes(asset.id)} onChange={() => setCompareIds((ids) => mediaToggleCompare(ids, asset.id))}
              aria-label={`加入对比：${asset.title}`} />对比
          </label>
        </div>)}</div>}
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
      {selected && <DetailDrawer title="素材详情" onClose={() => setSelected(null)}>
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
              <label>评分<select className="select" value={form.rating} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })}>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "未评分" : `${n} 星`}</option>)}
              </select></label>
              <label>备注<textarea className="input" rows="4" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
              <button className="btn btn-primary" onClick={save}>保存</button>
            </div> : <div className="media-detail-meta">
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>编辑标题、标签和评分</button>
              {selected.rating > 0 && <p>评分：{selected.rating} 星</p>}
              {selected.tags && <p>标签：{selected.tags}</p>}
              {selected.note && <p>备注：{selected.note}</p>}
            </div>}
            {selected.prompt && <div className="media-detail-section"><strong>本次提示词</strong><p>{selected.prompt}</p></div>}
            {selected.model && <div className="media-detail-section"><strong>使用模型</strong><p>{selected.model}</p></div>}
            {selected.jobId && <div className="media-detail-section"><strong>生成参数</strong>
              {selectedJob ? paramList(selectedJob)
                : <p>{jobDetails[selected.jobId] === null ? "生成任务记录暂时无法读取" : "正在读取生成任务记录…"}</p>}
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
