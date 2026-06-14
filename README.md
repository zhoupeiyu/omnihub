# 万象台 OmniHub

一个支持**多用户**的「个人聚合主页」应用：网站收藏 + 提示词库 + AI 对话 + 信息流 + 工具箱。
每个用户注册自己的账号，数据互相隔离，并可配置**自己的 AI API Key** 来使用 AI 对话。

技术上零第三方依赖：后端是 Node.js 原生 HTTP + 内置 SQLite（`node:sqlite`），前端是 React（CDN 加载，浏览器内 Babel 转译），**不需要 npm install，不需要构建**。

## 如何启动

要求 Node.js ≥ 22.5（你机器上是 v25，满足）：

```bash
cd ~/Desktop/omnihub
node server.js
```

浏览器打开 <http://localhost:4320>，注册一个账号即可使用。
数据保存在 `data/app.db`（SQLite 文件）；删除该文件即可重置所有数据。

## 功能说明

### 用户系统
- 注册 / 登录 / 退出，密码用 scrypt 加盐哈希存储，会话 Cookie 30 天有效
- 每个用户拥有独立的收藏、提示词和 AI 配置；新账号自动写入演示数据

### AI 对话（每人配自己的账号）
- 侧边栏左下角「AI 设置」：一键选择 DeepSeek / Kimi / 智谱 / 通义 / OpenAI 预设，填入自己的 API Key 与模型名（任何 OpenAI 兼容接口都行，Base URL 填到 `/v1` 这一级）
- Key 存在本地数据库、仅由后端转发调用，不暴露给网页
- **流式回复**：AI 回答逐字呈现（SSE 转发），并以 **Markdown 渲染**（标题/列表/代码块/表格/引用，由本地 vendor 的 marked + DOMPurify 解析与消毒，无 XSS 风险）
- 聊天支持多轮对话、新对话、Enter 发送；切换模块不丢聊天记录
- 提示词库每张卡片有「**试跑**」按钮：一键把提示词带进聊天框直接发给 AI

### 提示词灵感库（AI 图像 / 视频创作管理）
- **完整字段**：标题、提示词、负面提示词、使用模型、标签、分类、效果图、参考帖子链接、备注、成功原因、失败点、复现技巧、收藏、归档、创建/更新时间
- **模型预设**：Seedance / Vidu / Kling / Sora / Veo / Runway / Luma / Pika / Midjourney / Niji / GPT Image / 即梦 / 可灵，也可输入自定义
- **SNS 参考链接**：保存时自动识别平台（B站 / 抖音 / 小红书 / 微博 / X / YouTube / TikTok / Instagram）并**规范化 URL**（去跟踪参数、统一格式）；B站 与 YouTube 在详情抽屉里**内嵌播放器直接预览**，其他平台显示链接卡片一键打开
- **抽屉式详情 / 编辑**：点卡片右侧滑出抽屉，查看全文与复盘笔记，点铅笔进入编辑
- **收藏 ⭐ 与归档**：星标自动置顶；归档进「已归档」视图，可随时恢复
- **多维筛选**：分类（侧边栏）× 模型 × 标签 × 只看收藏 × 已归档叠加生效；搜索覆盖标题/内容/备注/标签
- **JSON 导出**：一键下载全部灵感备份
- 效果图支持网络链接或本地图片（自动压缩入库）；「试跑」一键把提示词带进 AI 对话

### 信息流（多来源聚合 + AI 精选）
- **多来源架构**：服务器代理拉取外部源并解析为统一条目；来源是后端白名单（防 SSRF，前端只传来源 id）
- **按来源区分**：顶部来源切换栏，每个来源带**分类徽章**（如「AI」），区分不同领域
- 已接入 **AI 资讯**（[AI HOT](https://aihot.virxact.com/) 的公开 REST API），复刻其精选体验：
  - **分类标签**：全部 / 模型 / 产品 / 行业 / 论文 / 技巧（对应 API 的 category）
  - **精选分**：每条右上角 0-100 评分徽章，精选条目高亮；「只看精选」一键过滤
  - **时间线**：按发布日期分组（今天 / 昨天 / 具体日期），组内显示时刻
  - **当前热点**：右侧按评分取 TOP3
- 后续加新源只需在 `lib/feed.js` 的 `FEED_SOURCES` 加一行（RSS 源走通用解析，富源可自定义解析）
- **磁盘缓存降级**：每次成功拉取缓存到 `data/feed-cache/`，源故障/断网时自动回退到上次内容
- 条目标题点击直达原文，显示来源平台与时间；右侧「每日一言」

### 网站收藏 / 工具箱
- 收藏：分类分区 + 计数、搜索、favicon 自动获取、一句话描述、增删改（含改分类）
- 工具箱：密码生成、时间戳双向转换、PDF 压缩、字数统计、颜色转换、随机决定、专注倒计时
- PDF 压缩走本机服务端 Ghostscript，支持高压缩 / 推荐 / 高质量三档、压缩进度、压缩率和下载保存；部署机器需安装 `ghostscript` 或设置 `GS_PATH`
- 4 套皮肤 × 明暗主题，本机记忆

## 文件结构

```
omnihub/
├── server.js          # 入口：静态服务 + API（node server.js 启动）
├── lib/
│   ├── db.js          # SQLite 建表、增删查、新用户种子数据
│   ├── auth.js        # scrypt 密码哈希、会话、Cookie
│   ├── api.js         # REST 路由（认证/收藏/提示词/信息流/AI 配置与对话）
│   ├── ai.js          # AI 代理：转发到用户配置的 OpenAI 兼容接口
│   ├── sns.js         # SNS 链接平台识别与 URL 规范化
│   ├── feed.js        # 信息流：RSS 来源白名单 + 拉取解析 + 磁盘缓存降级
│   └── pdf_tools.js   # PDF 压缩任务：上传、Ghostscript 压缩、进度与下载
├── public/            # 前端（React + Babel，无构建）
│   ├── index.html     # 样式系统（4 皮肤 × 2 主题）+ 页面入口
│   ├── api.js         # fetch 封装
│   ├── app.jsx        # 主应用与登录态
│   ├── auth.jsx       # 登录/注册页
│   ├── chat.jsx       # AI 对话 + AI 设置弹窗
│   ├── components.jsx # 顶栏/侧边栏/收藏卡片等
│   ├── prompts.jsx    # 提示词卡片/详情/添加（含图片压缩）
│   ├── tools.jsx      # 工具箱：时间戳 / PDF 压缩 / 密码等
│   ├── data.jsx       # 本机偏好与静态数据
│   └── icons.jsx      # SVG 图标库
├── scripts/mock_ai.js # 本地模拟 AI 接口（离线自测用：node scripts/mock_ai.js）
├── data/app.db        # SQLite 数据库（运行时生成）
└── designs/           # 早期设计原型（baoyu-design 产出，保留存档）
```

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register · /api/login · /api/logout | 注册 / 登录 / 退出 |
| GET | /api/me | 当前用户与 AI 配置状态 |
| GET / POST / DELETE | /api/favorites(/:id) | 收藏增删查 |
| GET / POST / PUT / DELETE | /api/prompts(/:id) | 灵感增删改查（PUT 支持部分更新，URL 自动规范化） |
| GET | /api/prompts/export | 全部灵感 JSON 导出 |
| GET | /api/feed/sources | 信息流来源列表（含分类） |
| GET | /api/feed/:id | 拉取指定来源条目（代理 RSS + 缓存降级） |
| POST / GET | /api/tools/pdf-compress(/:id) | PDF 压缩任务创建与进度查询 |
| GET | /api/tools/pdf-compress/:id/download | 下载压缩后的 PDF |
| GET / PUT | /api/ai-config | AI 配置（Key 只回传掩码） |
| POST | /api/ai/chat | 多轮对话转发（一次性返回） |
| POST | /api/ai/chat/stream | 多轮对话转发（SSE 流式） |

## 后续优化建议

- 对话历史入库，支持多个会话存档
- 信息流接入更多来源（综合热榜、设计、财经等，每个标分类）
- 灵感库 JSON 导入（与导出配对，换设备迁移）
- 部署到服务器供多人通过网络访问（加 HTTPS 与速率限制）

> 注：信息流的服务端拉取需要运行 server 的机器能直连来源站点（如 AI HOT）。若你的网络需代理才能访问某来源，给 Node 配置代理后即可；拉取失败时会自动回退到磁盘缓存的上次内容。
