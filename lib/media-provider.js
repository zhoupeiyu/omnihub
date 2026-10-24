const IMAGE_MODELS = {
  "nano-banana-pro": { maxImages: 8, maxSize: "4k" },
  "gpt-image-2": { maxImages: 8, maxSize: "4k" },
  "seedream-5.0-pro": { maxImages: 10, maxSize: "2k" },
  "gpt-image-2-flare": { maxImages: 16, maxSize: "4k" },
};
const VIDEO_MODELS = {
  seedance: ["seedance2.0", "seedance2.0-mini", "seedance2.5"],
  hh1: ["hh1"],
  wan3: ["wan3.0-video", "wan3.0-video-prime"],
};
const RATIOS = new Set(["adaptive", "auto", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"]);
export const DOCUMENTED_MEDIA_BASE_URL = "http://39.96.116.239:9001";

function invalid(message) { throw { status: 400, message }; }

// URL parsing normalizes decimal/hex IPv4 spellings, so checking URL.hostname
// blocks the common literal bypasses.  DNS rebinding requires a pinned socket
// strategy and is deliberately not claimed as solved by this parser.
function privateIpv4(host) {
  const match=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if(!match)return false;
  const [a,b,c,d]=match.slice(1).map(Number);
  if([a,b,c,d].some(value=>value>255))return true;
  return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||
    (a===192&&b===168)||(a===100&&b>=64&&b<=127);
}
export function unsafeNetworkHost(host,{allowLocal=false}={}) {
  const value=String(host||'').toLowerCase();
  if(allowLocal&&['localhost','127.0.0.1','[::1]','::1'].includes(value))return false;
  if(['localhost','[::1]','::1'].includes(value))return !allowLocal;
  // Do not permit literal IPv6 endpoints. This closes loopback, ULA and
  // IPv4-mapped forms until a connection-pinning transport is introduced.
  if(value.includes(':'))return true;
  return privateIpv4(value);
}

export function validateMediaBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { invalid("媒体接口地址不正确"); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const documentedHttp = url.origin === DOCUMENTED_MEDIA_BASE_URL && url.pathname === "/";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (local || documentedHttp))) {
    invalid("媒体接口需要 HTTPS；仅公司文档地址及本机测试允许 HTTP");
  }
  if (url.username || url.password || url.search || url.hash) invalid("媒体接口地址不能包含账号、查询参数或片段");
  if (unsafeNetworkHost(url.hostname,{allowLocal:local})) invalid("媒体接口地址不能使用内网或 IPv6 字面地址");
  return url.toString().replace(/\/+$/, "");
}

export function validateMediaResultUrl(value, baseValue) {
  let url,base;
  try { url=new URL(value);base=new URL(baseValue); }
  catch { throw new Error('结果 URL 不正确'); }
  const sameLocal=['localhost','127.0.0.1','[::1]'].includes(base.hostname)&&url.origin===base.origin;
  if(url.protocol!=='https:'&&!(sameLocal&&url.protocol==='http:'))throw new Error('结果 URL 必须使用 HTTPS');
  if(url.username||url.password||unsafeNetworkHost(url.hostname,{allowLocal:sameLocal}))throw new Error('结果 URL 不安全');
  return url;
}

function text(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeGeneration(input, refs) {
  const module = String(input.module || "image");
  if (!["image", "seedance", "hh1", "wan3"].includes(module)) invalid("不支持的生成服务");
  const kind = module === "image" ? "image" : "video";
  const model = text(input.model, 80) || (module === "image" ? "nano-banana-pro" : module === "seedance" ? "seedance2.0" : module === "hh1" ? "hh1" : "wan3.0-video");
  if (module === "image" ? !IMAGE_MODELS[model] : !VIDEO_MODELS[module].includes(model)) invalid("模型与生成服务不匹配");
  const mode = text(input.mode, 40) || (kind === "image" ? "image" : "text_video");
  const promptLimit = module === "image" && model === "gpt-image-2-flare" ? 30000 : module === "image" ? 10000 : 5000;
  const prompt = String(input.prompt || "").trim();
  if (prompt.length > promptLimit) invalid(`提示词最多 ${promptLimit} 个字符`);
  const images = refs.filter((r) => r.kind === "image");
  const videos = refs.filter((r) => r.kind === "video");
  const audios = refs.filter((r) => r.kind === "audio");
  const ratio = text(input.aspectRatio, 20) || (kind === "image" ? "auto" : "adaptive");
  if (!RATIOS.has(ratio)) invalid("画面比例不受支持");
  const args = { prompt };

  if (module === "image") {
    if (!prompt) invalid("请填写提示词");
    if (mode !== "image" || videos.length || audios.length || images.length > IMAGE_MODELS[model].maxImages) invalid("参考素材不符合生图模型要求");
    const size = text(input.size, 8) || "1k";
    if (!["1k", "2k", "4k"].includes(size) || (size === "4k" && IMAGE_MODELS[model].maxSize === "2k")) invalid("图片尺寸不受该模型支持");
    if (model === "seedream-5.0-pro" && ["auto", "5:4", "4:5"].includes(ratio)) invalid("该模型不支持所选画面比例");
    args.model = model;
    if (model !== "gpt-image-2") args.size = size;
    args.aspect_ratio = ratio;
  } else {
    const duration = Number(input.duration == null ? 5 : input.duration);
    if (!Number.isInteger(duration)) invalid("视频时长需要整数秒");
    if (module === "hh1") {
      if (!["text", "frame", "reference", "video_edit"].includes(mode)) invalid("视频模式不受支持");
      if (mode === "text" && (!prompt || refs.length)) invalid("文生视频需要提示词，不能带参考素材");
      if (mode === "frame" && (images.length !== 1 || videos.length || audios.length)) invalid("首帧模式需要一张图片");
      if (mode === "reference" && (images.length < 1 || images.length > 9 || videos.length || audios.length)) invalid("参考图模式需要 1 至 9 张图片");
      if (mode === "video_edit" && (videos.length !== 1 || images.length > 5 || audios.length)) invalid("视频编辑需要一段视频，最多五张参考图");
      if (mode !== "frame" && !prompt) invalid("请填写提示词");
      if (mode !== "video_edit" && (duration < 3 || duration > 15)) invalid("视频时长需在 3 至 15 秒之间");
      args.generation_mode = mode;
      if (mode !== "video_edit") args.duration = duration;
      if (mode === "video_edit") args.audio_setting = input.audioSetting === "origin" ? "origin" : "auto";
      if (mode !== "frame" && mode !== "video_edit") args.ratio = ratio === "adaptive" ? "16:9" : ratio;
      if (mode !== "text") args.input_image_url = [];
      if (mode === "video_edit") args.input_video_url = "";
    } else {
      args.model = model;
      if (!["text_video", "first_last_frame", "reference_images"].includes(mode)) invalid("视频模式不受支持");
      if (mode === "text_video" && (!prompt || refs.length)) invalid("文生视频需要提示词，不能带参考素材");
      if (mode === "first_last_frame" && (images.length < 1 || images.length > 2 || videos.length || audios.length)) invalid("首尾帧模式需要一至两张图片");
      if (mode === "reference_images" && !prompt && !refs.length) invalid("请填写提示词或选择参考素材");
      if (module === "seedance" && !prompt) invalid("Seedance 需要提示词");
      if (module === "seedance") {
        const maxImage = model === "seedance2.5" ? 30 : 9;
        const maxVideo = model === "seedance2.5" ? 10 : 3;
        const maxAudio = model === "seedance2.5" ? 10 : 3;
        if (images.length > maxImage || videos.length > maxVideo || audios.length > maxAudio) invalid("参考素材超过模型上限");
        if (model !== "seedance2.5" && refs.length > 15) invalid("参考素材总数最多 15 个");
        if (duration !== -1 && (duration < 4 || duration > (model === "seedance2.5" ? 30 : 15))) invalid("视频时长不受该模型支持");
        const face = Number(input.faceProcessing || 0);
        if (![0, 1, 2, 3].includes(face)) invalid("人脸处理模式不受支持");
        const faceList = Array.isArray(input.faceProcessingList) ? input.faceProcessingList : [];
        if ((face && !faceList.length) || (!face && faceList.length)) invalid("人脸处理参数不完整");
        if (faceList.some((label) => !/^图片[1-9]\d*$|^视频[1-9]\d*$/.test(label))) invalid("人脸素材标记不正确");
        args.face_processing = face;
        args.face_processing_list = faceList;
      } else {
        if (images.length > 10 || videos.length > 5 || audios.length > 5) invalid("参考素材超过 Wan 的上限");
        if (duration !== -1 && (duration < 2 || duration > 30)) invalid("视频时长需在 2 至 30 秒之间");
        args.audio = input.audio !== false;
        args.prompt_extend = input.promptExtend !== false;
      }
      args.task_type = mode;
      args.duration = duration;
      args.ratio = ratio === "auto" ? "adaptive" : ratio;
      args.resolution = ["480p", "720p", "1080p"].includes(input.resolution) ? input.resolution : "720p";
    }
  }
  return { module, model, mode, kind, prompt, args };
}

export async function parseProviderResponse(response, { submission = false, timeoutMs = 20_000 } = {}) {
  const unknown = message => ({ status: 502, message, ...(submission ? { uncertain: true } : {}) });
  if (Number(response.status) >= 500) throw unknown('生成服务响应异常，请先核对任务，暂勿重复提交');
  let data;
  let timer;
  try {
    data = await Promise.race([
      response.json(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } catch { throw unknown('生成服务响应无法确认，请先核对任务，暂勿重复提交'); }
  finally { clearTimeout(timer); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unknown('生成服务响应无法确认，请先核对任务，暂勿重复提交');
  const status = Number(response.status || 0);
  const hasBusinessCode = Number.isInteger(data.code);
  if (status >= 200 && status < 300) {
    if (!hasBusinessCode) throw unknown('生成服务响应无法确认，请先核对任务，暂勿重复提交');
    if (data.code !== 0) throw { status: 502, message: `生成服务拒绝或暂时无法处理请求（业务码 ${data.code}）` };
    return data.body;
  }
  if (status >= 400 && status < 500) {
    const code = hasBusinessCode ? `（业务码 ${data.code}）` : '';
    throw { status: 502, message: `生成服务拒绝或暂时无法处理请求${code}` };
  }
  throw unknown('生成服务响应无法确认，请先核对任务，暂勿重复提交');
}

async function providerPost(config, path, body, multipart = false) {
  const url = validateMediaBaseUrl(config.base_url) + path;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: multipart ? undefined : { "Content-Type": "application/json" },
      body: multipart ? body : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw { status: 503, message: "生成服务无法连接或请求结果不明，请先核对任务，暂勿重复提交", uncertain: true };
  }
  return parseProviderResponse(response, { submission: path.endsWith('/create') });
}

export async function createProviderJob(config, job, referenceFiles) {
  const payload = {
    authentication: config.authentication,
    ...(config.sys_token ? { sys_token: config.sys_token } : {}),
    module: job.module,
    args: { ...job.args },
    remark: `OmniHub ${job.id}`,
  };
  if (referenceFiles.length) {
    const form = new FormData();
    form.set("authentication", payload.authentication);
    if (payload.sys_token) form.set("sys_token", payload.sys_token);
    form.set("module", payload.module);
    form.set("remark", payload.remark);
    const groups = { image: "images", video: "videos", audio: "audios" };
    for (const file of referenceFiles) {
      const blob = new Blob([await file.read()], { type: file.mimeType });
      form.append(groups[file.kind], blob, file.name);
    }
    // The documented multipart contract requires args as a JSON string.
    form.set("args", JSON.stringify(payload.args));
    return providerPost(config, "/support/open_api/create", form, true);
  }
  return providerPost(config, "/support/open_api/create", payload);
}

export async function queryProviderJobs(config, ids) {
  return providerPost(config, "/support/open_api/query", { ids });
}

export const MEDIA_MODELS = { image: Object.keys(IMAGE_MODELS), ...VIDEO_MODELS };
