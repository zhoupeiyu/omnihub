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

function MediaStudioView({ draft, assets, jobs, configVersion, allowExternal = true, onAssetsChanged, onJobsChanged, onOpenSettings, onShowAsset, showToast }) {
  const [generationRoute, setGenerationRoute] = useMediaState('local');
  const [localDevices, setLocalDevices] = useMediaState([]);
  const [localError, setLocalError] = useMediaState('');
  const [deviceId, setDeviceId] = useMediaState('');
  const [showDevices, setShowDevices] = useMediaState(false);
  const [module, setModule] = useMediaState("image");
  const [model, setModel] = useMediaState("nano-banana-pro");
  const [mode, setMode] = useMediaState("image");
  const [title, setTitle] = useMediaState("");
  const [prompt, setPrompt] = useMediaState("");
  const [aspectRatio, setAspectRatio] = useMediaState("auto");
  const [size, setSize] = useMediaState("1k");
  const [duration, setDuration] = useMediaState(5);
  const [resolution, setResolution] = useMediaState("720p");
  const [faceProcessing, setFaceProcessing] = useMediaState(0);
  const [referenceIds, setReferenceIds] = useMediaState([]);
  const [acceptedCost, setAcceptedCost] = useMediaState(false);
  const [busy, setBusy] = useMediaState(false);
  const [uploading, setUploading] = useMediaState(false);
  const [source, setSource] = useMediaState(null);
  const [config, setConfig] = useMediaState(null);
  const [submitError, setSubmitError] = useMediaState("");
  const [jobErrors, setJobErrors] = useMediaState({});
  const uploadInput = useMediaRef(null);
  const submitKey = useMediaRef(null);

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
  useMediaEffect(() => { void loadLocalDevices(); }, [configVersion, showDevices]);
  useMediaEffect(() => {
    if (!draft) return;
    const nextModule = draft.targetModule || "image";
    setModule(nextModule);
    setModel(MEDIA_MODEL_OPTIONS[nextModule][0]);
    const requestedMode = draft.targetMode;
    setMode(MEDIA_MODES[nextModule].some((item) => item.id === requestedMode) ? requestedMode : MEDIA_MODES[nextModule][0].id);
    setAspectRatio(nextModule === "image" ? "auto" : "adaptive");
    setTitle(draft.title || "");
    setPrompt(draft.prompt || "");
    setSource(draft.sourceType || draft.parentAssetId ? draft : null);
    setReferenceIds(draft.referenceAssetId ? [draft.referenceAssetId] : []);
    setAcceptedCost(false);
    setSubmitError("");
    submitKey.current = null;
  }, [draft?.key]);
  useMediaEffect(() => {
    setAcceptedCost(false);
    setSubmitError("");
    submitKey.current = null;
  }, [module, model, mode, title, prompt, aspectRatio, size, duration, resolution, faceProcessing, referenceIds, generationRoute, deviceId]);

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
    if (busy || !acceptedCost) return;
    if (useLocal && (referenceIds.length || source?.parentAssetId)) {
      setSubmitError('本机生图暂不支持参考图编辑。请明确改为仅使用文字，或选择支持参考图的媒体 API。'); return;
    }
    const key = submitKey.current || crypto.randomUUID();
    submitKey.current = key;
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
      await onJobsChanged();
      setAcceptedCost(false);
      if (job.status !== "needs_review") submitKey.current = null;
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
  return (
    <div className="media-studio">
      <div className="media-page-head">
        <div><h1>创作台</h1><p>从收藏或提示词开始生成，结果自动回到作品库。</p></div>
        <button className="btn" onClick={() => setShowDevices(true)}><IconSettings />生图设备</button>
      </div>
      <div className={`media-studio-layout${recentJobs.length ? " has-jobs" : ""}`}>
        <section className="media-compose">
          {source && <details className="media-source-box">
            <summary><span>{MEDIA_SOURCE_LABELS[source.sourceType] || "作品"} · 来源</span><strong>{source.title || "未命名内容"}</strong></summary>
            <div>{source.url && <a href={source.url} target="_blank" rel="noopener noreferrer">打开原链接 ↗</a>}</div>
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
          {!useLocal && <details className="media-reference-panel" defaultOpen={referenceIds.length > 0}>
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
            {useLocal ? <React.Fragment>
              {localReferenceBlocked && <div className="media-config-callout" role="alert"><div><strong>当前草稿带有参考图，暂不能交给本机生成</strong><p>本机文字生图不会读取参考图。你可以明确只复用文字，或选择支持参考图的媒体 API。</p></div><button className="btn" onClick={() => {setReferenceIds([]);setSource(previous => previous ? {...previous,parentAssetId:''} : previous);setAcceptedCost(false);}}>仅使用文字，不使用参考图</button></div>}
              <p>电脑在线并运行接收程序后生成 1 张图片，结果自动存入私有作品库。当前支持文字生成，不会把来源效果图当作输入，也不支持参考图编辑。</p>
              <p className="muted">使用本机 Codex 用量，不是 ChatGPT 网页生图额度。不切换付费 API；套餐及 credits 的限制由本机检查，不满足条件时任务暂停。</p>
              {localError && <p className="media-error" role="alert">{localError}<button className="btn btn-ghost" onClick={loadLocalDevices}>重试</button></p>}
              {!localDevices.length ? <button className="btn" onClick={() => setShowDevices(true)}>配对我的电脑</button> : <React.Fragment>
                <label className="media-inline-check"><input type="checkbox" checked={acceptedCost} onChange={e => setAcceptedCost(e.target.checked)} />确认使用我自己的本机 Codex 用量生成 1 张</label>
                <button className="btn btn-primary" disabled={busy || !acceptedCost || !prompt.trim() || localReferenceBlocked} onClick={submit}>{busy ? '提交中…' : '交给本机生成'}</button>
              </React.Fragment>}
              {submitError && <p className="media-error" role="alert">{submitError}</p>}
            </React.Fragment> : !mediaConfigured ? <div className="media-config-callout"><div><strong>还没有可用的媒体服务</strong><p>可以继续编辑草稿、上传和整理素材。第三方 API 服务与 ChatGPT 授权额度互不相通。</p></div><button className="btn" onClick={onOpenSettings}>去配置</button></div> : <React.Fragment>
            <p>{config.baseUrl === "http://39.96.116.239:9001"
              ? "已连接媒体服务。认证将通过明文 HTTP 发送；生成可能消耗第三方服务额度，当前接口未提供价格。"
              : "已连接媒体服务。生成可能消耗第三方服务额度，当前接口未提供价格。"}</p>
            <label className="media-inline-check"><input type="checkbox" checked={acceptedCost}
              onChange={(e) => setAcceptedCost(e.target.checked)} />我确认提交本次生成，费用或额度消耗暂未公布</label>
            <button className="btn btn-primary" disabled={busy || !acceptedCost}
              onClick={submit}>{busy ? "提交中…" : module === "image" ? "生成图片" : "生成视频"}</button>
            {submitError && <p className="media-error" role="alert">{submitError}</p>}
            </React.Fragment>}
          </div>
        </section>
        {recentJobs.length > 0 && <aside className="media-job-list">
          <div className="media-job-head"><h2>生成任务</h2><button className="btn btn-ghost" onClick={onJobsChanged}><IconRefresh />刷新</button></div>
          {recentJobs.map((job) => <div className="media-job" key={job.id}>
            <div><strong>{job.title}</strong><span aria-live="polite">{MEDIA_STATUS[job.status] || job.status}</span></div>
            <small>{job.module === 'codex-local' ? '本机 Codex' : `${job.module} · ${job.model}`} · {job.createdAt}</small>
            {job.assetId && job.module === 'codex-local' && <a href={`/api/media/assets/${job.assetId}/file`} target="_blank" rel="noopener noreferrer"><img className="local-image-result" src={`/api/media/assets/${job.assetId}/file`} alt={job.title} /></a>}
            {job.error && <p>{job.error}</p>}
            {jobErrors[job.id] && <p className="media-error" role="alert">{jobErrors[job.id]}</p>}
            {MEDIA_ACTIVE_STATUSES.has(job.status) && formatMediaNextPollAt(job.nextPollAt) && <small>下次查询：{formatMediaNextPollAt(job.nextPollAt)}{job.pollAttempts != null ? ` · 已查询 ${job.pollAttempts} 次` : ""}</small>}
            <div className="media-job-actions">
              {job.assetId && <button className="btn" onClick={() => onShowAsset(job.assetId)}>查看作品</button>}
              {MEDIA_ACTIVE_STATUSES.has(job.status) &&
                <button className="btn btn-ghost" onClick={() => refresh(job)}>查询进度</button>}
              {['local_queued','local_claimed'].includes(job.status) && <button className="btn btn-ghost" onClick={async () => {try {await api(`/api/local-image/jobs/${job.id}/cancel`,{method:'POST',body:{}}); await onJobsChanged();} catch(error) {showToast(error.message);}}}>取消等待</button>}
            </div>
          </div>)}
        </aside>}
      </div>
      {showDevices && <DetailDrawer title="我的生图设备" onClose={() => setShowDevices(false)}><div className="detail-drawer-body"><LocalImageDevices /></div></DetailDrawer>}
    </div>
  );
}

function MediaAssetsView({ assets, query, onCreate, onContinue, onUpdated, showToast, openAssetId, onOpenAssetHandled, allowExternal = true }) {
  const [selected, setSelected] = useMediaState(null);
  const [filter, setFilter] = useMediaState("all");
  const [sort, setSort] = useMediaState("newest");
  const [editing, setEditing] = useMediaState(false);
  const [form, setForm] = useMediaState({ title: "", note: "", tags: "", rating: 0 });
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
      {visible.length === 0 ? <EmptyState message="还没有匹配的作品"
        hint={allowExternal ? "上传已有图片或视频，也可以从提示词与 X 收藏进入创作台" : '从创作台提交本机生图任务，完成后会出现在这里'} /> :
        <div className="media-gallery">{visible.map((asset) => <button key={asset.id} className="media-card"
          onClick={() => setSelected(asset)}>
          <div className="media-card-preview">
            {asset.kind === "image" ? <img src={mediaFileUrl(asset)} alt={asset.title} loading="lazy" /> :
              asset.kind === "video" ? <video src={mediaFileUrl(asset)} preload="metadata" muted playsInline /> :
                <span>音频</span>}
            {asset.kind === "video" && <span className="media-play-marker">▶</span>}
          </div>
          <strong>{asset.title}</strong>
          <small>{asset.origin === "generated" ? asset.model : "手动上传"} · {asset.createdAt}</small>
        </button>)}</div>}
      {selected && <DetailDrawer title="素材详情" onClose={() => setSelected(null)}>
          <div className="detail-drawer-body">
            <h2>{selected.title}</h2>
            <div className="media-detail-preview">
              {selected.kind === "image" ? <img src={mediaFileUrl(selected)} alt={selected.title} /> :
                selected.kind === "video" ? <video src={mediaFileUrl(selected)} controls playsInline preload="metadata" /> :
                  <audio src={mediaFileUrl(selected)} controls />}
            </div>
            <div className="media-detail-actions">
              <a className="btn" href={mediaFileUrl(selected)} target="_blank" rel="noopener noreferrer">原尺寸查看</a>
              <a className="btn" href={mediaFileUrl(selected, true)}>下载文件</a>
              {selected.kind === "image" ? <React.Fragment>
                <button className="btn btn-primary" onClick={() => { onContinue(selected, "image"); setSelected(null); }}>{allowExternal ? '以图改图' : '复用文字提示词'}</button>
                {allowExternal && <button className="btn" onClick={() => { onContinue(selected, "seedance"); setSelected(null); }}>用此图生成视频</button>}
              </React.Fragment> : <button className="btn btn-primary" onClick={() => { onContinue(selected, "seedance"); setSelected(null); }}>继续创作</button>}
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
            {selected.sourceUrl && <div className="media-detail-section"><strong>原始来源</strong>
              <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">{selected.sourceUrl}</a></div>}
            {selected.parentAssetId && <div className="media-detail-section"><strong>上一版本</strong>
              <button className="btn" onClick={() => setSelected(assets.find((a) => a.id === selected.parentAssetId) || selected)}>查看</button></div>}
            {assets.some((a) => a.parentAssetId === selected.id) && <div className="media-detail-section"><strong>后续版本</strong>
              <div>{assets.filter((a) => a.parentAssetId === selected.id).map((child) =>
                <button key={child.id} className="btn" onClick={() => setSelected(child)}>{child.title}</button>)}</div>
            </div>}
          </div>
      </DetailDrawer>}
    </div>
  );
}
