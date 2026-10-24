# OmniHub 第二大脑改造方案

> 2026-07-10 · V2 产品与实施方案。目标：把 OmniHub 从几个独立模块组成的聚合主页，改造成一套可以持续处理个人信息的 AI 资产工作台。

## 一、当前判断

OmniHub 已经具备信息流、收藏、提示词、AI 对话和工具箱，但这些能力目前彼此独立：

- 信息流看完即走，不能直接沉淀。
- 收藏库和提示词库主要依赖手工录入。
- AI 对话可以整理内容，但结果不能直接回写资产库。
- 收藏库里的“AI 工具 / 学习资料 / 开发工程”仍是前端关键词推断，不是真实的数据字段。
- 页面开始使用“资产、提炼、工作流”等语言，但还没有形成对应的数据流。

因此下一阶段不继续增加首页统计、说明卡片和装饰性工作流，而是先完成一条最短闭环：

```text
收进来 → 判断是什么 → 存到正确位置 → 以后能搜到 → 再次使用
```

## 二、产品边界

当前产品按私人工作台设计：

- `zane` 为完整功能白名单账号。
- 游客和非白名单账号只访问公开信息流。
- 不以多人协作、团队权限、公开内容社区为近期目标。
- 所有 AI 提炼都保留原始来源，不让生成内容覆盖原文。

完成标准不是“增加了收件箱页面”，而是任意一条链接或文字可以在一分钟内完成收录、分发和再次找到。

## 三、核心工作流

```text
输入                         处理                    沉淀                  使用
────                         ────                    ────                  ────
快速粘贴链接/文字   ┐
X 书签导入          ├──→  收件箱  ──→ 人工确认 ──→  提示词资产  ──→ 复制 / 试跑
信息流一键收藏      ┤       AI 预分类               资源资产    ──→ 一键打开
浏览器剪藏          ┘       摘要与字段提取           知识资产    ──→ 搜索 / 回顾
                                └──────────────→  忽略并留痕
```

设计原则：AI 做摘要、分类和字段提取，人只负责确认。AI 失败时不阻塞收录，原始内容必须完整进入收件箱。

## 四、信息架构

### 主导航

```text
收件箱  12       默认首页，数字为待处理数量
信息流           浏览外部内容，可一键存入收件箱
资产库           提示词 / 资源 / 知识三个内部视图
AI 提炼台        处理内容，并把结构化结果回写资产库

──────────
工具箱           放在侧栏底部，降低视觉权重
设置
```

不再让提示词、资源、知识、AI 对话和工具箱全部平级。提示词、资源和知识是同一种“沉淀结果”的不同类型，应统一收进资产库。

### 默认首页

默认打开收件箱，不额外建设一个仪表盘首页。收件箱本身就是首页，也是每天最需要处理的地方。

```text
┌────────────────────────────────────────────────────────┐
│ 粘贴链接、文字或提示词……                    [快速收录] │
├────────────────────────────────────────────────────────┤
│ 待处理 12   提示词 4   资源 3   知识 2   未识别 3      │
├──────────────────────────┬─────────────────────────────┤
│ 原始内容列表              │ 当前内容详情                │
│                          │                             │
│ 来源、作者、正文、图片     │ AI 摘要                     │
│ AI 建议类型与置信度        │ 建议分类：提示词             │
│                          │ 提取出的标题、正文、链接      │
│                          │                             │
│                          │ [存为提示词] [改分类] [忽略] │
└──────────────────────────┴─────────────────────────────┘
```

收件箱每条内容只有一个主要目标：决定去向。复杂编辑放到分发后的资产详情里，不在收件箱重复完成全部整理工作。

## 五、模块设计

### 1. 收件箱

#### 输入

- 顶部快速收录支持粘贴 URL 或纯文本。
- X 书签、信息流、浏览器剪藏统一进入同一张 `inbox` 表。
- 按 `user_id + source + external_id` 去重；手动内容以内容哈希辅助去重。
- URL 收录时尝试抓取标题、摘要和最终跳转地址，失败也要保存用户原始输入。

#### 列表

每条显示来源、作者、时间、正文前几行、首张图片、AI 建议分类和处理状态。筛选只保留：

- 全部待处理
- 提示词
- 资源
- 知识
- 未识别

批量操作仅用于“批量忽略”和“批量确认同一分类”，避免做成复杂表格管理器。

#### 详情与分发

详情右侧展示原始证据和 AI 提取结果。主操作根据建议类型动态显示：

- `存为提示词`
- `存为资源`
- `存为知识`
- `忽略`

点击保存时弹出精简确认表单；成功后在一个数据库事务中创建资产、更新收件箱状态并记录 `dispatched_to`。已分发条目可以跳转到最终资产。

### 2. 资产库

资产库顶部只保留紧凑标题、搜索、类型标签和新增按钮，不再为每个子页面重复英文眉题、大段介绍和统计卡。

```text
资产库  86
[提示词 32] [资源 41] [知识 13] [待完善 8]       搜索…  + 新增
```

#### 提示词资产

卡片优先展示结果和用途，而不是大段正文：

- 效果图或参考图；多图显示 `+N`。
- 标题和一句话用途。
- 类型、模型、来源、状态。
- 复制、试跑、详情。

详情抽屉顺序固定为：

1. 效果与参考图。
2. 原始来源、作者、原文和链接。
3. 原始提示词与优化版提示词。
4. 变量、推荐模型和参数。
5. 实测结果、失败原因和复现技巧。

状态统一为 `待测试 / 好用 / 需改写 / 已归档`。AI 可以生成优化版，但不能覆盖原始提示词。

#### 资源资产

不再通过前端正则猜测资源类型，类型、标签和来源必须真实入库。

- 类型：网站 / 工具 / 开源项目 / 课程·文章。
- 卡片：图标、名称、一句话用途、类型、标签、来源、收藏状态。
- GitHub 项目额外显示 `owner/repo`，后续再考虑仓库数据抓取。
- “待完善”指缺少用途、类型或标签的真实数据状态。

#### 知识资产

用于保存技巧、方法论和经验，不存放纯链接或提示词。

- 卡片显示标题、两三行摘要、标签和来源。
- 详情使用 Markdown 展示完整正文。
- 支持从收件箱分发、从 AI 提炼结果保存、手动新建。
- 第一版不做双向链接、知识图谱和复杂层级。

### 3. AI 提炼台

AI 提炼台的输出必须可操作，不能只生成一段聊天回复。

用户可以粘贴原文、链接内容或从收件箱发送一条素材。AI 返回结构化结果：

```text
建议类型：提示词资产

标题：Seedance 多镜头转场模板
用途：把普通分镜改成连贯的电影感镜头
模型：Seedance
标签：视频、转场、分镜
原始提示词：……
优化版提示词：……

[保存到提示词库] [改为知识卡片] [继续修改]
```

保存按钮直接调用资产 API，并附带来源信息。普通自由对话仍然保留，但预设模板统一改成结构化任务，不再只是往输入框追加一段说明文字。

### 4. 信息流

保留现有 AI HOT 信息流和筛选能力，只增加一个关键动作：`存入收件箱`。

- 保存标题、摘要、原文链接、来源和发布时间。
- 已保存条目显示状态，防止重复收录。
- 信息流不直接弹出提示词或知识编辑表单，统一经过收件箱。

### 5. 工具箱

工具箱保留现有七个工具，但降为辅助入口：

- 删除顶部“整理资料 / 开发辅助 / 决策与专注”等说明性工作流卡片。
- 直接展示工具，常用操作优先。
- PDF 压缩继续作为主要工具，并保留文件信息、进度、压缩率和下载闭环。
- 工具结果后续可以增加“复制到收件箱”，但不进入第一阶段。

## 六、视觉与交互原则

- 页面标题使用正常工作台字号，不使用营销落地页式巨型标题。
- 删除重复英文眉题和产品理念文案，让数据和动作成为第一视觉信号。
- 统计只出现在收件箱总览，不在每个资产页重复出现。
- 页面区块保持无框布局；卡片只用于单条资产、素材和工具，不做卡片套卡片。
- 所有主要操作固定使用同一个强调色；状态色只表达待处理、成功、警告和归档。
- 卡片圆角不超过 8px，控件尺寸稳定，内容变化不能让网格跳动。
- 桌面端收件箱采用列表 + 详情双栏；移动端改为列表进入详情，不强行压缩双栏。
- 动效只表达状态变化：收录成功、分发完成、列表移除、抽屉开合。取消纯装饰性循环动效。

## 七、数据模型

### 收件箱

```sql
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'manual',       -- x / feed / manual / web
  external_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',            -- JSON
  links TEXT NOT NULL DEFAULT '[]',            -- JSON
  metrics TEXT NOT NULL DEFAULT '{}',          -- JSON
  ai_type TEXT NOT NULL DEFAULT '',            -- prompt / resource / knowledge / noise
  ai_confidence REAL NOT NULL DEFAULT 0,
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_extract TEXT NOT NULL DEFAULT '{}',       -- JSON
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / dispatched / ignored
  dispatched_to TEXT NOT NULL DEFAULT '',      -- prompts:12 / favorites:8 / knowledge:3
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, source, external_id)
);
```

### 知识资产

```sql
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_author TEXT NOT NULL DEFAULT '',
  source_content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 资源资产迁移

```sql
ALTER TABLE favorites ADD COLUMN type TEXT NOT NULL DEFAULT 'site';
ALTER TABLE favorites ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE favorites ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE favorites ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE favorites ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
```

### 提示词资产迁移

```sql
ALTER TABLE prompts ADD COLUMN kind TEXT NOT NULL DEFAULT 'creative';
ALTER TABLE prompts ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN prompt_text_raw TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN prompt_text_clean TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN variables TEXT NOT NULL DEFAULT '{}';
ALTER TABLE prompts ADD COLUMN media TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prompts ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN source_author TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN source_content TEXT NOT NULL DEFAULT '';
ALTER TABLE prompts ADD COLUMN status TEXT NOT NULL DEFAULT 'untested';
ALTER TABLE prompts ADD COLUMN rating INTEGER NOT NULL DEFAULT 0;
```

所有迁移继续使用现有 `schema_migrations` 机制。分发操作必须在事务内完成，防止资产创建成功但收件箱仍显示待处理。

## 八、API 设计

第一阶段最小接口：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/inbox` | 列出待处理内容，支持类型和状态筛选 |
| POST | `/api/inbox` | 快速收录文本或 URL |
| POST | `/api/inbox/import` | 外部脚本批量导入，按来源 id 去重 |
| GET | `/api/inbox/:id` | 查看原始内容和 AI 提取结果 |
| POST | `/api/inbox/:id/dispatch` | 创建目标资产并更新分发状态 |
| POST | `/api/inbox/:id/ignore` | 忽略但保留记录 |
| GET / POST | `/api/knowledge` | 知识资产列表与新建 |
| GET / PUT / DELETE | `/api/knowledge/:id` | 知识资产详情、编辑和删除 |

第二阶段增加：

- `POST /api/inbox/:id/analyze`：AI 分类和字段提取。
- `POST /api/ai/extract`：把任意输入转成结构化资产草稿。
- `POST /api/assets/from-ai`：保存 AI 提炼结果并保留来源。

第三阶段增加统一搜索 API，不让前端分别请求三个模块后拼接结果。

## 九、X 书签与输入源

自动化不是第一阶段前置条件。先让手动粘贴和手动分发闭环稳定，再接同步脚本。

```text
fetch-bookmarks.sh
        │ bookmarks.posts.jsonl
        ▼
sync-to-omnihub.sh
        │ POST /api/inbox/import
        ▼
收件箱
        │ 可选 AI 预分类
        ▼
人工确认并分发
```

- AI 分类失败不阻塞导入。
- 图片、原帖正文、展开后的链接和作者信息全部保留。
- 首次导入 99 条存量时允许先不调用 AI，验证去重和分发后再批量分析。
- 定时同步、信息流收藏、bookmarklet 都复用同一个导入协议。

## 十、实施顺序与验收

### P1：手动闭环

内容：

- `inbox`、`knowledge` 表及资产字段迁移。
- 快速收录文本和 URL。
- 收件箱列表、详情、分类、忽略和分发。
- 资产库统一入口及提示词 / 资源 / 知识三个视图。
- 信息流增加“存入收件箱”。

验收：

- 粘贴一条文本和一条 URL 都能进入收件箱。
- 每条内容可以分别存为提示词、资源或知识。
- 分发后能跳转到目标资产，刷新页面状态不丢失。
- 重复内容不会生成重复资产。
- 整个流程不依赖 AI，也能完整使用。

### P2：AI 提炼与回写

内容：

- AI 预分类、摘要、置信度和字段提取。
- AI 提炼台结构化输出。
- 一键保存到三类资产。
- 提示词保留原始版和优化版。

验收：

- AI 失败时素材仍可人工处理。
- AI 输出能直接生成合法资产，而不是要求用户复制粘贴。
- 所有生成内容都能追溯原文和来源链接。

### P3：统一搜索

内容：

- SQLite FTS5 索引提示词、资源、知识和收件箱。
- `Command + K` 全局搜索。
- 搜索结果按资产类型分组，可直接打开详情。

验收：

- 标题、正文、摘要、标签和来源内容都可召回。
- 新增、编辑、删除资产后索引同步更新。
- 不知道资产被分到哪里时仍能在一次搜索中找到。

### P4：自动输入

内容：

- X 书签存量和增量同步。
- macOS 定时任务。
- 浏览器 bookmarklet。
- 其他输入源沿用相同导入协议。

验收：

- 重复执行同步不产生重复内容。
- 单条失败不阻塞整个批次。
- 同步结果能显示新增、跳过和失败数量。

## 十一、明确暂不做

- 独立仪表盘首页。
- 知识图谱、双向链接和复杂目录树。
- 团队协作、分享和多级权限。
- AI 全自动决定最终去向。
- 在手动闭环稳定前接入大量内容源。
- 为每个页面继续增加宣传式 Hero、统计卡和说明卡。

先完成 P1。P1 跑通以后，OmniHub 才真正从“功能集合”变成一套个人信息处理系统；后面的 AI、搜索和自动同步都是在这条主流程上增效。
