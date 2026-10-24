import { normalizeXInboxRow, sourceRecord } from "./x-refinement-common.js";

const RESERVED_ROOTS = new Set([
  "about", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore",
  "features", "issues", "login", "marketplace", "new", "notifications", "orgs", "pricing", "pulls",
  "search", "security", "settings", "site", "sponsors", "topics", "trending",
]);

export function parseGitHubRepositoryLink(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { return null; }
  if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2 || RESERVED_ROOTS.has(parts[0].toLowerCase())) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (!owner || !name) return null;
  const marker = String(parts[2] || "").toLowerCase();
  const kind = marker === "blob" ? "file" : marker === "tree" ? "directory" :
    marker === "releases" || marker === "release" ? "release" : marker ? "repository_page" : "repository";
  return {
    key: `${owner}/${name}`.toLowerCase(),
    owner,
    name,
    repositoryUrl: `https://github.com/${owner}/${name}`,
    targetUrl: url.href,
    kind,
  };
}

/** Build one repository asset from any number of saved X posts and deep links. */
export function extractXGitHubAssets(rows) {
  const repositories = new Map();
  for (const item of rows.map(normalizeXInboxRow)) {
    if (item.source !== "x" || !item.externalId) continue;
    const matches = item.links.map(parseGitHubRepositoryLink).filter(Boolean);
    for (const match of matches) {
      if (!repositories.has(match.key)) {
        repositories.set(match.key, {
          key: match.key,
          owner: match.owner,
          name: match.name,
          repositoryUrl: match.repositoryUrl,
          targetLinks: [],
          sourcePosts: [],
          linkOccurrenceCount: 0,
          topics: [],
          existingAssetTypes: [],
        });
      }
      const repository = repositories.get(match.key);
      repository.linkOccurrenceCount += 1;
      if (!repository.targetLinks.some((link) => link.url === match.targetUrl)) {
        repository.targetLinks.push({ url: match.targetUrl, kind: match.kind });
      }
      if (!repository.sourcePosts.some((post) => post.externalId === item.externalId)) {
        repository.sourcePosts.push(sourceRecord(item));
      }
      const topic = item.organization.topic;
      const assetType = item.organization.assetType;
      if (topic && !repository.topics.includes(topic)) repository.topics.push(topic);
      if (assetType && !repository.existingAssetTypes.includes(assetType)) {
        repository.existingAssetTypes.push(assetType);
      }
    }
  }
  return [...repositories.values()].map((repository) => ({
    ...repository,
    sourcePostCount: repository.sourcePosts.length,
    targetLinkCount: repository.targetLinks.length,
    targetLinks: repository.targetLinks.sort((a, b) => a.url.localeCompare(b.url)),
    sourcePosts: repository.sourcePosts.sort((a, b) => a.externalId.localeCompare(b.externalId)),
    topics: repository.topics.sort(),
    existingAssetTypes: repository.existingAssetTypes.sort(),
  })).sort((a, b) => b.sourcePostCount - a.sourcePostCount || a.key.localeCompare(b.key));
}

export function summarizeXGitHubAssets(assets) {
  const kinds = {};
  const topics = {};
  const uniqueSourcePosts = new Set();
  let uniqueTargetLinks = 0;
  let rawLinkOccurrences = 0;
  let sourcePosts = 0;
  for (const asset of assets) {
    uniqueTargetLinks += asset.targetLinkCount;
    rawLinkOccurrences += asset.linkOccurrenceCount;
    sourcePosts += asset.sourcePostCount;
    for (const post of asset.sourcePosts) uniqueSourcePosts.add(post.externalId);
    for (const link of asset.targetLinks) kinds[link.kind] = (kinds[link.kind] || 0) + 1;
    for (const topic of asset.topics) topics[topic] = (topics[topic] || 0) + 1;
  }
  return {
    repositories: assets.length,
    rawLinkOccurrences,
    uniqueTargetLinks,
    uniqueSourcePosts: uniqueSourcePosts.size,
    sourcePostReferences: sourcePosts,
    repositoriesWithMultipleSourcePosts: assets.filter((asset) => asset.sourcePostCount > 1).length,
    uniqueLinkKinds: kinds,
    topics,
  };
}
