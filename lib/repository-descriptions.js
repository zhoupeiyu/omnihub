/// Pure helpers that turn official GitHub repository text (description + README) and,
/// failing that, saved X source posts into one bounded, source-grounded introduction.
/// No network access happens here; every function only transforms strings that are
/// already available in memory so the module stays easy to unit test.

export const MAX_README_INTRO_LENGTH = 360;
export const MAX_FALLBACK_LENGTH = 320;

export const DESCRIPTION_PROVENANCE = Object.freeze({
  README: "github_readme",
  DESCRIPTION: "github_description",
  SOURCES: "sources",
  TOPICS: "topics_fallback",
});

const HEADING_LINE = /^#{1,6}\s/;
const HR_LINE = /^(-{3,}|\*{3,}|_{3,})$/;
const BADGE_LINE = /^\[?!\[/;
const LINK_REFERENCE_DEFINITION = /^\[[^\]]+\]:\s*https?:\/\//i;
const TOC_LIST_ITEM = /^[-*+]\s*\[[^\]]+\]\(#[^)]*\)/;
const EMPTY_LIST_MARKER = /^[-*+]\s*$/;

const BOILERPLATE_PATTERNS = [
  /table of contents/i,
  /^licen[cs]e$/i,
  /^contributing$/i,
  /code of conduct/i,
  /star history/i,
  /^sponsors?$/i,
  /sponsored by/i,
  /thanks? (?:to|our sponsors?)/i,
  /our open source friend/i,
  /support(?:ed|ing) (?:this|the) project/i,
  /感谢.+赞助/,
  /acknowledge?ments?/i,
  /give it a star/i,
  /leave a star/i,
  /drop a star/i,
  /buy me a coffee/i,
  /^badges?$/i,
];

const INSTALL_COMMAND_PATTERNS = [
  /^[$>]\s/,
  /\bnpm (install|i)\b/i,
  /\byarn add\b/i,
  /\bpnpm add\b/i,
  /\bpip3? install\b/i,
  /\bpoetry add\b/i,
  /\bgo get\b/i,
  /\bcargo (add|install)\b/i,
  /\bdocker (run|pull)\b/i,
  /\bbrew install\b/i,
  /\bapt(-get)? install\b/i,
  /\bgit clone\b/i,
  /\bmake install\b/i,
  /\bcmake\s/i,
  /^\.\/configure\b/i,
];

const MARKETING_PATTERNS = [
  /check (it |this )?out/i,
  /don'?t miss/i,
  /must[- ]have/i,
  /click here/i,
  /follow (me|us)\b/i,
  /\bretweet\b/i,
  /like (and|&) (share|retweet)/i,
  /give it a star/i,
  /drop a star/i,
  /go check/i,
  /amazing (tool|project|repo)/i,
  /game[- ]changer/i,
  /you need to (see|try)/i,
  /建议收藏|值得收藏|强烈推荐|必装|最强|起飞|含金量|宝藏项目|冲[！!]?$/,
  /我(?:精心)?(?:收集|整理)了|感谢.+(?:分享|移植)/,
  /[\u{1F300}-\u{1FAFF}☀-➿]/u,
];

const STAR_COUNT_PATTERN = /(?:\b\d[\d,.]*\s*k?\+?\s*stars?\b|\d+(?:\.\d+)?\s*[万千kK]?\s*(?:星|star))/i;

const COLLECTION_PATTERNS = [
  /\bcollection of\b/i,
  /\blist of\b/i,
  /\bcurated list\b/i,
  /\bawesome list\b/i,
  /\bcompilation of\b/i,
  /\bround[- ]?up\b/i,
  /\bcurated collection\b/i,
  /(?:仓库|项目|技能|skills?)(?:合集|清单|汇总)|(?:合集|清单|汇总)(?:里|中|：|:)/i,
];

const FUNCTIONAL_KEYWORDS = new RegExp(
  "\\b(builds?|building|creates?|generates?|automat\\w*|manages?|analyz\\w*|converts?|" +
  "extracts?|deploys?|integrat\\w*|syncs?|schedul\\w*|tracks?|visualiz\\w*|pars\\w*|" +
  "renders?|searches?|translat\\w*|monitors?|debugs?|optimiz\\w*|compress\\w*|encrypt\\w*|" +
  "migrat\\w*|scrap\\w*|crawl\\w*|summariz\\w*|classif\\w*|detect\\w*|recommend\\w*|" +
  "orchestrat\\w*|provision\\w*|process\\w*|rotates?|lets you|allows you|enables?|" +
  "helps you|is a tool|is a library|is a framework|is a cli|command[- ]line|" +
  "plugin for|extension for|api for|sdk for)\\b",
  "i",
);

const CHINESE_FUNCTIONAL_KEYWORDS =
  /(用于|用来|可以|能够|支持|帮助|让.+(?:完成|减少|避免|理解)|把.+(?:变成|转换|生成)|生成|创建|制作|自动化?|整理|提取|分析|管理|部署|同步|监控|调试|优化|搜索|识别|转换|渲染|编排|处理|提供|集成|实现|教\s*AI)/;

function stripCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
}

function stripFrontMatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
}

function stripHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "\n").replace(/<[^>]+>/g, " ");
}

function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/[`*_~]+/g, "")
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isTableRow(line) {
  return (line.match(/\|/g) || []).length >= 2;
}

function isNavigationLine(line) {
  const links = line.match(/\[[^\]]+\]\([^)]+\)/g) || [];
  if (links.length < 2) return false;
  const withoutLinks = line.replace(/\[[^\]]+\]\([^)]+\)/g, "").replace(/[|·•\-\s]/g, "");
  return withoutLinks.length === 0;
}

function isBoilerplateLine(line) {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(line));
}

function isInstallCommandLine(line) {
  return INSTALL_COMMAND_PATTERNS.some((pattern) => pattern.test(line));
}

function isNoiseLine(line) {
  if (HEADING_LINE.test(line)) return true;
  if (HR_LINE.test(line)) return true;
  if (isTableRow(line)) return true;
  if (BADGE_LINE.test(line)) return true;
  if (LINK_REFERENCE_DEFINITION.test(line)) return true;
  if (TOC_LIST_ITEM.test(line)) return true;
  if (EMPTY_LIST_MARKER.test(line)) return true;
  if (isNavigationLine(line)) return true;
  if (isInstallCommandLine(line)) return true;
  if (isBoilerplateLine(line)) return true;
  return false;
}

function isReadableParagraph(paragraph) {
  if (!paragraph || paragraph.length < 20) return false;
  const letters = (paragraph.match(/[A-Za-z一-鿿]/g) || []).length;
  if (letters < 15) return false;
  if (/^[-*+]\s/.test(paragraph)) return false;
  const linkChars = (paragraph.match(/\[[^\]]+\]\([^)]+\)/g) || []).join("").length;
  if (linkChars > paragraph.length * 0.5) return false;
  return true;
}

function cleanReadmeParagraphs(markdown) {
  let text = String(markdown || "");
  if (!text.trim()) return [];
  text = stripFrontMatter(text);
  text = stripCodeFences(text);
  text = stripHtml(text);
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { kept.push(""); continue; }
    if (isNoiseLine(trimmed)) continue;
    kept.push(trimmed);
  }
  const paragraphs = [];
  let current = [];
  for (const line of kept) {
    if (!line) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs
    .map(stripInlineMarkdown)
    .filter(isReadableParagraph);
}

function truncateAtSentence(text, maxLength) {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastBreak = Math.max(
    slice.lastIndexOf(". "), slice.lastIndexOf("。"),
    slice.lastIndexOf("! "), slice.lastIndexOf("? "),
  );
  if (lastBreak > maxLength * 0.4) return slice.slice(0, lastBreak + 1).trim();
  return `${slice.trim()}…`;
}

function isPromotionalParagraph(paragraph) {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(paragraph)) ||
    MARKETING_PATTERNS.some((pattern) => pattern.test(paragraph));
}

function readmeParagraphScore(paragraph) {
  if (!paragraph || isPromotionalParagraph(paragraph)) return -Infinity;
  const length = paragraph.length;
  if (length < 30) return -Infinity;
  let score = 0;
  if (FUNCTIONAL_KEYWORDS.test(paragraph) || CHINESE_FUNCTIONAL_KEYWORDS.test(paragraph)) score += 8;
  if (length >= 55 && length <= 260) score += 4;
  else if (length <= 360) score += 2;
  if (/[.!?。！？]/.test(paragraph)) score += 2;
  if (/\b(is|are) (?:an? |the )?(?:tool|library|framework|platform|application|app|cli|collection|methodology)\b/i.test(paragraph)) score += 4;
  if (/^(?:welcome|introducing|overview)\b/i.test(paragraph)) score -= 2;
  return score;
}

/** Extract the first concrete source-grounded introduction paragraph from README markdown. */
export function extractReadmeIntroduction(markdown) {
  const paragraphs = cleanReadmeParagraphs(markdown);
  if (!paragraphs.length) return null;
  const selected = paragraphs
    .slice(0, 18)
    .find((paragraph) => readmeParagraphScore(paragraph) >= 8);
  if (!selected) return null;
  return selected.length > MAX_README_INTRO_LENGTH
    ? truncateAtSentence(selected, MAX_README_INTRO_LENGTH)
    : selected;
}

function isUsefulGithubDescription(description) {
  const text = String(description || "").trim();
  if (!text) return false;
  if (/^no description/i.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (text.length < 8) return false;
  return true;
}

/**
 * Prefer a meaningful README introduction, enriched by the repository description when
 * useful; otherwise fall back to the description alone. Returns null when neither GitHub
 * field carries a usable official introduction.
 */
export function selectOfficialDescription({ description, readme } = {}) {
  const readmeIntro = extractReadmeIntroduction(readme);
  const usefulDescription = isUsefulGithubDescription(description) ? stripInlineMarkdown(description) : "";
  if (usefulDescription) {
    if (usefulDescription.length >= 80) {
      return { text: usefulDescription, provenance: DESCRIPTION_PROVENANCE.DESCRIPTION };
    }
    let text = usefulDescription;
    const alreadyIncluded = readmeIntro && (
      readmeIntro.toLowerCase().includes(usefulDescription.toLowerCase().slice(0, 24)) ||
      usefulDescription.toLowerCase().includes(readmeIntro.toLowerCase().slice(0, 24))
    );
    if (readmeIntro && !alreadyIncluded) {
      const joiner = /[.!?。！？:]$/.test(usefulDescription) ? " " : ". ";
      text = `${usefulDescription}${joiner}${readmeIntro}`;
    }
    if (text.length > MAX_README_INTRO_LENGTH) text = truncateAtSentence(text, MAX_README_INTRO_LENGTH);
    return {
      text,
      provenance: readmeIntro && !alreadyIncluded
        ? DESCRIPTION_PROVENANCE.README
        : DESCRIPTION_PROVENANCE.DESCRIPTION,
    };
  }
  if (readmeIntro) return { text: readmeIntro, provenance: DESCRIPTION_PROVENANCE.README };
  return null;
}

function isRejectedSentence(sentence) {
  if (/https?:\/\//i.test(sentence)) return true;
  if (/\bwww\./i.test(sentence)) return true;
  if (/pic\.twitter\.com/i.test(sentence)) return true;
  if (STAR_COUNT_PATTERN.test(sentence)) return true;
  if (MARKETING_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
  if (COLLECTION_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
  return false;
}

function isSpecificSentence(sentence) {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  if (sentence.length > 260) return false;
  if (/[一-鿿]/.test(sentence)) {
    return sentence.length >= 10 && CHINESE_FUNCTIONAL_KEYWORDS.test(sentence);
  }
  if (words.length < 4) return false;
  return FUNCTIONAL_KEYWORDS.test(sentence);
}

function splitSentences(text) {
  return String(text || "")
    .split(/[\n。！？；]+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Choose specific, functional sentences from saved X source posts, rejecting noise. */
export function synthesizeSourceFallback({ sourcePosts = [] } = {}) {
  const sentences = [];
  outer: for (const post of sourcePosts || []) {
    const combined = `${post.title || ""}. ${post.content || post.excerpt || ""}`;
    for (const sentence of splitSentences(combined)) {
      if (isRejectedSentence(sentence)) continue;
      if (!isSpecificSentence(sentence)) continue;
      if (sentences.includes(sentence)) continue;
      sentences.push(sentence);
      if (sentences.length >= 2) break outer;
    }
  }
  if (!sentences.length) return null;
  let text = sentences.join(" ");
  if (text.length > MAX_FALLBACK_LENGTH) text = truncateAtSentence(text, MAX_FALLBACK_LENGTH);
  return { text, provenance: DESCRIPTION_PROVENANCE.SOURCES };
}

/** Last-resort, honest fallback built only from repository identity and known topics. */
export function synthesizeTopicsFallback({ owner, name, topics = [] } = {}) {
  const topicLabels = {
    software: "软件开发", workflow: "工作流与自动化", video: "视频创作", image: "图像创作",
    crypto: "加密与交易", business: "商业", product: "产品设计", other: "其他主题",
  };
  const label = (topics || []).filter(Boolean).slice(0, 3).map((topic) => topicLabels[topic] || topic).join("、");
  const focus = label ? `目前只确认它与${label}有关` : "目前还没有确认具体用途";
  const text = `${owner}/${name}：${focus}，官方介绍与可用的来源总结仍待补充。`;
  return { text, provenance: DESCRIPTION_PROVENANCE.TOPICS };
}

/**
 * Full selection pipeline: official GitHub text first, then saved-source synthesis, then
 * the generic topics fallback. Never invents capabilities that are not grounded in one of
 * these inputs.
 */
export function selectRepositoryDescription({
  owner, name, description = "", readme = "", topics = [], sourcePosts = [],
} = {}) {
  const official = selectOfficialDescription({ description, readme });
  if (official) return official;
  const fallback = synthesizeSourceFallback({ sourcePosts });
  if (fallback) return fallback;
  return synthesizeTopicsFallback({ owner, name, topics });
}
