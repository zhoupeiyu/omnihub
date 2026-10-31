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
import { db, DATA_DIR } from "./lib/db.js";
import { getSessionUser } from "./lib/auth.js";
import { createVideoToolHandler } from "./lib/video-tools.js";
import { createMediaProcessingHandler } from "./lib/media-processing.js";
import { createLifeGuideStore } from "./lib/life-guide-store.js";
import { createLifeGuideHandler } from "./lib/life-guide-api.js";
import { createReferenceLibraryHandler } from './lib/reference-library.js';
import { startReferenceSync } from './lib/reference-runtime.js';

const PORT = Number(process.env.PORT || 4320);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = process.env.OMNIHUB_STATIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const serveStatic = createStaticHandler(PUBLIC_DIR);
const referenceDirectory = process.env.OMNIHUB_REFERENCE_DIR || path.join(DATA_DIR, 'reference-library');
const referenceHandler = createReferenceLibraryHandler({ directory: referenceDirectory, getUser: getSessionUser });
const videoToolHandler = createVideoToolHandler({ databasePath: path.join(DATA_DIR, 'video-tools.db'), getUser: getSessionUser });
const mediaProcessingHandler = createMediaProcessingHandler({ databasePath: path.join(DATA_DIR, 'media-processing.db'), getUser: getSessionUser,
  sourceReader: (req, source) => videoToolHandler.readSource(req, source) });

// Public read-only life-guide routes. Built once against the shared db handle;
// mounted ahead of handleApi so the prefix is owned by the guide router.
const lifeGuideHandler = createLifeGuideHandler(createLifeGuideStore(db));
const isLifeGuidePath = (pathname) => pathname === "/api/life-guide" || pathname.startsWith("/api/life-guide/");

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let handled = false;
    if (pathname.startsWith('/api/reference-library')) handled = await referenceHandler(req, res, pathname);
    if (pathname.startsWith('/api/tools/video')) handled = await videoToolHandler(req, res, pathname);
    if (!handled && pathname.startsWith('/api/tools/media')) handled = await mediaProcessingHandler(req, res, pathname);
    if (!handled && isLifeGuidePath(pathname)) handled = await lifeGuideHandler(req, res, pathname);
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
  startReferenceSync({ directory: referenceDirectory });
});
