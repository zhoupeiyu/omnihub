/// 本地模拟 OpenAI 兼容接口 —— 仅用于离线自测 AI 链路（node scripts/mock_ai.js）
/// 支持流式（stream: true，按字逐个吐出）与非流式两种模式
import http from "node:http";

function buildReply(body) {
  let lastUserText = "";
  try {
    const payload = JSON.parse(body);
    const userMessages = (payload.messages || []).filter((m) => m.role === "user");
    lastUserText = userMessages.length ? userMessages[userMessages.length - 1].content : "";
    return {
      reply: [
        `收到你的消息：「${lastUserText.slice(0, 40)}」。这是**模拟 AI** 的 Markdown 流式演示：`,
        "",
        "## 支持的格式",
        "1. **加粗**、*斜体* 和 `行内代码`",
        "2. 列表与引用",
        "",
        "> 这是一段引用文字。",
        "",
        "```python",
        "def greet(name):",
        '    return f"你好，{name}！"',
        "```",
        "",
        "| 模块 | 状态 |",
        "| --- | --- |",
        "| 流式输出 | ✅ |",
        "| Markdown 渲染 | ✅ |",
        "",
        "接入真实服务商（DeepSeek、Kimi 等）后，这里就是大模型的回答。",
      ].join("\n"),
      stream: Boolean(payload.stream),
    };
  } catch (err) {
    return { reply: "【模拟 AI 回复】链路畅通。", stream: false };
  }
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer mock-")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    }
    const { reply, stream } = buildReply(body);

    if (!stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chars = Array.from(reply);
    let index = 0;
    const timer = setInterval(() => {
      if (index >= chars.length) {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const piece = chars.slice(index, index + 2).join("");
      index += 2;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }, 30);
    // 注意要挂在 res 上：req 在请求体读完后就会触发 close
    res.on("close", () => clearInterval(timer));
  });
}).listen(4399, () => console.log("Mock AI 已启动：http://localhost:4399"));
