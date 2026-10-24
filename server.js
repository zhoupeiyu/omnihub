/// 万象台 OmniHub 服务器 —— 静态页面 + REST API，零第三方依赖
/// 启动：node server.js（默认 http://localhost:4320）
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./lib/api.js";
import { startMediaWorker } from "./lib/media.js";
import { startLocalImageMonitor } from './lib/local-image.js';
import { createStaticHandler } from "./lib/http-static.js";
import { startContentWorker } from './lib/content-runtime.js';
import { startXWatchWorker } from './lib/x-watch-runtime.js';
import { startXBookmarkSyncWorker } from './lib/x-bookmark-sync-runtime.js';
import { db } from "./lib/db.js";
import { createLifeGuideStore } from "./lib/life-guide-store.js";
import { createLifeGuideHandler } from "./lib/life-guide-api.js";

const PORT = Number(process.env.PORT || 4320);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = process.env.OMNIHUB_STATIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const serveStatic = createStaticHandler(PUBLIC_DIR);

// Public read-only life-guide routes. Built once against the shared db handle;
// mounted ahead of handleApi so the prefix is owned by the guide router.
const lifeGuideHandler = createLifeGuideHandler(createLifeGuideStore(db));
const isLifeGuidePath = (pathname) => pathname === "/api/life-guide" || pathname.startsWith("/api/life-guide/");

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let handled = false;
    if (isLifeGuidePath(pathname)) handled = await lifeGuideHandler(req, res, pathname);
    if (!handled) handled = await handleApi(req, res, pathname);
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

server.listen(PORT, HOST, () => {
  console.log(`万象台 OmniHub 已启动：http://${HOST}:${PORT}`);
  startMediaWorker();
  startLocalImageMonitor();
  startContentWorker();
  startXWatchWorker();
  startXBookmarkSyncWorker();
});
