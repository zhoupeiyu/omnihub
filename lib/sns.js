/// SNS 链接处理 —— 平台类型识别与 URL 规范化（去跟踪参数、统一短链格式）
/// 支持：B站 / 抖音 / 小红书 / 微博 / X / YouTube / TikTok / Instagram

/** 各平台的识别规则与规范化方法 */
const SNS_RULES = [
  {
    type: "bilibili",
    hosts: ["bilibili.com", "b23.tv"],
    normalize(url) {
      const bv = url.pathname.match(/(BV[0-9A-Za-z]{10})/);
      if (bv) return `https://www.bilibili.com/video/${bv[1]}`;
      return stripQuery(url);
    },
  },
  {
    type: "douyin",
    hosts: ["douyin.com", "iesdouyin.com", "v.douyin.com"],
    normalize(url) {
      const video = url.pathname.match(/\/video\/(\d+)/);
      if (video) return `https://www.douyin.com/video/${video[1]}`;
      return stripQuery(url);
    },
  },
  {
    type: "xiaohongshu",
    hosts: ["xiaohongshu.com", "xhslink.com"],
    normalize(url) {
      const note = url.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/);
      if (note) return `https://www.xiaohongshu.com/explore/${note[1]}`;
      return stripQuery(url);
    },
  },
  {
    type: "weibo",
    hosts: ["weibo.com", "weibo.cn", "m.weibo.cn"],
    normalize(url) {
      const status = url.pathname.match(/\/(\d+)\/([0-9A-Za-z]+)/);
      if (status) return `https://weibo.com/${status[1]}/${status[2]}`;
      return stripQuery(url);
    },
  },
  {
    type: "x",
    hosts: ["twitter.com", "x.com", "mobile.twitter.com"],
    normalize(url) {
      const status = url.pathname.match(/\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (status) return `https://x.com/${status[1]}/status/${status[2]}`;
      return stripQuery(new URL(url.href.replace(url.hostname, "x.com")));
    },
  },
  {
    type: "youtube",
    hosts: ["youtube.com", "youtu.be", "m.youtube.com"],
    normalize(url) {
      let videoId = "";
      if (url.hostname.includes("youtu.be")) videoId = url.pathname.slice(1).split("/")[0];
      else if (url.pathname.startsWith("/watch")) videoId = url.searchParams.get("v") || "";
      else {
        const shorts = url.pathname.match(/\/shorts\/([0-9A-Za-z_-]{11})/);
        if (shorts) videoId = shorts[1];
      }
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      return stripQuery(url);
    },
  },
  {
    type: "tiktok",
    hosts: ["tiktok.com", "vm.tiktok.com"],
    normalize(url) {
      const video = url.pathname.match(/\/(@[A-Za-z0-9_.]+)\/video\/(\d+)/);
      if (video) return `https://www.tiktok.com/${video[1]}/video/${video[2]}`;
      return stripQuery(url);
    },
  },
  {
    type: "instagram",
    hosts: ["instagram.com"],
    normalize(url) {
      const post = url.pathname.match(/\/(p|reel|reels)\/([0-9A-Za-z_-]+)/);
      if (post) return `https://www.instagram.com/${post[1] === "reels" ? "reel" : post[1]}/${post[2]}/`;
      return stripQuery(url);
    },
  },
];

function stripQuery(url) {
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * 识别并规范化 SNS 链接
 * 返回 { snsType, normalizedUrl }；无法解析时 snsType="other"，normalizedUrl 原样返回
 */
export function normalizeSnsUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return { snsType: "", normalizedUrl: "" };
  let url;
  try {
    url = new URL(trimmed);
  } catch (err) {
    return { snsType: "other", normalizedUrl: trimmed };
  }
  const host = url.hostname.replace(/^www\./, "");
  const rule = SNS_RULES.find((r) => r.hosts.some((h) => host === h || host.endsWith("." + h)));
  if (!rule) return { snsType: "other", normalizedUrl: stripQuery(url) };
  try {
    return { snsType: rule.type, normalizedUrl: rule.normalize(url) };
  } catch (err) {
    return { snsType: rule.type, normalizedUrl: stripQuery(url) };
  }
}
