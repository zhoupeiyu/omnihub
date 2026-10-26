/// AI 对话模块 —— 聊天界面（流式 + Markdown 渲染）+ AI 账号配置弹窗
const { useState: useChatState, useEffect: useChatEffect, useRef: useChatRef } = React;

/** 把 AI 回复的 Markdown 安全地渲染成 HTML（marked 解析 + DOMPurify 消毒） */
function MarkdownBubble({ content }) {
  const html = DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  return <div className="msg-bubble md-body" dangerouslySetInnerHTML={{ __html: html }}></div>;
}

/** AI 配置弹窗：服务商预设一键填入，Key 留空表示沿用已保存的 */
function AiSettingsModal({ onClose, onSaved, showToast, embedded = false, initialTab = "chat" }) {
  const [settingsTab, setSettingsTab] = useChatState(initialTab);
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
  const [loaded, setLoaded] = useChatState({chat:false, media:false});
  const [loadErrors, setLoadErrors] = useChatState({});

  useChatEffect(() => {
    api("/api/ai-config")
      .then((config) => {
        setBaseUrl(config.baseUrl);
        setModel(config.model);
        setMaskedKey(config.apiKeyMasked);
        setLoaded(current => ({...current,chat:true}));
      })
      .catch(() => setLoadErrors(current => ({...current, chat:"无法读取文字服务配置，请关闭设置后重试。"})));
    api("/api/media/config")
      .then((config) => {
        setMediaBaseUrl(config.baseUrl || "");
        setMediaAuthMasked(config.authenticationMasked || "");
        setSysTokenMasked(config.sysTokenMasked || "");
        setLoaded(current => ({...current,media:true}));
      })
      .catch(() => setLoadErrors(current => ({...current, media:"无法读取媒体服务配置，请关闭设置后重试。"})));
  }, []);

  function applyPreset(preset) {
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  }

  function handleSave() {
    if (!loaded[settingsTab] || saving) return;
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
    <div className={embedded ? "settings-ai" : "modal-overlay"} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? "settings-ai-form" : "modal wide"} onClick={(e) => e.stopPropagation()}>
        <h2>AI 服务</h2><p className="settings-description">连接当前账号使用的服务。模型、比例和时长仍在创作时选择。</p>
        <div className="media-settings-tabs" role="group" aria-label="服务类型">
          <button aria-pressed={settingsTab === "chat"} className={settingsTab === "chat" ? "active" : ""} onClick={() => { setSettingsTab("chat"); setError(""); }}>文字对话</button>
          <button aria-pressed={settingsTab === "media"} className={settingsTab === "media" ? "active" : ""} onClick={() => { setSettingsTab("media"); setError(""); }}>图片／视频生成</button>
        </div>
        <fieldset className="settings-service-fields" disabled={!loaded[settingsTab] || saving}>
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
        </fieldset>
        {(error || loadErrors[settingsTab]) && <p className="auth-error" role="alert">{error || loadErrors[settingsTab]}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !loaded[settingsTab]}>
            <IconCheck />{saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 聊天视图：消息状态由上层持有（切换模块不丢失）；prefill 只带入提示词，不自动发送 */
function ChatView({ messages, onMessagesChange, prefill, onPrefillUsed, hasAiConfig, onOpenAiSettings, showToast, sources = [], onSaveResult }) {
  const setMessages = onMessagesChange;
  const [input, setInput] = useChatState("");
  const [waiting, setWaiting] = useChatState(false);
  const [modelTag, setModelTag] = useChatState("");
  const msgsRef = useChatRef(null);
  const requestRef = useChatRef(null);
  const [selectedSource,setSelectedSource] = useChatState(null);
  useChatEffect(() => () => requestRef.current?.abort(), []);

  useChatEffect(() => {
    if (prefill) {
      setInput(current => current.trim() ? `${current}\n\n${prefill}` : prefill);
      onPrefillUsed();
    }
  }, [prefill]);

  useChatEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages, waiting]);

  /** 解析后端 SSE 流，把增量内容逐字渲染到最后一条 assistant 消息上 */
  async function readStream(response, baseMessages, source) {
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
          setMessages([...baseMessages, { role: "assistant", content: accumulated, source, complete:false }]);
        }
      }
    }
    if (!accumulated) throw new Error("AI 服务返回了空回复");
    setMessages([...baseMessages,{role:'assistant',content:accumulated,source,complete:true}]);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || waiting) return;
    if (!hasAiConfig) { onOpenAiSettings(); return; }
    const nextMessages = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setWaiting(true);
    const controller = new AbortController(); requestRef.current = controller;
    const source = selectedSource;
    try {
      const response = await fetch("/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages.map(({role,content}) => ({role,content})) }),
        signal:controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload && payload.error) || `请求失败（${response.status}）`);
      }
      await readStream(response, nextMessages, source);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setInput(current => current || text);
        setMessages(current => current.map((message,index) => index >= nextMessages.length ? {...message,complete:false,error:'回复未完成，请核对后重试'} : message));
        showToast(err.message);
      }
    } finally {
      setWaiting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      <SectionHead icon={<IconSend />} title="AI 提炼台" count={null}>
        {modelTag && <span className="chat-model-tag">{modelTag}</span>}
        {messages.length > 0 && (
          <button className="btn" disabled={waiting} onClick={() => {setMessages([]);setSelectedSource(null);}}><IconRefresh />新对话</button>
        )}
        <button className="btn" onClick={onOpenAiSettings}><IconSettings />设置</button>
      </SectionHead>
      <div className="chat-workbench">
      <div className="chat-shell">
        {messages.length === 0 && !waiting ? (
          <div className="chat-empty">
            <div>
              <div className="empty-icon"><IconSparkle /></div>
              <p style={{ fontWeight: 600, color: "var(--text-2)" }}>
                <BlurText value={hasAiConfig ? "把收藏、提示词、网页内容丢进来，我帮你提炼成可复用资产" : "先到「设置 → AI 服务」连接文字对话服务"} />
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
                  ? <div className="chat-result"><MarkdownBubble content={m.content} />
                      {m.source?.url && <a className="chat-result-source" href={m.source.url} target="_blank" rel="noopener noreferrer">原始来源：{m.source.title || '打开原文'} ↗</a>}
                      {m.error && <p role="status" className="muted">{m.error}</p>}
                      {m.complete && onSaveResult && <div className="chat-result-actions">
                        <button className="btn btn-ghost" onClick={() => onSaveResult(m,i,'knowledge')}>{m.savedAssets?.knowledge ? '查看已保存文章' : '存为知识文章'}</button>
                        <button className="btn btn-ghost" onClick={() => onSaveResult(m,i,'prompt')}>{m.savedAssets?.prompt ? '查看已保存提示词' : '存为提示词'}</button>
                      </div>}
                    </div>
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
          <button className="btn btn-primary" onClick={handleSend} disabled={waiting || !input.trim()}>
            <IconSend />{waiting ? "等待中" : "发送"}
          </button>
        </div>
      </div>
      <aside className="chat-capture-panel">
        <div className="capture-panel-head">
          <IconSparkle />
          <div>
            <h3>提炼台</h3>
            <p>选择原文、提炼内容，核对后保存到主库。</p>
          </div>
        </div>
        <label className="capture-source-field">从待整理收藏开始
          <select className="select" value={selectedSource?.id || ''} disabled={waiting} onChange={event => {
            const item = sources.find(row => String(row.id) === event.target.value);
            if (!item) {setSelectedSource(null);return;}
            if (input.trim() && !confirm('用这条收藏替换当前输入吗？已发送的对话会保留。')) return;
            setSelectedSource({id:item.id,title:item.title,url:item.url || '',author:item.author || '',content:item.content || ''});
            setInput(`${item.title || ''}\n\n${item.content || ''}${item.url ? `\n\n原始来源：${item.url}` : ''}`.trim());
          }}><option value="">选择收藏，或直接粘贴内容</option>{sources.map(item => <option key={item.id} value={item.id}>{item.title || (item.content || '').slice(0,40) || '未命名收藏'}</option>)}</select>
        </label>
        <div className="capture-template-list">
          {captureTemplates.map((item) => (
            <button key={item.title} className="capture-template" disabled={waiting} onClick={() => useTemplate(item)}>
              <span>{item.title}</span>
              <IconPlus />
            </button>
          ))}
        </div>
        <div className="capture-rules">
          <div><strong>收集</strong><span>原文、链接、截图、上下文</span></div>
          <div><strong>提炼</strong><span>用途、变量、注意事项</span></div>
          <div><strong>复用</strong><span>预览确认后保存到知识库或提示词库</span></div>
        </div>
      </aside>
      </div>
    </div>
  );
}

Object.assign(window, { AiSettingsModal, ChatView });
