import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const organizedFile = option("--organized");
const mediaManifestFile = option("--media-manifest");
const outputFile = option("--out");
if (![organizedFile, mediaManifestFile, outputFile].every((value) => value && path.isAbsolute(value))) {
  console.error("用法: node scripts/render-x-review.mjs --organized <整理后 JSONL> --media-manifest <媒体清单> --out <复核 Markdown>");
  process.exit(2);
}

const assetNames = { prompt: "提示词", resource: "资源", knowledge: "知识", idea: "项目想法", unknown: "待核对" };
const topicNames = {
  video: "视频与短剧", image: "图像创作", software: "开发与 AI", crypto: "加密领域",
  product: "产品设计", workflow: "效率方法", business: "商业", other: "其他",
};
const inline = (value) => String(value || "").replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").slice(0, 120);
const quoted = (value) => String(value || "").split(/\r?\n/).map((line) => `> ${line.replace(/[<>]/g, "")}`).join("\n");

try {
  const rows = (await readFile(organizedFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const summary = JSON.parse(await readFile(path.join(path.dirname(organizedFile), "summary.json"), "utf8"));
  const mediaManifest = JSON.parse(await readFile(mediaManifestFile, "utf8"));
  if (summary.posts !== rows.length) throw new Error("整理数量与复核数据不一致");
  const topicCounts = new Map(Object.keys(topicNames).map((topic) => [topic, 0]));
  const relatedGroups = new Map();
  let promptIncomplete = 0;
  let archivedMedia = 0;
  for (const row of rows) {
    const org = row.organization;
    topicCounts.set(org.topic, (topicCounts.get(org.topic) || 0) + 1);
    if (org.assetType === "prompt" && org.contentIncomplete) promptIncomplete += 1;
    const members = relatedGroups.get(org.groupId) || [];
    members.push(row);
    relatedGroups.set(org.groupId, members);
    for (const [index, media] of (row.media || []).entries()) {
      if (mediaManifest[`${row.externalId}:${media.media_key || index}`]?.status === "saved") archivedMedia += 1;
    }
  }
  const multiPostGroups = [...relatedGroups.values()].filter((members) => members.length > 1);
  const relatedPostCount = multiPostGroups.reduce((count, members) => count + members.length, 0);
  const visibleTopics = [...topicCounts].filter(([, count]) => count > 0);
  const lines = [
    "# X 收藏分类复核",
    "",
    summary.coverage === "complete" ? "来源：完整导出"
      : summary.coverage === "partial_ui_scan" ? "来源：X 页面部分采集；尚未读到列表末尾，不能代表当前全部收藏"
        : summary.coverage === "partial_xarchive_scan" ? "来源：xarchive Full refresh；收藏分页重复，未证实读到末尾，不能代表当前全部收藏"
        : "来源：历史快照，不能代表当前全部收藏",
    "",
    `收藏 ${summary.posts} 条；浏览主题 ${visibleTopics.length} 类；同作者多帖关联 ${multiPostGroups.length} 组、${relatedPostCount} 条；待核对 ${summary.needsReview} 条。`,
    ...(summary.coverage === "partial_ui_scan" ? [
      "", `其中 ${summary.textTruncated} 条正文不完整，可能是折叠内容或文章卡片摘要。未补全的内容只供暂时分类，提示词不可直接复用。新媒体仅保留原始链接，未向 X 下载。`,
    ] : []),
    ...(summary.coverage === "partial_xarchive_scan" ? [
      "", `xarchive 因分页游标重复而停止，本批次保存了已读到的 ${summary.posts} 条；其中 ${summary.textTruncated} 条正文不可用。即使页面采集的记录全部包含在内，也不能据此认定这是当前全部收藏。`,
    ] : []),
    "",
    "单条收藏不会占用一个浏览主题。同一作者谈论同一具体事项时只建立关联，每条原帖仍单独保留。TypeSafe 仅判断文字与可用说明，图片内容需看下方原图。",
    "",
    "## 阅读索引",
    "",
    `提示词 ${summary.assetTypes.prompt || 0} 条，其中 ${promptIncomplete} 条正文待补全。媒体 ${summary.mediaCount} 项，其中 ${archivedMedia} 项已有本地归档，其余只保留原始链接。`,
    "",
    `主题：${visibleTopics.map(([topic, count]) => `[${topicNames[topic] || topic} ${count} 条](#topic-${topic})`).join(" · ")}`,
    "",
    `### 同主题关联（${multiPostGroups.length} 组，${relatedPostCount} 条）`,
    "",
  ];
  if (!multiPostGroups.length) lines.push("暂无多帖主题组。", "");
  for (const members of multiPostGroups) {
    lines.push(`- ${inline(members[0].organization.groupTitle || members[0].title) || "未命名主题"}：` +
      members.map((row) => `[${inline(row.author) || "作者"} · ${row.externalId}](${row.url})`).join("、"));
  }
  lines.push("");
  for (const [topic, count] of visibleTopics) {
    lines.push(`<a id="topic-${topic}"></a>`, "", `## ${topicNames[topic] || topic}（${count}）`, "");
    const topicRows = rows.filter((row) => row.organization.topic === topic);
    for (const assetType of ["prompt", "resource", "knowledge", "idea", "unknown"]) {
      const section = topicRows.filter((row) => row.organization.assetType === assetType);
      if (!section.length) continue;
      lines.push(`### ${assetNames[assetType]}（${section.length}）`, "");
      for (const row of section) {
        const org = row.organization;
        const relatedCount = relatedGroups.get(org.groupId)?.length || 1;
        lines.push(`#### ${inline(row.title) || `X 帖子 ${row.externalId}`}`, "");
        lines.push(`来源：[原帖](${row.url}) · ${inline(row.author) || `作者 ID ${row.metrics?.authorId || "未知"}`}`);
        lines.push(`TypeSafe 类型置信度：${Number(org.assetConfidence || 0).toFixed(2)}` +
          (relatedCount > 1 ? ` · 同作者关联 ${relatedCount} 条` : ""), "");
        if (org.contentIncomplete) lines.push("**正文待补全**：页面只显示了片段或卡片摘要。", "");
        if (assetType === "prompt" || assetType === "unknown") lines.push(quoted(row.content), "");
        for (const [index, media] of (row.media || []).entries()) {
          const key = `${row.externalId}:${media.media_key || index}`;
          const archived = mediaManifest[key];
          if (archived?.status === "saved") {
            const localFile = path.join(path.dirname(mediaManifestFile), archived.file);
            lines.push(`![效果图 ${index + 1}](${localFile})`, "");
          } else {
            const mediaUrl = media.type === "photo" ? media.url : media.preview_image_url || media.url;
            if (mediaUrl) lines.push(`[媒体 ${index + 1}：原始链接，未本地归档](${mediaUrl})`, "");
          }
        }
        lines.push("");
      }
    }
  }
  const lowConfidence = rows.filter((row) => !row.organization.contentIncomplete &&
    row.organization.assetType !== "unknown" &&
    (row.organization.assetConfidence < 0.5 || row.organization.topicConfidence < 0.5));
  lines.push(`## 其他低置信度条目（${lowConfidence.length}）`, "");
  for (const row of lowConfidence) {
    lines.push(`- [${inline(row.title) || row.externalId}](${row.url})：${assetNames[row.organization.assetType]}，` +
      `类型 ${Number(row.organization.assetConfidence || 0).toFixed(2)}，主题 ${Number(row.organization.topicConfidence || 0).toFixed(2)}`);
  }
  lines.push("");
  await writeFile(outputFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputFile, posts: rows.length, mediaLinks: Object.keys(mediaManifest).length }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
