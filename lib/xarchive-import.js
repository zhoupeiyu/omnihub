import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

/** Convert a completed xarchive full snapshot into the same private JSONL input as X API pages. */
export function convertXarchiveSnapshot(archive, expectedUserId, { allowPartial = false } = {}) {
  const metadata = archive?.export_metadata;
  const coverage = metadata?.collection;
  if (!/^\d{1,19}$/.test(String(expectedUserId || "")) || metadata?.user_id !== String(expectedUserId)) {
    throw new Error("xarchive 导出账号与预期 X 账号不一致");
  }
  const complete = coverage?.mode === "full" && coverage.bookmarks === "complete";
  const guardedPartial = coverage?.mode === "full" && coverage.bookmarks === "partial" &&
    coverage.reason === "pagination_guard";
  if (metadata.kind !== "snapshot" || (!complete && !(allowPartial && guardedPartial))) {
    throw new Error("请选择 Full refresh 完成后下载的 latest snapshot；累计或部分导出不能证明当前收藏完整");
  }
  if (!Array.isArray(archive.bookmarks) || !archive.bookmarks.length) {
    throw new Error("xarchive 快照中没有收藏记录");
  }
  const ids = new Set();
  const posts = archive.bookmarks.map((bookmark) => {
    const id = String(bookmark?.tweet_id || "");
    if (!/^\d{1,20}$/.test(id) || ids.has(id)) throw new Error("xarchive 包含无效或重复的帖子 ID");
    ids.add(id);
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(bookmark.author?.screen_name || "")
      ? bookmark.author.screen_name : "i";
    const content = String(bookmark.full_text || "").trim();
    const media = (bookmark.media || []).map((entry, index) => ({
      media_key: `${id}-${index}`,
      type: String(entry.type || ""),
      url: httpUrl(entry.url),
      preview_image_url: httpUrl(entry.thumbnail_url || entry.url),
      alt_text: String(entry.alt_text || ""),
      variants: Array.isArray(entry.variants) ? entry.variants : [],
    }));
    const links = (bookmark.entities?.urls || []).map((entry) => httpUrl(entry.expanded_url || entry.url))
      .filter((url, index, all) => url && all.indexOf(url) === index);
    const quoted = bookmark.quoted_tweet && typeof bookmark.quoted_tweet === "object"
      ? bookmark.quoted_tweet : null;
    return {
      source: "x",
      externalId: id,
      title: content.split(/\r?\n/)[0].slice(0, 160) || `X 帖子 ${id}`,
      url: `https://x.com/${handle}/status/${id}`,
      author: handle === "i" ? "" : `@${handle}`,
      content,
      media,
      links,
      metrics: {
        ...bookmark.metrics,
        authorId: String(bookmark.author?.user_id || ""),
        postCreatedAt: bookmark.created_at || "",
        lang: bookmark.lang || "",
        folders: Array.isArray(bookmark.folders) ? bookmark.folders : [],
        status: bookmark.status || "available",
        unavailableReason: bookmark.unavailable_reason || "",
        quotedTweet: quoted,
      },
    };
  });
  return {
    posts,
    manifest: {
      source: complete ? "xarchive latest full snapshot" : "xarchive pagination-guarded snapshot",
      userId: String(expectedUserId),
      screenName: metadata.screen_name || "",
      coverage: complete ? "complete" : "partial_xarchive_scan",
      complete,
      partialReason: complete ? "" : coverage.reason,
      foldersComplete: coverage.folders === "complete",
      uniquePosts: posts.length,
      exportedAt: metadata.exported_at || "",
    },
  };
}

export async function saveXarchiveSnapshot({ archiveFile, expectedUserId, outDir, allowPartial = false }) {
  if (!path.isAbsolute(archiveFile) || !path.isAbsolute(outDir)) throw new Error("路径必须是绝对路径");
  const archive = JSON.parse(await readFile(archiveFile, "utf8"));
  const { posts, manifest } = convertXarchiveSnapshot(archive, expectedUserId, { allowPartial });
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  await writeFile(path.join(outDir, "bookmarks.raw.jsonl"),
    `${posts.map((post) => JSON.stringify(post)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest)}\n`,
    { mode: 0o600, flag: "wx" });
  return manifest;
}
