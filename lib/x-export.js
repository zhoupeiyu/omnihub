import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// A bookmarked Post and its expanded author can each be billable resources.
// This local estimate assumes standard Post ($0.005) and User ($0.010) reads.
const CONSERVATIVE_RESOURCE_PRICE_USD = 0.015;
const PAGE_NAME = /^page-(\d{4,})\.json$/;

function validateOptions({ userId, maxUsd, outDir }) {
  if (!/^\d{1,19}$/.test(String(userId || ""))) throw new Error("X 用户 ID 无效");
  if (!Number.isFinite(maxUsd) || maxUsd < CONSERVATIVE_RESOURCE_PRICE_USD) {
    throw new Error("本轮费用上限过低或无效");
  }
  if (!outDir || !path.isAbsolute(outDir)) throw new Error("导出目录必须是绝对路径");
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

async function readPages(outDir) {
  const names = (await readdir(outDir)).filter((name) => PAGE_NAME.test(name)).sort();
  const pages = [];
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== `page-${String(index + 1).padStart(4, "0")}.json`) {
      throw new Error("导出分页不连续，不能安全续跑");
    }
    const page = JSON.parse(await readFile(path.join(outDir, names[index]), "utf8"));
    if (!Array.isArray(page.data) || !page.meta || typeof page.meta !== "object") {
      throw new Error(`导出分页 ${names[index]} 格式无效`);
    }
    pages.push(page);
  }
  return pages;
}

function manifestFor(userId, pages, complete, reason = "") {
  const ids = new Set();
  let returned = 0;
  for (const page of pages) {
    returned += page.data.length;
    for (const post of page.data) {
      if (!/^\d{1,20}$/.test(String(post.id || ""))) throw new Error("X 返回了无效帖子 ID");
      ids.add(String(post.id));
    }
  }
  return {
    source: "X bookmarks API",
    userId: String(userId),
    pages: pages.length,
    returned,
    uniquePosts: ids.size,
    complete,
    reason,
    conservativeEstimatedUsd: Number((returned * CONSERVATIVE_RESOURCE_PRICE_USD).toFixed(3)),
    checkedAt: new Date().toISOString(),
  };
}

/** Export X bookmark pages without overwriting earlier output or retrying uncertain paid reads. */
export async function exportXBookmarks({ userId, maxUsd, outDir, token, resume = false, fetchImpl = fetch }) {
  validateOptions({ userId, maxUsd, outDir });
  if (!token || typeof token !== "string") throw new Error("X OAuth 令牌不可用");
  if (resume) await readdir(outDir);
  else await mkdir(outDir, { recursive: false, mode: 0o700 });

  const pages = await readPages(outDir);
  const priorManifestPath = path.join(outDir, "manifest.json");
  if (resume) {
    const prior = JSON.parse(await readFile(priorManifestPath, "utf8"));
    if (prior.userId !== String(userId) || prior.pages > pages.length) {
      throw new Error("续跑目录与 X 账号或分页不匹配");
    }
  } else {
    await writeJsonAtomic(priorManifestPath, manifestFor(userId, [], false, "in_progress"));
  }
  let nextToken = pages.length ? pages.at(-1).meta.next_token || "" : "";
  let complete = pages.length > 0 && !nextToken;
  const seenTokens = new Set(pages.map((page) => page.meta.next_token).filter(Boolean));

  while (!complete) {
    const returned = pages.reduce((total, page) => total + page.data.length, 0);
    const remaining = Math.floor((maxUsd - returned * CONSERVATIVE_RESOURCE_PRICE_USD + 1e-9) / CONSERVATIVE_RESOURCE_PRICE_USD);
    if (remaining < 1) break;
    const params = new URLSearchParams({
      max_results: String(Math.min(100, remaining)),
      "post.fields": "created_at,entities,attachments,lang,note_post,public_metrics",
      expansions: "attachments.media_keys,author_id",
      "user.fields": "username,name",
      "media.fields": "url,preview_image_url,type,alt_text,width,height",
    });
    if (nextToken) params.set("pagination_token", nextToken);
    const url = `https://api.x.com/2/users/${userId}/bookmarks?${params}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`X 收藏读取失败（HTTP ${response.status}），已保存的分页可续跑`);
    const page = await response.json();
    if (!Array.isArray(page.data) || !page.meta || typeof page.meta !== "object") {
      throw new Error("X 返回的分页格式不完整；未写入该页");
    }
    if (page.data.length > Math.min(100, remaining)) throw new Error("X 返回数量超过本轮预算余量；未写入该页");
    for (const post of page.data) {
      if (!/^\d{1,20}$/.test(String(post.id || ""))) throw new Error("X 返回了无效帖子 ID；未写入该页");
    }
    const newToken = page.meta.next_token || "";
    if (newToken && (newToken === nextToken || seenTokens.has(newToken))) {
      throw new Error("X 分页游标重复；未写入该页");
    }
    await writeJsonAtomic(path.join(outDir, `page-${String(pages.length + 1).padStart(4, "0")}.json`), page);
    pages.push(page);
    if (newToken) seenTokens.add(newToken);
    nextToken = newToken;
    complete = !nextToken;
    await writeJsonAtomic(priorManifestPath, manifestFor(userId, pages, complete));
  }

  const manifest = manifestFor(userId, pages, complete, complete ? "" : "budget_limit");
  await writeJsonAtomic(priorManifestPath, manifest);
  if (pages.length) {
    await writeFile(path.join(outDir, "bookmarks.raw.jsonl"),
      `${pages.map((page) => JSON.stringify(page)).join("\n")}\n`, { mode: 0o600 });
  }
  return manifest;
}
