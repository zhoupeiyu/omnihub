# 万象台 OmniHub

一个支持**多用户**的「个人聚合主页」应用：网站收藏 + 提示词库 + AI 对话 + 信息流 + 工具箱。
每个用户注册自己的账号，数据互相隔离，并可配置**自己的 AI API Key** 来使用 AI 对话。

技术上零第三方依赖：后端是 Node.js 原生 HTTP + 内置 SQLite（`node:sqlite`），前端是 React（CDN 加载，浏览器内 Babel 转译），**不需要 npm install，不需要构建**。

## 如何启动

要求 Node.js ≥ 22.5（你机器上是 v25，满足）：

```bash
cd /Users/zhoupeiyu/Path/playground/web/omnihub
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

### TypeSafe 收件箱预分类

新收录的单条内容会先保存原文，再由 TypeSafe Jev 建议存为提示词、资源或知识。判断不清晰、密钥不可用或服务超时时，内容仍留在收件箱，用户可以手动选类型。已有条目可在详情里点击「TypeSafe 判断」重新分析。最终分发仍由用户确认；批量导入暂不自动调用 TypeSafe。

服务端默认读取 `~/.config/typesafe-ai/api-key`，文件权限需仅允许所有者访问（如 `0600`）。也可以设置 `TYPESAFE_API_KEY_FILE` 指向另一个私有密钥文件，或通过 `TYPESAFE_API_KEY` 提供密钥。它与「AI 设置」里的个人聊天 Key 分开，密钥不会返回浏览器。判断时会把该条内容的标题、网址和正文前 4000 个字符发给 TypeSafe；不要把不应外发的内容放进需要自动判断的收件箱。

`POST /api/inbox/:id/analyze` 可对待处理条目重新判断。返回的 `aiType` 只是建议，`aiConfidence` 表示答案分布的集中程度，不能当成分类准确率。当前 `0.5` 的建议门槛需要用自己的已标注内容继续校准。

### 导入 X 收藏

X 收藏按“全量导出、分类与同主题分组、图片归档、核对、入站”的顺序处理。旧导出保留在原目录；新的导出写入独立目录，支持从已保存的分页续跑。导出脚本要求设置本轮费用上限，并按每条 $0.015 保守限制请求数量：按普通帖子读取 $0.005，加上展开作者资料时可能产生的用户读取 $0.010 估算。符合条件的本人收藏读取可能更便宜。这个数值是本地估算，实际费用和开发者账户的硬性消费限制以 [X 开发者控制台](https://docs.x.com/x-api/getting-started/pricing)为准。

```bash
node scripts/export-x-bookmarks.mjs --user-id <X 用户 ID> --max-usd <本轮上限> --out <新的绝对目录>
node scripts/organize-x-bookmarks.mjs --raw <导出目录>/bookmarks.raw.jsonl --out <整理目录> --previous <旧导出目录>/bookmarks.raw.jsonl
node scripts/archive-x-media.mjs --organized <整理目录>/bookmarks.organized.jsonl --out <整理目录>
node scripts/render-x-review.mjs --organized <整理目录>/bookmarks.organized.jsonl --media-manifest <整理目录>/media-manifest.json --out <整理目录>/分类复核.md
```

不使用付费开发者 API 时，也可用 [xarchive](https://github.com/sytelus/xarchive) 在已登录的 X 浏览器中执行 **Full refresh**，下载 **latest snapshot**。它通过 X 网页内部接口读取，需授予扩展 X 站点、Cookie 和请求头访问权；内部接口或 X 返回范围变化时，完整性仍需核对。OmniHub 的转换脚本只接受账号匹配、收藏分页完成的 full snapshot；累计档案或中断快照不会被标为全量。

```bash
node scripts/convert-xarchive.mjs --archive <latest snapshot JSON> --user-id <X 用户 ID> --out <新的绝对目录>
node scripts/organize-x-bookmarks.mjs --raw <新目录>/bookmarks.raw.jsonl --out <整理目录> --previous <旧导出目录>/bookmarks.raw.jsonl
```

若 Full refresh 因 `pagination_guard` 停止，快照只能按 `partial_xarchive_scan` 保全和整理，不能标为全量。显式加 `--allow-partial` 转换，再按 `--coverage partial_xarchive_scan` 整理；导入时同样需要 `--allow-partial` 和对应 `manifest.json`。后续真正完整的快照会按帖子 ID 原位升级这些记录。

浏览器页面只采集到一部分时，可在本地整理这份快照。转换脚本按帖子 ID 与旧导出对照，只用旧文件补齐匹配帖子的正文和媒体；旧文件里未在本轮页面出现的帖子单独列在 `scan-manifest.json`，不计入当前收藏。X Article 卡片只有标题和摘要，折叠长文也不能视为全文。这些条目会进入待核对清单。以下命令只读取本地文件，分类阶段会把可用文字发送给 TypeSafe，不再访问 X。

```bash
node scripts/convert-x-ui-scan.mjs --scan <页面快照 JSON> --historical <旧 raw.jsonl> --account <X 用户名> --out <新的绝对目录>
node scripts/organize-x-bookmarks.mjs --raw <新目录>/bookmarks.raw.jsonl --coverage partial_ui_scan --out <整理目录>
node scripts/render-x-review.mjs --organized <整理目录>/bookmarks.organized.jsonl --media-manifest <旧媒体目录>/media-manifest.json --out <整理目录>/分类复核.md
```

`partial_ui_scan` 可以作为明确标记的部分批次先导入收件箱，网站会显示覆盖范围和正文缺口，不能把它当作全量收藏。后续导入完整批次时，同一帖子 ID 会补全原记录，不会再增加一条。新图片和视频预览图只保留页面读到的源链接；没有下载成功的媒体不标为本地归档。

若要由本机脚本导入当前部分批次，先用 `--dry-run` 核对账号、范围和条数，再去掉该参数执行。脚本要求目标 OmniHub 账号已经存在且有收件箱权限；写入前会在本机 `data/backups/` 保存数据库快照。

```bash
node scripts/import-x-organized-local.mjs --file <整理目录>/bookmarks.organized.jsonl --username <OmniHub 账号> --allow-partial --scan-manifest <页面转换目录>/scan-manifest.json --account <X 用户名> --dry-run
```

`manifest.json` 的 `complete` 为 `true` 且导出数量与解析数量一致后，整理脚本才会运行。TypeSafe Jev 分别建议资产类型和浏览主题；当前浏览主题固定为八类。同一作者有多条收藏时，再判断它们是否属于同一具体事项或连续系列。内部 `groupId` 只用来串联相关原帖，单帖不会成为一个新的浏览主题。复核页先按浏览主题、再按资产类型排列；每条帖子仍保留原文、作者 ID、来源、外链和媒体。整理结果包括 `bookmarks.organized.jsonl`、`groups.json`、`needs-review.jsonl` 与数量摘要。判断不明确的条目留待核对。Jev 目前只读取文字和图片说明，不能判断图片画面；效果图本身另行归档。

旧导出可用 `--snapshot` 单独整理，用来提前核对分类与图片。它会被明确标为历史快照；网站导入接口接受完整批次，以及明确选择导入的部分页面采集批次，不接受历史快照。

图片归档脚本把 X 返回的图片或视频预览图下载到整理目录，记录校验和；失败项会列在 `media-manifest.json`，不能当作已经保存。现阶段网站展示的是 X 媒体链接，归档的本地图片文件尚未上传到网站的媒体存储，因此网站中的图片仍依赖原链接可访问。

核对完成后，登录 OmniHub，在「收件箱」选择 `bookmarks.organized.jsonl`。页面按请求大小分批上传，以帖子 ID 去重；重复上传会跳过已导入的记录。X 收藏有独立视图，可按 TypeSafe 建议类型和主题筛选；同一作者的同主题内容连续显示。提示词转入资料库时，保留原文、来源链接和媒体记录，并显示可访问的效果图。网站不接收 X 访问令牌，也不会在批量导入时重新调用 TypeSafe。

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
- PDF 压缩走本机服务端 Ghostscript，支持高压缩 / 推荐 / 高质量三档、压缩进度、压缩率和下载保存；单文件默认上限 300MB，部署机器需安装 `ghostscript` 或设置 `GS_PATH`
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
