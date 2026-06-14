/// API 路由层 —— 认证、收藏、提示词、AI 配置与对话
import {
  createUser, findUserByName,
  listFavorites, addFavorite, updateFavorite, deleteFavorite,
  listPrompts, addPrompt, updatePrompt, deletePrompt,
  getAiConfig, saveAiConfig,
} from "./db.js";
import { normalizeSnsUrl } from "./sns.js";
import { fetchFeed, listFeedSources } from "./feed.js";
import {
  hashPassword, verifyPassword,
  createSession, destroySession, sessionCookie, clearSessionCookie, getSessionUser,
} from "./auth.js";
import { chatWithAi, streamChatToClient } from "./ai.js";
import {
  createPdfCompressionJob,
  downloadPdfCompressionJob,
  getPdfCompressionJob,
} from "./pdf_tools.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 支持 base64 配图

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject({ status: 413, message: "请求内容过大（图片请控制在 5MB 内）" }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (err) { reject({ status: 400, message: "请求格式不是合法 JSON" }); }
    });
    req.on("error", () => reject({ status: 400, message: "读取请求失败" }));
  });
}

/** 输出 JSON 响应；返回 true 方便路由分支 `return send(...)` 标记“已处理” */
function send(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(payload));
  return true;
}

function requireUser(req) {
  const user = getSessionUser(req);
  if (!user) throw { status: 401, message: "请先登录" };
  return user;
}

function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : key.slice(0, 4) + "****" + key.slice(-4);
}

/** 处理 /api/* 请求；非 API 路径返回 false 交给静态服务 */
export async function handleApi(req, res, pathname) {
  if (!pathname.startsWith("/api/")) return false;

  try {
    const route = `${req.method} ${pathname}`;

    /* ---------- 认证 ---------- */
    if (route === "POST /api/register") {
      const { username, password } = await readBody(req);
      const name = (username || "").trim();
      if (name.length < 2 || name.length > 20) throw { status: 400, message: "用户名需要 2–20 个字符" };
      if (!password || password.length < 6) throw { status: 400, message: "密码至少 6 位" };
      if (findUserByName(name)) throw { status: 409, message: "用户名已被占用，换一个试试" };
      const { hash, salt } = hashPassword(password);
      const userId = createUser({ username: name, passwordHash: hash, salt });
      const token = createSession(userId);
      return send(res, 200, { id: userId, username: name }, { "Set-Cookie": sessionCookie(token) });
    }

    if (route === "POST /api/login") {
      const { username, password } = await readBody(req);
      const user = findUserByName((username || "").trim());
      if (!user || !verifyPassword(password || "", user.salt, user.password_hash)) {
        throw { status: 401, message: "用户名或密码不对" };
      }
      const token = createSession(user.id);
      return send(res, 200, { id: user.id, username: user.username }, { "Set-Cookie": sessionCookie(token) });
    }

    if (route === "POST /api/logout") {
      const user = getSessionUser(req);
      if (user) destroySession(user.token);
      return send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (route === "GET /api/me") {
      const user = requireUser(req);
      const config = getAiConfig(user.id);
      return send(res, 200, {
        id: user.id, username: user.username,
        hasAiConfig: Boolean(config && config.api_key),
      });
    }

    /* ---------- 收藏 ---------- */
    if (route === "GET /api/favorites") {
      const user = requireUser(req);
      return send(res, 200, listFavorites(user.id));
    }
    if (route === "POST /api/favorites") {
      const user = requireUser(req);
      const { name, url, desc, category } = await readBody(req);
      if (!name || !url) throw { status: 400, message: "名称和网址不能为空" };
      try { new URL(url); } catch (err) { throw { status: 400, message: "网址格式不正确" }; }
      const id = addFavorite(user.id, { name, url, desc, category });
      return send(res, 200, { id });
    }
    const favMatch = pathname.match(/^\/api\/favorites\/(\d+)$/);
    if (favMatch && req.method === "PUT") {
      const user = requireUser(req);
      const { name, url, desc, category } = await readBody(req);
      if (!name || !url) throw { status: 400, message: "名称和网址不能为空" };
      try { new URL(url); } catch (err) { throw { status: 400, message: "网址格式不正确" }; }
      if (!updateFavorite(user.id, Number(favMatch[1]), { name, url, desc, category })) {
        throw { status: 404, message: "收藏不存在" };
      }
      return send(res, 200, { ok: true });
    }
    if (favMatch && req.method === "DELETE") {
      const user = requireUser(req);
      if (!deleteFavorite(user.id, Number(favMatch[1]))) throw { status: 404, message: "收藏不存在" };
      return send(res, 200, { ok: true });
    }

    /* ---------- 提示词（灵感库） ---------- */
    if (route === "GET /api/prompts") {
      const user = requireUser(req);
      return send(res, 200, listPrompts(user.id));
    }
    if (route === "POST /api/prompts") {
      const user = requireUser(req);
      const data = await readBody(req);
      if (!data.title || !data.text) throw { status: 400, message: "标题和提示词内容不能为空" };
      const sns = normalizeSnsUrl(data.snsUrl);
      const id = addPrompt(user.id, { ...data, snsUrlNormalized: sns.normalizedUrl, snsType: sns.snsType });
      return send(res, 200, { id, snsUrlNormalized: sns.normalizedUrl, snsType: sns.snsType });
    }
    if (route === "GET /api/prompts/export") {
      const user = requireUser(req);
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), prompts: listPrompts(user.id) }, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="omnihub-prompts-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      res.end(payload);
      return true;
    }
    const promptMatch = pathname.match(/^\/api\/prompts\/(\d+)$/);
    if (promptMatch && req.method === "PUT") {
      const user = requireUser(req);
      const patch = await readBody(req);
      if (patch.title !== undefined && !patch.title) throw { status: 400, message: "标题不能为空" };
      if (patch.text !== undefined && !patch.text) throw { status: 400, message: "提示词内容不能为空" };
      if (patch.snsUrl !== undefined) {
        const sns = normalizeSnsUrl(patch.snsUrl);
        patch.snsUrlNormalized = sns.normalizedUrl;
        patch.snsType = sns.snsType;
      }
      if (!updatePrompt(user.id, Number(promptMatch[1]), patch)) throw { status: 404, message: "提示词不存在" };
      return send(res, 200, { ok: true, snsUrlNormalized: patch.snsUrlNormalized, snsType: patch.snsType });
    }
    if (promptMatch && req.method === "DELETE") {
      const user = requireUser(req);
      if (!deletePrompt(user.id, Number(promptMatch[1]))) throw { status: 404, message: "提示词不存在" };
      return send(res, 200, { ok: true });
    }

    /* ---------- 信息流（外部 RSS 代理，公共内容，游客可访问） ---------- */
    if (route === "GET /api/feed/sources") {
      return send(res, 200, listFeedSources());
    }
    const feedMatch = pathname.match(/^\/api\/feed\/([a-z0-9_-]+)$/);
    if (feedMatch && req.method === "GET") {
      const items = await fetchFeed(feedMatch[1]);
      return send(res, 200, items);
    }

    /* ---------- 工具箱：PDF 压缩（公共工具，游客可用） ---------- */
    if (route === "POST /api/tools/pdf-compress") {
      return await createPdfCompressionJob(req, res);
    }
    const pdfJobMatch = pathname.match(/^\/api\/tools\/pdf-compress\/([0-9a-f-]+)$/);
    if (pdfJobMatch && req.method === "GET") {
      return getPdfCompressionJob(res, pdfJobMatch[1]);
    }
    const pdfDownloadMatch = pathname.match(/^\/api\/tools\/pdf-compress\/([0-9a-f-]+)\/download$/);
    if (pdfDownloadMatch && req.method === "GET") {
      return await downloadPdfCompressionJob(res, pdfDownloadMatch[1]);
    }

    /* ---------- AI 配置与对话 ---------- */
    if (route === "GET /api/ai-config") {
      const user = requireUser(req);
      const config = getAiConfig(user.id);
      return send(res, 200, config
        ? { baseUrl: config.base_url, model: config.model, apiKeyMasked: maskKey(config.api_key), hasKey: Boolean(config.api_key) }
        : { baseUrl: "", model: "", apiKeyMasked: "", hasKey: false });
    }
    if (route === "PUT /api/ai-config") {
      const user = requireUser(req);
      const { baseUrl, apiKey, model } = await readBody(req);
      if (!baseUrl || !model) throw { status: 400, message: "接口地址和模型名不能为空" };
      const existing = getAiConfig(user.id);
      // 留空 apiKey 表示沿用已保存的 Key（界面里显示的是掩码）
      const finalKey = apiKey || (existing ? existing.api_key : "");
      if (!finalKey) throw { status: 400, message: "请填写 API Key" };
      saveAiConfig(user.id, { baseUrl: baseUrl.trim(), apiKey: finalKey.trim(), model: model.trim() });
      return send(res, 200, { ok: true });
    }
    if (route === "POST /api/ai/chat") {
      const user = requireUser(req);
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) throw { status: 400, message: "消息不能为空" };
      const result = await chatWithAi(user.id, messages);
      return send(res, 200, result);
    }
    if (route === "POST /api/ai/chat/stream") {
      const user = requireUser(req);
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) throw { status: 400, message: "消息不能为空" };
      await streamChatToClient(user.id, messages, res);
      return true;
    }

    throw { status: 404, message: "接口不存在" };
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "服务器开小差了";
    if (status === 500) console.error("[api]", err);
    send(res, status, { error: message });
  }
  return true;
}
