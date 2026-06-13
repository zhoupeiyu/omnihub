/// 提示词模块 —— 卡片（配图）、详情弹窗、添加弹窗（支持本地图片压缩上传）
const { useState: usePromptState } = React;

/** 把本地图片文件压缩为 ≤720px 宽的 JPEG dataURL，便于存进 localStorage */
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

/** 单张提示词卡片：有配图显示配图，无配图显示占位图标 */
function PromptCard({ prompt, onCopy, onDelete, onOpen }) {
  const [imgFailed, setImgFailed] = usePromptState(false);
  const hasImage = prompt.image && !imgFailed;

  return (
    <div className="prompt-card" onClick={() => onOpen(prompt)}>
      {hasImage ? (
        <img className="prompt-cover" src={prompt.image} alt={prompt.title}
          loading="lazy" onError={() => setImgFailed(true)} />
      ) : (
        <div className="prompt-cover-placeholder"><IconSparkle /></div>
      )}
      <div className="prompt-body">
        <h3 className="prompt-title">{prompt.title}</h3>
        <p className="prompt-text">{prompt.text}</p>
        <div className="prompt-foot">
          <span className="tag-chip">{prompt.category}</span>
          <button className="prompt-copy"
            onClick={(e) => { e.stopPropagation(); onCopy(prompt.text); }}>
            <IconCopy />复制
          </button>
        </div>
      </div>
      <button className="card-del" title="删除提示词"
        onClick={(e) => { e.stopPropagation(); onDelete(prompt.id); }}>
        <IconTrash />
      </button>
    </div>
  );
}

/** 提示词详情弹窗：大图 + 全文 + 复制 */
function PromptDetailModal({ prompt, onClose, onCopy }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        {prompt.image && <img className="detail-cover" src={prompt.image} alt={prompt.title} />}
        <h2 style={{ marginBottom: 10 }}>{prompt.title}</h2>
        <span className="tag-chip">{prompt.category}</span>
        <p className="detail-text" style={{ marginTop: 12 }}>{prompt.text}</p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>关闭</button>
          <button className="btn btn-primary" onClick={() => onCopy(prompt.text)}><IconCopy />复制提示词</button>
        </div>
      </div>
    </div>
  );
}

/** 添加提示词弹窗：标题 / 内容 / 分类 / 配图（粘贴 URL 或本地上传） */
function AddPromptModal({ onClose, onSubmit }) {
  const [title, setTitle] = usePromptState("");
  const [text, setText] = usePromptState("");
  const [category, setCategory] = usePromptState(PROMPT_CATEGORIES[0]);
  const [image, setImage] = usePromptState("");
  const [error, setError] = usePromptState("");

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("请选择图片文件"); return; }
    compressImageFile(file, setImage);
  }

  function handleSubmit() {
    if (!title.trim()) { setError("请填写标题"); return; }
    if (!text.trim()) { setError("请填写提示词内容"); return; }
    onSubmit({ title: title.trim(), text: text.trim(), category, image: image.trim() });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>收藏提示词</h2>
        <div className="form-field">
          <label>标题</label>
          <input className="input" placeholder="例如：赛博朋克雨夜街景" value={title}
            onChange={(e) => { setTitle(e.target.value); setError(""); }} autoFocus />
        </div>
        <div className="form-field">
          <label>提示词内容</label>
          <textarea className="input" rows="5" style={{ resize: "vertical", lineHeight: 1.7 }}
            placeholder="粘贴完整提示词……" value={text}
            onChange={(e) => { setText(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label>分类</label>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {PROMPT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label>配图（可选，提示词对应的效果图）</label>
          <div className="tool-row">
            <input className="input" placeholder="粘贴图片链接 https://…"
              value={image.startsWith("data:") ? "（已选择本地图片）" : image}
              disabled={image.startsWith("data:")}
              onChange={(e) => setImage(e.target.value)} />
            <label className="btn" style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
              <IconUpload />本地图片
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
            </label>
          </div>
          <p className="form-hint">本地图片会自动压缩后保存在浏览器中；也可以直接粘贴网络图片链接</p>
          {image && (
            <div style={{ position: "relative", marginTop: 10 }}>
              <img className="img-preview" src={image} alt="预览" onError={() => setError("图片链接无法加载")} />
              <button className="card-del" style={{ opacity: 1 }} title="移除图片" onClick={() => setImage("")}>
                <IconX />
              </button>
            </div>
          )}
        </div>
        {error && <p style={{ color: "oklch(58% 0.2 25)", fontSize: 13, fontWeight: 600 }}>{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit}><IconPlus />收藏</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PromptCard, PromptDetailModal, AddPromptModal, compressImageFile });
