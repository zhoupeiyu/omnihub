async function videoToolApi(path, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30000);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error("网络响应超时。任务可能已提交，请查看记录后再试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function videoInputLinks(text) {
  return String(text || "").match(/https?:\/\/[^\s<>"\u3000]+/gi) || [];
}

function useAutomaticMediaPreview({ active, job, onPrepare }) {
  const attempted = React.useRef(new Set());
  React.useEffect(() => {
    if (!active || job?.state !== "parsed" || job.error || attempted.current.has(job.id)) return;
    attempted.current.add(job.id);
    void onPrepare(job, false);
  }, [active, job?.id, job?.state, job?.error, onPrepare]);
}

const VIDEO_TOOL_CATALOG = Object.freeze([
  {
    id: "video-download",
    name: "视频下载",
    description: "解析作品链接，保存视频、图集与封面。",
    icon: IconDownload,
    badge: "视频 · 图集",
  },
  {
    id: "media-processing",
    name: "视频处理",
    description: "裁剪、压缩、转换格式和提取音画。",
    icon: IconWrench,
    badge: "上传文件",
  },
  {
    id: "image-processing",
    name: "图片处理",
    description: "去除背景，导出透明图片。",
    icon: IconPalette,
    badge: "透明 PNG",
  },
  {
    id: "video-transcribe",
    name: "文字与字幕",
    description: "链接转文字，或在 AI 工具配置后生成文件字幕。",
    icon: IconType,
    badge: "链接转写 · AI 字幕",
  },
  {
    id: "video-collections",
    name: "作者与收藏",
    description: "查看公开作品、合集与收藏。",
    icon: IconBookOpen,
    badge: "公开内容",
  },
  {
    id: "media-library",
    name: "素材库",
    description: "继续下载、复制原文和查找已保存素材。",
    icon: IconInbox,
    badge: "记录与文件",
  },
  {
    id: "media-discovery",
    name: "内容发现",
    description: "搜索公开内容、热榜、评论和直播状态。",
    icon: IconBookOpen,
    badge: "公开信息",
  },
  {
    id: "audio-processing",
    name: "音频处理",
    description: "裁剪、提取音频；AI 工具配置后可分离人声伴奏。",
    icon: IconWrench,
    badge: "上传文件 · AI 工具",
  },
  {
    id: "camera-recipes",
    name: "运镜与镜头配方",
    description: "按镜头意图挑选运镜提示词，整理成可执行的短片镜头卡。",
    icon: IconBookOpen,
    badge: "提示词 · 分镜",
  },
  {
    id: "omniget-download",
    name: "OmniGet 下载",
    description: "解析公开作品并按需下载。",
    icon: IconDownload,
    badge: "公开链接",
  },
]);
const CAMERA_MOVE_LIBRARY = Object.freeze([
  { id: "locked", category: "基础与定机", name: "固定机位", use: "交代环境、让表演和画面稳定落下", prompt: "Locked-off camera, stable composition, no camera movement; keep the subject readable and hold the final frame.", zh: "固定机位，构图稳定，无镜头运动；保持主体清晰，结尾停在可读画面。" },
  { id: "push-in", category: "推进与轨道", name: "缓慢推进", use: "把注意力收束到人物、产品或细节", prompt: "Slow controlled dolly in toward the main subject, natural parallax, steady framing, end on a clean close composition.", zh: "镜头平稳缓慢推进至主体，自然视差，构图稳定，收在干净的近景。" },
  { id: "pull-out", category: "推进与轨道", name: "缓慢拉远", use: "从情绪或细节回到环境与关系", prompt: "Slow dolly out from the subject, reveal the surrounding environment gradually, maintain a calm stable horizon.", zh: "镜头从主体缓慢拉远，逐步展示环境，保持平静稳定的水平线。" },
  { id: "orbit", category: "环绕与跟随", name: "半环绕", use: "给人物或产品增加层次与立体感", prompt: "Smooth half-orbit around the subject, consistent distance and eye-level camera, controlled parallax, finish on a flattering three-quarter angle.", zh: "镜头围绕主体平滑半环绕，距离与机位高度一致，控制视差，收在舒适的三分之四角度。" },
  { id: "track", category: "环绕与跟随", name: "侧向跟拍", use: "适合走路、展示空间或产品移动", prompt: "Side tracking shot moving with the subject, keep pace constant, preserve separation between foreground and background.", zh: "镜头与主体侧向同速跟拍，保持节奏稳定，保留前景、中景和背景层次。" },
  { id: "reveal", category: "特殊与转场", name: "遮挡揭示", use: "用于开场、产品亮相或空间转场", prompt: "Begin behind a soft foreground occlusion, glide forward to reveal the subject, keep the reveal deliberate and end in a balanced frame.", zh: "从柔和前景遮挡后开始，平滑前移揭示主体，揭示过程克制，收在平衡构图。" },
  { id: "crane", category: "空间与航空", name: "升降俯视", use: "展示场景尺度、桌面或空间关系", prompt: "Gentle crane up from eye level to a high wide view, keep the subject centered while the space opens beneath the camera.", zh: "镜头从平视缓慢升至高位广角，主体保持在画面中心，空间在镜头下方展开。" },
  { id: "pan", category: "平摇与俯仰", name: "平稳横摇", use: "从一个信息点带到另一个信息点", prompt: "Smooth horizontal pan from the opening subject to the destination subject, level horizon, constant speed, settle before the cut.", zh: "从起始主体平稳横摇到目标主体，保持水平线与匀速，剪辑前稳定落幅。" },
  { id: "tilt", category: "平摇与俯仰", name: "向上仰摇", use: "强调建筑、高度、人物气势", prompt: "Controlled tilt up from the lower detail to the upper subject, steady axis, retain readable vertical lines.", zh: "镜头从下方细节受控上摇至上方主体，转轴稳定，保留清晰的垂直线条。" },
  { id: "handheld", category: "人机与质感", name: "克制手持", use: "纪实、现场感和轻微紧张感", prompt: "Subtle handheld camera with restrained natural micro-movement, keep the subject framed and avoid excessive shake.", zh: "克制的手持镜头，保留自然微小运动，主体始终在画面内，避免过度抖动。" },
  { id: "whip", category: "特殊与转场", name: "快速甩镜", use: "强节奏转场，必须有清楚的起止画面", prompt: "Fast whip pan transition between two readable compositions, brief motion blur only during the turn, settle sharply on the destination.", zh: "在两组清晰构图间快速甩镜转场，仅转动时产生短暂运动模糊，目标画面迅速稳定。" },
  { id: "zoom", category: "推进与轨道", name: "变焦强调", use: "制造突然注意力或复古感，谨慎使用", prompt: "Deliberate slow optical zoom toward the key detail, keep the camera position fixed and preserve the subject in focus.", zh: "镜头位置固定，刻意缓慢光学变焦至关键细节，保持主体清晰对焦。" },
  { id: "static-detail", category: "基础与定机", name: "静态细节", use: "给材质、手部或关键物品一个呼吸点", prompt: "Locked close detail shot, no camera move, shallow depth of field, let the texture and action remain readable.", zh: "固定近景细节镜头，无运动，浅景深，让材质与动作保持清晰。" },
  { id: "slow-push", category: "推进与轨道", name: "极慢推近", use: "适合情绪积累和高级感产品亮相", prompt: "Very slow cinematic push in, barely perceptible camera travel, preserve the subject's position and finish with a quiet hold.", zh: "极慢电影感推近，镜头位移几乎不可察，主体位置稳定，结尾安静停顿。" },
  { id: "slider-left", category: "推进与轨道", name: "滑轨左移", use: "通过视差呈现前中后景层次", prompt: "Short slider move to the left, gentle parallax across foreground and background, keep the subject in the safe frame.", zh: "镜头短距离向左滑轨移动，前后景产生柔和视差，主体保持在安全构图内。" },
  { id: "slider-right", category: "推进与轨道", name: "滑轨右移", use: "与左移形成可剪辑的方向语法", prompt: "Short slider move to the right, controlled parallax, maintain an even horizon and a readable end frame.", zh: "镜头短距离向右滑轨移动，控制视差，保持水平线与清晰的结束构图。" },
  { id: "arc-push", category: "环绕与跟随", name: "弧线推进", use: "在推进中轻微改变角度，增强空间感", prompt: "Arc dolly toward the subject on a gentle curved path, subtle parallax, finish at a three-quarter angle.", zh: "镜头沿柔和弧线推进至主体，产生轻微视差，收在三分之四角度。" },
  { id: "full-orbit", category: "环绕与跟随", name: "完整环绕", use: "适合静态产品、雕塑感人物或空间中心", prompt: "Controlled full orbit around the centered subject, consistent radius and speed, keep the background motion smooth.", zh: "围绕居中主体做受控完整环绕，半径与速度一致，背景运动平顺。" },
  { id: "follow-back", category: "环绕与跟随", name: "背跟", use: "带观众进入人物视线所在的空间", prompt: "Follow behind the subject at walking pace, stable shoulder-height framing, let the destination reveal naturally.", zh: "以行走速度从背后跟拍主体，稳定肩高机位，让目的地自然出现。" },
  { id: "lead-follow", category: "环绕与跟随", name: "前引跟拍", use: "人物走向镜头，适合自信出场", prompt: "Lead the subject from the front while moving backward smoothly, keep eye line and face stable in frame.", zh: "镜头平稳后退并从前方引导主体，保持眼神线与面部构图稳定。" },
  { id: "handheld-follow", category: "人机与质感", name: "手持跟随", use: "更贴近人物行动，但避免纪实抖动过强", prompt: "Natural handheld follow shot with small controlled sway, keep the action legible and avoid abrupt framing loss.", zh: "自然手持跟随，小幅受控摇摆，动作清晰，避免突然丢失构图。" },
  { id: "pan-left", category: "平摇与俯仰", name: "向左横摇", use: "从右侧信息回到左侧主体", prompt: "Smooth pan left from the opening detail to the destination subject, keep the horizon level and settle before the end.", zh: "从起始细节平稳向左横摇至目标主体，保持水平线，结尾稳定停住。" },
  { id: "tilt-down", category: "平摇与俯仰", name: "向下俯摇", use: "从人物或建筑落到关键动作与物品", prompt: "Controlled tilt down from the upper subject to the lower detail, steady axis, land on a clear point of focus.", zh: "从上方主体受控向下俯摇到下方细节，转轴稳定，落在明确焦点。" },
  { id: "roll", category: "平摇与俯仰", name: "轻微旋转", use: "仅用于不安、梦境或强调失衡", prompt: "Subtle camera roll during a stable shot, restrained angle change, preserve the subject and avoid disorienting rotation.", zh: "稳定镜头中加入轻微旋转，角度变化克制，主体保持清晰，避免失控眩晕。" },
  { id: "top-down", category: "空间与航空", name: "垂直俯拍", use: "展示桌面、群体关系或产品排列", prompt: "Top-down overhead shot, camera perpendicular to the surface, balanced graphic composition, no perspective drift.", zh: "垂直俯拍，镜头与平面垂直，构图平衡有图形感，不产生透视漂移。" },
  { id: "drone-rise", category: "空间与航空", name: "航拍上升", use: "从人物或建筑揭开更大的空间", prompt: "Drone rise from a low establishing view to a higher wide view, smooth ascent, keep the location readable.", zh: "航拍从低位建立镜头平稳上升至高位广角，地点信息始终清晰。" },
  { id: "drone-descend", category: "空间与航空", name: "航拍下降", use: "从大环境落向人物或事件", prompt: "Drone descend gently toward the main action, controlled speed, transition from wide context to readable subject.", zh: "航拍平稳下降至主要动作，速度受控，从环境广角过渡到清晰主体。" },
  { id: "fly-through", category: "空间与航空", name: "穿越空间", use: "从门、窗或通道穿过进入新场景", prompt: "Smooth fly-through moving through a doorway or opening into the next space, preserve forward direction and avoid collisions.", zh: "镜头平滑穿过门洞或开口进入下一空间，保持前进方向，避免碰撞感。" },
  { id: "fpv-dive", category: "空间与航空", name: "FPV 俯冲", use: "高能量进入，适合运动与场景转换", prompt: "Controlled FPV dive toward the destination, fast but readable trajectory, level out into a stable final frame.", zh: "受控 FPV 俯冲至目标区域，轨迹快速但可读，结尾拉平至稳定画面。" },
  { id: "rack-focus", category: "人机与质感", name: "焦点转移", use: "不移动机位也能在两层信息间切换", prompt: "Static camera with a deliberate rack focus from foreground detail to background subject, smooth focus transition, no camera travel.", zh: "固定机位，从前景细节刻意移焦到背景主体，焦点过渡平滑，无镜头位移。" },
  { id: "breathing", category: "人机与质感", name: "呼吸式轻推", use: "让静态画面有细微生命感", prompt: "Minimal breathing camera drift, almost imperceptible forward and backward motion, calm and intimate, keep the frame stable.", zh: "极细微呼吸式前后漂移，安静亲密，构图保持稳定。" },
  { id: "crash-zoom", category: "特殊与转场", name: "冲击变焦", use: "做强重音，不连续滥用", prompt: "One decisive crash zoom toward the key subject, brief impact energy, immediately settle into a sharp stable frame.", zh: "向关键主体做一次果断冲击变焦，短暂重音后立刻稳定在清晰画面。" },
  { id: "match-cut", category: "特殊与转场", name: "形状匹配转场", use: "让两场景中的相似形状或动作无缝衔接", prompt: "Match cut between two scenes using a shared shape, direction, or gesture; align the subject position and preserve visual continuity.", zh: "利用共享形状、方向或动作在两场景间匹配剪辑；对齐主体位置，保留视觉连续性。" },
  { id: "speed-ramp", category: "特殊与转场", name: "速度渐变", use: "在动作关键点压缩或释放时间", prompt: "Speed ramp through one decisive action: normal pace into a brief fast passage, then resolve into a stable hold.", zh: "围绕一个关键动作做速度渐变：正常节奏进入短暂加速，再落回稳定停顿。" },
  { id: "freeze", category: "特殊与转场", name: "定格收束", use: "作为片尾、标题或强调点", prompt: "Move into a clean final composition and hold a deliberate freeze frame, leave clear negative space for a title.", zh: "运动进入干净的终局构图后有意识定格，为标题保留清晰留白。" },
  { id: "silhouette-reveal", category: "特殊与转场", name: "逆光剪影揭示", use: "先给轮廓再给信息，适合人物或新品", prompt: "Start with a backlit silhouette, slowly reveal facial or product detail with a controlled camera move, preserve rim light.", zh: "从逆光剪影开始，以受控镜头运动逐步揭示人物或产品细节，保留轮廓光。" },
  { id: "dutch-push", category: "人机与质感", name: "倾斜推进", use: "表现压力或异常，仅用于有叙事理由的画面", prompt: "Slow push in with a restrained Dutch angle, keep the subject readable and use the tilt only to support tension.", zh: "带克制荷兰角的缓慢推进，主体保持清晰，倾斜只为服务紧张感。" },
  { id: "low-angle", category: "基础与定机", name: "低机位仰视", use: "强调力量、尺度或产品高度", prompt: "Low-angle stable shot looking up at the subject, preserve vertical lines and leave room above for scale.", zh: "低机位稳定仰视主体，保留垂直线，并在上方留下尺度感空间。" },
  { id: "high-angle", category: "基础与定机", name: "高机位俯视", use: "呈现脆弱、秩序或桌面关系", prompt: "High-angle stable shot looking down at the subject, balanced composition, keep all key objects readable.", zh: "高机位稳定俯视主体，构图平衡，让关键物体保持可读。" },
  { id: "dolly-zoom", category: "推进与轨道", name: "推拉变焦", use: "用透视变化制造心理冲击，适合少量重点镜头", prompt: "Dolly zoom on the subject: camera travels forward as focal length widens, preserve subject size while the background perspective shifts.", zh: "对主体做推拉变焦：镜头前移同时拉广焦距，主体大小稳定，背景透视发生变化。" },
  { id: "orbit-reveal", category: "环绕与跟随", name: "环绕揭示", use: "利用前景或人物转身揭开隐藏信息", prompt: "Orbit past a foreground edge to reveal the hidden subject, keep the motion smooth and end on a composed reveal.", zh: "镜头绕过前景边缘揭示隐藏主体，运动平滑，结尾收在完整揭示构图。" },
  { id: "lens-flare", category: "人机与质感", name: "掠光经过", use: "在真实光源下增加温度与节奏", prompt: "Camera glides past a practical light source, subtle natural lens flare, retain contrast and keep the main subject visible.", zh: "镜头掠过真实光源，产生细微自然炫光，保留对比与主体可见性。" },
  { id: "macro-glide", category: "推进与轨道", name: "微距掠过", use: "沿材质、文字或产品边缘建立触感", prompt: "Macro glide along the product surface, shallow focus, slow controlled travel, let highlights reveal texture without losing the key detail.", zh: "镜头沿产品表面微距掠过，浅景深、缓慢受控移动，用高光展示材质且不丢失关键细节。" },
  { id: "rack-and-push", category: "人机与质感", name: "移焦后推进", use: "先告诉观众看什么，再把注意力交给主体", prompt: "Rack focus from a foreground cue to the subject, then begin a gentle push in after focus locks; keep each action clearly separated.", zh: "从前景线索移焦到主体，焦点锁定后再轻微推进；两个动作清楚分开。" },
  { id: "door-swing", category: "特殊与转场", name: "开门入场", use: "用可见动作把观众带入室内或新场景", prompt: "Camera follows a door opening and moves through the doorway into the new space, keep the transition motivated by the action.", zh: "镜头跟随门被打开并穿过门洞进入新空间，让转场由动作自然驱动。" },
  { id: "slow-arc-out", category: "环绕与跟随", name: "弧线拉远", use: "让人物与环境关系逐步显现", prompt: "Arc slowly away from the subject on a curved path, reveal the environment while preserving a calm composed frame.", zh: "镜头沿弧线缓慢远离主体，在保持安静构图的同时揭示环境。" },
]);
const SHOTCRAFT_METADATA_URL = "/assets/creator-skills/shotcraft-cards.json";
const videoPlatformName = {
  douyin: "抖音",
  tiktok: "TikTok",
  bilibili: "哔哩哔哩",
};
const videoStateName = {
  queued: "等待处理",
  parsing: "正在解析",
  parsed: "待下载",
  saving: "正在准备",
  saved: "可下载",
  transcribing: "正在转写",
  transcribed: "转写完成",
  browsing: "正在读取",
  ready: "已准备",
  failed: "处理失败",
};
const videoFileSize = (bytes) =>
  bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
const videoFileHref = (job, file, inline = false) =>
  `/api/tools/video/jobs/${job.id}/files/${encodeURIComponent(file.name)}${
    inline ? "?inline=1" : ""
  }`;
const videoOriginalInput = (job) => job.input ?? job.url ?? "";
// Discovery uses `input` for handoffs; older internal links use `text`.
// Preserve an explicitly empty handoff too, rather than falling back to stale text.
const videoHandoffInput = (params) =>
  params.has("input") ? params.get("input") || "" : params.get("text") || "";
const videoBusy = (job) =>
  ["queued", "parsing", "saving", "transcribing", "browsing", "processing", "submitting", "submission-unknown"].includes(
    job?.state,
  );
const VIDEO_TOOL_TABS = Object.freeze([
  { id: "download", name: "下载解析", tool: VIDEO_TOOL_CATALOG[0] },
  { id: "process", name: "视频处理", tool: VIDEO_TOOL_CATALOG[1] },
  { id: "audio", name: "音频处理", tool: VIDEO_TOOL_CATALOG[7] },
  { id: "transcribe", name: "文字与字幕", tool: VIDEO_TOOL_CATALOG[3] },
  { id: "collections", name: "作者与收藏", tool: VIDEO_TOOL_CATALOG[4] },
  { id: "discover", name: "内容发现", tool: VIDEO_TOOL_CATALOG[6] },
  { id: "image", name: "图片处理", tool: VIDEO_TOOL_CATALOG[2] },
  { id: "library", name: "素材库", tool: VIDEO_TOOL_CATALOG[5] },
]);
const videoLegacyTab = Object.freeze({
  "video-download": "download",
  "video-transcribe": "transcribe",
  "video-collections": "collections",
  "media-library": "library",
  "media-discovery": "discover",
});
const videoTabForHash = (hash) => {
  const name = workspaceHashName(hash);
  const legacy = videoLegacyTab[name];
  if (legacy) return legacy;
  const tab = workspaceHashParams(hash).get("tab");
  return VIDEO_TOOL_TABS.some((item) => item.id === tab) ? tab : "download";
};
function standaloneVideoToolForHash(hash) {
  const route = workspaceHashName(hash);
  if (route === "camera-recipes") return "camera";
  if (route === "omniget") return "omniget";
  // Existing bookmarks keep working, but now render the independent tool page
  // instead of reopening a tab inside the media workspace.
  if (route === "media-tools" || route === "video-tools") {
    const tab = workspaceHashParams(hash).get("tab");
    if (tab === "camera" || tab === "omniget") return tab;
  }
  return "";
}
function StandaloneVideoToolWorkspace({ kind, active, space, showToast }) {
  const title = kind === "camera" ? "运镜与镜头配方" : "OmniGet 下载";
  return <section className="video-tool-center standalone-video-tool" aria-labelledby={`standalone-${kind}-title`}>
    <header className="video-center-heading">
      <a className="video-breadcrumb" href={`#tools?space=${space}`}>← 所有工具</a>
      <h1 id={`standalone-${kind}-title`}>{title}</h1>
    </header>
    {kind === "camera"
      ? <CameraRecipeWorkspace visible={active} space={space} showToast={showToast} />
      : typeof OmnigetWorkspace === "function"
      ? <OmnigetWorkspace active={active} />
      : <p role="alert">OmniGet 工具暂时不可用。</p>}
  </section>;
}
function VideoToolsWorkspace({ active, userKey, userId, showToast, referenceAccess = false, toolAccess = new Set(['media','markdown','camera','omniget']), onCreateReference }) {
  const [hash, setHash] = React.useState(window.location.hash);
  const tabsRef = React.useRef(null);
  const visibleTabs = VIDEO_TOOL_TABS.filter(item => !item.private || referenceAccess);
  const requestedTab = videoTabForHash(hash);
  const tab = visibleTabs.some(item => item.id === requestedTab) ? requestedTab : 'download';
  React.useEffect(() => {
    if (!active) return;
    const revealTab = () => {
      const list = tabsRef.current, current = list?.querySelector('[aria-selected="true"]');
      if (!list || !current) return;
      const bounds = list.getBoundingClientRect(), item = current.getBoundingClientRect();
      if (item.left < bounds.left) list.scrollLeft -= bounds.left - item.left + 8;
      else if (item.right > bounds.right) list.scrollLeft += item.right - bounds.right + 8;
    };
    revealTab();
    window.addEventListener("resize", revealTab);
    return () => window.removeEventListener("resize", revealTab);
  }, [hash, tab, active]);
  React.useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener("hashchange", sync);
    window.addEventListener("omnihub:route-restored", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("omnihub:route-restored", sync);
    };
  }, []);
  const route = workspaceHashName(hash),
    space = workspaceHashParams(hash).get("space") === "mine"
      ? "mine"
      : "public";
  const standaloneTool = standaloneVideoToolForHash(hash);
  if (route === 'markdown-editor') return toolAccess.has('markdown') ? <MarkdownToolWorkspace space={space} /> : <ToolAccessDenied/>;
  if (route === 'pdf-compress') return toolAccess.has('pdf') ? <PdfCompressWorkspace showToast={showToast}/> : <ToolAccessDenied/>;
  if (route === 'ai-art') return referenceAccess ? <AiArtWorkspace key={userKey} active={active} hash={hash} userId={userId} showToast={showToast} onCreate={onCreateReference} /> : <ToolAccessDenied/>;
  if (standaloneTool) return toolAccess.has(standaloneTool)
    ? <StandaloneVideoToolWorkspace kind={standaloneTool} active={active} space={space} showToast={showToast} />
    : <ToolAccessDenied/>;
  if (
    route !== "media-tools" && route !== "video-tools" && !videoLegacyTab[route]
  ) return <ToolCatalog key={userKey} space={space} active={active} referenceAccess={referenceAccess} toolAccess={toolAccess} />;
  if (!toolAccess.has('media')) return <ToolAccessDenied/>;
  const changeTab = (next) => {
    const params = new URLSearchParams();
    params.set("tab", next);
    params.set("space", space);
    window.location.hash = `#media-tools?${params}`;
  };
  return (
    <section className="video-tool-center" aria-labelledby="media-tools-title">
      <header className="video-center-heading">
        <div>
          <h1 id="media-tools-title">媒体工具</h1>
        </div>
      </header>
      <div ref={tabsRef} className="video-center-tabs" role="tablist" aria-label="媒体工具" onKeyDown={event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...tabsRef.current.querySelectorAll('[role="tab"]')];
        const index = tabs.indexOf(event.target);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus({ preventScroll: true });
        changeTab(visibleTabs[next].id);
      }}>
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tool-tab={item.id}
            id={`media-tools-tab-${item.id}`}
            aria-controls={`media-tools-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? "active" : ""}
            onClick={() => changeTab(item.id)}
          >
            <item.tool.icon />
            {item.name}
          </button>
        ))}
      </div>
      <div className="video-center-panels">
        <ToolShell
          key={`download:${userKey}:${space}`}
          tool={VIDEO_TOOL_TABS[0].tool}
          embedded
          hash={hash}
          visible={tab === "download"}
          active={active && tab === "download"}
          space={space}
          showToast={showToast}
        />
        <MediaProcessingTool key={`process:${userKey}:${space}`} mode="process" active={active && tab === "process"} visible={tab === "process"} space={space} hash={hash} showToast={showToast} />
        <MediaProcessingTool key={`audio:${userKey}:${space}`} mode="audio" active={active && tab === "audio"} visible={tab === "audio"} space={space} hash={hash} showToast={showToast} />
        <MediaTextWorkspace key={`text:${userKey}:${space}`} userKey={userKey} hash={hash} visible={tab === "transcribe"} active={active && tab === "transcribe"} space={space} showToast={showToast} />
        <MediaProcessingTool key={`image:${userKey}:${space}`} mode="image" active={active && tab === "image"} visible={tab === "image"} space={space} hash={hash} showToast={showToast} />
        <MediaCollectionWorkspace key={`collections:${userKey}:${space}`} hash={hash} visible={tab === "collections"} active={active && tab === "collections"} space={space} showToast={showToast} />
        <MediaDiscoveryTool
          key={`discover:${userKey}:${space}`}
          active={active && tab === "discover"}
          visible={tab === "discover"}
          space={space}
          hash={hash}
          showToast={showToast}
        />
        <MediaLibraryTool
          key={`library:${userKey}:${space}`}
          embedded
          hash={hash}
          visible={tab === "library"}
          active={active && tab === "library"}
          space={space}
          showToast={showToast}
          onNavigate={changeTab}
        />
      </div>
    </section>
  );
}
function MarkdownToolWorkspace({ space }) {
  const container = React.useRef(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  React.useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return <section ref={container} className="markdown-tool-workspace" aria-label="Markdown 排版">
    <header className="markdown-tool-toolbar">
      <h1>Markdown 排版</h1>
      <nav aria-label="编辑器操作">
        <a className="btn" href="/apps/mdskill/index.html" target="_blank" rel="noopener noreferrer">独立打开 ↗</a>
        <button className="btn" type="button" onClick={() => {
          const action = document.fullscreenElement ? document.exitFullscreen() : container.current?.requestFullscreen();
          action?.catch(() => {});
        }}>{fullscreen ? "退出全屏" : "全屏"}</button>
      </nav>
    </header>
    <LoadingFrame title="MDskill Markdown 编辑器" src="/apps/mdskill/index.html" allow="clipboard-write; fullscreen" />
  </section>;
}
function ToolAccessDenied(){return <section className="tool-access-denied"><h1>工具暂未授权</h1><p>请联系管理员在“设置 → 用户与权限”中开通相应工具。</p></section>;}
function PdfCompressWorkspace({showToast}){return <section className="pdf-compress-workspace" aria-label="PDF 压缩"><PdfCompressTool showToast={showToast}/></section>;}
function ToolCatalog({ space, active, referenceAccess = false, toolAccess = new Set(['media','markdown','camera','omniget']) }) {
  return (
    <section
      className="topics-catalog tools-catalog tool-catalog"
      aria-label="工具"
    >
      <ul className="topics-grid">
        {toolAccess.has('media')&&<li>
          <a
            className="topics-card video-tool-card"
            href={`#media-tools?tab=download&space=${space}`}
          >
            <CoverCardSkeleton /><img className="video-tool-cover" src="/assets/tool-covers/media-tools-v1.png" alt="" decoding="async" />
            <strong>媒体工具</strong>
            <span className="video-tool-description">下载、视频处理、图片处理与素材库。</span>
          </a>
        </li>}
        {toolAccess.has('camera')&&<li>
          <a className="topics-card video-tool-card camera-tool-card" href={`#camera-recipes?space=${space}`}>
            <strong>运镜与镜头配方</strong>
            <span className="video-tool-description">选择可复用的运镜提示词，再把镜头节奏整理为短片配方。</span>
          </a>
        </li>}
        {toolAccess.has('omniget')&&<li>
          <a className="topics-card video-tool-card omniget-tool-card" href={`#omniget?space=${space}`}>
            <strong>OmniGet 下载</strong>
            <span className="video-tool-description">解析公开作品并按需下载。</span>
          </a>
        </li>}
        {toolAccess.has('markdown')&&<li>
          <a className="topics-card video-tool-card" href={`#markdown-editor?space=${space}`}>
            <CoverCardSkeleton /><img className="video-tool-cover" src="/apps/mdskill/cover.png" alt="" loading="lazy" decoding="async" />
            <strong>Markdown 排版</strong>
            <span className="video-tool-description">主题排版、一键复制与图片、HTML 导出。</span>
          </a>
        </li>}
        {toolAccess.has('pdf')&&<li>
          <a className="topics-card pdf-tool-card" href={`#pdf-compress?space=${space}`}>
            <strong>PDF 压缩</strong>
            <span>上传本地 PDF，选择清晰度后压缩并下载。</span>
          </a>
        </li>}
        {referenceAccess && <li>
          <a className="topics-card ai-art-card" href="#ai-art?space=mine">
            <CoverCardSkeleton /><AiArtCover active={active} />
            <strong>AI 作图</strong>
            <span className="ai-art-description">人物、服装、姿势参考与 AI 创作。</span>
          </a>
        </li>}
      </ul>
    </section>
  );
}
const CAMERA_PREVIEW_ROOT = "https://aicameramovements.com/previews/hq/";
const CAMERA_PREVIEWS = Object.freeze({
  locked: "01-static-shot-hq", "push-in": "08-dolly-in-hq", "pull-out": "09-dolly-out-hq",
  track: "19-side-tracking-hq", crane: "25-crane-up-hq", pan: "02-pan-right-hq", reveal: "13-push-past-pass-by-shot-hq",
  tilt: "04-tilt-up-hq", handheld: "23-handheld-shot-hq", whip: "03-whip-pan-right-hq",
  zoom: "05-slow-zoom-in-hq", "slider-left": "12b-slider-left-hq", "slider-right": "12-slider-right-hq",
  "full-orbit": "15-orbit-clockwise-hq", "follow-back": "17-follow-shot-over-the-shoulder-hq",
  "lead-follow": "18-reverse-tracking-walk-and-talk-hq", "pan-left": "2b-pan-left-hq",
  "tilt-down": "4b-tilt-down-hq", "fly-through": "s6-pass-through-objects-hq",
  "crash-zoom": "07a-crash-zoom-in-v2-hq"
});
const CAMERA_WHITEBOX_PREVIEWS = Object.freeze({"orbit": "07_orbit", "static-detail": "105_insert_detail", "slow-push": "52_slow_creep", "arc-push": "24_arc_inward", "drone-rise": "06_crane_up", "drone-descend": "18_high_descend", "fpv-dive": "27_fpv_dive", "rack-focus": "34_rack_focus", "breathing": "134_breathing_drift", "speed-ramp": "131_speed_ramp", "freeze": "133_push_freeze", "dutch-push": "30_dolly_in_dutch", "low-angle": "57_low_angle_hero", "high-angle": "56_high_angle", "dolly-zoom": "10_vertigo_push", "orbit-reveal": "24_arc_inward", "slow-arc-out": "25_arc_outward"});
const CAMERA_WHITEBOX_FALLBACKS = Object.freeze({
  locked: "00_static", "push-in": "01_dolly_in", "pull-out": "02_dolly_out", track: "39_walk_side",
  reveal: "24_arc_inward", crane: "06_crane_up", handheld: "20_handheld", zoom: "11_zoom_in",
  "follow-back": "37_walk_follow", "lead-follow": "38_walk_lead", "crash-zoom": "13_crash_zoom",
  "fly-through": "64_push_through", pan: "03_pan", "pan-left": "03_pan_mirror",
  tilt: "04_tilt", "tilt-down": "04_tilt_reverse",
  "slider-left": "05_truck", "slider-right": "05_truck_mirror"
});
function CameraMovePreview({ item }) {
  const clip = CAMERA_WHITEBOX_PREVIEWS[item.id];
  const video = CAMERA_PREVIEWS[item.id];
  const external = {
    "top-down": { video: "/assets/camera-other/topdown-writing-pexels-6830880.mp4", poster: "/assets/camera-other/topdown-writing-pexels-6830880.jpg", source: "https://www.pexels.com/video/overhead-shot-of-a-love-letter-on-a-table-6830880/", label: "垂直俯拍示例 · cottonbro studio" },
    "silhouette-reveal": { video: "/assets/camera-other/silhouette-reverse-pexels.mp4", poster: "/assets/camera-other/silhouette-reverse-pexels.jpg", source: "https://www.pexels.com/video/silhouette-of-woman-in-warm-backlight-34016973/", label: "逆光参考（倒放示意）· Alexander Mass" },
    "macro-glide": { video: "/assets/camera-other/macro-glide-pexels.mp4", poster: "/assets/camera-other/macro-glide-pexels.jpg", source: "https://www.pexels.com/video/panning-shot-on-the-scrabble-tiles-and-a-clapperboard-5651594/", label: "微距掠过示例 · Tima Miroshnichenko" },
    "lens-flare": { video: "/assets/camera-other/light-pass-pexels.mp4", poster: "/assets/camera-other/light-pass-pexels.jpg", source: "https://www.pexels.com/video/silhouette-of-woman-in-warm-backlight-34016973/", label: "掠光参考 · Alexander Mass" },
    "door-swing": { video: "/assets/camera-other/door-open-pexels.mp4", poster: "/assets/camera-other/door-open-pexels.jpg", source: "https://www.pexels.com/video/opening-an-antique-door-to-a-vintage-room-34835402/", label: "开门揭示示例 · Belén Montero" },
    "roll": { video: "https://ialchemy.org/camera-samples/dutch-roll.mp4", poster: "https://ialchemy.org/camera-samples/dutch-roll.jpg", source: "https://ialchemy.org/camera-movements", label: "示例 · iALCHEMY" },
    "handheld-follow": { video: "https://cdn.starrdcdn.com/template-assets/camera-movements/handheld-follow.mp4", poster: "https://jpsgqxabsyoszaxywdki.supabase.co/storage/v1/object/public/template-assets/camera-movements/handheld-follow-poster.jpg", source: "https://www.getstarrd.app/camera-movements/handheld-follow", label: "示例 · Starrd" },
    "match-cut": { video: "https://media.maxvideoai.com/renders/301cc489-d689-477f-94c4-0b051deda0bc/61dbdd60-f1bd-4422-967b-54fbbd1c29ab.mp4", poster: "https://media.maxvideoai.com/renders/301cc489-d689-477f-94c4-0b051deda0bc/0c5f5b6a-0feb-4d89-8ac1-4dcc55995a80.jpg", source: "https://maxvideoai.com/video/wan-3-prime-ai-match-cut-transitions", label: "示例 · MaxVideoAI" }
  }[item.id];
  const [failed, setFailed] = React.useState(false);
  const [usingFallback, setUsingFallback] = React.useState(false);
  if (item.id === "rack-and-push") return <div className="camera-preview-pair"><span>分步示意：先移焦，再推进 · <a href="https://github.com/q2522879285-source/camera-moves-whitebox" target="_blank" rel="noopener noreferrer">hong hou zi</a></span>{[["34_rack_focus", "移焦"], ["01_dolly_in", "推进"]].map(([file, label]) => <div key={file} className="camera-preview"><video src={`/assets/camera-whitebox-preview/${file}.mp4`} poster={`/assets/camera-whitebox-preview/${file}.jpg`} muted loop playsInline preload="none" controls aria-label={`${label}示例`} /><span className="camera-preview-source">{label}示例</span></div>)}</div>;
  if ((!video && !clip && !external) || failed) return <div className="camera-preview camera-preview-empty"><span>{failed ? "预览暂时不可用" : "暂无对应视频"}</span><a href="https://aicameramovements.com/#finder" target="_blank" rel="noopener noreferrer">查看参考站</a></div>;
  const selectedClip = usingFallback ? CAMERA_WHITEBOX_FALLBACKS[item.id] : clip;
  const base = selectedClip ? `/assets/camera-whitebox-preview/${selectedClip}` : `${CAMERA_PREVIEW_ROOT}${video}`;
  const src = (!usingFallback && external?.video) || `${base}.mp4`;
  const poster = (!usingFallback && external?.poster) || `${base}.jpg`;
  const source = selectedClip ? "https://github.com/q2522879285-source/camera-moves-whitebox" : external?.source || "https://aicameramovements.com/#finder";
  const portrait = ["door-swing", "silhouette-reveal", "lens-flare"].includes(item.id);
  const fallbackLabel = item.id === "locked" ? "备用白膜示意（定格）· hong hou zi" : ["pan-left", "slider-right"].includes(item.id) ? "备用白膜示意（镜像）· hong hou zi" : item.id === "tilt-down" ? "备用白膜示意（倒放）· hong hou zi" : "备用白膜示意 · hong hou zi";
  return <div className={`camera-preview${portrait ? " camera-preview--portrait" : ""}`} style={portrait ? { "--camera-poster": `url("${poster}")` } : undefined}><video key={src} src={src} poster={poster} muted loop playsInline preload="none" autoPlay={usingFallback} controls aria-label={`${item.name}运镜预览`} onError={() => { if (!usingFallback && CAMERA_WHITEBOX_FALLBACKS[item.id]) setUsingFallback(true); else setFailed(true); }} /><a className="camera-preview-source" href={source} target="_blank" rel="noopener noreferrer">{selectedClip ? (usingFallback ? fallbackLabel : ["breathing", "freeze"].includes(item.id) ? "白膜改编示意 · hong hou zi" : "白膜示意 · hong hou zi") : external?.label || "视频来源"}</a></div>;
}
function CameraRecipeWorkspace({ visible, space, showToast }) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("全部");
  const [shotcraft, setShotcraft] = React.useState({ loading: true, error: "", data: null });
  const [shotQuery, setShotQuery] = React.useState("");
  const [shotCategory, setShotCategory] = React.useState("全部");
  React.useEffect(() => {
    const controller = new AbortController();
    fetch(SHOTCRAFT_METADATA_URL, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error("镜头卡元数据暂时不可用");
      const data = await response.json();
      if (!Array.isArray(data.cards) || data.cards.length !== 124) throw Error("镜头卡数据不完整");
      setShotcraft({ loading: false, error: "", data });
    }).catch(error => {
      if (error.name !== "AbortError") setShotcraft({ loading: false, error: error.message || "镜头卡元数据暂时不可用", data: null });
    });
    return () => controller.abort();
  }, []);
  const categories = ["全部", ...new Set(CAMERA_MOVE_LIBRARY.map(item => item.category))];
  const normalized = query.trim().toLowerCase();
  const moves = CAMERA_MOVE_LIBRARY.filter(item =>
    (category === "全部" || item.category === category) &&
    (!normalized || `${item.name} ${item.category} ${item.use} ${item.prompt} ${item.zh}`.toLowerCase().includes(normalized)),
  );
  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast?.("运镜提示词已复制");
    } catch {
      showToast?.("复制失败，请手动选择提示词");
    }
  };
  const shotCards = shotcraft.data?.cards || [];
  const shotCategories = ["全部", ...new Set(shotCards.map(item => item.category))];
  const normalizedShot = shotQuery.trim().toLowerCase();
  const filteredShots = shotCards.filter(item => (shotCategory === "全部" || item.category === shotCategory) && (!normalizedShot || `${item.name} ${item.summary} ${item.use} ${item.tags?.join(" ")}`.toLowerCase().includes(normalizedShot)));
  const useShotcraftCard = (card) => {
    const repository = shotcraft.data.source.repository;
    const source = {
      title: `Shotcraft 镜头卡 · ${card.name}`,
      summary: [`镜头概述：${card.summary}`, `适用：${card.use}`, `时长：${card.duration}`, `节奏：${card.energy}`, `意图：${card.intention}`].filter(Boolean).join("\n\n"),
      origin: "video-shotcraft · Apache-2.0 元数据",
      url: repository,
      shotcraft: { version: 1, card: { ...card }, repository, license: "Apache-2.0" },
    };
    try { sessionStorage.setItem("omnihub:creator-source", JSON.stringify(source)); } catch { showToast?.("浏览器无法暂存镜头卡，请复制内容后继续"); return; }
    window.location.hash = "#studio?space=mine&view=content";
    window.dispatchEvent(new Event("omnihub:creator-source"));
  };
  return <section className="camera-recipe-workspace" hidden={!visible} aria-label="运镜与镜头配方">
    <header className="camera-recipe-head">
      <div><p>创作辅助</p><h2>运镜与镜头配方</h2><span>先选镜头意图，再替换主体、场景与画风。提示词为本站原创整理，参考通用电影摄影术语。</span></div>
      <a className="btn" href="#studio?space=mine">打开创作台</a>
    </header>
    <div className="camera-recipe-controls">
      <label className="camera-search"><IconSearch /><input value={query} onChange={event => setQuery(event.target.value)} type="search" placeholder="搜索运镜、意图或英文术语" aria-label="搜索运镜提示词" /></label>
      <div className="camera-filter" aria-label="运镜类别">{categories.map(item => <button type="button" key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
    </div>
    <div className="camera-move-grid">
      {moves.map(item => <article key={item.id} className="camera-move-card">
        <CameraMovePreview item={item} />
        <p>{item.category}</p><h3>{item.name}</h3><span>{item.use}</span>
        <div className="camera-prompt"><strong>EN</strong><code>{item.prompt}</code><strong>中文</strong><code>{item.zh}</code></div>
        <button className="btn btn-ghost" type="button" onClick={() => copy(`${item.prompt}\n${item.zh}`)}><IconCopy />复制提示词</button>
      </article>)}
      {moves.length === 0 && <p className="camera-empty">没有匹配的运镜。试试“推进”“跟拍”或 “orbit”。</p>}
    </div>
    <section className="shotcraft-recipes" aria-labelledby="shotcraft-recipes-title">
      <div className="shotcraft-recipes-head"><div><p>Apache-2.0 镜头卡元数据</p><h2 id="shotcraft-recipes-title">Shotcraft 镜头库</h2><span>{shotcraft.data ? `已导入 ${shotcraft.data.stats.cardCount} 张镜头卡与 ${shotcraft.data.stats.styleCount} 种样式。只保留元数据，不加载上游预览视频或品牌素材。` : "正在读取镜头卡元数据…"}</span></div><a href="https://github.com/Vincentwei1021/video-shotcraft" target="_blank" rel="noopener noreferrer">查看 Shotcraft ↗</a></div>
      {shotcraft.error ? <p className="camera-empty">{shotcraft.error}</p> : <>
        <div className="shotcraft-controls"><label className="camera-search"><IconSearch /><input value={shotQuery} onChange={event => setShotQuery(event.target.value)} type="search" placeholder="搜索镜头卡、用途或标签" aria-label="搜索 Shotcraft 镜头卡" /></label><div className="camera-filter" aria-label="Shotcraft 镜头类别">{shotCategories.map(item => <button type="button" key={item} className={shotCategory === item ? "active" : ""} onClick={() => setShotCategory(item)}>{item}</button>)}</div></div>
        <div className="shotcraft-recipe-grid">{filteredShots.map(card => <article key={card.name}><p className="shotcraft-category">{card.category}</p><h3>{card.name}</h3><p>{card.summary}</p><dl><div><dt>适用场景</dt><dd>{card.use}</dd></div><div><dt>时长 / 节奏</dt><dd>{[card.duration, card.energy].filter(Boolean).join(" · ")}</dd></div></dl><div className="shotcraft-card-actions"><button className="btn btn-ghost" type="button" onClick={() => copy([card.name, card.summary, card.use, card.intention].filter(Boolean).join("\n\n"))}><IconCopy />复制镜头卡</button><button className="btn" type="button" onClick={() => useShotcraftCard(card)}>加入创作台</button></div></article>)}</div>
        {!shotcraft.loading && filteredShots.length === 0 && <p className="camera-empty">没有匹配的镜头卡。</p>}
      </>}
      <p className="shotcraft-note">来源：video-shotcraft，Apache-2.0。部分卡片的独立实现来源说明保留在随包附带的 ATTRIBUTION 文件中。镜头卡只用于策划与创作台材料，不会直接生成视频。</p>
    </section>
  </section>;
}
function useToolData(active, kind, extra = "") {
  const [jobs, setJobs] = React.useState([]),
    [status, setStatus] = React.useState({
      available: null,
      scope: null,
      features: {},
    }),
    [loading, setLoading] = React.useState(true),
    [error, setError] = React.useState(""),
    [loadError, setLoadError] = React.useState("");
  const refresh = React.useCallback(async (signal) => {
    const state = await videoToolApi("/api/tools/video/status", { signal });
    if (signal?.aborted) return state;
    if (state.available === false) {
      setStatus(state); setJobs([]); setLoadError("");
      return state;
    }
    const result = await videoToolApi(
      `/api/tools/video/jobs?${extra || `kind=${encodeURIComponent(kind)}`}`,
      { signal },
    );
    if (signal?.aborted) return state;
    setJobs(result.jobs || []);
    setStatus({ ...state, scope: result.scope || state.scope });
    setLoadError("");
    return state;
  }, [kind, extra]);
  React.useEffect(() => {
    if (!active) return;
    let dead = false;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setStatus({ available: null, scope: null, features: {} });
    setJobs([]);
    refresh(controller.signal).then(() => !dead && setError("")).catch((e) => {
      if (!dead) { setError(e.message); setLoadError(e.message); }
    }).finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
      controller.abort();
    };
  }, [active, refresh]);
  React.useEffect(() => {
    if (!active || !jobs.some(videoBusy)) return;
    const controller = new AbortController();
    const timer = setTimeout(() =>
      refresh(controller.signal).then(() => {
        if (!controller.signal.aborted) setError("");
      }).catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoadError(e.message);
          setJobs((items) => [...items]);
        }
      }), 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, jobs, error, refresh]);
  const update = React.useCallback(
    (next) =>
      setJobs((items) =>
        [next, ...items.filter((item) => item.id !== next.id)].sort((a, b) =>
          b.created - a.created
        )
      ),
    [],
  );
  return { jobs, status, loading, error, loadError, setError, refresh, update };
}
function ToolShell(
  {
    tool,
    active,
    visible = true,
    embedded = false,
    hash = window.location.hash,
    space,
    showToast,
    onNavigate,
  },
) {
  const isDownload = tool.id === "video-download",
    isTranscript = tool.id === "video-transcribe",
    isCollection = tool.id === "video-collections";
  const ownTab = isDownload
    ? "download"
    : isTranscript
    ? "transcribe"
    : "collections";
  const panelId = `media-tools-panel-${ownTab}`;
  const titleId = `media-tools-panel-title-${ownTab}`;
  const inputId = `media-tools-input-${ownTab}`;
  const initialParams = videoTabForHash(hash) === ownTab
    ? workspaceHashParams(hash)
    : new URLSearchParams();
  const [text, setText] = React.useState(
      videoHandoffInput(initialParams),
    ),
    [selected, setSelected] = React.useState(
      initialParams.get("engine") === "media" ? "" : initialParams.get("job") || "",
    ),
    [submitting, setSubmitting] = React.useState(false),
    [previewErrorId, setPreviewErrorId] = React.useState(null),
    [editingRetry, setEditingRetry] = React.useState(false),
    [collectionMode, setCollectionMode] = React.useState("posts");
  const inputRef = React.useRef(null);
  const [inputExpanded, setInputExpanded] = React.useState(Boolean(videoHandoffInput(initialParams)) && !initialParams.has("job"));
  const inputCount = isDownload ? videoInputLinks(text).length : 0;
  const { jobs, status, update, setError, error, loadError, loading, refresh } =
    useToolData(
      active,
      isDownload ? "download" : isTranscript ? "transcript" : "collection",
    );
  React.useEffect(() => { if (error) setInputExpanded(true); }, [error]);
  const mediaData = useMediaJobs(active && isDownload);
  const [mediaSelected, setMediaSelected] = React.useState("");
  React.useEffect(() => {
    if (!isDownload || videoTabForHash(hash) !== "download") return;
    const params = workspaceHashParams(hash);
    if (params.get("engine") === "media" && params.get("job")) setMediaSelected(params.get("job"));
    else if (params.has("job")) setMediaSelected("");
  }, [hash, isDownload]);
  const mediaJob = mediaSelected ? mediaData.jobs.find((item) => item.id === mediaSelected) : null;
  const job = selected ? jobs.find((item) => item.id === selected) : jobs[0];
  React.useEffect(() => {
    if (videoTabForHash(hash) !== ownTab) return;
    const params = workspaceHashParams(hash);
    if (params.has("input") || params.has("text")) { setText(videoHandoffInput(params)); setInputExpanded(!params.has("job")); }
    if (params.has("job") && params.get("engine") !== "media") setSelected(params.get("job") || "");
  }, [hash, ownTab]);
  React.useEffect(() => {
    if (
      !active || loading || !selected ||
      jobs.some((item) => item.id === selected)
    ) return;
    const controller = new AbortController();
    videoToolApi(`/api/tools/video/jobs/${selected}`, {
      signal: controller.signal,
    }).then((next) => {
      if (!controller.signal.aborted) update(next);
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [active, loading, selected, jobs, update, setError]);
  React.useEffect(() => {
    if (!selected && jobs[0]) setSelected(jobs[0].id);
  }, [jobs, selected]);
  const scope = status.scope;
  const copy = async (item) => {
    try {
      await navigator.clipboard.writeText(videoOriginalInput(item));
      showToast?.("已复制原始输入");
    } catch {
      setError("复制失败，请手动选择原始输入。");
    }
  };
  const fill = (item) => {
    setText(videoOriginalInput(item));
    setEditingRetry(true);
    setInputExpanded(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "center" });
    });
  };
  const submit = async (event, supplied) => {
    event?.preventDefault();
    const source = supplied ?? text;
    if (!source.trim() || submitting || !scope) return;
    if (isDownload && videoInputLinks(source).length > 1) return batch(source);
    setSubmitting(true);
    setError("");
    try {
      if (isDownload && mediaNeedsNewDownload(source)) {
        if (!mediaData.status.available) throw new Error("扩展下载服务暂未启用，请稍后再试。");
        const next = await mediaApi("/jobs", {method:"POST", body:{visibility:mediaData.status.scope,operation:"download",text:source,options:{}}});
        mediaData.update(next);
        setMediaSelected(next.id);
        setInputExpanded(false);
        window.location.hash = `#media-tools?${new URLSearchParams({tab:"download",space,engine:"media",job:next.id,text:source})}`;
        return;
      }
      const next = await videoToolApi("/api/tools/video/jobs", {
        method: "POST",
        body: {
          text: source,
          visibility: scope,
          kind: isTranscript
            ? "transcript"
            : isCollection
            ? "collection"
            : "download",
          ...isCollection ? { mode: collectionMode } : {},
          ...editingRetry ? { retry: true } : {},
        },
      });
      update(next);
      setSelected(next.id);
      setMediaSelected("");
      setEditingRetry(false);
      setInputExpanded(false);
    } catch (e) {
      setError(e.message);
      void refresh().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };
  const batch = async (source = text) => {
    if (!source.trim() || submitting || !scope) return;
    setSubmitting(true);
    setError("");
    try {
      if (videoInputLinks(source).length > 20) throw new Error("每次最多解析 20 条链接，请减少链接后重试。");
      if (videoInputLinks(source).some(mediaNeedsNewDownload)) throw new Error("扩展平台暂不支持批量解析，请单条提交 YouTube、Vimeo、X、Instagram 或 SoundCloud 链接。");
      const result = await videoToolApi("/api/tools/video/batch", {
        method: "POST",
        body: { text: source, visibility: scope },
      });
      for (const next of result.jobs || []) update(next);
      if (result.jobs?.[0]) {
        setSelected(result.jobs[0].id);
        setMediaSelected("");
        setEditingRetry(false);
        setInputExpanded(false);
      }
      showToast?.(`已加入 ${result.jobs?.length || 0} 条解析任务`);
    } catch (e) {
      setError(e.message);
      void refresh().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };
  const retry = async (item) => {
    setText(videoOriginalInput(item));
    setSubmitting(true);
    setError("");
    try {
      const next = await videoToolApi(
        `/api/tools/video/jobs/${item.id}/retry`,
        {
          method: "POST",
          body: { visibility: scope },
        },
      );
      update(next);
      setSelected(next.id);
      setEditingRetry(false);
    } catch (e) {
      setError(e.message);
      void refresh().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };
  const prepare = async (item, download) => {
    if (!item || videoBusy(item)) return;
    setError("");
    setPreviewErrorId(null);
    try {
      const next = await videoToolApi(`/api/tools/video/jobs/${item.id}/save`, {
        method: "POST",
        body: {},
      });
      update(next);
      if (download) showToast?.("正在准备文件，可在完成后下载");
    } catch (e) {
      setPreviewErrorId(item.id);
      setError(e.message);
    }
  };
  useAutomaticMediaPreview({ active: active && isDownload && !mediaSelected, job: mediaSelected ? null : job, onPrepare: prepare });
  const prepareAll = async () => {
    const ready = jobs.filter((item) =>
      item.kind === "download" && item.state === "parsed"
    );
    if (!ready.length || submitting) return;
    setSubmitting(true);
    setError("");
    let started = 0;
    for (const item of ready) {
      try {
        const next = await videoToolApi(
          `/api/tools/video/jobs/${item.id}/save`,
          {
            method: "POST",
            body: {},
          },
        );
        update(next);
        started++;
      } catch (e) {
        setError(e.message);
        break;
      }
    }
    setSubmitting(false);
    if (started) {
      showToast?.(`已依次准备 ${started} 条文件；完成后请逐个点击保存`);
    }
  };
  const openGroup = async (group, origin) => {
    if (submitting || !scope) return;
    setSubmitting(true);
    setError("");
    try {
      const next = await videoToolApi("/api/tools/video/jobs", {
        method: "POST",
        body: {
          text: origin,
          visibility: scope,
          kind: "collection",
          mode: group.kind,
          platform: group.platform,
          resourceId: group.id,
        },
      });
      update(next);
      setSelected(next.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  const transcribeSaved = async (item) => {
    if (!scope || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const next = await videoToolApi(
        `/api/tools/video/jobs/${item.id}/transcribe`,
        {
          method: "POST",
          body: { visibility: scope },
        },
      );
      const params = new URLSearchParams({
        tab: "transcribe",
        space,
        job: next.id,
        text: next.url,
      });
      window.location.hash = `#media-tools?${params}`;
    } catch (e) {
      setError(e.message);
      void refresh().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };
  const action = isCollection
    ? "读取内容"
    : isTranscript
    ? "开始转写"
    : inputCount > 1 ? `解析 ${inputCount} 条链接` : "解析链接";
  return (
    <section
      id={embedded ? panelId : undefined}
      role={embedded ? "tabpanel" : undefined}
      className="video-download tool-screen"
      hidden={!visible}
      aria-labelledby={embedded ? `media-tools-tab-${ownTab}` : titleId}
    >
      {!embedded && (
        <a className="video-breadcrumb" href={`#tools?space=${space}`}>
          ← 全部工具
        </a>
      )}
      {!embedded && (
        <header className="video-heading">
          <div>
            <h1 id={titleId}>{tool.name}</h1>
            <p>
              {isCollection
                ? "输入作者主页或公开合集链接。"
                : isTranscript
                ? "粘贴作品链接，完成后获取全文文本。"
                : "粘贴一条作品链接或分享文案。"}
            </p>
          </div>
          <span className="video-heading-icon">
            <tool.icon />
          </span>
        </header>
      )}
      {!embedded && <ToolLinks current={tool.id} space={space} />}
      {isTranscript && status.available &&
        status.features?.transcription === false && (
        <div className="video-error">
          转写服务尚未启用，下载和素材库仍可使用。
        </div>
      )}
      <div className={`video-workbench video-task-workbench${isDownload ? " video-download-workbench" : ""}`}>
        <div className="video-main">
          <div className={`video-input-panel${isDownload && (job || mediaJob) ? " has-result" : ""}${inputExpanded ? " input-expanded" : ""}`}>
          {isDownload && (job || mediaJob) && <button className="video-input-toggle" type="button" aria-expanded={Boolean(inputExpanded)} aria-controls={`${inputId}-content`} onClick={() => setInputExpanded(value => !value)}><IconPlus />{inputExpanded ? "收起链接输入" : "解析新链接"}</button>}
          <div className="video-input-content" id={`${inputId}-content`}>
          <form className="video-input-card" onSubmit={submit}>
            {isCollection && (
              <div
                className="collection-mode"
                role="tablist"
                aria-label="读取范围"
              >
                {[["posts", "作品"], ["mixes", "作者合集"], [
                  "collections",
                  "公开收藏",
                ]].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={collectionMode === id}
                    className={collectionMode === id ? "active" : ""}
                    onClick={() => setCollectionMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="video-input-heading">
              <label htmlFor={inputId}>
                {isCollection ? "主页或公开合集链接" : "链接或分享文案"}
              </label>
              <span>
                {isCollection
                  ? "公开内容"
                  : isDownload
                  ? "最多 20 条"
                  : "支持分享文案"}
              </span>
            </div>
            <textarea
              ref={inputRef}
              id={inputId}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={isCollection || isDownload ? 16384 : 4096}
              rows={isCollection ? 2 : 3}
              placeholder={isCollection
                ? "粘贴作者主页或公开合集链接…"
                : isDownload ? "粘贴作品链接或分享文案，支持多条链接…" : "把作品链接或分享文案粘贴到这里…"}
              spellCheck="false"
            />
            <div className="video-input-actions">
              <span className="video-platforms">抖音 <i /> TikTok <i /> 哔哩哔哩 {isDownload && <><i /> X 等</>}</span>
              <div className="tool-form-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={loading || submitting || !scope || !text.trim() ||
                    isTranscript && status.features?.transcription === false}
                >
                  {submitting ? "提交中…" : editingRetry && inputCount < 2 ? "重新解析" : action}
                </button>
              </div>
            </div>
          </form>
          <ScopeNote scope={loading || (isDownload && mediaData.loading && mediaData.jobs.length === 0) ? null : scope} error={loadError} />
          {isTranscript && (
            <p className="tool-hint">
              单次转写最多 10 分钟，完成后可复制全文或下载 TXT。
            </p>
          )}
          {isDownload && jobs.some((item) => item.state === "parsed") && (
            <button
              className="prepare-all"
              type="button"
              disabled={submitting}
              onClick={prepareAll}
            >
              依次准备全部待下载文件
            </button>
          )}
          {isCollection && (
            <p className="tool-hint">
              可读取公开作品和作者合集。个人收藏需要相应平台的登录身份，本站登录不会取得该权限。
            </p>
          )}
          {error && <div className="video-error" role="alert">{error}</div>}
          {status.available === false && (
            <div className="video-error">服务正在维护，请稍后再试。</div>
          )}
          </div>
          </div>
          <div className="video-preview-panel">
          {mediaJob && <MediaProcessingResult job={mediaJob} downloadWorkspace active={active} space={space} showToast={showToast} onRetry={async(item)=>{try{const next=await mediaApi(`/jobs/${item.id}/retry`,{method:"POST",body:{visibility:mediaData.status.scope}});mediaData.update(next);setMediaSelected(next.id);}catch(e){setError(e.message);}}}/>}
          {!mediaSelected && job && (
            <ToolResult
              job={job}
              mode={tool.id}
              space={space}
              submitting={submitting}
              onPrepare={prepare}
              onRetry={retry}
              onFill={fill}
              onCopy={copy}
              onDownloadItem={(item) => {
                const params = new URLSearchParams({
                  tab: "download",
                  space,
                  text: item.url || "",
                });
                window.location.hash = `#media-tools?${params}`;
              }}
              active={active}
              previewFailed={previewErrorId === job.id}
              onGroup={(group) => openGroup(group, videoOriginalInput(job))}
              onMore={async (item) => {
                try {
                  const next = await videoToolApi(
                    `/api/tools/video/jobs/${item.id}/more`,
                    { method: "POST", body: { visibility: scope } },
                  );
                  update(next);
                  setSelected(next.id);
                } catch (e) {
                  setError(e.message);
                }
              }}
              onTranscribe={isTranscript ? undefined : transcribeSaved}
              onDiscover={(operation, item) => {
                const input = operation === "music" ? item.content?.musicId : item.url;
                if (!input) return;
                window.location.hash = `#media-tools?${new URLSearchParams({
                  tab: "discover", space, discoveryMode: operation, input: String(input),
                })}`;
              }}
              showToast={showToast}
            />
          )} {!mediaSelected && !job && !loading && !error && (
            <div className="video-idle">
              <tool.icon />
              <div>
                <strong>
                  {isCollection
                    ? "从公开主页开始整理"
                    : isTranscript
                    ? "先保存，再转成文字"
                    : "预览并下载素材"}
                </strong>
                <p>{isDownload ? "粘贴链接开始解析，或从下载记录中选择一条素材。" : isTranscript ? "粘贴已发布作品的链接，提交后可在这里查看转写进度和文字。" : "粘贴公开作者主页或合集链接，提交后可在这里浏览作品。"}</p>
              </div>
            </div>
          )}
          {!mediaSelected && !job && loading && <div className="video-result-pending" role="status" aria-label="正在读取结果" aria-busy="true"><p className="loading-sr">正在读取结果</p><span className="sk-line"/><span className="sk-line"/><span className="sk-line"/></div>}
          {!mediaSelected && !job && !loading && error && <div className="video-idle" role="alert"><div><strong>结果暂时无法读取</strong><p>请检查提示后重试。</p></div></div>}
          <footer className="video-tool-footer">
            普通记录保留 30 天 · 素材记录保留 180 天 · 文件缓存可重新准备
          </footer>
          </div>
        </div>
        <ToolHistory
          compact
          title={isCollection
            ? "浏览记录"
            : isTranscript
            ? "转写记录"
            : loading || (isDownload && mediaData.loading && mediaData.jobs.length === 0)
            ? "正在确认下载记录归属"
            : error && !scope
            ? "下载记录暂不可用"
            : !scope
            ? "正在确认下载记录归属"
            : scope === "private"
            ? "我的下载记录"
            : "公共下载记录"}
          jobs={isDownload?[...jobs,...mediaData.jobs.filter(item=>item.operation==='download')].sort((a,b)=>b.created-a.created):jobs}
          pending={loading || (isDownload && mediaData.loading)}
          error={loadError || (isDownload ? mediaData.error : '')}
          selected={mediaSelected||job?.id}
          submitting={submitting}
          onSelect={(item) => {if(item.engine==='media')setMediaSelected(item.id);else {setMediaSelected('');setSelected(item.id);}window.location.hash=`#media-tools?${new URLSearchParams({tab:ownTab,space,job:item.id,...(item.engine==='media'?{engine:'media'}:{})})}`;}}
          onRetry={(item) => item.engine==='media'?mediaApi(`/jobs/${item.id}/retry`,{method:'POST',body:{visibility:mediaData.status.scope}}).then(next=>{mediaData.update(next);setMediaSelected(next.id);}).catch(e=>setError(e.message)):retry(item)}
          onCopy={copy}
        />
      </div>
    </section>
  );
}
function ToolLinks({ current, space }) {
  return (
    <nav className="tool-links" aria-label="工具切换">
      {VIDEO_TOOL_CATALOG.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}?space=${space}`}
          className={item.id === current ? "active" : ""}
        >
          {item.name}
        </a>
      ))}
    </nav>
  );
}
function ScopeNote({ scope, error = '' }) {
  return (
    <p
      className={`video-scope-note ${scope === "private" ? "is-private" : ""}`}
    >
      <span className="video-scope-dot" />
      {scope === "private"
        ? "个人记录 · 原始输入、文件与处理记录仅你可见"
        : scope === "public"
        ? "公开记录 · 未登录提交的原文和处理记录对所有人可见"
        : error ? "暂时无法确认记录归属，请重试" : "正在确认记录归属…"}
    </p>
  );
}
function ToolActionMenu({ children, label = "更多", ariaLabel = "更多操作" }) {
  const buttonRef = React.useRef(null), menuRef = React.useRef(null);
  const [position, setPosition] = React.useState(null);
  const close = (restore = false) => {
    setPosition(null);
    if (restore) buttonRef.current?.focus({ preventScroll: true });
  };
  React.useLayoutEffect(() => {
    if (!position || !menuRef.current) return;
    const menu = menuRef.current, rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(position.left, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(position.top, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [position]);
  React.useEffect(() => {
    if (!position) return;
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) close();
    };
    const resize = () => close();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", resize);
    window.addEventListener("hashchange", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("hashchange", resize);
    };
  }, [position]);
  return <>
    <button ref={buttonRef} type="button" className="btn btn-ghost tool-more-trigger" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
      if (position) return close();
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({ left: rect.left, top: rect.bottom + 5 });
    }}>{label}</button>
    {position && ReactDOM.createPortal(<div ref={menuRef} className="media-context-menu tool-action-menu" role="menu" aria-label={ariaLabel} style={position} onClick={event => {
      if (event.target.closest('[role="menuitem"]')) close(true);
    }} onKeyDown={event => {
      const items = [...menuRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>{React.Children.toArray(children).map(child => React.cloneElement(child, { role: "menuitem" }))}</div>, document.body)}
  </>;
}
function ToolResult(
  {
    job,
    mode,
    space = "public",
    active = true,
    previewFailed = false,
    submitting,
    onPrepare,
    onRetry,
    onFill,
    onCopy,
    onDownloadItem,
    onGroup,
    onMore,
    onTranscribe,
    onDiscover,
    showToast,
  },
) {
  const resultRef = React.useRef(null);
  React.useEffect(() => {
    if (!active) {
      resultRef.current?.querySelectorAll("video,audio").forEach((media) =>
        media.pause()
      );
    }
  }, [active]);
  const content = job.content,
    transcript = job.transcript,
    collection = job.collection,
    files = job.files || [],
    video = files.find((file) => file.type?.startsWith("video/")),
    cover = files.find((file) =>
      file.kind === "cover" || /^cover\./.test(file.name)
    ),
    images = files.filter((file) =>
      file.type?.startsWith("image/") && file !== cover
    ),
    otherFiles = files.filter((file) =>
      file !== video && file !== cover && !images.includes(file)
    );
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(transcript?.text || "");
      showToast?.("已复制全文");
    } catch {
      showToast?.("复制失败，请手动选择全文。");
    }
  };
  const supportsDiscovery = Boolean(
    onDiscover && content?.hasVideo && job.url &&
    ["douyin", "tiktok", "bilibili"].includes(job.platform),
  );
  const downloadAll = () => {
    for (const file of files) {
      const a = document.createElement("a");
      a.href = videoFileHref(job, file);
      a.download = file.label || file.name;
      document.body.append(a);
      a.click();
      a.remove();
    }
    showToast?.("已请求全部文件；浏览器可能会要求允许多文件下载");
  };
  return (
    <section ref={resultRef} className="video-result" aria-label="处理结果">
      <div className="video-result-head">
        <span className="video-platform">
          {videoPlatformName[job.platform] ||
            (mode === "video-collections" ? "资料" : "作品")}
        </span>
        <span className={`video-status state-${job.state}`}>
          {videoBusy(job) && <span className="video-spinner" />}
          {mode === "video-download" && job.state === "parsed" && !job.error && !previewFailed
            ? "正在加载预览"
            : videoStateName[job.state] || job.state}
        </span>
      </div>
      {content && (
        <>
          <h2>{content.title}</h2>
          <p className="video-meta">
            {[
              content.author,
              content.duration > 0
                ? `${Math.floor(content.duration / 6e4)}:${
                  String(Math.floor(content.duration / 1e3) % 60).padStart(
                    2,
                    "0",
                  )
                }`
                : "",
              content.imageCount ? `${content.imageCount} 张图片` : "",
            ].filter(Boolean).join(" · ")}
          </p>
        </>
      )}
      {job.error && <p className="video-error">{job.error}</p>}
      {mode === "video-download" && job.state === "parsed" && !job.error && !previewFailed && (
        <LoadingSkeleton variant="player" label="正在加载预览" />
      )}
      {videoBusy(job) && (
        <p className="video-pending-text">
          {job.state === "transcribing"
            ? "正在识别语音…"
            : job.state === "browsing"
            ? "正在读取列表…"
            : "正在后台处理中，完成后可从记录查看。"}
        </p>
      )}
      {collection && (
        <CollectionResult
          collection={collection}
          onDownloadItem={onDownloadItem}
          onGroup={onGroup}
          onMore={() => onMore(job)}
        />
      )} {transcript?.text && (
        <div className="transcript-text">
          <div>
            <h3>转写全文</h3>
            <span>{transcript.text.length} 字</span>
          </div>
          <p>{transcript.text}</p>
          <div className="video-original-actions">
            <button className="btn btn-primary" onClick={copyText}>
              <IconCopy />复制全文
            </button>
            <a className="btn btn-ghost" href={`/api/tools/video/jobs/${job.id}/transcript.txt`} download>
              下载 TXT
            </a>
          </div>
        </div>
      )}
      {job.state === "saved" && (
        <div className="video-media">
          {video && (
            <video
              controls
              playsInline
              preload="none"
              poster={cover ? videoFileHref(job, cover, true) : void 0}
              src={active ? videoFileHref(job, video, true) : undefined}
            />
          )} {images.length > 0 && (
            <div className="video-image-grid">
              {images.map((file, i) => (
                <figure key={file.name}>
                  <MediaThumbnail
                    src={videoFileHref(job, file, true)}
                    alt={`作品图片 ${i + 1}`}
                  />
                  <a href={videoFileHref(job, file)} download={file.label}>
                    <IconDownload />图片 {i + 1}
                    <small>{videoFileSize(file.bytes)}</small>
                  </a>
                </figure>
              ))}
            </div>
          )}
          {otherFiles.length > 0 && (
            <div className="tool-file-list">
              {otherFiles.map((file) => (
                <a
                  key={file.name}
                  href={videoFileHref(job, file)}
                  download={file.label}
                >
                  <IconDownload />
                  {file.label || file.name}
                  <small>{videoFileSize(file.bytes)}</small>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {content && (
        <div className="video-result-actions">
          {job.state === "parsed" && mode === "video-download" && (job.error || previewFailed) && (
            <button
              className="btn btn-ghost"
              disabled={videoBusy(job) || submitting}
              onClick={() => onPrepare(job, false)}
            >
              重试加载预览
            </button>
          )}
          {video && job.state === "saved" && (
            <a
              className="btn btn-primary"
              href={videoFileHref(job, video)}
              download={video.label}
            >
              <IconDownload />下载视频
            </a>
          )}
          {!video && images.length > 0 && job.state === "saved" && <a className="btn btn-primary" href={videoFileHref(job, images[0])} download={images[0].label}><IconDownload />下载图片</a>}
          {job.state === "saved" && (video || images[0]) && <a className="btn btn-ghost" href={mediaProcessHref(job, video || images[0], space)}>继续处理</a>}
          <ToolActionMenu key={job.id} ariaLabel="当前素材的更多操作">
          {onTranscribe && !videoBusy(job) && content?.hasVideo &&
            (job.state === "parsed" || job.state === "saved") && (
            <button
              className="btn btn-ghost"
              disabled={submitting}
              onClick={() => onTranscribe(job)}
            >
              <IconType />提取文字
            </button>
          )}
          {supportsDiscovery && (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={videoBusy(job) || submitting}
              onClick={() => onDiscover("comments", job)}
            >
              查看评论
            </button>
          )}
          {supportsDiscovery && content?.musicId &&
            ["douyin", "tiktok"].includes(job.platform) && (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={videoBusy(job) || submitting}
              onClick={() => onDiscover("music", job)}
            >
              音乐详情
            </button>
          )}
          {files.length > 1 && job.state === "saved" && (
            <button className="btn btn-ghost" onClick={downloadAll}>
              下载全部文件
            </button>
          )}
          {cover && (
            <a
              className="video-text-action"
              href={videoFileHref(job, cover)}
              download={cover.label}
            >
              下载封面
            </a>
          )}
          {job.url && (
            <a
              className="video-source"
              target="_blank"
              rel="noopener noreferrer"
              href={job.url}
            >
              打开原作品
            </a>
          )}
          </ToolActionMenu>
        </div>
      )}
      <details className="video-source-details" key={job.id}>
      <summary>原始输入与重新解析</summary>
      <OriginalInput
        job={job}
        busy={submitting || videoBusy(job)}
        onCopy={onCopy}
        onFill={onFill}
        onRetry={onRetry}
      />
      </details>
    </section>
  );
}
function CollectionResult({ collection, onDownloadItem, onGroup, onMore }) {
  const items = collection.items || [], groups = collection.groups || [];
  return (
    <div className="collection-result">
      <div className="collection-title">
        <h3>{collection.title || "公开内容"}</h3>
        <span>
          {groups.length ? `${groups.length} 个合集` : `${items.length} 条`}
        </span>
      </div>
      {groups.length > 0 && (
        <div className="collection-groups">
          {groups.map((group) => (
            <button
              type="button"
              key={`${group.kind}:${group.id}`}
              onClick={() => onGroup(group)}
            >
              {group.title}
              {group.count ? ` · ${group.count}` : ""}
            </button>
          ))}
        </div>
      )}
      <ul>
        {items.map((item) => (
          <li key={`${item.platform}:${item.contentId}`}>
            <div>
              <strong>{item.title || "未命名作品"}</strong>
              <span>
                {[videoPlatformName[item.platform], item.author].filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {item.url && (
              <button
                type="button"
                onClick={() => onDownloadItem(item)}
              >
                下载
              </button>
            )}
          </li>
        ))}
      </ul>
      {collection.hasMore && (
        <button className="btn btn-ghost collection-more" onClick={onMore}>
          读取更多
        </button>
      )}
    </div>
  );
}
function OriginalInput({ job, busy, onCopy, onFill, onRetry }) {
  return (
    <div className="video-original">
      <div className="video-original-heading">
        <h3>原始输入</h3>
        <span>{job.visibility === "public" ? "公开" : "仅自己可见"}</span>
      </div>
      <p>{videoOriginalInput(job)}</p>
      <div className="video-original-actions">
        <button type="button" onClick={() => onCopy(job)}>
          <IconCopy />复制原文
        </button>
        <button type="button" disabled={busy} onClick={() => onFill(job)}>
          填回编辑
        </button>
        <button type="button" disabled={busy} onClick={() => onRetry(job)}>
          <IconRefresh />重新解析
        </button>
      </div>
    </div>
  );
}
function ToolHistory(
  { title, jobs, selected, submitting, onSelect, onRetry, onCopy, compact = false, pending = false, error = '' },
) {
  const [query, setQuery] = React.useState("");
  const visible = jobs.filter((item) =>
    `${item.content?.title || ""} ${item.collection?.title || ""} ${
      videoOriginalInput(item)
    }`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <aside className="video-history">
      <div className="video-history-heading">
        <div>
          <h2>{title}</h2>
          <span>{pending && !jobs.length ? '正在读取记录…' : error && !jobs.length ? '记录读取失败' : `${jobs.length} 条记录`}</span>
        </div>
        <IconClock />
      </div>
      {jobs.length > 0 && (
        <label className="video-history-search">
          <IconSearch />
          <input
            type="search"
            aria-label={`搜索${title}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题或原始输入"
          />
        </label>
      )}
      {visible.length === 0
        ? pending && !jobs.length ? <div className="video-history-pending" role="status" aria-label="正在读取记录" aria-busy="true"><span className="sk-line"/><span className="sk-line"/></div>
        : error && !jobs.length ? <p className="video-history-empty" role="alert">记录未能读取，请稍后重试。</p>
        : <p className="video-history-empty">{query ? "没有匹配的记录" : "还没有记录"}</p>
        : (
          <ul>
            {visible.map((item) => (
              <li
                key={item.id}
                className={selected === item.id ? "selected" : ""}
              >
                <button
                  className="video-history-open"
                  aria-current={selected === item.id ? "true" : undefined}
                  onClick={() => onSelect(item)}
                >
                  {compact && <span className="video-history-thumb">{(item.files || []).some(file => file.type?.startsWith("image/")) ? <MediaThumbnail src={mediaFileHref(item, item.files.find(file => file.kind === "cover") || item.files.find(file => file.type?.startsWith("image/")), true)} alt="" /> : <IconDownload />}</span>}
                  <span className="video-history-copy">
                  <span className="video-history-meta">
                    <span>
                      {videoPlatformName[item.platform] ||
                        (item.kind === "transcript" ? "转写" : "资料")}
                    </span>
                    <time>
                      {new Date(item.created).toLocaleDateString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                      })}
                    </time>
                  </span>
                  <strong>
                    {item.content?.title || item.collection?.title ||
                      (videoBusy(item) ? "正在处理…" : "未命名记录")}
                  </strong>
                  <span className="video-history-input">
                    {videoOriginalInput(item)}
                  </span>
                  </span>
                </button>
                <div className="video-history-actions">
                  <span className={`video-status state-${item.state}`}>
                    {videoStateName[item.state] || item.state}
                  </span>
                  {item.state === "failed" && <button type="button" disabled={submitting} onClick={() => onRetry(item)}>重试</button>}
                  <ToolActionMenu ariaLabel="记录的更多操作">
                  <button type="button" onClick={() => onCopy(item)}><IconCopy />复制原文</button>
                  <button
                    disabled={submitting || videoBusy(item)}
                    onClick={() => onRetry(item)}
                    title="重新解析"
                  >
                    <IconRefresh />重新解析
                  </button>
                  </ToolActionMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
    </aside>
  );
}
function MediaLibraryTool(
  {
    active,
    visible = true,
    embedded = false,
    hash = window.location.hash,
    space,
    showToast,
    onNavigate,
  },
) {
  const panelId = "media-tools-panel-library";
  const titleId = "media-tools-panel-title-library";
  return (
    <section
      id={embedded ? panelId : undefined}
      role={embedded ? "tabpanel" : undefined}
      className="video-download tool-screen"
      hidden={!visible}
      aria-labelledby={embedded ? "media-tools-tab-library" : titleId}
    >
      {!embedded && (
        <a className="video-breadcrumb" href={`#tools?space=${space}`}>
          ← 全部工具
        </a>
      )}
      {!embedded && (
        <header className="video-heading">
          <div>
            <h1 id={titleId}>素材库</h1>
            <p>查找已保存的作品、图片和转写文本。</p>
          </div>
          <span className="video-heading-icon">
            <IconInbox />
          </span>
        </header>
      )}
      {!embedded && <ToolLinks current="media-library" space={space} />}
      <MediaLibrary
        active={active}
        hash={hash}
        space={space}
        showToast={showToast}
        onNavigate={onNavigate}
      />
    </section>
  );
}
const mediaImageTasks = [];
let activeMediaImages = 0;
function scheduleMediaImage(start) {
  const task = { start, state: "waiting" };
  const drain = () => {
    while (activeMediaImages < 2 && mediaImageTasks.length) {
      const next = mediaImageTasks.shift();
      next.state = "active";
      activeMediaImages++;
      next.start();
    }
  };
  mediaImageTasks.push(task);
  drain();
  return () => {
    if (task.state === "done") return;
    if (task.state === "active") activeMediaImages--;
    else mediaImageTasks.splice(mediaImageTasks.indexOf(task), 1);
    task.state = "done";
    drain();
  };
}
function MediaThumbnail({ src, alt = "", video = false }) {
  const ref = React.useRef(null);
  const task = React.useRef(null);
  const [requested, setRequested] = React.useState(null);
  const [failed, setFailed] = React.useState(null);
  React.useEffect(() => {
    let release;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      release = scheduleMediaImage(() => setRequested(src));
      task.current = { src, release };
    }, { rootMargin: "160px" });
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      release?.();
    };
  }, [src]);
  const finish = () => {
    if (task.current?.src === src) task.current.release();
  };
  return failed === src
    ? <span className="media-image-fallback">预览暂不可用</span>
    : video ? <video key={src} ref={ref} src={requested === src ? `${src}#t=0.1` : undefined} muted playsInline preload="metadata" aria-hidden="true" onLoadedMetadata={finish} onLoadedData={finish} onError={() => { setFailed(src); finish(); }} />
    : (
      <img
        key={src}
        ref={ref}
        src={requested === src ? src : undefined}
        alt={alt}
        onLoad={finish}
        onError={() => {
          finish();
          setFailed(src);
        }}
      />
    );
}
function MediaQuickPreview({ items, index, onChange, onClose }) {
  const dialogRef = React.useRef(null);
  const [imageIndex, setImageIndex] = React.useState(0);
  const item = items[index];
  const files = item.files || [];
  const video = files.find((file) => file.type?.startsWith("video/"));
  const audio = files.find((file) => file.type?.startsWith("audio/"));
  const cover = files.find((file) =>
    file.kind === "cover" || /^cover\./.test(file.name)
  );
  const images = files.filter((file) =>
    file.type?.startsWith("image/") && file !== cover
  );
  const image = images[imageIndex] || images[0] || cover;
  const text = item.transcript?.text;
  const download = text ? null : video || audio || image;
  React.useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  React.useEffect(() => setImageIndex(0), [item.id]);
  const navigate = (step) =>
    onChange(Math.min(items.length - 1, Math.max(0, index + step)));
  return (
    <dialog
      ref={dialogRef}
      className="media-preview-dialog"
      aria-labelledby="media-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.target.closest("video, audio, input, textarea")) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="media-preview-surface">
        <header>
          <div>
            <h2 id="media-preview-title">
              {item.content?.title || "素材预览"}
            </h2>
            <p>
              {[videoPlatformName[item.platform], item.content?.author].filter(
                Boolean,
              ).join(" · ")}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            autoFocus
          >
            <IconX />
          </button>
        </header>
        <div className={`media-preview-stage${text ? " is-text" : ""}`}>
          {text ? <p>{text}</p> : video
            ? (
              <video
                key={item.id}
                controls
                playsInline
                preload="none"
                poster={cover ? mediaFileHref(item, cover, true) : undefined}
                src={mediaFileHref(item, video, true)}
              />
            )
            : audio
            ? <audio controls preload="none" src={mediaFileHref(item, audio, true)} />
            : image
            ? (
              <MediaThumbnail
                src={mediaFileHref(item, image, true)}
                alt={item.content?.title || "素材图片"}
              />
            )
            : <p>文件暂不可预览，请返回详情重新准备。</p>}
        </div>
        {!text && !video && images.length > 1 && (
          <div className="media-preview-images" aria-label="图集图片">
            {images.map((file, i) => (
              <button
                type="button"
                key={file.name}
                aria-label={`查看第 ${i + 1} 张图片`}
                aria-pressed={i === imageIndex}
                onClick={() => setImageIndex(i)}
              >
                <MediaThumbnail src={mediaFileHref(item, file, true)} alt="" />
              </button>
            ))}
          </div>
        )}
        <footer>
          <div>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => navigate(-1)}
            >
              ← 上一项
            </button>
            <span>{index + 1} / {items.length}</span>
            <button
              type="button"
              disabled={index === items.length - 1}
              onClick={() => navigate(1)}
            >
              下一项 →
            </button>
          </div>
          {text
            ? (
              <a
                href={`/api/tools/video/jobs/${item.id}/transcript.txt`}
                download
              >
                <IconDownload />下载 TXT
              </a>
            )
            : download && (
              <a href={mediaFileHref(item, download)} download={download.label}>
                <IconDownload />下载{video ? "视频" : audio ? "音频" : "图片"}
              </a>
            )}
        </footer>
      </div>
    </dialog>
  );
}
function MediaContextMenu(
  { menu, busy, onClose, onPreview, onCopy, onFill, onRetry, onTranscribe, space },
) {
  const ref = React.useRef(null);
  const item = menu.item;
  const file = (item.files || []).find((file) =>
    file.type?.startsWith("video/") || file.type?.startsWith("audio/") || file.type?.startsWith("image/")
  );
  const [position, setPosition] = React.useState({ left: menu.x, top: menu.y });
  const restoreFocus = () => {
    const anchor = menu.anchor.matches("button")
      ? menu.anchor
      : menu.anchor.querySelector(".library-card-select");
    anchor?.focus({ preventScroll: true });
  };
  React.useLayoutEffect(() => {
    const rect = ref.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)),
    });
    ref.current.querySelector('[role="menuitem"]')?.focus({
      preventScroll: true,
    });
  }, [menu]);
  React.useEffect(() => {
    const outside = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const scroll = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", scroll, { passive: true });
    window.addEventListener("touchmove", scroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", scroll);
      window.removeEventListener("touchmove", scroll);
    };
  }, [onClose]);
  const run = (action) => {
    restoreFocus();
    onClose();
    action(item);
  };
  return ReactDOM.createPortal(
    <div
      ref={ref}
      className="media-context-menu"
      role="menu"
      aria-label="素材操作"
      style={position}
      onKeyDown={(event) => {
        const controls = [
          ...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)'),
        ];
        const index = controls.indexOf(document.activeElement);
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          restoreFocus();
          onClose();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home"
            ? 0
            : event.key === "End"
            ? controls.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) %
              controls.length;
          controls[next]?.focus();
        }
      }}
    >
      <button role="menuitem" onClick={() => run(onPreview)}>
        放大预览 <kbd>Space</kbd>
      </button>
      {file && (
        <a
          role="menuitem"
          href={mediaFileHref(item, file)}
          download={file.label}
          onClick={() => {
            restoreFocus();
            onClose();
          }}
        >
          <IconDownload />下载文件
        </a>
      )}
      {item.transcript?.text && (
        <a
          role="menuitem"
          href={`/api/tools/video/jobs/${item.id}/transcript.txt`}
          download
          onClick={() => {
            restoreFocus();
            onClose();
          }}
        >
          <IconType />下载 TXT
        </a>
      )}
      <hr />
      {file && <a role="menuitem" href={mediaProcessHref(item,file,space)} onClick={onClose}>继续处理 →</a>}
      {file?.type?.match(/^(video|audio)\//) && <a role="menuitem" href={mediaProcessHref(item,file,space,'subtitles')} onClick={onClose}>生成字幕</a>}
      {file?.type?.match(/^(video|audio)\//) && <a role="menuitem" href={mediaProcessHref(item,file,space,'audio')} onClick={onClose}>音频处理</a>}
      <button role="menuitem" onClick={() => run(onCopy)}>
        <IconCopy />复制原文
      </button>
      {item.engine!=='media' && <button role="menuitem" disabled={busy} onClick={() => run(onFill)}>
        填回解析
      </button>}
      <button
        role="menuitem"
        disabled={busy || videoBusy(item)}
        onClick={() => run(onRetry)}
      >
        <IconRefresh />重新处理
      </button>
      {item.engine!=='media' && item.kind === "download" && item.content?.hasVideo &&
        item.content.duration <= 600000 &&
        ["parsed", "saved"].includes(item.state) && (
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => run(onTranscribe)}
        >
          <IconType />提取文字
        </button>
      )}
      {item.url && (
        <a
          role="menuitem"
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
        >
          打开原作品 ↗
        </a>
      )}
    </div>,
    document.body,
  );
}
function MediaLibrary({ active, hash, space, showToast, onNavigate }) {
  const pickerParams = workspaceHashParams(hash);
  const pickerMode = videoTabForHash(hash) === 'library' && Object.prototype.hasOwnProperty.call(MEDIA_MODE_NAMES, pickerParams.get('pickFor')) ? pickerParams.get('pickFor') : '';
  const pickerOperation = mediaModeOperation(pickerMode, pickerParams.get('operation')) || MEDIA_MODE_OPERATIONS[pickerMode]?.[0] || '';
  const pickerReturnHref = `#media-tools?${new URLSearchParams({tab:pickerMode==='subtitles'?'transcribe':pickerMode,space,operation:pickerOperation,...(pickerMode==='subtitles'?{textMode:'subtitles'}:{})})}`;
  const pickerHref = item => {
    const file = pickerMode && mediaPickFile(item,pickerMode,pickerOperation);
    return file ? mediaProcessHref(item,file,space,pickerMode,pickerOperation) : '';
  };
  const [query, setQuery] = React.useState(""),
    [type, setType] = React.useState("all"),
    [items, setItems] = React.useState([]),
    [scope, setScope] = React.useState(null),
    [error, setError] = React.useState(""),
    [loading, setLoading] = React.useState(true),
    [selected, setSelected] = React.useState(
      videoTabForHash(hash) === "library"
        ? workspaceHashParams(hash).get("job") || ""
        : "",
    ),
    [busy, setBusy] = React.useState(false),
    [isMobile, setIsMobile] = React.useState(() =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 900px)").matches
    );
  React.useEffect(() => { if (pickerMode) setType('all'); }, [pickerMode,pickerOperation]);
  const request = React.useRef(0);
  const listRef = React.useRef(null);
  const detailRef = React.useRef(null);
  const selectionRef = React.useRef(null);
  const [previewId, setPreviewId] = React.useState(null);
  const [menu, setMenu] = React.useState(null);
  const [mobileDetail, setMobileDetail] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setPreviewId(null);
      setMenu(null);
    }
  }, [active]);
  React.useEffect(() => {
    setMenu(null);
    setMobileDetail(false);
  }, [query, type]);
  React.useEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px)");
    if (!media) return;
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);
  const selectItem = React.useCallback((id, element) => {
    setSelected(id);
    window.location.hash = `#media-tools?${new URLSearchParams({tab:'library',space,job:id,...(pickerMode?{pickFor:pickerMode,operation:pickerOperation}:{})})}`;
    selectionRef.current = element || document.activeElement;
    if (window.matchMedia?.("(max-width: 900px)")?.matches) {
      setMobileDetail(true);
    }
  }, [space,pickerMode,pickerOperation]);
  const openPreview = (item) => {
    setSelected(item.id);
    setPreviewId(item.id);
    setMenu(null);
  };
  const openMenu = (event, item) => {
    event.preventDefault();
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    setSelected(item.id);
    setMenu({
      item,
      anchor: element,
      x: event.clientX || rect.left,
      y: event.clientY || rect.bottom,
    });
  };
  const cardKeyDown = (event, item, index) => {
    if (event.key === " ") {
      event.preventDefault();
      openPreview(item);
    } else if (
      event.key === "ContextMenu" || event.shiftKey && event.key === "F10"
    ) {
      openMenu(event, item);
    } else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      const columns =
        getComputedStyle(listRef.current).gridTemplateColumns.split(" ").length;
      const step = event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp"
        ? -columns
        : columns;
      const next = Math.min(items.length - 1, Math.max(0, index + step));
      setSelected(items[next].id);
      listRef.current?.querySelectorAll(".library-card-select")[next]?.focus();
    }
  };
  const load = React.useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const r = await videoToolApi(
        `/api/tools/video/jobs?view=library&q=${
          encodeURIComponent(query)
        }&type=${type}`,
      );
      let mediaJobs = [], mediaError = "";
      try {
        const state = await mediaApi('/status');
        if (state.available) {
          const media = await mediaApi(`/jobs?view=library&q=${encodeURIComponent(query)}&type=${type}`);
          mediaJobs = media.jobs || [];
        }
      } catch (e) { mediaError = `处理素材暂时无法读取：${e.message}`; }
      if (current !== request.current) return;
      setItems([...(r.jobs || []), ...mediaJobs].filter(item=>!pickerMode||mediaPickFile(item,pickerMode,pickerOperation)).sort((a,b)=>b.created-a.created));
      setScope(r.scope);
      setError(mediaError);
    } catch (e) {
      if (current === request.current) setError(e.message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [query, type,pickerMode,pickerOperation]);
  React.useEffect(() => {
    if (!active) return;
    const t = setTimeout(load, query ? 250 : 0);
    return () => {
      clearTimeout(t);
      request.current++;
    };
  }, [active, load]);
  React.useEffect(() => {
    if (videoTabForHash(hash) !== "library") return;
    const params = workspaceHashParams(hash);
    if (params.has("job")) {
      setSelected(params.get("job") || "");
      setMobileDetail(Boolean(params.get("job")));
    }
  }, [hash]);
  const selectedItem = items.find((item) => item.id === selected) ||
    (!isMobile ? items[0] : undefined);
  const previewIndex = items.findIndex((item) => item.id === previewId);
  React.useEffect(() => {
    if (!active || !isMobile || !mobileDetail || !selectedItem) return;
    const frame = requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ block: "start" })
    );
    return () => cancelAnimationFrame(frame);
  }, [active, isMobile, mobileDetail, selectedItem?.id]);
  const copy = async (item) => {
    try {
      await navigator.clipboard.writeText(videoOriginalInput(item));
      showToast?.("已复制原始输入");
    } catch {
      setError("复制失败，请手动选择文字。");
    }
  };
  const retry = async (item) => {
    if (busy || !scope) return;
    setBusy(true);
    try {
      if (item.engine === 'media' && item.kind === 'upload') throw new Error('上传记录不能重试，请重新选择文件上传。');
      const next = await (item.engine === 'media' ? mediaApi : videoToolApi)(
        `${item.engine === 'media' ? '' : '/api/tools/video'}/jobs/${item.id}/retry`,
        {
          method: "POST",
          body: { visibility: scope },
        },
      );
      const tab = item.engine === 'media' ? item.operation === 'download' ? 'download' : item.operation === 'remove-background' ? 'image' : 'process' : next.kind === "transcript" ? "transcribe" : "download";
      window.location.hash = `#media-tools?${new URLSearchParams({
        tab,
        space,
        job: next.id,
        ...(item.engine === 'media' ? {engine:'media'} : {}),
        text: videoOriginalInput(next),
      })}`;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const fill = (item) => {
    if (item.engine === 'media') { window.location.hash = `#media-tools?${new URLSearchParams({tab:'download',space,text:videoOriginalInput(item)})}`; return; }
    const tab = item.kind === "transcript" ? "transcribe" : "download";
    window.location.hash = `#media-tools?${new URLSearchParams({
      tab,
      space,
      text: videoOriginalInput(item),
    })}`;
  };
  const transcribe = async (item) => {
    if (busy || !scope) return;
    setBusy(true);
    try {
      const next = await videoToolApi(
        `/api/tools/video/jobs/${item.id}/transcribe`,
        { method: "POST", body: { visibility: scope } },
      );
      window.location.hash = `#media-tools?${new URLSearchParams({
        tab: "transcribe",
        space,
        job: next.id,
        text: next.url,
      })}`;
    } catch (e) {
      setError(e.message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ScopeNote scope={scope} />
      {pickerMode&&<div className="library-picker-note" role="status"><div><strong>为{MEDIA_MODE_NAMES[pickerMode]}选择素材</strong><span>{pickerMode==='audio'&&pickerOperation==='trim'?'仅显示音频文件':pickerMode==='image'?'仅显示图片':pickerMode==='subtitles'||pickerOperation==='separate'?'仅显示视频和音频':'仅显示视频'}</span></div><a href={pickerReturnHref}>返回{MEDIA_MODE_NAMES[pickerMode]}</a></div>}
      <div className="library-controls">
        <label className="video-history-search">
          <IconSearch />
          <input
            aria-label="搜索素材"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、原始输入或转写内容"
          />
        </label>
        {!pickerMode&&<div role="group" aria-label="素材类型">
          {[["all", "全部"], ["video", "视频"], ["audio", "音频"], ["image", "图片"], [
            "text",
            "文字",
          ]].map(([key, label]) => (
            <button
              key={key}
              className={type === key ? "active" : ""}
              aria-pressed={type === key}
              onClick={() => setType(key)}
            >
              {label}
            </button>
          ))}
        </div>}
      </div>
      {error && (
        <div className="video-error">
          {error}
          <button type="button" className="video-error-retry" onClick={load}>
            重新读取
          </button>
        </div>
      )}
      <div className="library-toolbar-note">
        <span>{loading && !items.length ? <span className="sk-line" style={{display:"inline-block",width:88}} aria-label="正在读取数量" /> : `${items.length} 项素材`}</span>
        <span>单击查看详情 · 双击或空格预览</span>
      </div>
      <div
        className={`library-workbench${
          isMobile && mobileDetail ? " showing-detail" : ""
        }`}
      >
        <div ref={listRef} className="library-grid">
          {loading && !items.length
            ? <LoadingSkeleton variant="gallery" label="正在读取素材" />
            : items.length === 0
            ? <p>{pickerMode?'没有匹配的素材，可返回处理页上传文件。':'还没有可用素材。'}</p>
            : items.map((item, index) => {
              const file = pickerMode ? mediaPickFile(item,pickerMode,pickerOperation) : (item.files || []).find((f) =>
                f.type?.startsWith("video/") || f.type?.startsWith("audio/") || f.type?.startsWith("image/")
              );
              const isText = !pickerMode && Boolean(item.transcript?.text);
              const previewFile = isText
                ? undefined
                : (item.files || []).find((f) =>
                  f.kind === "cover" || /^cover\./.test(f.name) ||
                  f.type?.startsWith("image/")
                );
              const hasVideo = Boolean(item.content?.hasVideo) ||
                (item.files || []).some((f) => f.type?.startsWith("video/"));
              const hasAudio = (item.files || []).some((f) => f.type?.startsWith("audio/"));
              const typeLabel = isText ? "文字" : hasVideo ? "视频" : hasAudio ? "音频" : "图片";
              return (
                <article
                  key={item.id}
                  className={selectedItem?.id === item.id ? "selected" : ""}
                  onContextMenu={(event) => openMenu(event, item)}
                >
                  <button
                    type="button"
                    className="library-card-select"
                    onClick={(event) =>
                      selectItem(item.id, event.currentTarget)}
                    onDoubleClick={() => openPreview(item)}
                    onKeyDown={(event) => cardKeyDown(event, item, index)}
                    aria-label={`选择素材：${
                      mediaDisplayTitle(item)
                    }`}
                    aria-pressed={selectedItem?.id === item.id}
                  >
                    <div className="library-card-preview">
                      {previewFile
                        ? (
                          <MediaThumbnail
                            src={mediaFileHref(item, previewFile, true)}
                          />
                        )
                        : isText
                        ? <p>{item.transcript.text}</p>
                        : hasVideo && file ? <span aria-label="视频，点击预览播放">▶ 视频</span>
                        : hasAudio ? <span>♫ 音频</span>
                        : <span>等待文件</span>}
                      <span className="library-type">{typeLabel}</span>
                    </div>
                    <div className="library-card-head">
                      <span>{videoPlatformName[item.platform] || "资料"}</span>
                      <time>
                        {new Date(item.created).toLocaleDateString("zh-CN")}
                      </time>
                    </div>
                    <strong>
                      {mediaDisplayTitle(item)}
                    </strong>
                    <p title={videoOriginalInput(item)}>{file ? [file.name?.split('.').pop()?.toUpperCase(), videoFileSize(file.bytes || 0)].filter(Boolean).join(' · ') : '文字记录'}</p>
                  </button>
                  <div className="library-card-actions" onClick={(event) => event.stopPropagation()}>
                    <button onClick={() => openPreview(item)}>预览</button>
                    {pickerMode&&pickerHref(item)&&<a className="library-pick-action" href={pickerHref(item)}>使用素材</a>}
                    {!pickerMode && file && (
                      <a href={mediaFileHref(item, file)} download={file.label}>
                        <IconDownload />下载
                      </a>
                    )}
                    {!file && item.transcript?.text && (
                      <a
                        href={`/api/tools/video/jobs/${item.id}/transcript.txt`}
                        download
                      >
                        TXT
                      </a>
                    )}
                    <button
                      className="library-card-more"
                      aria-label="更多操作"
                      aria-haspopup="menu"
                      onClick={(event) => openMenu(event, item)}
                    >
                      •••
                    </button>
                  </div>
                </article>
              );
            })}
        </div>
        {selectedItem && (!isMobile || mobileDetail) && (
          <section ref={detailRef} className="library-detail">
            <button
              type="button"
              className="library-back"
              onClick={() => {
                setMobileDetail(false);
                requestAnimationFrame(() => {
                  if (selectionRef.current?.isConnected) {
                    selectionRef.current.focus();
                  } else listRef.current?.scrollIntoView({ block: "start" });
                });
              }}
            >
              返回列表
            </button>
            <div className="library-detail-heading">
              <span>素材详情</span>
              {pickerMode&&pickerHref(selectedItem)&&<a className="library-pick-action" href={pickerHref(selectedItem)}>使用此素材</a>}
              <button
                type="button"
                onClick={() =>
                  openPreview(selectedItem)}
              >
                放大预览 ↗
              </button>
            </div>
            {selectedItem.engine === 'media' ? <MediaProcessingResult job={selectedItem} active={active && previewIndex < 0} space={space} onRetry={retry} showToast={showToast} /> : <ToolResult
              space={space}
              job={selectedItem}
              mode={selectedItem.kind === "transcript"
                ? "video-transcribe"
                : "video-download"}
              submitting={busy}
              active={active && previewIndex < 0}
              onPrepare={retry}
              onRetry={retry}
              onFill={fill}
              onCopy={copy}
              onDownloadItem={() => {
              }}
              onGroup={() => {
              }}
              onMore={() => {
              }}
              onTranscribe={selectedItem.kind === "download"
                ? transcribe
                : undefined}
              onDiscover={(operation, item) => {
                const input = operation === "music" ? item.content?.musicId : item.url;
                if (!input) return;
                window.location.hash = `#media-tools?${new URLSearchParams({
                  tab: "discover", space, discoveryMode: operation, input: String(input),
                })}`;
              }}
              showToast={showToast}
            />}
          </section>
        )}
      </div>
      {active && previewIndex >= 0 && (
        <MediaQuickPreview
          items={items}
          index={previewIndex}
          onChange={(index) => {
            setPreviewId(items[index].id);
            setSelected(items[index].id);
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
      {active && menu && (
        <MediaContextMenu
          menu={menu}
          busy={busy}
          onClose={() => setMenu(null)}
          onPreview={openPreview}
          onCopy={copy}
          onFill={fill}
          onRetry={retry}
          onTranscribe={transcribe}
          space={space}
        />
      )}
    </>
  );
}
function MediaCollectionWorkspace({ active, visible, space, hash, showToast }) {
  const watching = workspaceHashParams(hash).get('collectionMode') === 'watch';
  const switchMode = mode => {
    window.location.hash = `#media-tools?${new URLSearchParams({ tab:'collections', space, ...(mode === 'watch' ? {collectionMode:'watch'} : {}) })}`;
  };
  return <section hidden={!visible} aria-label="作者与收藏">
    <div className="mp-text-nav" role="tablist" aria-label="作者工具">
      <button type="button" role="tab" aria-selected={!watching} className={!watching?'active':''} onClick={()=>switchMode('browse')}>浏览作品与合集</button>
      <button type="button" role="tab" aria-selected={watching} className={watching?'active':''} onClick={()=>switchMode('watch')}>追更与数据快照</button>
    </div>
    {watching ? <MediaWatchPanel active={active && visible} space={space} hash={hash} showToast={showToast} /> : <ToolShell tool={VIDEO_TOOL_TABS.find(item=>item.id==='collections').tool} embedded hash={hash} visible={visible} active={active && visible} space={space} showToast={showToast} />}
  </section>;
}
function VideoDownloadTool({ active, space, showToast }) {
  return (
    <ToolShell
      tool={VIDEO_TOOL_CATALOG[0]}
      active={active}
      space={space}
      showToast={showToast}
    />
  );
}
