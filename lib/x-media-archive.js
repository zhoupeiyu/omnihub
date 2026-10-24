import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"],
  ["image/webp", "webp"], ["image/gif", "gif"],
]);

function mediaUrl(entry) {
  const raw = entry.type === "photo" ? entry.url : entry.preview_image_url || entry.url;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "pbs.twimg.com" ? url.toString() : "";
  } catch { return ""; }
}

async function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

async function readImage(response) {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const extension = IMAGE_TYPES.get(type);
  if (!extension) throw new Error("媒体响应不是支持的图片格式");
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error("单张图片超过 10MB");
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error("单张图片超过 10MB"); }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), extension };
}

/** Archive preview/effect images locally; source URLs stay in the organized export. */
export async function archiveXMedia({ posts, outDir, fetchImpl = fetch }) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const mediaDir = path.join(outDir, "media");
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(outDir, "media-manifest.json");
  let records = {};
  try { records = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  for (const post of posts) {
    for (const [index, media] of (post.media || []).entries()) {
      const key = `${post.externalId}:${media.media_key || index}`;
      const url = mediaUrl(media);
      if (!url) {
        records[key] = { status: "missing_url", postId: post.externalId };
        await atomicJson(manifestPath, records);
        continue;
      }
      const old = records[key];
      if (old?.status === "saved" && old.url === url) {
        try {
          const bytes = await readFile(path.join(outDir, old.file));
          if (createHash("sha256").update(bytes).digest("hex") === old.sha256) continue;
        } catch { /* Re-fetch a missing or changed local copy. */ }
      }
      try {
        let downloadUrl = url;
        let response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
        if (response.status === 404) {
          const fallback = new URL(url);
          if (fallback.searchParams.get("name") === "orig") {
            await response.body?.cancel();
            fallback.searchParams.set("name", "large");
            downloadUrl = fallback.toString();
            response = await fetchImpl(downloadUrl, { redirect: "manual", signal: AbortSignal.timeout(30000) });
          }
        }
        if (!response.ok || response.url && new URL(response.url).hostname !== "pbs.twimg.com") {
          throw new Error(`媒体下载失败（HTTP ${response.status}）`);
        }
        const { bytes, extension } = await readImage(response);
        const file = path.join("media", `${post.externalId}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}.${extension}`);
        await writeFile(path.join(outDir, file), bytes, { mode: 0o600 });
        records[key] = {
          status: "saved", postId: post.externalId, url, downloadUrl, file,
          bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (error) {
        records[key] = { status: "failed", postId: post.externalId, url, reason: error.message };
      }
      await atomicJson(manifestPath, records);
    }
  }
  const values = Object.values(records);
  return {
    total: values.length,
    saved: values.filter((entry) => entry.status === "saved").length,
    failed: values.filter((entry) => entry.status !== "saved").length,
    manifestPath,
  };
}
