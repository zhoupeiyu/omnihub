import { createHash } from "node:crypto";

const URL_RE = /https?:\/\/\S+/gi;
const LINK_ONLY_RE = /^https?:\/\/\S+$/i;
const HYPE_RE = /^(?:震惊|太牛|太强|牛逼|卧槽|必看|绝了|重磅|速看|分享给|转发|快来|建议大家|强烈建议)/iu;
const VALUE_RE = /(?:提供|包含|支持|实现|介绍|整理|解释|对比|步骤|方法|教程|代码|开源|案例|示例|提示词|参数|下载|安装|申请|使用|如何|可以|适合|原因|因为|基于)/iu;

function plain(value) {
  return String(value || "")
    .replace(URL_RE, " ")
    .replace(/\b(?:sk|tp|ghp|gho|xoxb|xoxp)-[A-Za-z0-9_-]{16,}\b/g, "[凭据已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[长令牌已隐藏]")
    .replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return plain(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function isSourceEvidence(value) {
  const text = plain(value);
  return text.length >= 12 && !LINK_ONLY_RE.test(text) && /\p{L}/u.test(text);
}

function sentences(content) {
  const result = [];
  for (const line of String(content || "").split(/\n+/)) {
    for (const part of line.split(/(?<=[。！？!?；;])\s*/u)) {
      const text = plain(part).replace(/^[\s\d①-⑳一二三四五六七八九十、.．)）:：•·\-—]+/u, "").trim();
      if (text && isSourceEvidence(text)) result.push(text);
    }
  }
  return result;
}

function scoreSentence(sentence, index, title) {
  const length = [...sentence].length;
  let score = Math.min(length, 110) / 12 - index * 0.25;
  if (length >= 25 && length <= 145) score += 4;
  if (VALUE_RE.test(sentence)) score += 3;
  if (/\d|[A-Z][a-z]/.test(sentence)) score += 1;
  if (HYPE_RE.test(sentence)) score -= 5;
  if (length > 200) score -= 4;
  if (normalize(sentence) === normalize(title)) score -= 8;
  return score;
}

function trimText(value, limit) {
  const text = plain(value);
  return [...text].length <= limit ? text : [...text].slice(0, limit - 1).join("").trimEnd() + "…";
}

/** Extractive, source-grounded digest. No unavailable article or image content is invented. */
export function digestXBookmark(item) {
  const title = plain(item.title);
  const raw = String(item.content || "").trim();
  const organization = item.organization || {};
  const kind = organization.assetType || item.aiType || "unknown";
  const validTitle = title && !LINK_ONLY_RE.test(title) && !/^X 帖子 \d+$/u.test(title);
  const promptMarker = kind === "prompt" ? raw.search(/(?:^|\n)\s*(?:提示词|prompt)\s*[:：]/imu) : -1;
  const source = promptMarker > 30 ? raw.slice(0, promptMarker)
    : kind === "prompt" ? raw.slice(0, 500) : raw;
  const candidates = sentences(source).filter((sentence) =>
    normalize(sentence) !== normalize(title) &&
    !(normalize(title).length > 10 && normalize(sentence).startsWith(normalize(title)))).slice(0, 8);
  const ranked = candidates.map((sentence, index) => ({
    sentence, index, score: scoreSentence(sentence, index, title),
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = ranked.filter((entry) => entry.score >= 2).slice(0, 2)
    .sort((a, b) => a.index - b.index).map((entry) => entry.sentence);
  const evidence = chosen.join(" ");
  const sourceLead = plain(source);
  const promptBodyLead = validTitle && sourceLead.startsWith(title)
    ? sourceLead.slice(title.length).trim() : sourceLead;
  const promptLead = kind === "prompt" && promptMarker <= 30 && promptBodyLead &&
    isSourceEvidence(promptBodyLead) ? `原帖分享${validTitle ? `「${trimText(title, 35)}」` : "提示词"}：${promptBodyLead.slice(0, 105)}` : "";
  const summary = organization.contentIncomplete && !evidence ? ""
    : trimText(promptLead || evidence, 155);
  return {
    summary,
    reason: "",
    status: summary ? organization.contentIncomplete ? "partial_excerpt" : "source_excerpt" : "needs_source",
    sourceHash: createHash("sha256").update(JSON.stringify({
      content: item.content || "", title: item.title || "",
      assetType: item.organization?.assetType || item.aiType || "",
      incomplete: Boolean(item.organization?.contentIncomplete),
      media: item.media || [], links: item.links || [],
    })).digest("hex"),
  };
}
