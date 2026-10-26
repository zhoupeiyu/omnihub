/// 提示词灵感库 —— 卡片（星标/模型/SNS 徽章）、抽屉式详情与编辑、SNS 内嵌预览
const { useState: usePromptState, useEffect: usePromptEffect, useMemo: usePromptMemo } = React;

// <prompt-drawer-state>
/** Fields edited by the prompt drawer; dirty checks compare only these. */
const PROMPT_FORM_FIELDS = ["title", "text", "negativeText", "category", "model", "tags", "snsUrl", "image",
  "note", "successNotes", "failureNotes", "reproTips"];

/** The saved record shown in view mode and used as the edit baseline. */
function promptDrawerBaseline(prompt, initialForm, defaultCategory) {
  const base = {
    title: "", text: "", negativeText: "", category: defaultCategory || "",
    model: "", tags: "", snsUrl: "", image: "",
    note: "", successNotes: "", failureNotes: "", reproTips: "",
    ...(initialForm || {}), ...(prompt || {}),
  };
  for (const key of PROMPT_FORM_FIELDS) if (base[key] == null) base[key] = "";
  return base;
}

function promptFormDirty(form, baseline) {
  if (!form || !baseline) return false;
  const value = (record, key) => String(record[key] ?? "").replace(/\r\n/g, "\n");
  return PROMPT_FORM_FIELDS.some((key) => value(form, key) !== value(baseline, key));
}

/** Cancel never keeps the draft: create closes, edit returns to the saved record. */
function promptDrawerCancel(mode, baseline) {
  if (mode === "create") return { close: true, mode, form: { ...baseline } };
  return { close: false, mode: "view", form: { ...baseline } };
}

/** Existing records stay the read-only baseline; an incoming refinery draft is edit-only. */
function promptDrawerInitialForm(saved, initialForm, hasPrompt) {
  return hasPrompt ? { ...saved, ...(initialForm || {}) } : { ...saved };
}
// </prompt-drawer-state>

/** 把内部标签翻译成中文（复用提示词库字典；未知内部标识给出友好名称） */
function promptFriendlyTag(tag) {
  return typeof window.promptTagLabel === "function" ? window.promptTagLabel(tag) : String(tag || "").trim();
}

function promptFriendlyTags(tags) {
  return [...new Set(String(tags || "").split(",").map(promptFriendlyTag).filter(Boolean))];
}

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

function getPromptVariables(text) { return promptTemplateNames(text); }

function getPromptMedia(prompt) {
  let entries = prompt.media;
  if (typeof entries === "string") {
    try { entries = JSON.parse(entries); } catch { entries = []; }
  }
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const raw = entry?.type === "photo" ? entry.url : entry?.preview_image_url || entry?.url;
    try {
      const archived = /^\/api\/x-media\/[1-9]\d*\/[a-f0-9]{64}$/.test(raw || "");
      const url = archived ? new URL(raw, window.location.origin) : new URL(raw);
      return archived || url.protocol === "https:" ? { url: url.toString(), alt: entry.alt_text || "提示词效果图" } : null;
    } catch { return null; }
  }).filter(Boolean);
}

function getPromptAssetScore(prompt) {
  let score = 45;
  if ((prompt.text || "").length > 80) score += 12;
  if (prompt.model) score += 10;
  if (prompt.tags) score += 10;
  if (prompt.successNotes || prompt.reproTips) score += 15;
  if (prompt.favorite) score += 8;
  if (prompt.snsUrl || prompt.image) score += 6;
  if (prompt.archived) score -= 20;
  return Math.max(0, Math.min(100, score));
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
        ? <iframe className="sns-embed" src={embed} allowFullScreen title={`参考帖子（${typeName}）`}
            sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="no-referrer"></iframe>
        : (
          <a className="sns-link-card" href={url} target="_blank" rel="noopener noreferrer">
            <span aria-hidden="true">↗</span>{url}
          </a>
        )}
    </div>
  );
}

/** 灵感卡片 */
function PromptCard({ prompt, onToggleFavorite, onCopy, onDelete, onOpen, onTryRun, onCreateMedia }) {
  const [imgFailed, setImgFailed] = usePromptState(false);
  const cover = prompt.image || getPromptMedia(prompt)[0]?.url;
  const hasImage = Boolean(cover && !imgFailed);
  const hasExample = Boolean(prompt.image || getPromptMedia(prompt).length);
  const variables = getPromptVariables(prompt.text);
  const needsReview = !(prompt.note || prompt.successNotes || prompt.reproTips || prompt.tags || prompt.model);
  const tags = promptFriendlyTags(prompt.tags).slice(0, 3);

  return (
    <div id={`asset-prompt-${prompt.id}`} className={"prompt-card prompt-asset-card" + (prompt.archived ? " archived-mask" : "")} onClick={() => onOpen(prompt)}>
      {hasImage ? (
        <img className="prompt-cover" src={cover} alt={prompt.title}
          loading="lazy" onError={() => setImgFailed(true)} />
      ) : (
        <div className="prompt-cover-placeholder"><IconSparkle /></div>
      )}
      <div className="prompt-body">
        <div className="prompt-card-top">
          <span className="review-chip">{hasExample ? "有样例" : "待验证"}</span>
          {needsReview && !prompt.archived && <span className="review-chip">待提炼</span>}
          {Boolean(prompt.archived) && <span className="review-chip muted">已归档</span>}
          <button className={"star-btn" + (prompt.favorite ? " on" : "")} title={prompt.favorite ? "取消收藏" : "收藏"}
            aria-label={prompt.favorite ? "取消收藏" : "收藏"}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(prompt); }}>
            <IconStar filled={Boolean(prompt.favorite)} />
          </button>
        </div>
        <h3 className="prompt-title">{prompt.title}</h3>
        <p className="prompt-text">{prompt.text}</p>
        {variables.length > 0 && (
          <div className="variable-row">
            {variables.map((v) => <span key={v} className="variable-chip">{v}</span>)}
          </div>
        )}
        <div className="prompt-meta">
          <span className="tag-chip">{prompt.category}</span>
          {prompt.model && <span className="model-chip">{prompt.model}</span>}
          {prompt.snsType && <span className="sns-chip">{SNS_TYPE_NAMES[prompt.snsType] || "链接"}</span>}
          {tags.map((tag) => <span key={tag} className="tag-chip prompt-friendly-tag">{tag}</span>)}
        </div>
        <div className="prompt-actions">
          {promptCreationModule(prompt) && <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onCreateMedia(prompt); }}>
            <IconPalette />{promptCreationModule(prompt) === 'seedance' ? '创作视频' : '生成图片'}
          </button>}
          <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onTryRun(prompt); }}>
            <IconSend />{variables.length ? "填写模板" : "带入对话"}
          </button>
          <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onCopy(prompt.text); }}>
            <IconCopy />复制
          </button>
        </div>
      </div>
      <button className="card-del" title="删除" aria-label="删除提示词"
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

function PromptAssetSummary({ prompt }) {
  const hasExample = Boolean(prompt.image || getPromptMedia(prompt).length);
  const variables = getPromptVariables(prompt.text);
  return (
    <div className="asset-summary-card">
      <div>
        <span>效果参考</span>
        <strong>{hasExample ? "有样例" : "待验证"}</strong>
      </div>
      <div>
        <span>变量</span>
        <strong>{variables.length || 0}</strong>
      </div>
      <div>
        <span>状态</span>
        <strong>{prompt.archived ? "已归档" : prompt.favorite ? "已收藏" : "已保存"}</strong>
      </div>
      {variables.length > 0 && (
        <div className="asset-summary-vars">
          {variables.map((v) => <span key={v} className="variable-chip">{v}</span>)}
        </div>
      )}
    </div>
  );
}

/** 抽屉：mode="view" 详情 / mode="edit" 编辑 / mode="create" 新建 */
function PromptDrawer({ prompt, initialMode, initialForm, onClose, onSave, onCopy, onTryRun, onCreateMedia, onToggleFavorite, onToggleArchive, showToast }) {
  const [mode, setMode] = usePromptState(initialMode);
  // 已保存记录：查看、复制、带入对话都只读它，绝不读取被取消的草稿。
  const saved = usePromptMemo(() => promptDrawerBaseline(prompt, prompt ? null : initialForm, PROMPT_CATEGORIES[0]), [prompt, initialForm]);
  const [form, setForm] = usePromptState(() => promptDrawerInitialForm(saved, initialForm, Boolean(prompt)));
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

  function startEdit() {
    setForm({ ...saved });
    setError("");
    setMode("edit");
  }

  function handleCancel() {
    if (mode === "create" && dirty && !confirm("放弃未保存的提示词草稿吗？")) return;
    const next = promptDrawerCancel(mode, saved);
    setError("");
    if (next.close) { onClose(); return; }
    setForm(next.form);
    setMode(next.mode);
  }

  function handleSave() {
    if (saving) return;
    if (!form.title.trim()) { setError("请填写标题"); return; }
    if (!form.text.trim()) { setError("请填写提示词内容"); return; }
    setSaving(true);
    Promise.resolve(onSave(form, prompt ? prompt.id : null))
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  const isView = mode === "view";
  const dirty = !isView && promptFormDirty(form, saved);
  const record = saved;
  const viewTags = promptFriendlyTags(saved.tags);
  const tags = (form.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const extraMedia = getPromptMedia(record).filter((media) => media.url !== record.image);

  return (
    <DetailDrawer title={isView ? "提示词详情" : (mode === "create" ? "新建提示词资产" : "编辑提示词资产")} onClose={onClose} dirty={dirty}
      dirtyMessage="提示词还有未保存的修改，关闭后会丢失。确定放弃吗？" actions={<React.Fragment>
          {isView && prompt && (
            <button className={"star-btn" + (prompt.favorite ? " on" : "")} title="收藏" aria-label={prompt.favorite ? "取消收藏" : "收藏"}
              onClick={() => onToggleFavorite(prompt)}>
              <IconStar filled={Boolean(prompt.favorite)} style={{ width: 17, height: 17 }} />
            </button>
          )}
          {isView && <button className="btn btn-ghost" title="编辑" onClick={startEdit}>编辑</button>}
        </React.Fragment>}>

        <div className="detail-drawer-body">
          {isView ? (
            <div>
              <h2 className="prompt-drawer-title">{record.title}</h2>
              {record.image && <img className="detail-cover" src={record.image} alt={record.title} style={{ marginBottom: 14 }} />}
              {extraMedia.length > 0 && (
                <div className="prompt-media-gallery">
                  {extraMedia.map((media, index) => (
                    <a key={`${media.url}-${index}`} href={media.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                      <img src={media.url} alt={media.alt} loading="lazy" referrerPolicy="no-referrer" />
                    </a>
                  ))}
                </div>
              )}
              <PromptAssetSummary prompt={record} />
              <div className="tag-input-row" style={{ marginBottom: 14, marginTop: 0 }}>
                <span className="tag-chip">{record.category}</span>
                {record.model && <span className="model-chip">{record.model}</span>}
                {viewTags.map((t) => <span key={t} className="filter-chip active prompt-friendly-tag" style={{ cursor: "default" }}>{t}</span>)}
                {prompt && prompt.archived ? <span className="model-chip">已归档</span> : null}
              </div>
              <DetailField label="原始提示词" value={record.text} />
              <DetailField label="负面提示词" value={record.negativeText} />
              <SnsPreview prompt={record} />
              <DetailField label="为什么值得保留" value={record.successNotes} />
              <DetailField label="踩坑记录" value={record.failureNotes} />
              <DetailField label="复用方法" value={record.reproTips} />
              <DetailField label="整理备注" value={record.note} />
              {prompt && (prompt.createdAt || prompt.updatedAt) && (
                <p style={{ fontSize: 11, color: "var(--text-3)" }}>
                  创建 {prompt.createdAt || "—"}{prompt.updatedAt ? ` · 更新 ${prompt.updatedAt}` : ""}
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="field-block">
                <label htmlFor="prompt-form-title">标题 *</label>
                <input id="prompt-form-title" className="input" value={form.title} autoFocus
                  placeholder="例如：产品需求拆解提示词"
                  onChange={(e) => setField("title", e.target.value)} />
              </div>
              <div className="field-grid">
                <div className="field-block">
                  <label htmlFor="prompt-form-category">分类</label>
                  <select id="prompt-form-category" className="select" value={form.category} onChange={(e) => setField("category", e.target.value)}>
                    {[...new Set([...PROMPT_CATEGORIES, ...(form.category ? [form.category] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field-block">
                  <label htmlFor="prompt-form-model">使用模型</label>
                  <input id="prompt-form-model" className="input" list="model-presets" value={form.model}
                    placeholder="选择或输入模型"
                    onChange={(e) => setField("model", e.target.value)} />
                  <datalist id="model-presets">
                    {MODEL_PRESETS.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
              </div>
              <div className="field-block">
                <label htmlFor="prompt-form-text">提示词 *</label>
                <textarea id="prompt-form-text" className="input" rows="4" style={{ resize: "vertical", lineHeight: 1.65 }}
                  placeholder="粘贴完整提示词，变量可以用 {主题} 这种形式标出来……" value={form.text}
                  onChange={(e) => setField("text", e.target.value)} />
              </div>
              <div className="field-block">
                <label htmlFor="prompt-form-negative">负面提示词</label>
                <textarea id="prompt-form-negative" className="input" rows="2" style={{ resize: "vertical", lineHeight: 1.65 }}
                  placeholder="不想出现的元素（可选）" value={form.negativeText}
                  onChange={(e) => setField("negativeText", e.target.value)} />
              </div>
              <div className="field-block">
                <label htmlFor="prompt-form-tags">标签（点选或逗号分隔输入）</label>
                <input id="prompt-form-tags" className="input" value={form.tags} placeholder="人物,运镜"
                  onChange={(e) => setField("tags", e.target.value)} />
                <div className="tag-input-row">
                  {TAG_TEMPLATES.map((t) => (
                    <button key={t} type="button" className={"filter-chip" + (tags.includes(t) ? " active" : "")}
                      aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</button>
                  ))}
                </div>
              </div>
              <div className="field-block">
                <label htmlFor="prompt-form-sns">参考帖子链接（B站 / 抖音 / 小红书 / 微博 / X / YouTube / TikTok / Instagram）</label>
                <input id="prompt-form-sns" className="input" value={form.snsUrl} placeholder="https://…（保存时自动识别平台并规范化）"
                  onChange={(e) => setField("snsUrl", e.target.value)} />
              </div>
              <div className="field-block">
                <label>效果图（可选）</label>
                <div className="tool-row">
                  <input className="input" placeholder="粘贴图片链接 https://…" aria-label="效果图链接"
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
                    <button className="card-del" style={{ opacity: 1 }} title="移除图片" aria-label="移除图片" onClick={() => setField("image", "")}>
                      <IconX />
                    </button>
                  </div>
                )}
              </div>
              <div className="field-block">
                <label htmlFor="prompt-form-note">备注</label>
                <textarea id="prompt-form-note" className="input" rows="2" style={{ resize: "vertical" }} value={form.note}
                  placeholder="适用场景、来源、下次怎么用（可选）" onChange={(e) => setField("note", e.target.value)} />
              </div>
              <details className="prompt-review-notes" open={Boolean(form.successNotes || form.failureNotes || form.reproTips)}>
                <summary>复盘笔记（可选）</summary>
                <div style={{ width: "100%" }}>
                  <div className="field-block">
                    <label htmlFor="prompt-form-success">为什么值得保留</label>
                    <textarea id="prompt-form-success" className="input" rows="2" style={{ resize: "vertical" }} value={form.successNotes}
                      placeholder="为什么效果好" onChange={(e) => setField("successNotes", e.target.value)} />
                  </div>
                  <div className="field-block">
                    <label htmlFor="prompt-form-failure">踩坑记录</label>
                    <textarea id="prompt-form-failure" className="input" rows="2" style={{ resize: "vertical" }} value={form.failureNotes}
                      placeholder="踩过的坑" onChange={(e) => setField("failureNotes", e.target.value)} />
                  </div>
                  <div className="field-block" style={{ marginBottom: 4 }}>
                    <label htmlFor="prompt-form-repro">复用方法</label>
                    <textarea id="prompt-form-repro" className="input" rows="2" style={{ resize: "vertical" }} value={form.reproTips}
                      placeholder="参数、步骤等" onChange={(e) => setField("reproTips", e.target.value)} />
                  </div>
                </div>
              </details>
              {error && <p className="auth-error" role="alert">{error}</p>}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          {isView ? (
            <React.Fragment>
              <button className="btn" onClick={() => onCopy(saved.text)}><IconCopy />复制</button>
              {promptCreationModule(saved) && <button className="btn" onClick={() => onCreateMedia(saved)}><IconPalette />{promptCreationModule(saved) === "seedance" ? "创作视频" : "生成图片"}</button>}
              <button className="btn btn-primary" onClick={() => onTryRun(saved)}><IconSend />{getPromptVariables(saved.text).length ? "填写模板" : "带入对话"}</button>
              <span className="spacer"></span>
              {prompt && (
                <button className="btn btn-ghost" onClick={() => onToggleArchive(prompt)}>
                  <IconArchive style={{ width: 14, height: 14 }} />{prompt.archived ? "恢复" : "归档"}
                </button>
              )}
            </React.Fragment>
          ) : (
            <React.Fragment>
              {dirty && <span className="prompt-drawer-dirty" role="status">有未保存的修改</span>}
              <span className="spacer"></span>
              <button className="btn btn-ghost" onClick={handleCancel} disabled={saving}>{mode === "create" ? "取消" : "取消修改"}</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <IconCheck />{saving ? "保存中…" : "保存"}
              </button>
            </React.Fragment>
          )}
        </div>
    </DetailDrawer>
  );
}

Object.assign(window, { PromptCard, PromptDrawer, IconStar, IconArchive, compressImageFile,
  promptFormDirty, promptDrawerCancel, promptDrawerBaseline, promptFriendlyTags });
