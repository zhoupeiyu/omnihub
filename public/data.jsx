/// 前端数据层 —— 本机偏好（皮肤/主题）存 localStorage，业务数据走服务器 API

const D_STORAGE_PREFIX = "omnihub.";

/** 读取本机偏好（皮肤、主题等），失败返回默认值 */
function loadStored(key, fallback) {
  try {
    const raw = localStorage.getItem(D_STORAGE_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

/** 保存本机偏好 */
function saveStored(key, value) {
  try {
    localStorage.setItem(D_STORAGE_PREFIX + key, JSON.stringify(value));
  } catch (err) { /* 隐私模式下静默失败 */ }
}

/** 提取 URL 的域名部分用于展示 */
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch (err) { return url; }
}

/** 根据名称生成确定性的头像色相（同名永远同色） */
function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `oklch(58% 0.16 ${hash % 360})`;
}

const SKIN_LIST = [
  { id: "minimal", name: "极简清爽", dot: "oklch(55% 0.21 258)" },
  { id: "tech",    name: "深色科技", dot: "oklch(60% 0.22 290)" },
  { id: "warm",    name: "温暖杂志", dot: "oklch(60% 0.14 45)" },
  { id: "playful", name: "活泼多彩", dot: "oklch(68% 0.19 25)" },
];

const FAV_CATEGORIES = ["常用", "学习", "开发", "娱乐"];
const PROMPT_CATEGORIES = ["图像", "视频", "写作", "编程", "学习"];
const FEED_CATEGORIES = ["全部", "科技", "资讯", "设计"];

/** AI HOT 分类编码 → 中文标签（用于信息流分类筛选） */
const AI_FEED_CATS = [
  { id: "", name: "全部" },
  { id: "ai-models", name: "模型" },
  { id: "ai-products", name: "产品" },
  { id: "industry", name: "行业" },
  { id: "paper", name: "论文" },
  { id: "tip", name: "技巧" },
];
const AI_FEED_CAT_NAMES = {
  "ai-models": "模型", "ai-products": "产品", product: "产品",
  industry: "行业", paper: "论文", tip: "技巧", technique: "技巧",
};

/** 示例信息流数据 —— 演示用，后续可替换为真实热榜 API */
const SAMPLE_FEED = [
  { id: "n1", title: "国产大模型集体冲刺多模态：视频生成进入「秒级出片」时代", source: "示例·科技日报", category: "科技", time: "25 分钟前", heat: "98.2万" },
  { id: "n2", title: "Flutter 4 路线图公布：渲染引擎全面切换 Impeller，启动速度提升 40%", source: "示例·开发者社区", category: "科技", time: "1 小时前", heat: "72.5万" },
  { id: "n3", title: "今年最值得关注的 10 个开源项目，第一名竟然是个浏览器", source: "示例·掘金热榜", category: "科技", time: "2 小时前", heat: "65.1万" },
  { id: "n4", title: "新版个人信息保护指引发布：App 收集数据需「最小必要」", source: "示例·每日资讯", category: "资讯", time: "3 小时前", heat: "54.8万" },
  { id: "n5", title: "高校开设「AI 通识课」成趋势，中学阶段编程教育同步升温", source: "示例·教育观察", category: "资讯", time: "4 小时前", heat: "43.6万" },
  { id: "n6", title: "从拟物到「新极简」：2026 年界面设计趋势盘点", source: "示例·设计周刊", category: "设计", time: "5 小时前", heat: "38.9万" },
  { id: "n7", title: "为什么大厂都在重做暗色模式？一文讲透对比度与可读性", source: "示例·UX 笔记", category: "设计", time: "6 小时前", heat: "31.2万" },
  { id: "n8", title: "太阳能电池板效率再破纪录，实验室转换率达 35.7%", source: "示例·前沿科学", category: "科技", time: "8 小时前", heat: "28.4万" },
  { id: "n9", title: "周末观影指南：这五部高分纪录片值得一看", source: "示例·生活方式", category: "资讯", time: "10 小时前", heat: "22.0万" },
  { id: "n10", title: "字体排印小课堂：中西文混排的五个常见错误", source: "示例·设计周刊", category: "设计", time: "12 小时前", heat: "18.7万" },
];

/** 一言加载失败时的本地后备语录 */
const FALLBACK_QUOTES = [
  { text: "种一棵树最好的时间是十年前，其次是现在。", from: "谚语" },
  { text: "我们登上并非我们所选择的舞台，演出并非我们所选择的剧本。", from: "《无问西东》" },
  { text: "热爱可抵岁月漫长。", from: "佚名" },
  { text: "凡是过往，皆为序章。", from: "莎士比亚《暴风雨》" },
  { text: "路虽远行则将至，事虽难做则必成。", from: "《荀子》" },
];

/** 生成模型预设（图像 / 视频） */
const MODEL_PRESETS = [
  "Seedance", "Vidu", "Kling", "Sora", "Veo", "Runway",
  "Luma", "Pika", "Midjourney", "Niji", "GPT Image", "即梦", "可灵",
];

/** 标签模板 —— 一键添加常用标签 */
const TAG_TEMPLATES = [
  "人物", "风景", "动漫", "写实", "电商", "运镜", "转场", "特效", "口播", "产品图",
];

/** SNS 平台类型 → 显示名 */
const SNS_TYPE_NAMES = {
  bilibili: "B站", douyin: "抖音", xiaohongshu: "小红书", weibo: "微博",
  x: "X", youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", other: "链接",
};

/** AI 服务商预设 —— 一键填入接口地址与常用模型 */
const AI_PRESETS = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
];

Object.assign(window, {
  loadStored, saveStored, getDomain, getAvatarColor,
  SKIN_LIST, FAV_CATEGORIES, PROMPT_CATEGORIES,
  FEED_CATEGORIES, SAMPLE_FEED, FALLBACK_QUOTES, AI_PRESETS,
  MODEL_PRESETS, TAG_TEMPLATES, SNS_TYPE_NAMES,
  AI_FEED_CATS, AI_FEED_CAT_NAMES,
});
