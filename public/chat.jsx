/// AI 对话模块 —— AI 提炼台（原文 / 结果 / 保存三栏 + 辅助对话，流式 + Markdown 渲染）+ AI 账号配置弹窗
const { useState: useChatState, useEffect: useChatEffect, useRef: useChatRef, useMemo: useChatMemo } = React;

// <chat-workbench-logic>
const CHAT_STREAM_EOF_ERROR = "回复中断：连接提前结束";
const CHAT_SOURCE_MATCH_LIMIT = 8;
const CHAT_RECENT_SOURCE_LIMIT = 5;

/** A finished assistant turn that may be sent back as context or saved. */
function chatTurnUsable(message) {
  return Boolean(message && message.role === "assistant" && message.complete === true && !message.error
    && String(message.content || "").trim());
}

/** Outbound context: failed/incomplete turns and their unanswered questions stay local. */
function chatOutboundMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!message) continue;
    if (message.role === "assistant") {
      if (chatTurnUsable(message)) out.push({ role: "assistant", content: String(message.content) });
      continue;
    }
    if (message.role !== "user") continue;
    if (index === list.length - 1 || chatTurnUsable(list[index + 1])) out.push({ role: "user", content: String(message.requestContent || message.content || "") });
  }
  return out;
}

/** Decide how a send changes the thread: retry replaces the failed turn, a new question appends. */
function chatSendPlan(messages, text) {
  const list = Array.isArray(messages) ? messages : [];
  const question = String(text || "").trim();
  const last = list[list.length - 1];
  const previous = list[list.length - 2];
  const same = (message) => message && message.role === "user" && String(message.content || "").trim() === question;
  let base;
  let retry = false;
  if (last && last.role === "assistant" && !chatTurnUsable(last) && same(previous)) {
    base = list.slice(0, -1);
    retry = true;
  } else if (same(last)) {
    base = list.slice();
    retry = true;
  } else {
    base = [...list, { role: "user", content: question }];
  }
  return { base, retry, outbound: chatOutboundMessages(base) };
}

/** Incremental SSE parser. end() throws unless the stream reported completion. */
function createChatStreamParser(handlers = {}) {
  let buffer = "";
  let text = "";
  let completed = false;
  function handleEvent(raw) {
    const data = String(raw).split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { completed = true; return; }
    let payload;
    try { payload = JSON.parse(data); } catch { throw new Error("AI 服务返回了无法解析的数据"); }
    if (payload && payload.error) throw new Error(String(payload.error));
    if (payload && payload.model && handlers.onModel) handlers.onModel(payload.model);
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const delta = typeof payload?.delta === "string" ? payload.delta : choice?.delta?.content;
    if (delta) {
      text += delta;
      if (handlers.onDelta) handlers.onDelta(text, delta);
    }
    if (payload?.done === true || payload?.finish_reason || choice?.finish_reason) completed = true;
  }
  return {
    push(chunk) {
      buffer += String(chunk || "").replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const event of events) handleEvent(event);
    },
    end() {
      if (buffer.trim()) { const rest = buffer; buffer = ""; handleEvent(rest); }
      if (!completed) throw new Error(text ? CHAT_STREAM_EOF_ERROR : "AI 服务没有返回内容，连接已结束");
      if (!text.trim()) throw new Error("AI 服务返回了空回复");
      return text;
    },
    get text() { return text; },
    get completed() { return completed; },
  };
}

function chatSourceMaterial(source) {
  const metrics = typeof source?.metrics === 'string' ? (() => { try { return JSON.parse(source.metrics); } catch { return {}; } })() : (source?.metrics || {});
  return metrics?.article?.plainText || metrics?.article?.body || metrics?.recoveredPost?.text || source?.content || '';
}
function chatSourceText(source) {
  if (!source) return "";
  return `${source.title || ""}\n\n${chatSourceMaterial(source)}${source.url ? `\n\n原始来源：${source.url}` : ""}`.trim();
}
function chatSourceRef(source) {
  return { id: source.id, title: source.title || "", url: source.url || "", author: source.author || "", content: chatSourceMaterial(source) };
}

/** Bounded source search over title / author / content; title hits rank first. */
function chatSourceSearch(sources, query, limit = CHAT_SOURCE_MATCH_LIMIT) {
  const list = Array.isArray(sources) ? sources : [];
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { matches: [], total: 0 };
  const hits = [];
  list.forEach((item, order) => {
    if (!item) return;
    const title = String(item.title || "").toLowerCase();
    const author = String(item.author || "").toLowerCase();
    const content = String(item.content || "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 3;
      else if (author.includes(term)) score += 2;
      else if (content.includes(term)) score += 1;
      else return;
    }
    hits.push({ item, score, order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return { matches: hits.slice(0, Math.max(0, limit)).map((hit) => hit.item), total: hits.length };
}

function chatTextGrams(text) {
  const compact = String(text || "").toLowerCase().replace(/\s+/g, "");
  const grams = new Set();
  if (compact.length === 1) grams.add(compact);
  for (let index = 0; index < compact.length - 1; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

function chatGramCoverage(part, whole) {
  if (!part.size) return 1;
  let hit = 0;
  for (const gram of part) if (whole.has(gram)) hit += 1;
  return hit / part.size;
}

/**
 * Is the composer still about the bound source?
 * Before the first send the inserted source text must mostly remain; after it was sent,
 * short follow-ups are fine but a large unrelated paste counts as replaced material.
 */
function chatSourceBindingState(binding, input) {
  if (!binding || !binding.source) return "none";
  const text = String(input || "").trim();
  if (!text) return "empty";
  if (binding.confirmedInput && binding.confirmedInput === text) return "bound";
  const sourceGrams = chatTextGrams(binding.insertedText || chatSourceText(binding.source));
  const inputGrams = chatTextGrams(text);
  return chatGramCoverage(sourceGrams, inputGrams) < 0.5 ? "stale" : "bound";
}

/** Keep the human instruction separate while making the exact source sent to AI auditable. */
function chatRequestContent(original, instruction) {
  const source = String(original || "").trim();
  const task = String(instruction || "").trim();
  return source ? `原文：\n${source}\n\n整理要求：\n${task}` : task;
}

/** Shape shared with the parent save record; compare content, classification and provenance together. */
function chatSaveSnapshot(content, source, classification) {
  const tags = Array.isArray(classification?.tags) ? classification.tags.join(',') : String(classification?.tags || '');
  return {
    content: String(content || ''),
    source: source ? { id: source.id || null, url: source.url || '' } : null,
    classification: { category: classification?.category || '', tags },
  };
}

/** A generated result is safe to leave only after its current draft has a matching save snapshot. */
function chatHasUnsavedWork(originalText, lastSentOriginal, messages, drafts, saveOptions) {
  if (String(originalText || '').trim() !== String(lastSentOriginal || '').trim()) return Boolean(String(originalText || '').trim());
  return (Array.isArray(messages) ? messages : []).some((message, index) => {
    if (!chatTurnUsable(message)) return false;
    const draft = drafts?.[index] ?? message.content ?? '';
    const snapshots = message.savedSnapshots || {};
    if (drafts?.[index] === undefined) return !Object.values(snapshots).some((snapshot) => snapshot?.content === draft);
    const option = saveOptions?.[index] || { target: 'knowledge', category: '', tagText: '', includeSource: true };
    const tags = String(option.tagText || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    const source = option.includeSource === false ? null : message.source || null;
    const current = chatSaveSnapshot(draft, source, { category: option.target === 'prompt' ? option.category : '', tags });
    return JSON.stringify(snapshots[option.target]) !== JSON.stringify(current);
  });
}

/** A retry must use the failed turn's exact source snapshot, including null and an empty original. */
function chatRequestSnapshot(plan, binding, originalText, instruction) {
  const retryUser = plan?.retry ? plan.base?.[plan.base.length - 1] : null;
  const own = (key) => retryUser && Object.prototype.hasOwnProperty.call(retryUser, key);
  const source = retryUser ? (own('source') ? retryUser.source : null) : binding?.source || null;
  const sourceText = retryUser ? (own('originalText') ? retryUser.originalText : '') : String(originalText || '').trim();
  const requestContent = retryUser && own('requestContent')
    ? retryUser.requestContent : chatRequestContent(sourceText, instruction);
  return { source, originalText: sourceText, requestContent };
}

function chatRecentSources(recentIds, sources, limit = CHAT_RECENT_SOURCE_LIMIT) {
  const byId = new Map((Array.isArray(sources) ? sources : []).map((item) => [String(item.id), item]));
  return (Array.isArray(recentIds) ? recentIds : []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, limit);
}

function chatPushRecent(recentIds, id, limit = CHAT_RECENT_SOURCE_LIMIT) {
  const key = String(id);
  return [key, ...(Array.isArray(recentIds) ? recentIds : []).map(String).filter((item) => item !== key)].slice(0, limit);
}
// </chat-workbench-logic>

/** 把 AI 回复的 Markdown 安全地渲染成 HTML（marked 解析 + DOMPurify 消毒） */
function MarkdownBubble({ content, className = "msg-bubble md-body" }) {
  const html = DOMPurify.sanitize(marked.parse(content || "", { breaks: true }));
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }}></div>;
}

/** AI 配置弹窗：服务商预设一键填入，Key 留空表示沿用已保存的 */
function AiSettingsModal({ onClose, onSaved, showToast, embedded = false, initialTab = "chat", onDirtyChange }) {
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
  const [initial, setInitial] = useChatState({ baseUrl: "", model: "", mediaBaseUrl: "" });
  const dirtyReport = useChatRef(onDirtyChange);
  dirtyReport.current = onDirtyChange;

  useChatEffect(() => {
    api("/api/ai-config")
      .then((config) => {
        setBaseUrl(config.baseUrl || "");
        setModel(config.model || "");
        setMaskedKey(config.apiKeyMasked);
        setInitial(current => ({ ...current, baseUrl: config.baseUrl || "", model: config.model || "" }));
        setLoaded(current => ({...current,chat:true}));
      })
      .catch(() => setLoadErrors(current => ({...current, chat:"无法读取文字服务配置，请关闭设置后重试。"})));
    api("/api/media/config")
      .then((config) => {
        setMediaBaseUrl(config.baseUrl || "");
        setMediaAuthMasked(config.authenticationMasked || "");
        setSysTokenMasked(config.sysTokenMasked || "");
        setInitial(current => ({ ...current, mediaBaseUrl: config.baseUrl || "" }));
        setLoaded(current => ({...current,media:true}));
      })
      .catch(() => setLoadErrors(current => ({...current, media:"无法读取媒体服务配置，请关闭设置后重试。"})));
  }, []);

  // 未保存修改：改了地址/模型，或填写了新的密钥类字段（留空表示沿用已保存值，不算修改）
  const dirty = Boolean(
    (loaded.chat && (baseUrl !== initial.baseUrl || model !== initial.model)) || apiKey.trim()
    || (loaded.media && mediaBaseUrl !== initial.mediaBaseUrl) || authentication.trim() || sysToken.trim() || clearSysToken
  );
  useChatEffect(() => { if (dirtyReport.current) dirtyReport.current(dirty); }, [dirty]);
  useChatEffect(() => () => { if (dirtyReport.current) dirtyReport.current(false); }, []);

  function finishSaved(kind) {
    if (dirtyReport.current) dirtyReport.current(false);
    onSaved(kind);
    onClose();
  }

  function handleCancel() {
    if (!embedded && dirty && window.OmniNavigationGuard && !window.OmniNavigationGuard.confirmDiscard(true, "AI 服务设置还有未保存的修改，确定放弃吗？")) return;
    onClose();
  }

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
        .then(() => {
          setInitial(current => ({ ...current, mediaBaseUrl }));
          if (authentication.trim()) setMediaAuthMasked(current => current || "已保存");
          setAuthentication(""); setSysToken(""); setClearSysToken(false);
          showToast(mediaBaseUrl.trim() ? "媒体接口配置已保存" : "认证已保存到网站服务，等待填写安全接口地址");
          finishSaved("media");
        })
        .catch((err) => setError(err.message))
        .finally(() => setSaving(false));
      return;
    }
    if (!baseUrl.trim() || !model.trim()) { setError("接口地址和模型名不能为空"); return; }
    if (!apiKey.trim() && !maskedKey) { setError("请填写 API Key"); return; }
    setSaving(true);
    api("/api/ai-config", { method: "PUT", body: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() } })
      .then(() => {
        setInitial(current => ({ ...current, baseUrl, model }));
        if (apiKey.trim()) setMaskedKey(current => current || "已保存");
        setApiKey("");
        showToast("AI 配置已保存");
        finishSaved("chat");
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className={embedded ? "settings-ai" : "modal-overlay"} onClick={embedded ? undefined : handleCancel}>
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
          <label htmlFor="ai-settings-base-url">接口地址 Base URL（填到 /v1 这一级）</label>
          <input id="ai-settings-base-url" className="input" placeholder="例如：https://api.deepseek.com/v1" value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label htmlFor="ai-settings-key">API Key{maskedKey ? `（已保存 ${maskedKey}，留空表示不变）` : ""}</label>
          <input id="ai-settings-key" className="input" type="password" autoComplete="off" placeholder={maskedKey ? "留空沿用已保存的 Key" : "sk-…"}
            value={apiKey} onChange={(e) => { setApiKey(e.target.value); setError(""); }} />
          <p className="form-hint">Key 保存在本网站服务的数据库中，只用于转发你自己的对话请求；保存后只显示掩码。</p>
        </div>
        <div className="form-field">
          <label htmlFor="ai-settings-model">模型名</label>
          <input id="ai-settings-model" className="input" placeholder="例如：deepseek-chat" value={model}
            onChange={(e) => { setModel(e.target.value); setError(""); }} />
        </div>
        </React.Fragment> : <React.Fragment>
          <div className="form-field">
            <label htmlFor="ai-settings-media-url">媒体接口 Base URL</label>
            <input id="ai-settings-media-url" className="input" value={mediaBaseUrl}
              placeholder="http://39.96.116.239:9001"
              onChange={(e) => { setMediaBaseUrl(e.target.value); setError(""); }} />
            <p className="form-hint">个人调用只需 authentication，sys_token 可留空。公司文档地址使用明文 HTTP；提交时认证可能被中间网络设备读取。其他公网 HTTP 地址仍不可配置。</p>
          </div>
          <div className="form-field">
            <label htmlFor="ai-settings-media-auth">authentication{mediaAuthMasked ? `（${mediaAuthMasked}，留空沿用）` : ""}</label>
            <input id="ai-settings-media-auth" className="input" type="password" autoComplete="off" value={authentication}
              placeholder={mediaAuthMasked ? "留空沿用已保存认证" : "填写你自己的认证信息"}
              onChange={(e) => { setAuthentication(e.target.value); setError(""); }} />
          </div>
          <div className="form-field">
            <label htmlFor="ai-settings-sys-token">sys_token{sysTokenMasked ? `（${sysTokenMasked}，留空沿用）` : "（个人调用通常留空）"}</label>
            <input id="ai-settings-sys-token" className="input" type="password" autoComplete="off" value={sysToken}
              placeholder="仅服务方要求时填写"
              onChange={(e) => { setSysToken(e.target.value); setError(""); }} />
            {sysTokenMasked && <label className="media-inline-check"><input type="checkbox" checked={clearSysToken}
              onChange={(e) => setClearSysToken(e.target.checked)} />清除已保存的 sys_token</label>}
            <p className="form-hint">认证信息保存在本网站服务的数据库中，保存后只显示掩码，不会完整返回到网页。生成可能消耗公司额度。</p>
          </div>
        </React.Fragment>}
        </fieldset>
        {(error || loadErrors[settingsTab]) && <p className="auth-error" role="alert">{error || loadErrors[settingsTab]}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleCancel}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !loaded[settingsTab]}>
            <IconCheck />{saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

const CHAT_CAPTURE_TEMPLATES = [
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

const CHAT_RECENT_STORAGE_KEY = "refinery.recentSources";

/** AI 提炼台：原文（检索并显式关联）→ 生成结果（可编辑）→ 保存位置/分类/引用；辅助对话保留 */
function ChatView({ messages, onMessagesChange, prefill, onPrefillUsed, hasAiConfig, onOpenAiSettings, showToast, sources = [], onLoadSource, onSearchSources, onSaveResult, active = false }) {
  const setMessages = onMessagesChange;
  const [input, setInput] = useChatState("");
  const [originalText, setOriginalText] = useChatState("");
  const [lastSentOriginal, setLastSentOriginal] = useChatState("");
  const [waiting, setWaiting] = useChatState(false);
  const [modelTag, setModelTag] = useChatState("");
  const [binding, setBinding] = useChatState(null);
  const [bindingPrompt, setBindingPrompt] = useChatState(false);
  const [sourceQuery, setSourceQuery] = useChatState("");
  const [recentIds, setRecentIds] = useChatState(() => (typeof loadStored === "function" ? loadStored(CHAT_RECENT_STORAGE_KEY, []) : []));
  const [showFullSource, setShowFullSource] = useChatState(false);
  const [selectedIndex, setSelectedIndex] = useChatState(-1);
  const [drafts, setDrafts] = useChatState({});
  const [resultMode, setResultMode] = useChatState("preview");
  const [saveOptions, setSaveOptions] = useChatState({});
  const [inspectSource, setInspectSource] = useChatState(false);
  const [mobileTab, setMobileTab] = useChatState("source");
  const msgsRef = useChatRef(null);
  const requestRef = useChatRef(null);
  const runRef = useChatRef(0);
  const busyRef = useChatRef(false);
  const sourceSearchRunRef = useChatRef(0);
  const sourceBindRunRef = useChatRef(0);
  const sourceBindControllerRef = useChatRef(null);
  const sourceSearchRef = useChatRef(onSearchSources);
  sourceSearchRef.current = onSearchSources;
  const activeRef = useChatRef(active);
  activeRef.current = active;
  const messagesRef = useChatRef(messages);
  messagesRef.current = messages;

  useChatEffect(() => () => { runRef.current += 1; sourceSearchRunRef.current += 1; sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort(); requestRef.current?.abort(); }, []);
  useChatEffect(() => { if (!active) { sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort(); } }, [active]);

  useChatEffect(() => {
    if (prefill) {
      setInput(current => current.trim() ? `${current}\n\n${prefill}` : prefill);
      onPrefillUsed();
    }
  }, [prefill]);

  useChatEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages, waiting]);

  useChatEffect(() => { if (typeof saveStored === "function") saveStored(CHAT_RECENT_STORAGE_KEY, recentIds); }, [recentIds]);

  const [remoteSearch, setRemoteSearch] = useChatState(null);
  const [sourceSearchError, setSourceSearchError] = useChatState("");
  const [sourceSearchRetry, setSourceSearchRetry] = useChatState(0);
  useChatEffect(() => {
    const query = String(sourceQuery || "").trim();
    const searchSources = sourceSearchRef.current;
    if (!query || typeof searchSources !== "function") { setRemoteSearch(null); setSourceSearchError(""); return undefined; }
    const controller = new AbortController(); const run = ++sourceSearchRunRef.current;
    setRemoteSearch(null); setSourceSearchError("");
    const timer = setTimeout(() => searchSources(query, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted && run === sourceSearchRunRef.current) setRemoteSearch({ query, ids: result.ids || [], total: Number(result.total) || 0 });
    }).catch((error) => { if (!controller.signal.aborted && run === sourceSearchRunRef.current) setSourceSearchError(error.message || "搜索失败，请重试"); }), 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sourceQuery, sourceSearchRetry]);
  const bindingState = chatSourceBindingState(binding, originalText);
  const search = useChatMemo(() => {
    if (remoteSearch?.query === String(sourceQuery || "").trim()) {
      const byId = new Map(sources.map(item => [String(item.id), item]));
      return { matches: remoteSearch.ids.map(id => byId.get(String(id))).filter(Boolean).slice(0, CHAT_SOURCE_MATCH_LIMIT), total: remoteSearch.total };
    }
    return chatSourceSearch(sources, sourceQuery);
  }, [sources, sourceQuery, remoteSearch]);
  const recent = useChatMemo(() => chatRecentSources(recentIds, sources), [recentIds, sources]);

  const lastAssistantIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "assistant") return index;
    return -1;
  })();
  const resultIndex = messages[selectedIndex]?.role === "assistant" ? selectedIndex : lastAssistantIndex;
  const result = resultIndex >= 0 ? messages[resultIndex] : null;
  const draft = result ? (drafts[resultIndex] ?? result.content ?? "") : "";
  const resultUsable = chatTurnUsable(result);
  const resultIsLast = resultIndex === messages.length - 1;
  const retryQuestion = result && !resultUsable && resultIsLast && messages[resultIndex - 1]?.role === "user"
    ? messages[resultIndex - 1].content : "";
  const resultSource = result?.source || null;
  const saveOption = saveOptions[resultIndex] || { target: "knowledge", category: PROMPT_CATEGORIES[0], tagText: "", includeSource: true };
  const { target, category, tagText, includeSource } = saveOption;
  const sourceMismatch = Boolean(resultSource && binding?.source && String(resultSource.id) !== String(binding.source.id));
  const hasUnsavedWork = chatHasUnsavedWork(originalText, lastSentOriginal, messages, drafts, saveOptions);

  useChatEffect(() => {
    const message = "提炼台还有未保存的原文或结果，确定离开吗？";
    const confirmLeave = () => window.OmniNavigationGuard?.confirmDiscard
      ? window.OmniNavigationGuard.confirmDiscard(hasUnsavedWork, message)
      : !hasUnsavedWork || window.confirm(message);
    if (!active) return undefined;
    const unregister = window.OmniNavigationGuard?.register?.(confirmLeave);
    return () => { unregister?.(); };
  }, [active, hasUnsavedWork]);

  useChatEffect(() => {
    const message = "提炼台还有未保存的原文或结果，确定离开吗？";
    const beforeUnload = (event) => {
      if (!hasUnsavedWork) return;
      event.preventDefault();
      event.returnValue = message;
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("beforeunload", beforeUnload); };
  }, [hasUnsavedWork]);

  function commit(next) {
    messagesRef.current = next;
    setMessages(next);
  }

  async function bindSource(item) {
    if (busyRef.current || !item || !activeRef.current) return;
    sourceBindControllerRef.current?.abort();
    const controller = new AbortController(); sourceBindControllerRef.current = controller;
    const run = ++sourceBindRunRef.current;
    let source = item;
    try {
      if (item.isListItem) {
        if (typeof onLoadSource !== "function") throw new Error("原文暂时无法加载");
        source = await onLoadSource(item.id, { signal: controller.signal });
        if (controller.signal.aborted || run !== sourceBindRunRef.current || !activeRef.current || busyRef.current) return;
        if (!source || String(source.id) !== String(item.id)) throw new Error("原文加载失败");
      }
    } catch (error) { if (run === sourceBindRunRef.current && activeRef.current) showToast(error.message || "原文加载失败"); return; }
    if (controller.signal.aborted || run !== sourceBindRunRef.current || !activeRef.current || busyRef.current) return;
    const text = chatSourceText(source);
    if (originalText.trim() && originalText.trim() !== text && !confirm("用这条收藏替换当前原文吗？已发送的对话会保留。")) return;
    setBinding({ source: chatSourceRef(source), insertedText: text, sent: false, confirmedInput: "" });
    setBindingPrompt(false);
    setOriginalText(text);
    setRecentIds(current => chatPushRecent(current, item.id));
    setSourceQuery("");
    setShowFullSource(false);
    setMobileTab("result");
  }

  function detachSource() {
    sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort();
    setBinding(null);
    setBindingPrompt(false);
    showToast("已解除原文关联，之后的结果不会带这条来源");
  }

  function keepSource() {
    setBinding(current => current && { ...current, confirmedInput: originalText.trim() });
    setBindingPrompt(false);
  }

  function newConversation() {
    const allowNew = window.OmniNavigationGuard?.confirmDiscard
      ? window.OmniNavigationGuard.confirmDiscard(hasUnsavedWork, "提炼台还有未保存的原文或结果，确定新建对话吗？")
      : !hasUnsavedWork || window.confirm("提炼台还有未保存的原文或结果，确定新建对话吗？");
    if (!allowNew) return;
    runRef.current += 1;
    sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort();
    requestRef.current?.abort();
    requestRef.current = null;
    busyRef.current = false;
    setWaiting(false);
    commit([]);
    setBinding(null);
    setBindingPrompt(false);
    setDrafts({});
    setSaveOptions({});
    setOriginalText("");
    setLastSentOriginal("");
    setSelectedIndex(-1);
    setResultMode("preview");
  }

  async function handleSend(override) {
    const text = String(override ?? input).trim();
    if (!text || busyRef.current) return;
    if (!hasAiConfig) { onOpenAiSettings(); return; }
    sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort();
    const plan = chatSendPlan(messagesRef.current, text);
    if (!plan.retry && chatSourceBindingState(binding, originalText) === "stale") {
      setBindingPrompt(true);
      setMobileTab("source");
      showToast("输入内容已和关联原文明显不同，请先确认保留或解除关联");
      return;
    }
    const sent = chatRequestSnapshot(plan, binding, originalText, text);
    const source = sent.source;
    const sentOriginal = sent.originalText;
    const requestContent = sent.requestContent;
    const base = plan.base.map((message, index) => index === plan.base.length - 1 && message.role === "user"
      ? { ...message, source, originalText: sentOriginal, requestContent } : message);
    const outbound = chatOutboundMessages(base);
    const runId = runRef.current + 1;
    runRef.current = runId;
    busyRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    const isCurrent = () => runRef.current === runId && !controller.signal.aborted;
    commit(base);
    if (binding && !binding.sent) setBinding(current => current && { ...current, sent: true, confirmedInput: "" });
    setLastSentOriginal(sentOriginal);
    setInput("");
    setWaiting(true);
    setSelectedIndex(base.length);
    setMobileTab("result");
    let partial = "";
    try {
      const response = await fetch("/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: outbound }),
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error((payload && payload.error) || `请求失败（${response.status}）`);
      }
      const parser = createChatStreamParser({
        onModel: (name) => { if (isCurrent()) setModelTag(name); },
        onDelta: (accumulated) => {
          partial = accumulated;
          if (isCurrent()) commit([...base, { role: "assistant", content: accumulated, source, complete: false }]);
        },
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent()) { reader.cancel().catch(() => {}); return; }
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      const finalText = parser.end();
      if (!isCurrent()) return;
      commit([...base, { role: "assistant", content: finalText, source, complete: true }]);
    } catch (err) {
      if (err.name === "AbortError" || !isCurrent()) return;
      commit([...base, { role: "assistant", content: partial, source, complete: false, error: `回复未完成：${err.message}` }]);
      setInput(current => current.trim() ? current : text);
      showToast(err.message);
    } finally {
      if (runRef.current === runId) {
        busyRef.current = false;
        requestRef.current = null;
        setWaiting(false);
      }
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  function useTemplate(template) {
    setInput((current) => current ? `${template.text}${current}` : template.text);
  }

  function setDraft(value) {
    setDrafts(current => ({ ...current, [resultIndex]: value }));
  }

  function setSaveOption(field, value) {
    setSaveOptions(current => ({ ...current, [resultIndex]: { ...saveOption, [field]: value } }));
  }

  function saveResult() {
    if (!onSaveResult || !result || !resultUsable || !draft.trim()) return;
    const tags = tagText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
    const classification = { category: target === "prompt" ? category : "", tags };
    const selectedSource = includeSource ? resultSource : null;
    onSaveResult({
      ...result,
      content: draft,
      originalContent: result.content,
      source: selectedSource,
      classification,
      saveSnapshot: chatSaveSnapshot(draft, selectedSource, classification),
      save: { target, existingAsset: result.savedAssets?.[target] || null, previous: result.savedSnapshots?.[target] || null },
    }, resultIndex, target);
  }

  const currentSaveSnapshot = chatSaveSnapshot(draft, includeSource ? resultSource : null,
    { category: target === "prompt" ? category : "", tags: tagText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) });
  const savedChanged = Boolean(result?.savedSnapshots?.[target]
    && JSON.stringify(result.savedSnapshots[target]) !== JSON.stringify(currentSaveSnapshot));
  const savedLabel = target === "prompt"
    ? (result?.savedAssets?.prompt ? (savedChanged ? "更新已保存提示词" : "查看已保存提示词") : "预览并保存为提示词")
    : (result?.savedAssets?.knowledge ? (savedChanged ? "更新已保存文章" : "查看已保存文章") : "预览并保存为知识文章");
  const sourceBody = binding?.source?.content || "";
  const tabs = [
    { id: "source", label: "原文" },
    { id: "result", label: "结果" },
    { id: "save", label: "保存" },
  ];

  return (
    <div className="refinery-workbench-page">
      <SectionHead icon={<IconSend />} title="AI 提炼台" count={null}>
        {modelTag && <span className="chat-model-tag">{modelTag}</span>}
        {messages.length > 0 && (
          <button className="btn" onClick={newConversation}><IconRefresh />新对话</button>
        )}
        <button className="btn" onClick={onOpenAiSettings}><IconSettings />设置</button>
      </SectionHead>
      <div className="refinery-tabs" role="tablist" aria-label="提炼台分区">
        {tabs.map(tab => (
          <button key={tab.id} role="tab" id={`refinery-tab-${tab.id}`} aria-controls={`refinery-pane-${tab.id}`}
            aria-selected={mobileTab === tab.id} className={mobileTab === tab.id ? "active" : ""}
            onClick={() => setMobileTab(tab.id)}>{tab.label}</button>
        ))}
      </div>
      <div className="refinery-workbench">
        <section id="refinery-pane-source" role="tabpanel" aria-labelledby="refinery-tab-source"
          className={"refinery-pane refinery-source-pane" + (mobileTab === "source" ? " is-active" : "")}>
          <header className="refinery-pane-head"><h3>原文</h3><span>{sources.length} 条待整理收藏</span></header>
          <label className="refinery-field">检索收藏（标题 / 作者 / 正文）
            <input className="input" type="search" value={sourceQuery} disabled={waiting}
              placeholder="输入关键词查找原文" onChange={event => setSourceQuery(event.target.value)} />
          </label>
          {sourceQuery.trim() ? (
            <div className="refinery-source-results" aria-live="polite">
              {sourceSearchError ? <p className="auth-error">{sourceSearchError} <button className="btn btn-ghost" onClick={() => setSourceSearchRetry(value => value + 1)}>重试</button></p> : <p className="refinery-muted">{remoteSearch === null && typeof sourceSearchRef.current === "function" ? "正在搜索完整原文…" : (search.total ? `找到 ${search.total} 条${search.total > search.matches.length ? `，显示前 ${search.matches.length} 条，请继续缩小关键词` : ""}` : "没有匹配的收藏")}</p>}
              <ul className="refinery-source-list">
                {search.matches.map(item => (
                  <li key={item.id}><button type="button" disabled={waiting} onClick={() => bindSource(item)}
                    aria-current={binding && String(binding.source.id) === String(item.id) ? "true" : undefined}>
                    <strong>{item.title || (item.content || "").slice(0, 40) || "未命名收藏"}</strong>
                    {item.author && <span>{item.author}</span>}
                  </button></li>
                ))}
              </ul>
            </div>
          ) : recent.length > 0 && (
            <div className="refinery-source-results">
              <p className="refinery-muted">最近使用</p>
              <ul className="refinery-source-list">
                {recent.map(item => (
                  <li key={item.id}><button type="button" disabled={waiting} onClick={() => bindSource(item)}>
                    <strong>{item.title || (item.content || "").slice(0, 40) || "未命名收藏"}</strong>
                    {item.author && <span>{item.author}</span>}
                  </button></li>
                ))}
              </ul>
            </div>
          )}
          <label className="refinery-field">原文（可直接粘贴或由收藏填入）
            <textarea className="input refinery-original-editor" rows="10" aria-label="待整理原文" value={originalText} disabled={waiting}
              placeholder="粘贴需要整理的原文；选择收藏会自动填入这里。" onChange={event => { sourceBindRunRef.current += 1; sourceBindControllerRef.current?.abort(); setOriginalText(event.target.value); }} />
          </label>
          {binding ? (
            <div className={"refinery-binding" + (bindingState === "stale" ? " is-stale" : "")}>
              <div className="refinery-binding-head">
                <span className="refinery-chip">已关联原文</span>
                <button type="button" className="btn btn-ghost" onClick={detachSource}>解除关联</button>
              </div>
              <h4>{binding.source.title || "未命名收藏"}</h4>
              {binding.source.author && <p className="refinery-muted">作者：{binding.source.author}</p>}
              {binding.source.url && <a href={binding.source.url} target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a>}
              {(bindingState === "stale" || bindingPrompt) && (
                <div className="refinery-binding-warning" role="alert">
                  <p>输入框里的内容已和这条原文明显不同。继续发送前，请确认结果是否仍属于这条原文。</p>
                  <div className="refinery-row">
                    <button type="button" className="btn" onClick={keepSource}>保持关联</button>
                    <button type="button" className="btn btn-ghost" onClick={detachSource}>解除关联</button>
                  </div>
                </div>
              )}
              {sourceBody && <div className="refinery-source-text" tabIndex={0} aria-label="原文内容">
                {showFullSource ? sourceBody : sourceBody.slice(0, 1600)}
                {sourceBody.length > 1600 && <button type="button" className="btn btn-ghost refinery-more" onClick={() => setShowFullSource(value => !value)}>
                  {showFullSource ? "收起" : "展开全文"}
                </button>}
              </div>}
            </div>
          ) : <p className="refinery-empty">可直接粘贴原文；只有从收藏选择的原文才会自动附带来源引用。</p>}
        </section>

        <section id="refinery-pane-result" role="tabpanel" aria-labelledby="refinery-tab-result"
          className={"refinery-pane refinery-result-pane" + (mobileTab === "result" ? " is-active" : "")}>
          <header className="refinery-pane-head">
            <h3>生成结果</h3>
            {result && resultUsable && <div className="refinery-segment" role="group" aria-label="结果显示方式">
              <button type="button" aria-pressed={resultMode === "preview"} className={resultMode === "preview" ? "active" : ""} onClick={() => setResultMode("preview")}>预览</button>
              <button type="button" aria-pressed={resultMode === "edit"} className={resultMode === "edit" ? "active" : ""} onClick={() => setResultMode("edit")}>编辑</button>
            </div>}
          </header>
          {!hasAiConfig && messages.length === 0 ? (
            <div className="refinery-empty">
              <p>先到「设置 → AI 服务」连接文字对话服务。</p>
              <button className="btn btn-primary" onClick={onOpenAiSettings}><IconSettings />去配置</button>
            </div>
          ) : result ? (
            <div className="refinery-result">
              {resultUsable && resultMode === "edit"
                ? <textarea className="input refinery-result-editor" aria-label="编辑生成结果" value={draft} onChange={event => setDraft(event.target.value)} />
                : <MarkdownBubble className="md-body refinery-result-preview" content={resultUsable ? draft : (result.content || "")} />}
              {resultUsable && drafts[resultIndex] !== undefined && drafts[resultIndex] !== result.content && (
                <p className="refinery-muted">已修改，保存时使用修改后的内容。<button type="button" className="btn btn-ghost" onClick={() => setDrafts(current => { const next = { ...current }; delete next[resultIndex]; return next; })}>恢复原始结果</button></p>
              )}
              {result.error && <div className="refinery-result-error" role="alert">
                <p>{result.error}{result.content ? "（以上为中断前收到的部分内容，不会作为上下文发送，也不能保存）" : ""}</p>
                {retryQuestion && <button type="button" className="btn" disabled={waiting} onClick={() => handleSend(retryQuestion)}><IconRefresh />重试</button>}
              </div>}
              {!result.error && !result.complete && <p className="refinery-muted" role="status">正在生成……</p>}
            </div>
          ) : (
            <p className="refinery-empty">发送后，生成结果会出现在这里，可直接修改再保存。</p>
          )}

          <details className="refinery-thread" open={messages.length > 0}>
            <summary>辅助对话（{messages.length}）</summary>
            <div className="chat-msgs refinery-thread-list" ref={msgsRef}>
              {messages.map((m, i) => (
                <div key={i} className={"msg-row " + m.role}>
                  {m.role === "assistant"
                    ? <div className="chat-result">
                        <MarkdownBubble content={m.content || (m.error ? "（没有收到内容）" : "")} />
                        {m.error && <p role="status" className="muted">{m.error}</p>}
                        {i !== resultIndex && <button type="button" className="btn btn-ghost" onClick={() => { setSelectedIndex(i); setMobileTab("result"); }}>设为当前结果</button>}
                      </div>
                    : <div className="msg-bubble">{m.content}</div>}
                </div>
              ))}
              {waiting && messages[messages.length - 1]?.role === "user" && (
                <div className="msg-row assistant"><div className="msg-bubble thinking">正在思考……</div></div>
              )}
            </div>
          </details>

          <div className="refinery-templates">
            {CHAT_CAPTURE_TEMPLATES.map((item) => (
              <button key={item.title} type="button" className="capture-template" disabled={waiting} onClick={() => useTemplate(item)}>
                <span>{item.title}</span><IconPlus />
              </button>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea className="chat-input" rows="3" aria-label="提炼指令或追问" placeholder="输入内容，Enter 发送，Shift+Enter 换行"
              value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} />
            <button className="btn btn-primary" onClick={() => handleSend()} disabled={waiting || !input.trim()}>
              <IconSend />{waiting ? "等待中" : "发送"}
            </button>
          </div>
          {binding && <p className="refinery-muted">本次发送将关联：{binding.source.title || "未命名收藏"}{bindingState === "stale" ? "（需要先确认）" : ""}</p>}
        </section>

        <section id="refinery-pane-save" role="tabpanel" aria-labelledby="refinery-tab-save"
          className={"refinery-pane refinery-save-pane" + (mobileTab === "save" ? " is-active" : "")}>
          <header className="refinery-pane-head"><h3>保存</h3></header>
          <fieldset className="refinery-fieldset" disabled={!resultUsable}>
            <legend>保存位置</legend>
            <label className="refinery-radio"><input type="radio" name={`refinery-target-${resultIndex}`} value="knowledge" checked={target === "knowledge"} onChange={() => setSaveOption("target", "knowledge")} />知识文章</label>
            <label className="refinery-radio"><input type="radio" name={`refinery-target-${resultIndex}`} value="prompt" checked={target === "prompt"} onChange={() => setSaveOption("target", "prompt")} />提示词</label>
          </fieldset>
          <fieldset className="refinery-fieldset" disabled={!resultUsable}>
            <legend>分类</legend>
            {target === "prompt" && <label className="refinery-field">提示词分类
              <select className="select" value={category} onChange={event => setSaveOption("category", event.target.value)}>
                {PROMPT_CATEGORIES.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>}
            <label className="refinery-field">标签（逗号分隔，可选）
              <input className="input" value={tagText} placeholder="例如：运镜,人物" onChange={event => setSaveOption("tagText", event.target.value)} />
            </label>
          </fieldset>
          <div className="refinery-reference">
            <h4>引用来源</h4>
            {resultSource ? (
              <div className="refinery-reference-card">
                <strong>{resultSource.title || "未命名收藏"}</strong>
                {resultSource.author && <span className="refinery-muted">作者：{resultSource.author}</span>}
                {resultSource.url && <a href={resultSource.url} target="_blank" rel="noopener noreferrer">原始来源 ↗</a>}
                <button type="button" className="btn btn-ghost" aria-expanded={inspectSource} onClick={() => setInspectSource(value => !value)}>{inspectSource ? "收起原文摘录" : "查看原文摘录"}</button>
                {inspectSource && <blockquote className="refinery-reference-excerpt">{String(resultSource.content || "").slice(0, 600) || "这条收藏没有正文"}</blockquote>}
                <label className="refinery-radio"><input type="checkbox" checked={includeSource} onChange={event => setSaveOption("includeSource", event.target.checked)} />保存时附带这条来源引用</label>
                {sourceMismatch && <p className="refinery-warning" role="status">注意：这条结果来自「{resultSource.title || "未命名收藏"}」，与当前关联的原文不同，保存时以结果生成时的来源为准。</p>}
              </div>
            ) : <p className="refinery-muted">{result ? "这条结果没有关联原文，保存时不会附带来源。" : "暂无结果。"}</p>}
          </div>
          {onSaveResult && <button type="button" className="btn btn-primary refinery-save-btn" disabled={!resultUsable || !draft.trim() || waiting} onClick={saveResult}>
            <IconCheck />{savedLabel}
          </button>}
          {result && !resultUsable && !waiting && <p className="refinery-muted">只有完整生成的结果才能保存。</p>}
        </section>
      </div>
    </div>
  );
}

Object.assign(window, { AiSettingsModal, ChatView, chatOutboundMessages, chatSendPlan, createChatStreamParser,
  chatSourceSearch, chatSourceBindingState, chatSourceText, chatRequestContent, chatSaveSnapshot, chatHasUnsavedWork, chatRequestSnapshot });
