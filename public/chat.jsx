/// AI 对话模块 —— 聊天界面（流式 + Markdown 渲染）+ AI 账号配置弹窗
const { useState: useChatState, useEffect: useChatEffect, useRef: useChatRef } = React;

/** 把 AI 回复的 Markdown 安全地渲染成 HTML（marked 解析 + DOMPurify 消毒） */
function MarkdownBubble({ content }) {
  const html = DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  return <div className="msg-bubble md-body" dangerouslySetInnerHTML={{ __html: html }}></div>;
}

/** AI 配置弹窗：服务商预设一键填入，Key 留空表示沿用已保存的 */
function AiSettingsModal({ onClose, onSaved, showToast }) {
  const [baseUrl, setBaseUrl] = useChatState("");
  const [apiKey, setApiKey] = useChatState("");
  const [model, setModel] = useChatState("");
  const [maskedKey, setMaskedKey] = useChatState("");
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
  }, []);

  function applyPreset(preset) {
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  }

  function handleSave() {
    if (!baseUrl.trim() || !model.trim()) { setError("接口地址和模型名不能为空"); return; }
    if (!apiKey.trim() && !maskedKey) { setError("请填写 API Key"); return; }
    setSaving(true);
    api("/api/ai-config", { method: "PUT", body: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() } })
      .then(() => { showToast("AI 配置已保存"); onSaved(); onClose(); })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>AI 设置（只对你自己的账号生效）</h2>
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

  return (
    <div>
      <SectionHead icon={<IconSend />} title="AI 对话" count={null}>
        {modelTag && <span className="chat-model-tag">{modelTag}</span>}
        {messages.length > 0 && (
          <button className="btn" onClick={() => setMessages([])}><IconRefresh />新对话</button>
        )}
        <button className="btn" onClick={onOpenAiSettings}><IconSettings />AI 设置</button>
      </SectionHead>
      <div className="chat-shell">
        {messages.length === 0 && !waiting ? (
          <div className="chat-empty">
            <div>
              <div className="empty-icon"><IconSparkle /></div>
              <p style={{ fontWeight: 600, color: "var(--text-2)" }}>
                {hasAiConfig ? "随便聊点什么，或从提示词库点「试跑」开始" : "先到「AI 设置」填入你的 API Key 才能开聊"}
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
          <textarea className="chat-input" rows="2" placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} />
          <button className="btn btn-primary" onClick={handleSend} disabled={waiting}>
            <IconSend />{waiting ? "等待中" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AiSettingsModal, ChatView });
