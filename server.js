/// 万象台 OmniHub 服务器 —— 静态页面 + REST API，零第三方依赖
/// 启动：node server.js（默认 http://localhost:4320）
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./lib/api.js";

const PORT = Number(process.env.PORT || 4320);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".mp3": "audio/mpeg",
};

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const stats = await stat(filePath);
    // 基于文件大小 + 修改时间生成校验标记：文件变了标记就变，浏览器会重新拉取
    const etag = `"${stats.size}-${Math.round(stats.mtimeMs)}"`;
    const lastModified = stats.mtime.toUTCString();
    const cacheHeaders = {
      "ETag": etag,
      "Last-Modified": lastModified,
      "Cache-Control": "no-cache", // 可缓存，但每次用 304 校验，保证更新即时生效
    };
    // 协商缓存命中：文件未变，返回 304，浏览器直接用本地缓存（不重新下载内容）
    if (req.headers["if-none-match"] === etag ||
        req.headers["if-modified-since"] === lastModified) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return;
    }
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      ...cacheHeaders,
    });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const handled = await handleApi(req, res, pathname);
    if (!handled) await serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("500 Internal Server Error");
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`万象台 OmniHub 已启动：http://localhost:${PORT}`);
});
