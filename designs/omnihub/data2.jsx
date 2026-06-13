/// v2 数据层 —— 带描述的默认收藏、提示词分类与默认提示词库
/// 依赖 data.jsx 已挂载到 window 的 loadStored / saveStored / getDomain

/** v2 默认收藏（带一句话描述，与 v1 共用存储键，旧数据自动兼容） */
const DEFAULT_FAVORITES_V2 = [
  { id: "f1", name: "哔哩哔哩", url: "https://www.bilibili.com", category: "娱乐", desc: "年轻人的视频社区，学习娱乐都在这" },
  { id: "f2", name: "知乎", url: "https://www.zhihu.com", category: "常用", desc: "有问题，就会有答案" },
  { id: "f3", name: "GitHub", url: "https://github.com", category: "开发", desc: "全球最大的开源代码托管平台" },
  { id: "f4", name: "百度", url: "https://www.baidu.com", category: "常用", desc: "中文搜索引擎" },
  { id: "f5", name: "中国大学 MOOC", url: "https://www.icourse163.org", category: "学习", desc: "名校公开课，免费在线学习" },
  { id: "f6", name: "掘金", url: "https://juejin.cn", category: "开发", desc: "开发者技术内容分享社区" },
  { id: "f7", name: "网易云音乐", url: "https://music.163.com", category: "娱乐", desc: "听歌看评论，发现好音乐" },
  { id: "f8", name: "菜鸟教程", url: "https://www.runoob.com", category: "学习", desc: "编程入门教程大全" },
];

const PROMPT_CATEGORIES = ["绘画", "写作", "编程", "学习"];

/** 默认提示词示例 —— 演示配图与纯文本两种形态 */
const DEFAULT_PROMPTS = [
  {
    id: "p1",
    title: "赛博朋克雨夜街景",
    text: "A neon-lit cyberpunk street at night, heavy rain, reflections on wet asphalt, holographic billboards in Chinese, a lone figure with a transparent umbrella, cinematic lighting, ultra detailed, 8k --ar 16:9",
    category: "绘画",
    image: "https://picsum.photos/seed/cyberpunk-rain/640/360",
  },
  {
    id: "p2",
    title: "水彩风格小镇插画",
    text: "Watercolor illustration of a quiet European hillside town at sunrise, soft pastel palette, loose brush strokes, white paper margin, storybook style, gentle morning light",
    category: "绘画",
    image: "https://picsum.photos/seed/watercolor-town/640/360",
  },
  {
    id: "p3",
    title: "周报润色助手",
    text: "你是一名资深职场写作教练。请把我粘贴的流水账周报改写成结构化周报：1) 本周成果（量化）2) 进行中事项与风险 3) 下周计划。语气专业简洁，每条不超过两行，保留事实不要编造。",
    category: "写作",
    image: "",
  },
  {
    id: "p4",
    title: "代码审查助手",
    text: "请作为严格的代码审查者检查下面的代码：指出潜在 bug、性能问题、命名与可读性问题，按严重程度排序；每个问题给出修改建议和示例代码；最后总结 3 条最值得先改的点。",
    category: "编程",
    image: "",
  },
  {
    id: "p5",
    title: "费曼学习法讲解",
    text: "请用费曼学习法向一个初中生解释「{概念}」：先用一个生活类比开场，再分三步讲清原理，每步配一个例子，最后出 3 道由浅入深的小测验并附答案。",
    category: "学习",
    image: "https://picsum.photos/seed/feynman-study/640/360",
  },
];

Object.assign(window, {
  DEFAULT_FAVORITES_V2, PROMPT_CATEGORIES, DEFAULT_PROMPTS,
});
