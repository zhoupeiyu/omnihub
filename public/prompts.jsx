/// 提示词灵感库 —— 卡片（星标/模型/SNS 徽章）、抽屉式详情与编辑、SNS 内嵌预览
const { useState: usePromptState, useEffect: usePromptEffect } = React;

/** 把本地图片文件压缩为 ≤720px 宽的 JPEG dataURL */
function compressImageFile(file, callback) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxWidth = 720;
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

const IconStar = (props) => (
  <svg viewBox="0 0 24 24" fill={props.filled ? "currentColor" : "none"} stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    style={props.style} className={props.className}>
    <path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.65 1.13 6.57L12 17.56l-5.9 3.1 1.13-6.57-4.78-4.65 6.6-.96z" />
  </svg>
);
const IconArchive = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
  </svg>
);
const IconEdit = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </svg>
);
const IconDownload = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
);

/** 解析可内嵌播放的 SNS 链接，返回 iframe 地址（B站 / YouTube），否则 null */
function getEmbedUrl(prompt) {
  const url = prompt.snsUrlNormalized || prompt.snsUrl || "";
  if (prompt.snsType === "youtube") {
    const match = url.match(/[?&]v=([0-9A-Za-z_-]{11})/);
    if (match) return `https://www.youtube.com/embed/${match[1]}`;
  }
  if (prompt.snsType === "bilibili") {
    const match = url.match(/(BV[0-9A-Za-z]{10})/);
    if (match) return `https://player.bilibili.com/player.html?bvid=${match[1]}&autoplay=0`;
  }
  return null;
}

/** SNS 参考区：能内嵌就内嵌播放器，否则显示规范化链接卡片 */
function SnsPreview({ prompt }) {
  const url = prompt.snsUrlNormalized || prompt.snsUrl;
  if (!url) return null;
  const embed = getEmbedUrl(prompt);
  const typeName = SNS_TYPE_NAMES[prompt.snsType] || "链接";
  return (
    <div className="field-block">
      <label>参考帖子（{typeName}）</label>
      {embed
        ? <iframe className="sns-embed" src={embed} allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="no-referrer"></iframe>
        : (
          <a className="sns-link-card" href={url} target="_blank" rel="noopener noreferrer">
            <IconArrowUpRight />{url}
          </a>
        )}
    </div>
  );
}

/** 灵感卡片 */
function PromptCard({ prompt, onToggleFavorite, onCopy, onDelete, onOpen, onTryRun }) {
  const [imgFailed, setImgFailed] = usePromptState(false);
  const hasImage = prompt.image && !imgFailed;

  return (
    <div className={"prompt-card" + (prompt.archived ? " archived-mask" : "")} onClick={() => onOpen(prompt)}>
      {hasImage ? (
        <img className="prompt-cover" src={prompt.image} alt={prompt.title}
          loading="lazy" onError={() => setImgFailed(true)} />
      ) : (
        <div className="prompt-cover-placeholder"><IconSparkle /></div>
      )}
      <div className="prompt-body">
        <h3 className="prompt-title">{prompt.title}</h3>
        <p className="prompt-text">{prompt.text}</p>
        <div className="prompt-meta">
          <button className={"star-btn" + (prompt.favorite ? " on" : "")} title={prompt.favorite ? "取消收藏" : "收藏"}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(prompt); }}>
            <IconStar filled={Boolean(prompt.favorite)} />
          </button>
          <span className="tag-chip">{prompt.category}</span>
          {prompt.model && <span className="model-chip">{prompt.model}</span>}
          {prompt.snsType && <span className="sns-chip">{SNS_TYPE_NAMES[prompt.snsType] || "链接"}</span>}
        </div>
        <div className="prompt-actions">
          <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onTryRun(prompt); }}>
            <IconSend />试跑
          </button>
          <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onCopy(prompt.text); }}>
            <IconCopy />复制
          </button>
        </div>
      </div>
      <button className="card-del" title="删除"
        onClick={(e) => { e.stopPropagation(); onDelete(prompt.id); }}>
        <IconTrash />
      </button>
    </div>
  );
}

/** 详情字段（有值才显示） */
function DetailField({ label, value }) {
  if (!value) return null;
  return (
    <div className="field-block">
      <label>{label}</label>
      <p className="field-text">{value}</p>
    </div>
  );
}

/** 抽屉：mode="view" 详情 / mode="edit" 编辑 / mode="create" 新建 */
function PromptDrawer({ prompt, initialMode, onClose, onSave, onCopy, onTryRun, onToggleFavorite, onToggleArchive, showToast }) {
  const [mode, setMode] = usePromptState(initialMode);
  const [form, setForm] = usePromptState(() => ({
    title: "", text: "", negativeText: "", category: PROMPT_CATEGORIES[0],
    model: "", tags: "", snsUrl: "", image: "",
    note: "", successNotes: "", failureNotes: "", reproTips: "",
    ...(prompt || {}),
  }));
  const [error, setError] = usePromptState("");
  const [saving, setSaving] = usePromptState(false);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError("");
  }

  function toggleTag(tag) {
    const tags = form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const next = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    setField("tags", next.join(","));
  }

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("请选择图片文件"); return; }
    compressImageFile(file, (dataUrl) => setField("image", dataUrl));
  }

  function handleSave() {
    if (!form.title.trim()) { setError("请填写标题"); return; }
    if (!form.text.trim()) { setError("请填写提示词内容"); return; }
    setSaving(true);
    Promise.resolve(onSave(form, prompt ? prompt.id : null))
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  const isView = mode === "view";
  const tags = (form.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div>
      <div className="drawer-overlay" onClick={onClose}></div>
      <div className="drawer">
        <div className="drawer-head">
          {isView && prompt && (
            <button className={"star-btn" + (prompt.favorite ? " on" : "")} title="收藏"
              onClick={() => onToggleFavorite(prompt)}>
              <IconStar filled={Boolean(prompt.favorite)} style={{ width: 17, height: 17 }} />
            </button>
          )}
          <h2>{isView ? form.title : (mode === "create" ? "新建灵感" : "编辑灵感")}</h2>
          {isView && <button className="btn btn-icon" title="编辑" onClick={() => setMode("edit")}><IconEdit /></button>}
          <button className="btn btn-icon btn-ghost" title="关闭" onClick={onClose}><IconX /></button>
        </div>

        <div className="drawer-body">
          {isView ? (
            <div>
              {form.image && <img className="detail-cover" src={form.image} alt={form.title} style={{ marginBottom: 14 }} />}
              <div className="tag-input-row" style={{ marginBottom: 14, marginTop: 0 }}>
                <span className="tag-chip">{form.category}</span>
                {form.model && <span className="model-chip">{form.model}</span>}
                {tags.map((t) => <span key={t} className="filter-chip active" style={{ cursor: "default" }}>{t}</span>)}
                {prompt && prompt.archived ? <span className="model-chip">已归档</span> : null}
              </div>
              <DetailField label="提示词" value={form.text} />
              <DetailField label="负面提示词" value={form.negativeText} />
              <SnsPreview prompt={form} />
              <DetailField label="成功原因" value={form.successNotes} />
              <DetailField label="失败点" value={form.failureNotes} />
              <DetailField label="复现技巧" value={form.reproTips} />
              <DetailField label="备注" value={form.note} />
              {prompt && (prompt.createdAt || prompt.updatedAt) && (
                <p style={{ fontSize: 11, color: "var(--text-3)" }}>
                  创建 {prompt.createdAt || "—"}{prompt.updatedAt ? ` · 更新 ${prompt.updatedAt}` : ""}
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="field-block">
                <label>标题 *</label>
                <input className="input" value={form.title} autoFocus
                  placeholder="例如：赛博朋克雨夜街景"
                  onChange={(e) => setField("title", e.target.value)} />
              </div>
              <div className="field-grid">
                <div className="field-block">
                  <label>分类</label>
                  <select className="select" value={form.category} onChange={(e) => setField("category", e.target.value)}>
                    {PROMPT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field-block">
                  <label>使用模型</label>
                  <input className="input" list="model-presets" value={form.model}
                    placeholder="选择或输入模型"
                    onChange={(e) => setField("model", e.target.value)} />
                  <datalist id="model-presets">
                    {MODEL_PRESETS.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
              </div>
              <div className="field-block">
                <label>提示词 *</label>
                <textarea className="input" rows="4" style={{ resize: "vertical", lineHeight: 1.65 }}
                  placeholder="粘贴完整提示词……" value={form.text}
                  onChange={(e) => setField("text", e.target.value)} />
              </div>
              <div className="field-block">
                <label>负面提示词</label>
                <textarea className="input" rows="2" style={{ resize: "vertical", lineHeight: 1.65 }}
                  placeholder="不想出现的元素（可选）" value={form.negativeText}
                  onChange={(e) => setField("negativeText", e.target.value)} />
              </div>
              <div className="field-block">
                <label>标签（点选或逗号分隔输入）</label>
                <input className="input" value={form.tags} placeholder="人物,运镜"
                  onChange={(e) => setField("tags", e.target.value)} />
                <div className="tag-input-row">
                  {TAG_TEMPLATES.map((t) => (
                    <button key={t} className={"filter-chip" + (tags.includes(t) ? " active" : "")}
                      onClick={() => toggleTag(t)}>{t}</button>
                  ))}
                </div>
              </div>
              <div className="field-block">
                <label>参考帖子链接（B站 / 抖音 / 小红书 / 微博 / X / YouTube / TikTok / Instagram）</label>
                <input className="input" value={form.snsUrl} placeholder="https://…（保存时自动识别平台并规范化）"
                  onChange={(e) => setField("snsUrl", e.target.value)} />
              </div>
              <div className="field-block">
                <label>效果图（可选）</label>
                <div className="tool-row">
                  <input className="input" placeholder="粘贴图片链接 https://…"
                    value={form.image.startsWith("data:") ? "（已选择本地图片）" : form.image}
                    disabled={form.image.startsWith("data:")}
                    onChange={(e) => setField("image", e.target.value)} />
                  <label className="btn" style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
                    <IconUpload />本地图片
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
                  </label>
                </div>
                {form.image && (
                  <div style={{ position: "relative", marginTop: 8 }}>
                    <img className="img-preview" src={form.image} alt="预览" />
                    <button className="card-del" style={{ opacity: 1 }} title="移除图片" onClick={() => setField("image", "")}>
                      <IconX />
                    </button>
                  </div>
                )}
              </div>
              <div className="field-block">
                <label>成功原因</label>
                <textarea className="input" rows="2" style={{ resize: "vertical" }} value={form.successNotes}
                  placeholder="为什么效果好（可选）" onChange={(e) => setField("successNotes", e.target.value)} />
              </div>
              <div className="field-block">
                <label>失败点</label>
                <textarea className="input" rows="2" style={{ resize: "vertical" }} value={form.failureNotes}
                  placeholder="踩过的坑（可选）" onChange={(e) => setField("failureNotes", e.target.value)} />
              </div>
              <div className="field-block">
                <label>复现技巧</label>
                <textarea className="input" rows="2" style={{ resize: "vertical" }} value={form.reproTips}
                  placeholder="参数、步骤等（可选）" onChange={(e) => setField("reproTips", e.target.value)} />
              </div>
              <div className="field-block">
                <label>备注</label>
                <textarea className="input" rows="2" style={{ resize: "vertical" }} value={form.note}
                  placeholder="其他想记的（可选）" onChange={(e) => setField("note", e.target.value)} />
              </div>
              {error && <p className="auth-error">{error}</p>}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          {isView ? (
            <React.Fragment>
              <button className="btn" onClick={() => onCopy(form.text)}><IconCopy />复制</button>
              <button className="btn btn-primary" onClick={() => onTryRun(form)}><IconSend />试跑</button>
              <span className="spacer"></span>
              {prompt && (
                <button className="btn btn-ghost" onClick={() => onToggleArchive(prompt)}>
                  <IconArchive style={{ width: 14, height: 14 }} />{prompt.archived ? "恢复" : "归档"}
                </button>
              )}
            </React.Fragment>
          ) : (
            <React.Fragment>
              <span className="spacer"></span>
              <button className="btn btn-ghost" onClick={mode === "create" ? onClose : () => setMode("view")}>取消</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <IconCheck />{saving ? "保存中…" : "保存"}
              </button>
            </React.Fragment>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PromptCard, PromptDrawer, IconStar, IconArchive, IconDownload, compressImageFile });
