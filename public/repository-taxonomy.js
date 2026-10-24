// Shared by the browser and the local classification importer. No repository records here.
export const CLASSIFICATION_VERSION = 'repository-uses-2026-09-28-v1';
export const REPOSITORY_FORMS = {
  skill:'Skill', mcp:'MCP', app:'应用', cli:'CLI', tool:'工具', library:'库／框架',
  plugin:'插件／主题', resource:'资料集', model:'模型', workflow:'工作流', agent:'Agent',
};
export const REPOSITORY_TOPICS = [
  {id:'agent',title:'AI 编程与 Agent',description:'开发、编排、记忆与能力扩展',color:'#5976b8',background:'#edf2fc',children:{coding:'AI 编程',orchestration:'多 Agent 协作',routing:'模型路由与网关',memory:'记忆与上下文',skills:'技能开发与管理',catalog:'技能与生态导航',monitoring:'用量与运行监控',evaluation:'评测与质量保障',inference:'模型推理与训练',judgment:'结构化判断',persona:'角色与思维模型',learning:'Agent 学习资料',workspace:'Agent 客户端与工作台'}},
  {id:'video',title:'视频与短剧',description:'从剧本、分镜到剪辑成片',color:'#ae7a53',background:'#fbf1e9',children:{drama:'短剧制作',screenwriting:'剧本与分镜',generation:'视频生成',editing:'视频剪辑',prompts:'视频提示词',narration:'解说与字幕',download:'视频下载与归档',demo:'录屏与产品演示',motion:'代码与动画视频'}},
  {id:'design',title:'图像与设计',description:'画面、界面与视觉表达',color:'#9274ac',background:'#f4eef9',children:{ui:'UI 与产品设计',system:'设计系统与组件',image:'图像生成与编辑',portrait:'女性人像与穿搭',prompts:'图像提示词',graphics:'海报与信息图',motion:'界面动效',icons:'图标与标志',canvas:'画布与创作工作台'}},
  {id:'content',title:'写作与内容创作',description:'写作、演示、选题与发布',color:'#a86787',background:'#f8eef4',children:{writing:'写作与润色',fiction:'小说与故事',slides:'PPT 与演示',publishing:'多平台发布',planning:'选题与内容运营',documents:'文档排版'}},
  {id:'knowledge',title:'知识与研究',description:'收藏、笔记、阅读与信息追踪',color:'#508c83',background:'#eaf5f2',children:{capture:'采集与收藏',notes:'笔记与 Obsidian',reading:'阅读与学习',research:'深度研究与溯源',rag:'知识检索与 RAG',feeds:'资讯与 RSS',science:'科研与数据分析',documents:'文档转换与提取'}},
  {id:'automation',title:'自动化与连接',description:'让网页、设备和业务工具协同',color:'#688f66',background:'#eff6ed',children:{browser:'浏览器自动化',desktop:'桌面自动化',mobile:'手机与设备控制',workflow:'工作流编排',office:'办公与邮件连接',social:'社交平台连接',integrations:'API 与工具连接'}},
  {id:'audio',title:'音频与语音',description:'配音、转录、音乐与语音交互',color:'#5c94a3',background:'#ecf6f8',children:{tts:'语音合成与克隆',asr:'语音识别与输入',music:'音乐与音轨处理',assistant:'语音助手与数字人'}},
  {id:'development',title:'开发与基础工具',description:'工程、系统、运维与安全',color:'#6c8599',background:'#edf3f7',children:{frontend:'前端与组件',mobile:'移动与原生开发',backend:'后端与数据库',architecture:'架构与代码理解',review:'代码审查与重构',testing:'测试与质量',devops:'部署与运行环境',security:'安全与逆向研究',network:'网络与代理',terminal:'终端与 Git',utilities:'桌面与文件工具',learning:'开发学习资料',apis:'API 与 SDK'}},
  {id:'business',title:'商业与数据研究',description:'增长、分析、创业与量化研究',color:'#a28b4e',background:'#f8f4e7',children:{marketing:'营销与增长',seo:'SEO 与搜索可见性',startup:'创业与商业方法',finance:'金融数据与投研',trading:'量化与策略回测',market:'交易所与预测市场',career:'职业与远程工作'}},
  {id:'personal',title:'生活与兴趣',description:'个人效率、学习资料与兴趣项目',color:'#898079',background:'#f3f0ed',children:{productivity:'个人效率',learning:'生活与学习资料',games:'游戏与仿真',pets:'桌面宠物',divination:'命理与占卜文化',health:'健康学习资料'}},
];
REPOSITORY_TOPICS[0].children.accounts = '账号与订阅管理';
export const SUBTOPICS = new Map(REPOSITORY_TOPICS.flatMap(topic => Object.entries(topic.children).map(([id,label]) => [`${topic.id}.${id}`,{id:`${topic.id}.${id}`,topic:topic.id,label}])));
export function isValidClassification(classification) {
  return Boolean(classification && classification.version === CLASSIFICATION_VERSION &&
    Array.isArray(classification.uses) && classification.uses.length && classification.uses.every(use => SUBTOPICS.has(use)) &&
    Array.isArray(classification.forms) && classification.forms.length && classification.forms.every(form => Object.hasOwn(REPOSITORY_FORMS,form)));
}
