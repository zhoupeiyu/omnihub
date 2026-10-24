// Reviewed reading guides, separate from original collection records and classifications.
// Pin documentation and media to the version that was actually checked.
const toonflowCommit = 'ec8f54597bf6e6114ed56b832f9052cd6f735311';
const superpowersCommit = '8ca22dba9a94f28898bbce59f2537ff4d87c747d';
const toonflowRoot = `https://github.com/HBAI-Ltd/Toonflow-app/blob/${toonflowCommit}`;
const guides = new Map([
  ['hbai-ltd/toonflow-app', {
    checkedAt: '2026-10-01', tested: false,
    sourceUrl: `${toonflowRoot}/README.md`,
    summary: '在一张画布里组织剧本、角色和镜头，调用自己的模型生成图片与视频。',
    intro: '适合把短剧或短视频的剧本、角色素材和镜头放在一起制作。项目可以保存在本地；生成内容仍需要连接模型服务。',
    media: [
      {url:'/assets/repository-guides/toonflow-canvas.webp', alt:'Toonflow 创作画布与 AI 助手', sourceUrl:`${toonflowRoot}/docs/screenshots/canvasLight.png`},
      {url:'/assets/repository-guides/toonflow-assets.webp', alt:'角色、场景与道具资产', sourceUrl:`${toonflowRoot}/docs/screenshots/assetCanvas.png`},
      {url:'/assets/repository-guides/toonflow-setup.webp', alt:'首次启动与模型配置', sourceUrl:`${toonflowRoot}/docs/screenshots/quickStart.png`},
    ],
    requirements: '准备 Windows 或 Apple Silicon Mac，以及可用的图像／视频模型服务。已有 API 可以自行配置，不必为了浏览界面先购买模型额度。',
    platforms: [{label:'桌面客户端', steps:[
      {title:'安装桌面端', text:'在官方发布页下载对应系统的安装包。Mac 将应用拖入“应用程序”；Windows 按安装器操作。如系统拦截，先核实下载来源，不关闭系统安全保护。', link:{label:'下载官方客户端',url:'https://github.com/HBAI-Ltd/Toonflow-app/releases'}},
      {title:'接入自己的模型', text:'首次打开时选择“添加私有提供商”，按提供商要求填写 API 地址、Key 和模型。也可以先选“稍后配置”浏览界面。Key 只填在本地应用中，不放进提示词或分享截图。'},
    ]}],
    steps: [
      {title:'从一个镜头开始', text:'建立项目，在画布中准备角色或场景参考图，再使用图片／视频生成节点。先检查一张图或一个短镜头的输出，确认模型连接与素材路径，再扩展完整分镜。'},
    ],
    example: {
      prompt:'先做一个咖啡店的日景镜头。准备同一位角色的参考图，生成中景构图；确认人物一致后，再尝试生成一段短视频。',
      result:'先得到画布中的图片素材，再把选定的参考素材用于视频节点。官方截图展示了这些操作界面；具体生成质量与耗时取决于所选模型。',
    },
    alternative: {label:'我想用 Docker 部署', steps:[
      {title:'准备环境并启动', text:'先安装 Git、Docker Engine 和 Docker Compose，在终端运行以下命令。官方 Compose 仅绑定本机 127.0.0.1 的 3000 端口。', code:'git clone https://github.com/HBAI-Ltd/Toonflow-app.git\ncd Toonflow-app\ndocker compose up -d --build'},
      {title:'打开工作台', text:'浏览器打开 http://127.0.0.1:3000，选择 myProject 工作目录，再在页面配置模型。初次构建需要下载依赖，耗时取决于网络和机器。'},
    ]},
    cautions: [
      '图片、视频和语言模型可能分别计费，先确认服务商价格与调用额度。安装应用不等于模型调用免费。',
      '服务器版没有独立登录鉴权，不要把 3000 端口直接暴露到公网。远程使用应通过 SSH 隧道，或有认证的反向代理。',
      'Docker 项目保存在 toonflowData 数据卷中。备份时保留整个卷；不要执行带 -v 的 down 命令，以免删除项目。',
    ],
    references: [
      {label:'官方中文教程', url:'https://qcn7xdsqgc4z.feishu.cn/docx/RXFqdgR2Xo0dXZxGfd0cZCGgnwf'},
      {label:'官方 Compose 配置', url:`${toonflowRoot}/compose.yaml`},
      {label:'作者成片示例', url:'https://github.com/user-attachments/assets/2d9fddac-dfdf-4640-b030-b09d7f7287e9'},
    ],
  }],
  ['obra/superpowers', {
    checkedAt: '2026-10-01', tested: false,
    sourceUrl:`https://github.com/obra/superpowers/blob/${superpowersCommit}/README.md`,
    summary:'让编程 Agent 先澄清需求、给出设计，再按计划写代码、测试和审查。',
    intro:'适合给已有的编程 Agent 加一套开发流程。你仍在 Claude Code、Codex 或 Cursor 中工作；插件会在合适的任务里调用对应技能。',
    media:[],
    requirements:'需要已经可用的编程 Agent 及其模型服务。每个客户端要分别安装；给 Claude Code 装好后，Codex 不会自动拥有它。',
    platforms:[
      {label:'Claude Code', steps:[
        {title:'在 Claude Code 中安装', text:'在客户端的会话输入框执行官方市场安装命令，按提示完成安装。这里仅复制命令，不会替你安装。', code:'/plugin install superpowers@claude-plugins-official'},
      ]},
      {label:'Codex App', steps:[
        {title:'从插件目录安装', text:'按仓库说明，打开左侧 Plugins，在 Coding 分类找到 Superpowers，点击 + 并按提示安装。若当前客户端没有此条目，先核对客户端版本和官方目录，不改用未经核验的安装脚本。', link:{label:'查看仓库的安装说明',url:`https://github.com/obra/superpowers/blob/${superpowersCommit}/README.md#codex-app`}},
      ]},
      {label:'Cursor', steps:[
        {title:'在 Agent 对话中安装', text:'在 Cursor 的 Agent 输入框运行命令，或在插件市场搜索 superpowers。', code:'/add-plugin superpowers'},
      ]},
    ],
    steps:[
      {title:'在测试项目中新开会话', text:'先选一个范围明确的小功能。安装完成后新开会话，再描述需求；暂时不要用重要的未备份项目来验证流程。'},
      {title:'先确认设计，再进入实现', text:'按官方工作流，Agent 会先梳理需求与约束，把设计拆开与你确认，再给出实现计划。实现阶段强调测试先行，并包含代码审查。'},
    ],
    example:{
      prompt:'帮我做一个 React 待办列表，支持新增任务和标记完成。先澄清需求并给出设计，等我确认后再开始实现。',
      result:'应该先看到问题澄清和设计说明，确认后才进入计划、实现与测试。这里是根据官方流程整理的预期行为，不是本站的实测对话记录。',
    },
    cautions:[
      '插件会影响 Agent 的工作方式，不会替你配置模型账号或提供免费模型额度。',
      '启动子任务、测试或修改文件仍受客户端权限与项目规则约束。安装插件不代表允许自动发布或修改生产数据。',
      '如果一上来就写代码，先检查插件是否在当前客户端启用、会话是否重新启动；不要只凭回答语气判断已经生效。',
    ],
    references:[],
  }],
]);

export function getRepositoryGuide(key) {
  const normalized = normalizeGuideKey(key);
  return normalized ? guides.get(normalized) || null : null;
}

// Guide files are an optional, derived reading layer.  They never replace the
// repository record or its original links.  Keep this validation here (rather
// than trusting a JSON file served by the same deployment) because the JSON is
// generated in a separate batch job.
const GUIDE_KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const LOCAL_MEDIA = /^\/assets\/(?:repository-guides|build-[a-f0-9]{16}\/repository-media)\/(?:[a-z0-9-]+|media-[a-f0-9]{12,64})\.webp$/;
const normalizeGuideKey = key => typeof key === 'string' && GUIDE_KEY.test(key.toLowerCase()) ? key.toLowerCase() : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const safeHttps = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const safeLink = value => {
  if (!value || typeof value !== 'object') return null;
  const url = safeHttps(value.url);
  const label = text(value.label);
  return url && label ? {url,label} : null;
};
const safeSteps = value => Array.isArray(value) ? value.map(step => {
  if (!step || typeof step !== 'object') return null;
  const title = text(step.title), body = text(step.text);
  const code = typeof step.code === 'string' && step.code.trim() ? step.code.trim() : '';
  if (!title || !body) return null;
  return {title, text:body, ...(code ? {code} : {}), ...(safeLink(step.link) ? {link:safeLink(step.link)} : {})};
}).filter(Boolean) : [];
const safePlatforms = value => Array.isArray(value) ? value.map(platform => {
  const label = text(platform?.label);
  const steps = safeSteps(platform?.steps);
  return label && steps.length ? {label,steps} : null;
}).filter(Boolean) : [];
const safeMedia = value => Array.isArray(value) ? value.map(item => {
  const url = typeof item?.url === 'string' && LOCAL_MEDIA.test(item.url) ? item.url : '';
  const alt = text(item?.alt);
  const sourceUrl = safeHttps(item?.sourceUrl);
  return url && alt && sourceUrl ? {url,alt,sourceUrl,animated:item.animated === true} : null;
}).filter(Boolean) : [];

export function validateRepositoryGuide(value, expectedKey) {
  const key = normalizeGuideKey(value?.key);
  if (!key || key !== normalizeGuideKey(expectedKey) || value?.schemaVersion !== 1) return null;
  if (!['ready','partial','unavailable'].includes(value.status)) return null;
  const sourceUrl = safeHttps(value.sourceUrl);
  const checkedAt = typeof value.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.checkedAt) ? value.checkedAt : '';
  const summary = text(value.summary), intro = text(value.intro), requirements = text(value.requirements);
  if (!sourceUrl || !checkedAt || value.tested !== false) return null;
  if (value.status !== 'unavailable' && (!summary || !intro)) return null;
  const platforms = safePlatforms(value.platforms);
  const steps = safeSteps(value.steps);
  const references = Array.isArray(value.references) ? value.references.map(safeLink).filter(Boolean) : [];
  const media = safeMedia(value.media);
  const reason = text(value.reason);
  // A "ready" guide has actual cited instructions.  Partial/unavailable
  // records are still useful, but must make their limitation visible.
  if (value.status === 'ready' && !platforms.length && !steps.length) return null;
  if ((value.status === 'partial' || value.status === 'unavailable') && !reason) return null;
  const example = value.example && typeof value.example === 'object' && text(value.example.prompt) && text(value.example.result)
    ? {prompt:text(value.example.prompt), result:text(value.example.result)} : null;
  return {
    schemaVersion:1, key, status:value.status, ...(reason ? {reason} : {}), checkedAt, tested:false,
    sourceUrl, summary, intro, requirements, platforms, steps, example,
    cautions:Array.isArray(value.cautions) ? value.cautions.map(text).filter(Boolean) : [],
    references, media, mediaReferences:Array.isArray(value.mediaReferences) ? value.mediaReferences.map(safeLink).filter(Boolean).slice(0,12) : [], ...(text(value.generatedBy) ? {generatedBy:text(value.generatedBy)} : {}),
  };
}

const guideLoads = new Map();
const missingGuideKeys = new Set();
const guideAssetUrl = key => {
  const [owner,name] = key.split('/');
  const file = `${owner}~${name}.json`;
  try {
    const moduleUrl = new URL(import.meta.url);
    if (/^\/assets\/build-[a-f0-9]{16}\//.test(moduleUrl.pathname)) return new URL(`repository-media/${file}`, moduleUrl).href;
  } catch { /* Node tests and older browsers use the public path below. */ }
  return `/assets/repository-guides/${file}`;
};

export function loadRepositoryGuide(key, {signal, fetchImpl = globalThis.fetch} = {}) {
  const normalized = normalizeGuideKey(key);
  if (!normalized) return Promise.resolve(null);
  const existing = guides.get(normalized);
  if (existing) return Promise.resolve(existing);
  if (missingGuideKeys.has(normalized)) return Promise.resolve(null);
  if (typeof fetchImpl !== 'function') return Promise.resolve(null);
  // Do not attach a caller's abort signal to the shared network request: a
  // quick drawer switch should not discard a guide another drawer may need.
  if (!guideLoads.has(normalized)) {
    const request = new AbortController();
    let timeout;
    const deadline = new Promise(resolve => {
      timeout = setTimeout(() => { request.abort(); resolve(null); }, 12_000);
    });
    const pending = Promise.race([
      Promise.resolve().then(() => fetchImpl(guideAssetUrl(normalized), {signal:request.signal})),
      deadline,
    ])
      .then(response => {
        if (response?.status === 404) missingGuideKeys.add(normalized);
        return response?.ok ? response.json() : null;
      })
      .then(payload => validateRepositoryGuide(payload, normalized))
      .then(guide => { if (guide) guides.set(normalized, guide); return guide; })
      .catch(() => null)
      .finally(() => { clearTimeout(timeout); guideLoads.delete(normalized); });
    guideLoads.set(normalized,pending);
  }
  const pending = guideLoads.get(normalized);
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const finish = value => { signal.removeEventListener('abort', onAbort); resolve(value); };
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, {once:true});
    pending.then(finish);
  });
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const externalLink = ({url,label}) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return `<a class="inline-link" href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
  } catch { return ''; }
};
const codeBlock = (code, label) => `<div class="guide-code"><div class="guide-code-bar"><span>${escape(label)}</span><button type="button" data-guide-copy aria-label="复制${escape(label)}">复制</button></div><pre><code>${escape(code)}</code></pre><span class="guide-copy-status" role="status"></span></div>`;
const stepsMarkup = (steps, start = 1) => `<ol class="guide-steps" start="${start}">${steps.map(step => `<li><h4>${escape(step.title)}</h4><p>${escape(step.text)}</p>${step.code ? codeBlock(step.code,'原文代码') : ''}${step.link ? externalLink(step.link) : ''}</li>`).join('')}</ol>`;

export function renderGuideInstallation(guide, index = 0) {
  const platform = guide?.platforms?.[index] || guide?.platforms?.[0];
  return platform ? stepsMarkup(platform.steps) : '';
}

const guideStatus = guide => {
  if (!guide.status || guide.status === 'ready') return '';
  const heading = guide.status === 'unavailable' ? '暂时无法核对使用方法' : '这份使用说明还不完整';
  return `<section class="detail-section guide-status guide-status-${escape(guide.status)}"><h3>${heading}</h3><p>${escape(guide.reason || '官方资料暂时不足，先保留原仓库介绍与入口。')}</p>${externalLink({url:guide.sourceUrl,label:'查看官方文档'})}</section>`;
};

const sourceAttribution = media => media.length ? '<p class="detail-hint">素材来自仓库官方文档，原始出处与许可说明见上方链接。</p>' : '';

export function renderRepositoryGuideMeta(guide, {readmeUrl = ''} = {}) {
  const checkedAt = guide?.checkedAt;
  const date = typeof checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkedAt)
    ? `<time datetime="${checkedAt}">核对 ${checkedAt}</time>` : '';
  return `${date}${externalLink({url:guide?.sourceUrl || readmeUrl,label:'官方文档'})}`;
}

export function renderRepositoryGuideSources(guide) {
  if (!guide) return '';
  const media = guide.media || [];
  const references = [...(guide.references || []), ...media.map(item=>({url:item.sourceUrl,label:item.alt}))];
  const unique = references.filter((item,index,items)=>item.url !== guide.sourceUrl && items.findIndex(other=>other.url === item.url) === index);
  return `<p class="detail-source-note">${guide.status === 'unavailable' ? '保留收藏介绍，官方用法暂不可用。' : `${guide.generatedBy ? 'AI ' : ''}整理自官方文档，未实测。`}</p>${unique.length ? `<div class="guide-reference-links">${unique.map(externalLink).join('')}</div>` : ''}${sourceAttribution(media)}`;
}

export function renderRepositoryGuide(guide, {introFallback = ''} = {}) {
  if (!guide) return '';
  const media = guide.media || [];
  const mediaReferences = guide.mediaReferences || [];
  const platforms = guide.platforms || [];
  const steps = guide.steps || [];
  const cautions = guide.cautions || [];
  const firstPlatformSteps = platforms[0]?.steps?.length || 0;
  const intro = guide.intro || introFallback;
  return `<div class="repository-guide">
    ${media.length || mediaReferences.length ? `<section class="detail-section guide-gallery"><div class="guide-section-heading"><h3>演示与说明</h3><span>${media.length ? `${media.length} 张 · 点击放大` : '原文素材'}</span></div>${media.length ? `<div class="guide-images">${media.map((item,index) => `<a class="guide-image${index === 0 ? ' guide-image-main' : ''}" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer" data-repo-media="${index}" aria-label="放大${escape(item.alt)}"><img src="${escape(item.url)}" alt="${escape(item.alt)}" loading="lazy" decoding="async">${item.animated ? '<b class="guide-animation-badge">动图</b>' : ''}<span title="${escape(item.alt)}">${escape(item.alt)}</span></a>`).join('')}</div>` : ''}${mediaReferences.length ? `<details class="guide-media-sources"><summary>${media.length ? '更多原文素材' : '查看原文演示与说明图'}</summary><div class="guide-reference-links">${mediaReferences.map(externalLink).join('')}</div></details>` : ''}</section>` : ''}
    ${guideStatus(guide)}
    <section class="detail-section guide-usage"><h3>${guide.status === 'unavailable' ? '仓库介绍' : '怎么用'}</h3>${intro ? `<p>${escape(intro)}</p>` : ''}${guide.requirements ? `<p class="guide-requirements"><strong>开始前</strong>${escape(guide.requirements)}</p>` : ''}
      ${platforms.length > 1 ? `<label class="guide-platform">使用客户端<select data-guide-platform aria-label="选择使用客户端">${platforms.map((platform,index) => `<option value="${index}">${escape(platform.label)}</option>`).join('')}</select></label>` : ''}
      ${platforms.length ? `<div data-guide-installation>${renderGuideInstallation(guide)}</div>` : ''}${steps.length ? stepsMarkup(steps,firstPlatformSteps + 1) : ''}
      ${guide.example ? `<div class="guide-example"><h4>示例任务 <span>本站整理</span></h4>${codeBlock(guide.example.prompt,'示例任务')}<p><strong>预期会看到</strong>${escape(guide.example.result)}</p></div>` : ''}
      ${guide.alternative ? `<details class="guide-alternative"><summary>${escape(guide.alternative.label)}</summary>${stepsMarkup(guide.alternative.steps)}</details>` : ''}
    </section>
    ${cautions.length ? `<section class="detail-section guide-cautions"><h3>使用前留意</h3><ul>${cautions.map(text=>`<li>${escape(text)}</li>`).join('')}</ul></section>` : ''}
  </div>`;
}
