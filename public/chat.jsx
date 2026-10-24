/// AI 对话模块 —— 聊天界面（流式 + Markdown 渲染）+ AI 账号配置弹窗
const { useState: useChatState, useEffect: useChatEffect, useRef: useChatRef } = React;

/** 把 AI 回复的 Markdown 安全地渲染成 HTML（marked 解析 + DOMPurify 消毒） */
function MarkdownBubble({ content }) {
  const html = DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  return <div className="msg-bubble md-body" dangerouslySetInnerHTML={{ __html: html }}></div>;
}

/** AI 配置弹窗：服务商预设一键填入，Key 留空表示沿用已保存的 */
function AiSettingsModal({ onClose, onSaved, showToast }) {
  const [settingsTab, setSettingsTab] = useChatState("chat");
  const [baseUrl, setBaseUrl] = useChatState("");
  const [apiKey, setApiKey] = useChatState("");
  const [model, setModel] = useChatState("");
  const [maskedKey, setMaskedKey] = useChatState("");
  const [mediaBaseUrl, setMediaBaseUrl] = useChatState("");
  const [authentication, setAuthentication] = useChatState("");
  const [sysToken, setSysToken] = useChatState("");
  const [mediaAuthMasked, setMediaAuthMasked] = useChatState("");
  const [sysTokenMasked, setSysTokenMasked] = useChatState("");
  const [clearSysToken, setClearSysToken] = useChatState(false);
  const [error, setError] = useChatState("");
  const [saving, setSaving] = useChatState(false);

  useChatEffect(() => {
    api("/api/ai-config")
      .then((config) => {
        setBaseUrl(config.baseUrl);
        setModel(config.model);
        setMaskedKey(config.apiKeyMasked);
      })
      .catch(() => {});
    api("/api/media/config")
      .then((config) => {
        setMediaBaseUrl(config.baseUrl || "");
        setMediaAuthMasked(config.authenticationMasked || "");
        setSysTokenMasked(config.sysTokenMasked || "");
      })
      .catch(() => {});
  }, []);

  function applyPreset(preset) {
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  }

  function handleSave() {
    if (settingsTab === "media") {
      if (!authentication.trim() && !mediaAuthMasked) { setError("请填写媒体接口认证信息"); return; }
      setSaving(true);
      api("/api/media/config", { method: "PUT", body: {
        baseUrl: mediaBaseUrl.trim(), authentication: authentication.trim(),
        sysToken: sysToken.trim(), clearSysToken,
      } })
        .then(() => { showToast(mediaBaseUrl.trim() ? "媒体接口配置已保存" : "认证已保存在本机，等待安全接口地址"); onSaved("media"); onClose(); })
        .catch((err) => setError(err.message))
        .finally(() => setSaving(false));
      return;
    }
    if (!baseUrl.trim() || !model.trim()) { setError("接口地址和模型名不能为空"); return; }
    if (!apiKey.trim() && !maskedKey) { setError("请填写 API Key"); return; }
    setSaving(true);
    api("/api/ai-config", { method: "PUT", body: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() } })
      .then(() => { showToast("AI 配置已保存"); onSaved("chat"); onClose(); })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>AI 设置（只对你自己的账号生效）</h2>
        <div className="media-settings-tabs" role="tablist">
          <button className={settingsTab === "chat" ? "active" : ""} onClick={() => { setSettingsTab("chat"); setError(""); }}>文字对话</button>
          <button className={settingsTab === "media" ? "active" : ""} onClick={() => { setSettingsTab("media"); setError(""); }}>图片／视频生成</button>
        </div>
        {settingsTab === "chat" ? <React.Fragment>
        <div className="form-field">
          <label>快速选择服务商</label>
          <div className="preset-row">
            {AI_PRESETS.map((p) => (
              <button key={p.id} className="preset-chip" onClick={() => applyPreset(p)}>{p.name}</button>
            ))}
          </div>
        </div>
        <div className="form-field">
          <label>接口地址 Base URL（填到 /v1 这一级）</label>
          <input className="input" placeholder="例如：https://api.deepseek.com/v1" value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label>API Key{maskedKey ? `（已保存 ${maskedKey}，留空表示不变）` : ""}</label>
          <input className="input" type="password" placeholder={maskedKey ? "留空沿用已保存的 Key" : "sk-…"}
            value={apiKey} onChange={(e) => { setApiKey(e.target.value); setError(""); }} />
          <p className="form-hint">Key 保存在你电脑上的数据库里，只用于你自己的对话转发</p>
        </div>
        <div className="form-field">
          <label>模型名</label>
          <input className="input" placeholder="例如：deepseek-chat" value={model}
            onChange={(e) => { setModel(e.target.value); setError(""); }} />
        </div>
        </React.Fragment> : <React.Fragment>
          <div className="form-field">
            <label>媒体接口 Base URL</label>
            <input className="input" value={mediaBaseUrl}
              placeholder="http://39.96.116.239:9001"
              onChange={(e) => { setMediaBaseUrl(e.target.value); setError(""); }} />
            <p className="form-hint">个人调用只需 authentication，sys_token 可留空。公司文档地址使用明文 HTTP；提交时认证可能被中间网络设备读取。其他公网 HTTP 地址仍不可配置。</p>
          </div>
          <div className="form-field">
            <label>authentication{mediaAuthMasked ? `（${mediaAuthMasked}，留空沿用）` : ""}</label>
            <input className="input" type="password" autoComplete="off" value={authentication}
              placeholder={mediaAuthMasked ? "留空沿用已保存认证" : "填写你自己的认证信息"}
              onChange={(e) => { setAuthentication(e.target.value); setError(""); }} />
          </div>
          <div className="form-field">
            <label>sys_token{sysTokenMasked ? `（${sysTokenMasked}，留空沿用）` : "（个人调用通常留空）"}</label>
            <input className="input" type="password" autoComplete="off" value={sysToken}
              placeholder="仅服务方要求时填写"
              onChange={(e) => { setSysToken(e.target.value); setError(""); }} />
            {sysTokenMasked && <label className="media-inline-check"><input type="checkbox" checked={clearSysToken}
              onChange={(e) => setClearSysToken(e.target.checked)} />清除已保存的 sys_token</label>}
            <p className="form-hint">认证信息只保存在本机数据库，不会返回到网页。生成可能消耗公司额度。</p>
          </div>
        </React.Fragment>}
        {error && <p className="auth-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <IconCheck />{saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 聊天视图：消息状态由上层持有（切换模块不丢失）；prefill 为「试跑」带来的提示词 */
function ChatView({ messages, onMessagesChange, prefill, onPrefillUsed, hasAiConfig, onOpenAiSettings, showToast }) {
  const setMessages = onMessagesChange;
  const [input, setInput] = useChatState("");
  const [waiting, setWaiting] = useChatState(false);
  const [modelTag, setModelTag] = useChatState("");
  const msgsRef = useChatRef(null);

  useChatEffect(() => {
    if (prefill) {
      setInput(prefill);
      onPrefillUsed();
    }
  }, [prefill]);

  useChatEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages, waiting]);

  /** 解析后端 SSE 流，把增量内容逐字渲染到最后一条 assistant 消息上 */
  async function readStream(response, baseMessages) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const event of events) {
        const line = event.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(payload.error);
        if (payload.model) setModelTag(payload.model);
        if (payload.delta) {
          accumulated += payload.delta;
          setMessages([...baseMessages, { role: "assistant", content: accumulated }]);
        }
      }
    }
    if (!accumulated) throw new Error("AI 服务返回了空回复");
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || waiting) return;
    if (!hasAiConfig) { onOpenAiSettings(); return; }
    const nextMessages = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setWaiting(true);
    try {
      const response = await fetch("/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
        credentials: "same-origin",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload && payload.error) || `请求失败（${response.status}）`);
      }
      await readStream(response, nextMessages);
    } catch (err) {
      setMessages(nextMessages);
      showToast(err.message);
    } finally {
      setWaiting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const captureTemplates = [
    {
      title: "提炼提示词资产",
      text: "请把下面这段内容整理成一个可复用提示词资产，输出：适用场景、原始提示词、变量列表、使用步骤、好用原因、需要避免的坑。\n\n",
    },
    {
      title: "整理网页/工具价值",
      text: "请帮我把下面这个网页或工具整理成收藏库条目，输出：一句话用途、适合什么时候用、关键链接、标签、是否值得长期保留。\n\n",
    },
    {
      title: "从对话提取待办",
      text: "请从下面对话中提取：已决定事项、可沉淀知识、下一步动作、需要回看来源。\n\n",
    },
  ];

  function useTemplate(template) {
    setInput((current) => current ? `${current}\n\n${template.text}` : template.text);
  }

  return (
    <div>
      <SectionHead icon={<IconSend />} title="AI 对话" count={null}>
        {modelTag && <span className="chat-model-tag">{modelTag}</span>}
        {messages.length > 0 && (
          <button className="btn" onClick={() => setMessages([])}><IconRefresh />新对话</button>
        )}
        <button className="btn" onClick={onOpenAiSettings}><IconSettings />AI 设置</button>
      </SectionHead>
      <div className="chat-workbench">
      <div className="chat-shell">
        {messages.length === 0 && !waiting ? (
          <div className="chat-empty">
            <div>
              <div className="empty-icon"><IconSparkle /></div>
              <p style={{ fontWeight: 600, color: "var(--text-2)" }}>
                <BlurText value={hasAiConfig ? "把收藏、提示词、网页内容丢进来，我帮你提炼成可复用资产" : "先到「AI 设置」填入你的 API Key 才能开聊"} />
              </p>
              {!hasAiConfig && (
                <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={onOpenAiSettings}>
                  <IconSettings />去配置
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="chat-msgs" ref={msgsRef}>
            {messages.map((m, i) => (
              <div key={i} className={"msg-row " + m.role}>
                {m.role === "assistant"
                  ? <MarkdownBubble content={m.content} />
                  : <div className="msg-bubble">{m.content}</div>}
              </div>
            ))}
            {waiting && messages.length > 0 && messages[messages.length - 1].role === "user" && (
              <div className="msg-row assistant">
                <div className="msg-bubble thinking">正在思考……</div>
              </div>
            )}
          </div>
        )}
        <div className="chat-input-row">
          <textarea className="chat-input" rows="2" placeholder="输入内容，Enter 发送，Shift+Enter 换行"
            value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} />
          <button className="btn btn-primary" onClick={handleSend} disabled={waiting}>
            <IconSend />{waiting ? "等待中" : "发送"}
          </button>
        </div>
      </div>
      <aside className="chat-capture-panel">
        <div className="capture-panel-head">
          <IconSparkle />
          <div>
            <h3>提炼台</h3>
            <p>把散乱输入转成可收藏、可搜索、可复用的资产。</p>
          </div>
        </div>
        <div className="capture-template-list">
          {captureTemplates.map((item) => (
            <button key={item.title} className="capture-template" onClick={() => useTemplate(item)}>
              <span>{item.title}</span>
              <IconPlus />
            </button>
          ))}
        </div>
        <div className="capture-rules">
          <div><strong>收集</strong><span>原文、链接、截图、上下文</span></div>
          <div><strong>提炼</strong><span>用途、变量、注意事项</span></div>
          <div><strong>复用</strong><span>复制、试跑、回写到提示词库</span></div>
        </div>
      </aside>
      </div>
    </div>
  );
}

Object.assign(window, { AiSettingsModal, ChatView });
