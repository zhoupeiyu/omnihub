/// AI 代理层 —— 把用户消息转发到其配置的 OpenAI 兼容接口（支持流式）
import { getAiConfig } from "./db.js";

const REQUEST_TIMEOUT_MS = 120000;

/** 校验配置并请求上游接口，返回 fetch Response；问题统一抛 { status, message } */
async function requestUpstream(userId, messages, stream) {
  const config = getAiConfig(userId);
  if (!config || !config.api_key || !config.base_url) {
    throw { status: 400, message: "还没有配置 AI 账号，请到「设置 → AI 设置」填写" };
  }

  const endpoint = config.base_url.replace(/\/+$/, "") + "/chat/completions";
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.api_key}`,
      },
      body: JSON.stringify({ model: config.model, messages, stream }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "请求超时" : "无法连接到 AI 服务";
    throw { status: 502, message: `${reason}，请检查接口地址是否正确（${endpoint}）` };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) throw { status: 502, message: "API Key 无效或已过期，请到「AI 设置」检查" };
    if (response.status === 404) throw { status: 502, message: "接口地址不对（404），请确认 Base URL 填到 /v1 这一级" };
    throw { status: 502, message: `AI 服务返回错误（${response.status}）：${detail.slice(0, 200)}` };
  }
  return { response, model: config.model };
}

/**
 * 流式对话：把上游的 SSE 增量解析后转发给浏览器
 * 事件格式：data: {"model"} → data: {"delta"}×N → data: [DONE]
 * 配置/连接错误发生在响应头之前，按普通 JSON 错误抛出
 */
export async function streamChatToClient(userId, messages, res) {
  const { response, model } = await requestUpstream(userId, messages, true);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ model })}\n\n`);

  const decoder = new TextDecoder();
  let buffer = "";
  let upstreamDone = false;
  const forwardLine = (line) => {
    const data = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : null;
    if (!data) return;
    if (data === "[DONE]") {
      upstreamDone = true;
      res.write("data: [DONE]\n\n");
      return;
    }
    try {
      const payload = JSON.parse(data);
      const choice = payload.choices && payload.choices[0];
      const delta = choice?.delta?.content || "";
      if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      // Some compatible providers finish with finish_reason but omit the literal sentinel.
      if (payload.done === true || payload.finish_reason || choice?.finish_reason) {
        upstreamDone = true;
        res.write("data: [DONE]\n\n");
      }
    } catch { /* Ignore provider keepalive or malformed non-data events. */ }
  };
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) forwardLine(line);
    }
    if (buffer.trim()) forwardLine(buffer);
    if (!upstreamDone) res.write(`data: ${JSON.stringify({ error: "AI 服务传输中断，请重试" })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: "AI 服务传输中断，请重试" })}\n\n`);
  }
  res.end();
}

/** 非流式对话：一次性返回 { reply, model }（保留作为兼容接口） */
export async function chatWithAi(userId, messages) {
  const { response, model } = await requestUpstream(userId, messages, false);
  const data = await response.json();
  const reply = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (!reply) throw { status: 502, message: "AI 服务返回了空回复" };
  return { reply, model };
}
