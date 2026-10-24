/// 收件箱与知识资产 —— P1 手动收录、确认分发和知识卡片
const { useState: useInboxState, useEffect: useInboxEffect, useRef: useInboxRef } = React;

const INBOX_TYPE_LABELS = {
  prompt: "提示词",
  resource: "资源",
  knowledge: "知识",
  idea: "项目想法",
  unknown: "待核对",
  noise: "噪音",
  "": "未识别",
};

const INBOX_SOURCE_LABELS = {
  manual: "手动",
  feed: "信息流",
  x: "X",
  web: "网页",
  test: "测试",
};

const X_TOPIC_LABELS = {
  video: "视频与短剧", image: "图像创作", software: "开发与 AI",
  crypto: "加密领域", product: "产品设计", workflow: "效率方法",
  business: "商业", other: "其他",
};

function inboxJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function xOrganization(item) {
  return inboxJson(item?.aiExtract, {})?.xOrganization || null;
}

function inboxQuotedPost(item) {
  const metrics=inboxJson(item?.metrics, {});
  return metrics.recoveredQuote || metrics.quotedTweet || null;
}

function inboxMedia(item) {
  const items = inboxJson(item?.media, []);
  if (!Array.isArray(items)) return [];
  return items.map((entry) => {
    const video = ["video", "animated_gif"].includes(entry?.type);
    const raw = video ? entry?.preview_image_url || entry?.url : entry?.url;
    try {
      const archived = /^\/api\/x-media\/[1-9]\d*\/[a-f0-9]{64}$/.test(raw || "");
      const url = archived ? new URL(raw, window.location.origin) : new URL(raw);
      if (!archived && url.protocol !== "https:") return null;
      let videoUrl = "";
      const candidates = video ? [entry.verifiedVideoUrl, entry.video_url, ...(Array.isArray(entry.variants) ? entry.variants
        .filter((candidate) => candidate?.content_type === "video/mp4")
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0)).map((candidate) => candidate.url) : [])] : [];
      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          const playable = new URL(candidate);
          if (playable.protocol === "https:" && playable.hostname === "video.twimg.com" &&
              !playable.username && !playable.password && playable.pathname.endsWith(".mp4")) {
            playable.hash = "";
            videoUrl = playable.toString();
            break;
          }
        } catch {}
      }
      let sourceUrl = '';
      try {
        const source = new URL(entry.sourceUrl);
        if (source.protocol === 'https:' && ['x.com','twitter.com'].includes(source.hostname) &&
            !source.port && !source.username && !source.password && /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(source.pathname)) sourceUrl = source.href;
      } catch {}
      return { url: url.toString(), alt: entry.alt_text || (video ? "视频封面" : "帖子配图"), video, videoUrl, sourceUrl, sourceRelation:entry.sourceRelation };
    } catch { return null; }
  }).filter(Boolean);
}

function inboxThumbnailUrl(url) {
  try {
    const imageUrl = new URL(url);
    if (imageUrl.hostname === "pbs.twimg.com" && imageUrl.pathname.startsWith("/media/")) {
      imageUrl.searchParams.set("name", "small");
      return imageUrl.toString();
    }
  } catch {}
  return url;
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function inboxDate(item) {
  return item?.source === "x" ? inboxJson(item.metrics, {})?.postCreatedAt || "" : item.createdAt;
}

function inboxSafeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

function inboxLinks(item) {
  const found = new Set();
  const add = (value) => { const url = inboxSafeUrl(value); if (url) found.add(url); };
  const imported = inboxJson(item?.links, []);
  if (Array.isArray(imported)) imported.forEach((link) => add(typeof link === "string" ? link : link?.expanded_url || link?.url));
  for (const match of String(item?.content || "").matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    add(match[0].replace(/[.,!?;:。，！？；：）)\]]+$/u, ""));
  }
  return [...found];
}

function inboxArticleLink(item) {
  return inboxLinks(item).find((url) => /^https?:\/\/(?:www\.)?x\.com\/i\/article\//i.test(url)) || "";
}

function inboxRecoveredArticle(item) {
  const article = inboxJson(item?.metrics, {}).article;
  return article && typeof article.body === 'string' && article.body.trim() ? article : null;
}

function inboxSourceText(item) {
  const recovered = inboxJson(item?.metrics, {}).recoveredPost?.text;
  return typeof recovered === 'string' && recovered.trim() ? recovered : String(item?.content || '');
}

function inboxDetailLinks(item) {
  const links = inboxLinks(item);
  return links.some((url) => !/^https?:\/\/t\.co\//i.test(url))
    ? links.filter((url) => !/^https?:\/\/t\.co\//i.test(url)) : links;
}

function inboxLinkedText(value) {
  return String(value || "").split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const clean = part.replace(/[.,!?;:。，！？；：）)\]]+$/u, "");
    const href = inboxSafeUrl(clean);
    return href ? <React.Fragment key={`${index}:${href}`}>
      <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{clean}</a>
      {part.slice(clean.length)}
    </React.Fragment> : part;
  });
}

function inboxReviewReason(item) {
  const organization = xOrganization(item);
  const content = String(item?.content || "").trim();
  if (item?.source === "x" && !inboxRecoveredArticle(item) && /^https?:\/\/t\.co\/\S+$/i.test(content) && inboxArticleLink(item)) return "article";
  if (item?.source !== "x" || (item.aiType && organization?.assetType !== "unknown") ||
      organization?.assetType === "idea") return "";
  if (organization?.contentIncomplete) return "unavailable";
  if (inboxMedia(item).length && content.length < 80) return "visual";
  return "uncertain";
}

const INBOX_REVIEW_LABELS = {
  article: "文章正文待补", unavailable: "原帖不可用",
  visual: "配图待辨认", uncertain: "用途待整理",
};

function inboxDisplayTitle(item) {
  const title = String(item?.title || "").trim();
  if (title && !/^https?:\/\/t\.co\/\S+$/i.test(title) && !/^(?:未命名内容|无标题收藏)$/u.test(title)) return title;
  if (inboxReviewReason(item) === "article") return "X 文章 · 仅有链接";
  const content = String(item?.aiSummary || item?.content || "").trim().replace(/^https?:\/\/\S+\s*/i, "");
  const sentence = content.split(/[\r\n。！？!?]/u).map((part) => part.trim()).find(Boolean);
  if (sentence) return sentence.slice(0, 160);
  const link = inboxLinks(item)[0];
  if (link) return `链接收藏 · ${new URL(link).hostname}`;
  return "无标题收藏";
}

function inboxExcerpt(item) {
  const text = String(item?.aiSummary || item?.content || "").trim();
  const title = inboxDisplayTitle(item);
  return text.startsWith(title) ? text.slice(title.length).replace(/^[\s，,。.!！?？:：-]+/u, "").trim() : text;
}

function inboxDigest(item) {
  return inboxJson(item?.aiExtract, {}).xDigest || null;
}

function inboxEngagement(item) {
  const metrics = inboxJson(item?.metrics, {});
  const fields = ["likes", "retweets", "bookmarks", "replies"];
  if (!fields.some((field) => Number.isFinite(Number(metrics[field])) && metrics[field] !== undefined)) return null;
  const count = (field) => Math.max(0, Number(metrics[field]) || 0);
  return count("likes") + 2 * count("retweets") + 3 * count("bookmarks") + count("replies");
}

function inboxEngagementScore(item, maxEngagement) {
  const value = inboxEngagement(item);
  return value === null ? null : Math.round(100 * Math.log1p(value) / Math.log1p(Math.max(1, maxEngagement)));
}

function inboxTime(item) {
  const organized = globalThis.OmniHubLibraryOrder.timestamp(item);
  if (organized) return organized;
  const time = Date.parse(inboxDate(item));
  return Number.isFinite(time) ? time : 0;
}

function inboxDayLabel(item) {
  const date = new Date(inboxTime(item));
  if (!inboxTime(item)) return "时间待补全";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "今天";
  if (day === today - 86400000) return "昨天";
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function inboxTimeLabel(item) {
  return inboxTime(item) ? new Date(inboxTime(item)).toLocaleTimeString("zh-CN", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  }) : "—";
}

function inboxDefaultType(item) {
  return ["prompt", "resource", "knowledge"].includes(item && item.aiType) ? item.aiType : "knowledge";
}

function inboxAfterRepeatedTitle(content, title) {
  if (!title || title.length >= 160 || !content.startsWith(title)) return null;
  const rest = content.slice(title.length);
  if (rest && !/^[\s。！？!?，,:：；;.!]/u.test(rest)) return null;
  return rest.trim();
}

function inboxDraftContent(item, title) {
  const content = String(item?.content || "").trim();
  return inboxAfterRepeatedTitle(content, title) || content;
}

function inboxEvidenceContent(item) {
  const content = String(inboxSourceText(item) || item?.aiSummary || item?.url || "").trim();
  const title = inboxDisplayTitle(item);
  return inboxAfterRepeatedTitle(content, title) ?? content;
}

function inboxDraft(item, targetType) {
  if (!item) return {};
  const title = inboxDisplayTitle(item);
  const content = inboxDraftContent(item, title);
  if (targetType === "prompt") {
    const media = inboxMedia(item);
    return {
      title,
      text: content || item.aiSummary || "",
      category: "其他",
      tags: "",
      image: media[0]?.url || "",
      sourceUrl: item.url || "",
    };
  }
  if (targetType === "resource") {
    return {
      name: title,
      url: item.url || "",
      desc: item.aiSummary || content || "",
      category: "常用",
      type: "site",
      tags: "",
      sourceUrl: item.url || "",
    };
  }
  return {
    title,
    summary: item.aiSummary || "",
    body: content || item.aiSummary || "",
    tags: "",
    sourceUrl: item.url || "",
  };
}

function InboxDetailFrame({ overlay, panelRef, title, actions, onClose, children }) {
  if (!overlay) return <div ref={panelRef} className="inbox-detail">{children}</div>;
  return <DetailDrawer title={title} actions={actions} onClose={onClose}>
    <div ref={panelRef} className="inbox-detail inbox-drawer detail-drawer-body">{children}</div>
  </DetailDrawer>;
}

function inboxLinkedSourceId(hash) {
  const [section, search = ''] = String(hash).split('?');
  if (section !== '#inbox') return '';
  const id = new URLSearchParams(search).get('source') || '';
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function useInboxSourceLink(active, items, loadState, onOpen) {
  const handled = useInboxRef('');
  const [error, setError] = useInboxState('');
  useInboxEffect(() => {
    if (!active) { handled.current = ''; return; }
    const openLinkedSource = () => {
      const id = inboxLinkedSourceId(window.location.hash);
      if (!id) {
        if (handled.current) onOpen(null);
        handled.current = '';
        setError('');
        return;
      }
      // Resolve only against the current account's authorized collection.
      const item = items.find(entry => entry.source === 'x' && String(entry.id) === id);
      if (!item && ['idle', 'loading'].includes(loadState)) return;
      const key = `${id}:${item ? 'ready' : 'missing'}`;
      if (handled.current === key) return;
      handled.current = key;
      setError(item ? '' : '这条站内原文暂时无法查看，可能尚未加载、已移除或未公开。');
      onOpen(item || null);
    };
    openLinkedSource();
    window.addEventListener('hashchange', openLinkedSource);
    return () => window.removeEventListener('hashchange', openLinkedSource);
  }, [active, items, loadState]);
  return error;
}

function InboxView({ active = true, items, query, readOnly = false, loadState, loadError, onRetry, onCapture, onImportX, onAnalyze, onSetVisibility, onIgnore, onDispatch, onCreateMedia, onCorrectClassification, onOpenConnections }) {
  const [captureText, setCaptureText] = useInboxState("");
  const [captureBusy, setCaptureBusy] = useInboxState(false);
  const [importBusy, setImportBusy] = useInboxState(false);
  const [importMessage, setImportMessage] = useInboxState("");
  const importInput = useInboxRef(null);
  const [selectedId, setSelectedId] = useInboxState(items[0] ? items[0].id : null);
  const [sourceScope, setSourceScope] = useInboxState(readOnly ? "x" : "daily");
  const initialScopeSet = useInboxRef(false);
  const [detailOpen, setDetailOpen] = useInboxState(false);
  const [mediaPreview, setMediaPreview] = useInboxState(null);
  const [failedVideoUrl, setFailedVideoUrl] = useInboxState("");
  const [mediaZoomed, setMediaZoomed] = useInboxState(false);
  const mediaTriggerRef = useInboxRef(null);
  const mediaViewerRef = useInboxRef(null);
  const mediaStageRef = useInboxRef(null);
  const mediaDragRef = useInboxRef(null);
  const [editorOpen, setEditorOpen] = useInboxState(false);
  const detailPanelRef = useInboxRef(null);
  const [topicFilter, setTopicFilter] = useInboxState("");
  const [subjectFilter, setSubjectFilter] = useInboxState("");
  const [filter, setFilter] = useInboxState("");
  const [reviewFilter, setReviewFilter] = useInboxState("");
  const [sortMode, setSortMode] = useInboxState("time_desc");
  const [visibleLimit, setVisibleLimit] = useInboxState(60);
  const [targetType, setTargetType] = useInboxState(inboxDefaultType(items[0]));
  const [form, setForm] = useInboxState(inboxDraft(items[0], inboxDefaultType(items[0])));
  const [actionBusy, setActionBusy] = useInboxState(false);
  const [error, setError] = useInboxState("");

  useInboxEffect(() => { if (!active) { setDetailOpen(false); setMediaPreview(null); } }, [active]);

  const scopedItems = items.filter((item) => sourceScope === "x" ? item.source === "x" : item.source !== "x");
  const isPublicXScope = sourceScope === "x" && readOnly;
  const isPublicLoading = isPublicXScope && loadState === "loading" && scopedItems.length === 0;
  const isPublicError = isPublicXScope && loadState === "error" && scopedItems.length === 0;
  const hidePublicXControls = isPublicLoading || isPublicError;
  const selected = scopedItems.find((item) => item.id === selectedId) || null;
  const selectedSourceUrl = selected ? inboxSafeUrl(selected.url) : "";
  const visible = filter ? scopedItems.filter((item) => (item.aiType || "") === filter) : scopedItems;

  useInboxEffect(() => {
    if (initialScopeSet.current || !items.length) return;
    initialScopeSet.current = true;
    if (items.some((item) => item.source === "x") && !items.some((item) => item.source !== "x")) {
      setSourceScope("x");
    }
  }, [items]);

  useInboxEffect(() => {
    if (!active || !mediaPreview) return;
    mediaViewerRef.current?.focus({ preventScroll: true });
  }, [active, Boolean(mediaPreview)]);

  useInboxEffect(() => {
    if (!active || !mediaPreview || !mediaZoomed) return;
    const frame = requestAnimationFrame(() => {
      const stage = mediaStageRef.current;
      if (!stage) return;
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, mediaZoomed, mediaPreview?.index]);

  useInboxEffect(() => {
    if (!active || !mediaPreview) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.stopImmediatePropagation(); closeMediaPreview(); }
      else if (!mediaZoomed && event.target.tagName !== "VIDEO" && event.key === "ArrowLeft") changeMediaPreview(-1);
      else if (!mediaZoomed && event.target.tagName !== "VIDEO" && event.key === "ArrowRight") changeMediaPreview(1);
      else if (event.key === "Tab") {
        const focusable = [...(mediaViewerRef.current?.querySelectorAll('button, a[href], video[controls], [tabindex="0"]') || [])];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === mediaViewerRef.current || !mediaViewerRef.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !mediaViewerRef.current?.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, mediaPreview, mediaZoomed]);

  useInboxEffect(() => { setEditorOpen(false); }, [selectedId, sourceScope]);
  useInboxEffect(() => {
    if (detailPanelRef.current) detailPanelRef.current.scrollTop = 0;
  }, [editorOpen, selectedId]);

  useInboxEffect(() => { setVisibleLimit(60); }, [filter, reviewFilter, topicFilter, subjectFilter, sortMode, query, sourceScope]);

  useInboxEffect(() => {
    if (selectedId && scopedItems.some((item) => item.id === selectedId)) return;
    setSelectedId(scopedItems[0] ? scopedItems[0].id : null);
  }, [items, selectedId, sourceScope]);

  const sourceLinkError = useInboxSourceLink(active, items, loadState, item => {
    setSourceScope('x');
    setEditorOpen(false);
    setMediaPreview(null);
    setError('');
    if (item) setSelectedId(item.id);
    setDetailOpen(Boolean(item));
  });

  useInboxEffect(() => {
    if (!selected) { setForm({}); return; }
    const type = inboxDefaultType(selected);
    setTargetType(type);
    setForm(inboxDraft(selected, type));
    setError("");
  }, [selected && selected.id]);

  function changeTarget(type) {
    setTargetType(type);
    setForm(inboxDraft(selected, type));
    setError("");
  }

  function openMediaPreview(item, index, event) {
    mediaTriggerRef.current = event.currentTarget;
    setFailedVideoUrl("");
    setMediaZoomed(false);
    setMediaPreview({ media: inboxMedia(item), index, sourceUrl: inboxSafeUrl(item.url) });
  }

  function changeMediaPreview(direction) {
    setMediaZoomed(false);
    setMediaPreview((current) => current && ({ ...current,
      index: (current.index + direction + current.media.length) % current.media.length }));
  }

  function startMediaPan(event) {
    if (!mediaZoomed || event.pointerType !== "mouse" || event.button !== 0) return;
    const stage = mediaStageRef.current;
    mediaDragRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
  }

  function moveMediaPan(event) {
    const drag = mediaDragRef.current;
    if (!drag) return;
    const stage = mediaStageRef.current;
    stage.scrollLeft = drag.left - (event.clientX - drag.x);
    stage.scrollTop = drag.top - (event.clientY - drag.y);
  }

  function closeMediaPreview() {
    setMediaPreview(null);
    requestAnimationFrame(() => mediaTriggerRef.current?.isConnected && mediaTriggerRef.current.focus());
  }

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  async function capture() {
    if (!captureText.trim() || captureBusy) return;
    setCaptureBusy(true);
    try {
      const item = await onCapture(captureText.trim());
      setCaptureText("");
      if (item && item.id) setSelectedId(item.id);
    } finally {
      setCaptureBusy(false);
    }
  }

  async function importX(file) {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportMessage("");
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("导出文件不能超过 50MB");
      const result = await onImportX(await file.text());
      setImportMessage(`${result.coverage === "complete" ? "完整批次：" : "部分采集批次："}` +
        `已导入 ${result.imported} 条，补全 ${result.updated} 条，跳过 ${result.skipped} 条（重复或无可读内容）。`);
      setSourceScope("x");
      setFilter("");
      setTopicFilter("");
      setReviewFilter("");
      setDetailOpen(false);
    } catch (error) {
      setImportMessage(error.message || "X 收藏导入失败");
    } finally {
      setImportBusy(false);
    }
  }

  async function dispatch() {
    if (!selected || actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      await onDispatch(selected.id, targetType, form);
      setDetailOpen(false);
    } catch (err) {
      setError(err.message || "分发失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function analyze() {
    if (!selected || actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      const item = await onAnalyze(selected.id);
      const type = inboxDefaultType(item);
      setTargetType(type);
      setForm(inboxDraft(item, type));
    } catch (err) {
      setError(err.message || "TypeSafe 判断失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function changeVisibility() {
    if (!selected || actionBusy) return;
    setActionBusy(true);
    setError("");
    try { await onSetVisibility(selected.id, selected.visibility === "public" ? "private" : "public"); }
    catch (err) { setError(err.message || "修改可见范围失败"); }
    finally { setActionBusy(false); }
  }

  async function ignore() {
    if (!selected || actionBusy) return;
    setActionBusy(true);
    try { await onIgnore(selected.id); setDetailOpen(false); }
    finally { setActionBusy(false); }
  }

  const filterItems = [
    { id: "", label: "全部", count: scopedItems.length },
    { id: "prompt", label: "提示词", count: scopedItems.filter((i) => i.aiType === "prompt").length },
    { id: "resource", label: "资源", count: scopedItems.filter((i) => i.aiType === "resource").length },
    { id: "knowledge", label: "知识", count: scopedItems.filter((i) => i.aiType === "knowledge").length },
    ...(sourceScope === "x" ? [{ id: "idea", label: "项目想法", count: scopedItems.filter((i) => xOrganization(i)?.assetType === "idea").length }] : []),
    { id: "", filterId: "untyped", label: sourceScope === "x" ? "待整理" : "待核对",
      count: scopedItems.filter((i) => !i.aiType && xOrganization(i)?.assetType !== "idea").length },
  ];

  function applyFilter(item) {
    setFilter(item.filterId === "untyped" ? "__untyped__" : item.id);
    setReviewFilter("");
    setDetailOpen(false);
  }

  const byType = filter === "__untyped__" ? scopedItems.filter((item) => !item.aiType && xOrganization(item)?.assetType !== "idea")
    : filter === "idea" ? scopedItems.filter((item) => xOrganization(item)?.assetType === "idea") : visible;
  const subjectGroups = new Map();
  if (sourceScope === "x") {
    for (const item of scopedItems) {
      for (const subject of item.subjectCollections || []) {
        if (!subjectGroups.has(subject.id)) subjectGroups.set(subject.id, { title: subject.title, items: [] });
        subjectGroups.get(subject.id).items.push(item);
      }
    }
  }
  const subjectOptions = [...subjectGroups].filter(([, group]) => group.items.length >= 2)
    .sort((a, b) => b[1].items.length - a[1].items.length || a[1].title.localeCompare(b[1].title));
  const primarySubject = (item) => (item.subjectCollections || []).find((subject) =>
    subjectGroups.get(subject.id)?.items.length >= 2);
  const q = String(query || "").trim().toLowerCase();
  const filteredItems = byType.filter((item) => !q
    || `${item.title} ${inboxSourceText(item)} ${inboxRecoveredArticle(item)?.plainText || ''} ${item.aiSummary} ${item.author} ${item.url}`.toLowerCase().includes(q))
    .filter((item) => sourceScope !== "x" || !subjectFilter ||
      (item.subjectCollections || []).some((subject) => subject.id === subjectFilter))
    .filter((item) => sourceScope !== "x" || !topicFilter || xOrganization(item)?.topic === topicFilter)
    .filter((item) => filter !== "__untyped__" || !reviewFilter || inboxReviewReason(item) === reviewFilter);
  const groupedItems = new Map();
  const groupCounts = new Map();
  if (sourceScope === "x") {
    for (const item of scopedItems) {
      const groupId = xOrganization(item)?.groupId;
      if (groupId) groupCounts.set(groupId, (groupCounts.get(groupId) || 0) + 1);
    }
    for (const item of filteredItems) {
      const groupId = xOrganization(item)?.groupId || `single:${item.id}`;
      if (!groupedItems.has(groupId)) groupedItems.set(groupId, []);
      groupedItems.get(groupId).push(item);
    }
  }
  const listEntries = sourceScope === "x" ? [...groupedItems.values()].flatMap(group => group)
    : [...filteredItems].sort((a,b) => inboxTime(b) - inboxTime(a) || b.id - a.id);
  const xTopics = [...new Set(scopedItems.map((item) => xOrganization(item)?.topic).filter(Boolean))];
  const reviewItems = scopedItems.filter((item) => !item.aiType && xOrganization(item)?.assetType !== "idea");
  const maxEngagement = Math.max(1, ...scopedItems.map((item) => inboxEngagement(item) || 0));
  const sortedXItems = sourceScope === "x" ? [...filteredItems].sort((a, b) => {
    if (sortMode === "score_desc") {
      return (inboxEngagementScore(b, maxEngagement) ?? -1) -
        (inboxEngagementScore(a, maxEngagement) ?? -1) || inboxTime(b) - inboxTime(a);
    }
    const aTime = inboxTime(a);
    const bTime = inboxTime(b);
    if (!aTime || !bTime) return (!aTime ? 1 : 0) - (!bTime ? 1 : 0) || b.id - a.id;
    return (sortMode === "time_asc" ? aTime - bTime : bTime - aTime) || b.id - a.id;
  }) : [];
  const seenSubjects = new Set();
  const xTimelineItems = subjectFilter ? sortedXItems : sortedXItems.filter((item) => {
    const subject = primarySubject(item);
    if (!subject || seenSubjects.has(subject.id)) return !subject;
    seenSubjects.add(subject.id);
    return true;
  });
  const xPageItems = xTimelineItems.slice(0, visibleLimit);
  const xDayGroups = [];
  for (const item of xPageItems) {
    const key = sortMode === "score_desc" ? "score" : inboxDayLabel(item);
    const last = xDayGroups[xDayGroups.length - 1];
    if (last?.key === key) last.items.push(item);
    else xDayGroups.push({ key, label: key === "score" ? "按互动评分" : key, items: [item] });
  }
  const partialCount = scopedItems.filter((item) => {
    const coverage = xOrganization(item)?.coverage;
    return coverage === "partial_ui_scan" || coverage === "partial_xarchive_scan";
  }).length;
  const incompleteCount = scopedItems.filter((item) => xOrganization(item)?.contentIncomplete).length;
  const selectedGroupId = selected && xOrganization(selected)?.groupId;
  const selectedGroupItems = selectedGroupId ? scopedItems.filter((item) =>
    item.id !== selected.id && xOrganization(item)?.groupId === selectedGroupId) : [];
  const selectedSubject = selected && primarySubject(selected);
  const selectedSubjectItems = selectedSubject ? (subjectGroups.get(selectedSubject.id)?.items || [])
    .filter((item) => item.id !== selected.id) : [];
  const showSourceTabs = items.some((item) => item.source === "x") && items.some((item) => item.source !== "x");

  return (
    <div className="inbox-page">
      {sourceLinkError && <p className="auth-error" role="status">{sourceLinkError}</p>}
      <div className="inbox-head">
        <div>
          <h1>{sourceScope === "x" ? "X 收藏" : "收件箱"}</h1>
          <p>{sourceScope === "x" ? "按时间浏览、按用途整理收藏。" : "先收进来，再决定它值得去哪里。"}</p>
        </div>
        {!isPublicLoading && !isPublicError && (
          <span className="inbox-pending" title={sourceScope === "x" && partialCount ? "当前采集批次未证实完整，数量不代表全部收藏" : ""}>
            <AnimatedNumber value={scopedItems.length} /> 条{sourceScope === "x" ? "可浏览" : "待处理"}
          </span>
        )}
      </div>

      {!readOnly && onCapture && sourceScope !== "x" && <div className="capture-bar">
        <textarea rows="2" value={captureText} placeholder="粘贴链接、文字或提示词……"
          onChange={(event) => setCaptureText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") capture();
          }} />
        <button className="btn btn-primary" onClick={capture} disabled={captureBusy || !captureText.trim()}>
          <IconPlus />{captureBusy ? "收录中" : "快速收录"}
        </button>
        {!showSourceTabs && items.some((item) => item.source === "x") &&
          <button className="btn btn-ghost" onClick={() => setSourceScope("x")}>查看 X 收藏</button>}
      </div>}
      {!readOnly && onImportX && <input ref={importInput} type="file" accept=".jsonl,.json,application/json" hidden
        onChange={(event) => {
          importX(event.target.files && event.target.files[0]);
          event.target.value = "";
        }} />}
      {importMessage && <p className="inbox-import-message" role="status">{importMessage}</p>}

      {!readOnly && showSourceTabs && <div className="inbox-source-tabs">
        <button className={sourceScope === "daily" ? "active" : ""}
          onClick={() => { setSourceScope("daily"); setFilter(""); setReviewFilter(""); setTopicFilter(""); setDetailOpen(false); }}>
          待处理 <span>{items.filter((item) => item.source !== "x").length}</span>
        </button>
        <button className={sourceScope === "x" ? "active" : ""}
          onClick={() => { setSourceScope("x"); setFilter(""); setReviewFilter(""); setTopicFilter(""); setDetailOpen(false); }}>
          X 收藏 <span>{items.filter((item) => item.source === "x").length}</span>
        </button>
      </div>}

      {!hidePublicXControls && <div className="inbox-filters">
        {filterItems.map((item) => {
          const key = item.filterId || item.id || "all";
          const active = item.filterId === "untyped" ? filter === "__untyped__" : filter === item.id;
          return (
            <button key={key} className={active ? "active" : ""} onClick={() => applyFilter(item)}>
              {item.label}<span>{item.count}</span>
            </button>
          );
        })}
        {sourceScope === "x" && xTopics.length > 0 && (
          <select className="select inbox-topic-filter" aria-label="按主题筛选 X 收藏" value={topicFilter}
            onChange={(event) => setTopicFilter(event.target.value)}>
            <option value="">全部主题</option>
            {xTopics.map((topic) => <option key={topic} value={topic}>{X_TOPIC_LABELS[topic] || topic}</option>)}
          </select>
        )}
      </div>}
      {sourceScope === "x" && !hidePublicXControls && <div className="inbox-x-toolbar">
        <span>显示 {filteredItems.length} 条{subjectOptions.length > 0 && ` · ${subjectOptions.length} 个主题合集`}{partialCount > 0 && <small title={`当前 ${partialCount} 条来自未证实完整的采集批次；${incompleteCount} 条正文待补全`}> · 采集批次未证实完整</small>}</span>
        <div>
          {subjectOptions.length > 0 && <select className="select" aria-label="按跨作者主题合集筛选 X 收藏"
            value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
            <option value="">全部合集与原帖</option>
            {subjectOptions.map(([id, group]) => <option key={id} value={id}>
              {group.title} · {group.items.length} 条
            </option>)}
          </select>}
          <select className="select" aria-label="X 收藏排序" value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
            <option value="time_desc">整理时间 · 最新优先</option>
            <option value="time_asc">整理时间 · 最早优先</option>
            <option value="score_desc">互动评分 · 最高优先</option>
          </select>
          {!readOnly && onImportX && <button className="btn btn-ghost" onClick={() => importInput.current?.click()} disabled={importBusy}>
            {importBusy ? "导入中" : "导入收藏"}
          </button>}
          {!readOnly && onCapture && !showSourceTabs && <button className="btn btn-ghost" onClick={() => { setSourceScope("daily"); setDetailOpen(false); }}>
            其他收录
          </button>}
        </div>
      </div>}
      {sourceScope === "x" && filter === "__untyped__" && <div className="inbox-review-panel">
        <p>这些收藏尚未确定用途。长文链接缺正文和原帖不可用的记录需要补源；其余按原文与配图继续整理。</p>
        <div className="inbox-review-filters">
          <button className={!reviewFilter ? "active" : ""} onClick={() => setReviewFilter("")}>全部 <span>{reviewItems.length}</span></button>
          {Object.entries(INBOX_REVIEW_LABELS).map(([id, label]) =>
            <button key={id} className={reviewFilter === id ? "active" : ""} onClick={() => setReviewFilter(id)}>
              {label} <span>{reviewItems.filter((item) => inboxReviewReason(item) === id).length}</span>
            </button>)}
        </div>
      </div>}

      {isPublicLoading ? (
        <EmptyState message="正在加载 X 收藏" hint="请稍候，正在获取最新的公开收藏内容" />
      ) : isPublicError ? (
        <div className="inbox-error">
          <p>{loadError || "X 收藏加载失败，请稍后重试"}</p>
          <button type="button" className="btn" onClick={onRetry}>重新加载</button>
        </div>
      ) : scopedItems.length === 0 ? (
        <div className="inbox-empty-start">
          <EmptyState message={sourceScope === "x" ? "还没有 X 收藏" : "收件箱已经清空"}
            hint={sourceScope === "x" ? readOnly ? "登录后查看自己的收藏" : "连接自己的 X 账号，配置完成后同步收藏。已有的导出备份也可以导入。" : "粘贴一条链接或文字，开始第一条处理流程"} />
          {!readOnly && sourceScope === 'x' && onOpenConnections && <button className="btn btn-primary" onClick={onOpenConnections}>连接我的 X 账号</button>}
        </div>
      ) : (
        <div className={"inbox-workspace" + (sourceScope === "x" ? " x-mode" : "")}>
          <div className="inbox-list" role="list">
            {filteredItems.length === 0 && <p className="inbox-list-empty">这个分类暂时没有内容</p>}
            {sourceScope === "x" ? <React.Fragment>
              {xDayGroups.map((day) => <section className="feed-day" key={day.key} aria-label={day.label}>
                <div className="feed-day-label">{day.label}</div>
                <div className="timeline">
                  {day.items.map((item) => {
                    const organization = xOrganization(item);
                    const subject = !subjectFilter && primarySubject(item);
                    const subjectGroup = subject && subjectGroups.get(subject.id);
                    const assetType = item.aiType || organization?.assetType || "unknown";
                    const score = inboxEngagementScore(item, maxEngagement);
                    const reason = inboxReviewReason(item);
                    const excerpt = inboxExcerpt(item);
                    const digest = inboxDigest(item);
                    const media = inboxMedia(item);
                    return <div className="tl-row inbox-tl-row" key={item.id} role="listitem">
                      <span className="tl-time">{sortMode === "score_desc" ? xPageItems.indexOf(item) + 1 : inboxTimeLabel(item)}</span>
                      <span className="tl-rail"><span className="tl-dot" /></span>
                      <article className="feed-card inbox-timeline-card">
                        <button type="button" className="inbox-card-open" aria-label={`查看详情：${inboxDisplayTitle(item)}`} onClick={() => {
                        setSelectedId(item.id);
                        setEditorOpen(false);
                        setDetailOpen(true);
                        }} />
                        {score !== null && <span className="feed-corner"><span className="feed-score"
                          title="互动评分：按点赞、转发、收藏、回复加权并在本批数据内归一化；不是内容质量评分">{score}</span></span>}
                        <span className="feed-body">
                          <strong className="feed-title">{subject ? `${subject.title} · 主题合集` : inboxDisplayTitle(item)}</strong>
                          {subject && <span className="inbox-card-excerpt">{inboxDisplayTitle(item)}</span>}
                          {reason === "article" && <span className="inbox-card-excerpt">收藏导出只包含文章链接，标题和正文尚未采集。</span>}
                          {excerpt && excerpt !== item.title && reason !== "article" &&
                            <span className="inbox-card-excerpt"><b>{digest?.status === "partial_excerpt" ? "已有片段" : "内容提要"}</b>{excerpt}</span>}
                          {media.length > 0 && <span className={`inbox-card-media inbox-card-media--${Math.min(media.length, 4)}`}>
                            {media.slice(0, 4).map((image, index) => <button type="button" className="inbox-card-media-cell"
                              key={`${image.url}-${index}`} aria-label={image.video ? "播放视频" : `查看大图 ${index + 1}`}
                              onClick={(event) => openMediaPreview(item, index, event)}>
                              <img src={inboxThumbnailUrl(image.url)} alt={image.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                              {image.video && <span className="inbox-card-media-play" aria-hidden="true">▶</span>}
                              {index === 3 && media.length > 4 && <span className="inbox-card-media-more">+{media.length - 4}</span>}
                            </button>)}
                          </span>}
                          <span className="feed-tags inbox-card-meta">
                            {item.author && <span className="inbox-card-author">{item.author}</span>}
                            {organization?.topic && <span className="tag-chip">{X_TOPIC_LABELS[organization.topic] || organization.topic}</span>}
                            {filter !== assetType && filter !== "__untyped__" &&
                              <span className={"tag-chip inbox-type-chip type-" + assetType}>
                                {assetType === "unknown" ? "待整理" : INBOX_TYPE_LABELS[assetType] || "待整理"}
                              </span>}
                            {reason && <span className="tag-chip inbox-review-chip">{INBOX_REVIEW_LABELS[reason]}</span>}
                            {!readOnly &&
                              <span className="tag-chip inbox-review-chip">仅自己可见</span>}
                            {organization?.groupId && groupCounts.get(organization.groupId) > 1 &&
                              <span className="feed-related">同组 {groupCounts.get(organization.groupId)} 条</span>}
                            {subjectGroup && <span className="feed-related inbox-subject-badge">
                              跨作者 · {subjectGroup.items.length} 条 · {new Set(subjectGroup.items.map((post) => post.author)).size} 位作者
                            </span>}
                          </span>
                        </span>
                      </article>
                    </div>;
                  })}
                </div>
              </section>)}
              {xTimelineItems.length > visibleLimit && <button className="btn btn-ghost inbox-load-more"
                onClick={() => setVisibleLimit((count) => count + 60)}>
                加载更多 · 还剩 {xTimelineItems.length - visibleLimit} 个条目
              </button>}
            </React.Fragment> : listEntries.map((item) => {
              const organization = xOrganization(item);
              const group = organization && groupedItems.get(organization.groupId);
              const groupStart = group && group.length > 1 && group[0].id === item.id;
              return <React.Fragment key={item.id}>
                {groupStart && <div className="inbox-group-head">
                  <strong>{organization.groupTitle || "同一主题"}</strong>
                  <span>{item.author || "同一作者"} · {group.length} 条</span>
                </div>}
              <button role="listitem"
                className={"inbox-row" + (item.id === selectedId ? " active" : "")}
                onClick={() => setSelectedId(item.id)}>
                <div className="inbox-row-top">
                  <span className="inbox-source">{INBOX_SOURCE_LABELS[item.source] || item.source}</span>
                  <span>{shortDate(inboxDate(item))}</span>
                </div>
                <strong>{item.title || "未命名内容"}</strong>
                <p>{item.aiSummary || item.content || item.url}</p>
                {organization?.contentIncomplete && <small className="inbox-row-incomplete">正文待补全</small>}
                {organization && <small className="inbox-row-topic">{X_TOPIC_LABELS[organization.topic] || "其他"}</small>}
                <span className={"inbox-type type-" + (item.aiType || organization?.assetType || "unknown")}>
                  {INBOX_TYPE_LABELS[item.aiType || organization?.assetType || ""]}
                </span>
              </button>
              </React.Fragment>;
            })}
          </div>

          {(sourceScope !== "x" || (active && detailOpen)) && <InboxDetailFrame panelRef={detailPanelRef}
            overlay={sourceScope === "x"} title={editorOpen ? "整理入库" : "X 来源详情"} onClose={() => setDetailOpen(false)}
            actions={!readOnly && onDispatch && (editorOpen
                  ? <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)}>查看原文</button>
                  : <button type="button" className="btn btn-primary" onClick={() => setEditorOpen(true)}>整理入库</button>)}>
            {!selected ? (
              <EmptyState message="选择一条内容开始处理" />
            ) : (
              <React.Fragment>
                {(sourceScope !== "x" || !editorOpen) && <React.Fragment>
                <div className="inbox-detail-head">
                  <div>
                    {selected.source !== "x" && <span>{INBOX_SOURCE_LABELS[selected.source] || selected.source}</span>}
                    <h2 id="inbox-detail-title">{inboxDisplayTitle(selected)}</h2>
                  </div>
                  <div className="inbox-detail-actions">
                    {!readOnly && selected.source === 'x' && onCorrectClassification && <button className="btn btn-ghost" onClick={() => onCorrectClassification({sourceInboxId:selected.id})}>调整归类</button>}
                    {!readOnly && selected.source === "x" && <span className="tag-chip">原始收藏仅自己可见</span>}
                    {!readOnly && onCreateMedia && <button className="btn" onClick={() => onCreateMedia(selected)}><IconPalette />用于创作</button>}
                    {!readOnly && onAnalyze && <button className="btn btn-ghost" onClick={analyze} disabled={actionBusy}>
                      <IconSparkle />{actionBusy ? "判断中" : "TypeSafe 判断"}
                    </button>}
                    {selectedSourceUrl && <a className="btn btn-ghost" href={selectedSourceUrl} target="_blank" rel="noopener noreferrer"><IconArrowUpRight />原链接</a>}
                  </div>
                </div>

                {selected.source === "x" && inboxDigest(selected)?.summary && <div className="inbox-digest-block">
                  <strong>{inboxDigest(selected).status === "partial_excerpt" ? "已有片段" : "内容提要"}</strong>
                  <p>{inboxDigest(selected).summary}</p>
                </div>}

                <div className="inbox-evidence">
                  {selected.author && <p className="inbox-author">{selected.author}</p>}
                  {inboxEvidenceContent(selected) && <p>{inboxLinkedText(inboxEvidenceContent(selected))}</p>}
                  {inboxQuotedPost(selected)?.full_text && <blockquote className="inbox-quoted-post">
                    <small>引用帖 · {inboxQuotedPost(selected).author?.screen_name || "原作者"}</small>
                    <p>{inboxLinkedText(inboxQuotedPost(selected).full_text)}</p>
                  </blockquote>}
                </div>
                {inboxRecoveredArticle(selected) && <section className="inbox-recovered-article">
                  <h3>{inboxRecoveredArticle(selected).title || '文章正文'}</h3>
                  <div className="markdown-body" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(marked.parse(inboxRecoveredArticle(selected).body))}} />
                </section>}
                {inboxJson(selected.metrics, {}).relatedReplies?.length > 0 && <section className="inbox-recovered-article">
                  <h3>作者后续补充</h3>
                  {inboxJson(selected.metrics, {}).relatedReplies.map(reply => <div key={reply.id} className="inbox-evidence">
                    <p>{inboxLinkedText(reply.text)}</p>
                    <a href={inboxSafeUrl(reply.sourceUrl)} target="_blank" rel="noopener noreferrer">查看这条回复 ↗</a>
                  </div>)}
                </section>}
                {inboxDetailLinks(selected).length > 0 && <div className="inbox-extracted-links">
                  <strong>文中链接</strong>
                  {inboxDetailLinks(selected).map((url) => <a key={url} href={url} target="_blank"
                    rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a>)}
                </div>}
                {inboxReviewReason(selected) === "article" && <p className="inbox-review-note">
                  收藏导出只包含 X 文章的跳转链接，未包含标题和正文。{" "}
                  <a href={inboxArticleLink(selected)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开文章核对原文</a>
                </p>}
                {selectedGroupItems.length > 0 && <div className="inbox-related-posts">
                  <strong>同组收藏 · {selectedGroupItems.length + 1} 条</strong>
                  {selectedGroupItems.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)}>
                    {inboxDisplayTitle(item)}
                  </button>)}
                </div>}
                {selectedSubjectItems.length > 0 && <div className="inbox-related-posts">
                  <strong>{selectedSubject.title} · 跨作者主题合集 · {selectedSubjectItems.length + 1} 条</strong>
                  <button onClick={() => { setSubjectFilter(selectedSubject.id); setDetailOpen(false); }}>
                    按时间或评分查看合集里的全部原帖
                  </button>
                  {selectedSubjectItems.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)}>
                    {item.author && `${item.author} · `}{inboxDisplayTitle(item)}
                  </button>)}
                </div>}
                {xOrganization(selected) && <p className="inbox-organization">
                  {X_TOPIC_LABELS[xOrganization(selected).topic] || "其他"}
                  {xOrganization(selected).groupTitle && !/^https?:\/\//i.test(xOrganization(selected).groupTitle) &&
                    ` · ${xOrganization(selected).groupTitle}`}
                </p>}
                {inboxReviewReason(selected) !== "article" &&
                  ["partial_ui_scan", "partial_xarchive_scan"].includes(xOrganization(selected)?.coverage) && <p className="inbox-capture-notice">
                  {xOrganization(selected).coverage === "partial_ui_scan" ? "部分页面采集" : "X 分页未证实完成"}
                  {inboxReviewReason(selected) === "article" ? "；本条仅保存了长文链接，转存前请核对原文。"
                    : xOrganization(selected).contentIncomplete ? "；本条正文待补全，转存前请核对原帖。"
                      : "；本条帖子正文已保存，但整批收藏尚未证实完整。"}
                </p>}
                {inboxMedia(selected).length > 0 && <div className="inbox-media-gallery">
                  {inboxMedia(selected).map((media, index) => (
                    <button type="button" key={`${media.url}-${index}`} aria-label={media.video ? "播放视频" : `查看大图 ${index + 1}`}
                      onClick={(event) => openMediaPreview(selected, index, event)}>
                      <img src={media.url} alt={media.alt} loading="lazy" referrerPolicy="no-referrer" />
                      {media.video && <span className="inbox-card-media-play" aria-hidden="true">▶</span>}
                    </button>
                  ))}
                </div>}

                {!readOnly && selected.aiType && <p className="inbox-suggestion">TypeSafe 建议存为{INBOX_TYPE_LABELS[selected.aiType]}，保存前请核对原文。</p>}
                {sourceScope === "x" && error && <p className="auth-error">{error}</p>}
                </React.Fragment>}
                {!readOnly && onDispatch && (sourceScope !== "x" || editorOpen) && <React.Fragment>
                <div className="dispatch-label">存到哪里</div>
                <div className="dispatch-tabs">
                  <button className={targetType === "prompt" ? "active" : ""} onClick={() => changeTarget("prompt")}><IconSparkle />提示词</button>
                  <button className={targetType === "resource" ? "active" : ""} onClick={() => changeTarget("resource")}><IconBookmark />资源</button>
                  <button className={targetType === "knowledge" ? "active" : ""} onClick={() => changeTarget("knowledge")}><IconBookOpen />知识</button>
                </div>

                <div className="dispatch-form">
                  {targetType === "prompt" && (
                    <React.Fragment>
                      <label>标题<input className="input" value={form.title || ""} onChange={(e) => setField("title", e.target.value)} /></label>
                      <label>提示词<textarea className="input" rows="6" value={form.text || ""} onChange={(e) => setField("text", e.target.value)} /></label>
                      <div className="field-grid">
                        <label>分类<select className="select" value={form.category || "其他"} onChange={(e) => setField("category", e.target.value)}>{PROMPT_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
                        <label>标签<input className="input" placeholder="逗号分隔" value={form.tags || ""} onChange={(e) => setField("tags", e.target.value)} /></label>
                      </div>
                    </React.Fragment>
                  )}
                  {targetType === "resource" && (
                    <React.Fragment>
                      <label>名称<input className="input" value={form.name || ""} onChange={(e) => setField("name", e.target.value)} /></label>
                      <label>链接<input className="input" placeholder="https://" value={form.url || ""} onChange={(e) => setField("url", e.target.value)} /></label>
                      <label>一句话用途<textarea className="input" rows="3" value={form.desc || ""} onChange={(e) => setField("desc", e.target.value)} /></label>
                      <div className="field-grid">
                        <label>类型<select className="select" value={form.type || "site"} onChange={(e) => setField("type", e.target.value)}><option value="site">网站</option><option value="tool">工具</option><option value="repo">开源项目</option><option value="article">课程·文章</option></select></label>
                        <label>分类<select className="select" value={form.category || "常用"} onChange={(e) => setField("category", e.target.value)}>{FAV_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
                      </div>
                    </React.Fragment>
                  )}
                  {targetType === "knowledge" && (
                    <React.Fragment>
                      <label>标题<input className="input" value={form.title || ""} onChange={(e) => setField("title", e.target.value)} /></label>
                      <label>摘要<input className="input" placeholder="可选" value={form.summary || ""} onChange={(e) => setField("summary", e.target.value)} /></label>
                      <label>正文<textarea className="input" rows="7" value={form.body || ""} onChange={(e) => setField("body", e.target.value)} /></label>
                      <label>标签<input className="input" placeholder="逗号分隔" value={form.tags || ""} onChange={(e) => setField("tags", e.target.value)} /></label>
                    </React.Fragment>
                  )}
                </div>

                {error && <p className="auth-error">{error}</p>}
                <div className="dispatch-actions">
                  {onIgnore && <button className="btn btn-ghost" onClick={ignore} disabled={actionBusy}>忽略</button>}
                  <button className="btn btn-primary" onClick={dispatch} disabled={actionBusy}>
                    <IconCheck />{actionBusy ? "处理中" : `存为${INBOX_TYPE_LABELS[targetType]}`}
                  </button>
                </div>
                </React.Fragment>}
                {!readOnly && onIgnore && (!onDispatch || (sourceScope === "x" && !editorOpen)) && <div className="dispatch-actions">
                  <button className="btn btn-ghost" onClick={ignore} disabled={actionBusy}>忽略</button>
                </div>}
              </React.Fragment>
            )}
          </InboxDetailFrame>}
        </div>
      )}
      {active && mediaPreview && ReactDOM.createPortal(<div className="inbox-media-overlay" onClick={closeMediaPreview}>
        <div ref={mediaViewerRef} className="inbox-media-viewer" role="dialog" aria-modal="true" aria-label="媒体预览"
          tabIndex="-1" onClick={(event) => {
            if (event.target === event.currentTarget) closeMediaPreview();
            else event.stopPropagation();
          }}>
          <div className="inbox-media-viewer-toolbar">
            <span>{mediaPreview.index + 1} / {mediaPreview.media.length}</span>
            <div className="inbox-media-viewer-actions">
              {!mediaPreview.media[mediaPreview.index].video && <button type="button" onClick={() => setMediaZoomed((zoomed) => !zoomed)}
                aria-pressed={mediaZoomed} aria-label={mediaZoomed ? "适合窗口" : "放大到原图尺寸"}>
                {mediaZoomed ? "适合窗口" : "原图大小"}
              </button>}
              <button type="button" onClick={closeMediaPreview} aria-label="关闭媒体预览"><IconX aria-hidden="true" /></button>
            </div>
          </div>
          <div className="inbox-media-viewer-content">
            <div ref={mediaStageRef} className={`inbox-media-stage${mediaZoomed ? " is-zoomed" : ""}${mediaPreview.media.length > 1 ? " has-navigation" : ""}`}
              tabIndex={mediaZoomed ? 0 : undefined}
              aria-label={mediaZoomed ? "原图已放大，可滚动查看" : undefined}
              onPointerDown={startMediaPan} onPointerMove={moveMediaPan}
              onPointerUp={() => { mediaDragRef.current = null; }}
              onPointerCancel={() => { mediaDragRef.current = null; }}
              onClick={(event) => { if (event.target === event.currentTarget && !mediaZoomed) closeMediaPreview(); }}>
              {mediaPreview.media[mediaPreview.index].video ? (
                mediaPreview.media[mediaPreview.index].videoUrl &&
                  failedVideoUrl !== mediaPreview.media[mediaPreview.index].videoUrl
                  ? <video key={mediaPreview.media[mediaPreview.index].videoUrl} src={mediaPreview.media[mediaPreview.index].videoUrl}
                      poster={mediaPreview.media[mediaPreview.index].url} controls autoPlay playsInline preload="metadata" tabIndex="0"
                      onError={() => setFailedVideoUrl(mediaPreview.media[mediaPreview.index].videoUrl)} />
                  : <div className="inbox-media-unavailable">
                      <img src={mediaPreview.media[mediaPreview.index].url} alt={mediaPreview.media[mediaPreview.index].alt} />
                      <p>{mediaPreview.media[mediaPreview.index].videoUrl ? "视频暂时无法加载。" : "这条视频没有可播放的文件地址。"}</p>
                      {mediaPreview.sourceUrl && <a href={mediaPreview.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">在 X 查看原视频</a>}
                    </div>
              ) : <img className="inbox-media-full" src={mediaPreview.media[mediaPreview.index].url}
                alt={mediaPreview.media[mediaPreview.index].alt} referrerPolicy="no-referrer" draggable="false" />}
            </div>
            {mediaPreview.media.length > 1 && <div className="inbox-media-viewer-nav">
              <button type="button" className="inbox-media-prev" onClick={() => changeMediaPreview(-1)}
                aria-label="上一张" title="上一张">‹</button>
              <button type="button" className="inbox-media-next" onClick={() => changeMediaPreview(1)}
                aria-label="下一张" title="下一张">›</button>
            </div>}
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
}

function KnowledgeView({ items, query, onAdd, onOpen, onDelete }) {
  const q = query.trim().toLowerCase();
  const visible = items.filter((item) => !q || `${item.title} ${item.summary} ${item.body} ${item.tags}`.toLowerCase().includes(q));
  return (
    <div>
      <div className="asset-compact-head">
        <span>{items.length} 条知识资产</span>
        <button className="btn btn-primary" onClick={onAdd}><IconPlus />新建知识</button>
      </div>
      {visible.length === 0 ? (
        <EmptyState message="还没有匹配的知识资产" hint="从收件箱分发，或手动新建一条" />
      ) : (
        <div className="knowledge-grid">
          {visible.map((item) => (
            <article id={`asset-knowledge-${item.id}`} className="knowledge-card" key={item.id} onClick={() => onOpen(item)}>
              <div className="knowledge-card-icon"><IconBookOpen /></div>
              <div className="knowledge-card-body">
                <h3>{item.title}</h3>
                <p>{item.summary || item.body}</p>
                <div className="knowledge-meta">
                  {(item.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
                  {item.sourceUrl && <span>有来源</span>}
                </div>
              </div>
              <button className="card-del" title="删除知识" onClick={(event) => { event.stopPropagation(); onDelete(item.id); }}><IconTrash /></button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function KnowledgeDrawer({ item, onClose, onSave, onDelete }) {
  const [editing, setEditing] = useInboxState(!item);
  const [form, setForm] = useInboxState(item || { title: "", summary: "", body: "", tags: "", sourceUrl: "" });
  const [busy, setBusy] = useInboxState(false);
  const [error, setError] = useInboxState("");

  function setField(key, value) { setForm((current) => ({ ...current, [key]: value })); setError(""); }

  async function save() {
    if (!form.title.trim() || !form.body.trim()) { setError("标题和正文不能为空"); return; }
    setBusy(true);
    try { await onSave(form, item && item.id); }
    catch (err) { setError(err.message || "保存失败"); }
    finally { setBusy(false); }
  }

  const html = !editing && form.body
    ? DOMPurify.sanitize(marked.parse(form.body))
    : "";

  return (
    <DetailDrawer title={item ? "知识详情" : "新建知识资产"} onClose={onClose}
      actions={item && !editing && <button className="btn btn-icon" title="编辑" onClick={() => setEditing(true)}><IconSettings /></button>}>
        <div className="detail-drawer-body">
          {!editing && <h2>{form.title}</h2>}
          {editing ? (
            <div className="knowledge-form">
              <label>标题 *<input className="input" autoFocus value={form.title || ""} onChange={(e) => setField("title", e.target.value)} /></label>
              <label>摘要<input className="input" placeholder="一句话说明它解决什么问题" value={form.summary || ""} onChange={(e) => setField("summary", e.target.value)} /></label>
              <label>正文 *<textarea className="input" rows="14" value={form.body || ""} onChange={(e) => setField("body", e.target.value)} /></label>
              <label>标签<input className="input" placeholder="逗号分隔" value={form.tags || ""} onChange={(e) => setField("tags", e.target.value)} /></label>
              <label>来源链接<input className="input" placeholder="https://" value={form.sourceUrl || ""} onChange={(e) => setField("sourceUrl", e.target.value)} /></label>
              {error && <p className="auth-error">{error}</p>}
            </div>
          ) : (
            <div className="knowledge-detail">
              {form.summary && <p className="knowledge-summary">{form.summary}</p>}
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
              {(form.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean).length > 0 && (
                <div className="knowledge-meta">{form.tags.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => <span key={tag}>{tag}</span>)}</div>
              )}
              {form.sourceUrl && <a className="knowledge-source" href={form.sourceUrl} target="_blank" rel="noopener noreferrer"><IconArrowUpRight />查看原始来源</a>}
            </div>
          )}
        </div>
        <div className="drawer-foot">
          {item && <button className="btn btn-danger" onClick={() => onDelete(item.id)}><IconTrash />删除</button>}
          <span className="spacer"></span>
          {editing ? (
            <React.Fragment>
              {item && <button className="btn btn-ghost" onClick={() => { setForm(item); setEditing(false); }}>取消</button>}
              <button className="btn btn-primary" onClick={save} disabled={busy}><IconCheck />{busy ? "保存中" : "保存"}</button>
            </React.Fragment>
          ) : <button className="btn" onClick={() => setEditing(true)}>编辑</button>}
        </div>
    </DetailDrawer>
  );
}

Object.assign(window, { InboxView, KnowledgeView, KnowledgeDrawer });
