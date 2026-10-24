/// Authenticated, bounded local script: read one user's repository_assets, fetch current
/// GitHub repository metadata + README through the REST API using an already-configured
/// gh token, and store a source-grounded description + provenance back into
/// repository_assets. Never prints or persists the token. Node 22 built-ins only.
import { findUserByName } from "../lib/db.js";
import { getRepositoryAsset, listRepositoryAssets, updateRepositoryEnrichment } from "../lib/knowledge-store.js";
import { selectRepositoryDescription } from "../lib/repository-descriptions.js";
import { mapConcurrent } from "../lib/x-refinement-common.js";

const GITHUB_API = "https://api.github.com";
const MAX_ATTEMPTS = 3;

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a GitHub token from the environment or from an already-configured `gh` CLI
 * session, without ever logging, echoing, or persisting the value. Errors are generic on
 * purpose so a failure never leaks a partial token.
 */
async function resolveGithubToken() {
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { encoding: "utf8" }, (error, stdout) => {
      if (error || !String(stdout || "").trim()) {
        reject(new Error("无法获取 GitHub 令牌：请先运行 `gh auth login` 或设置 GH_TOKEN/GITHUB_TOKEN"));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/** One authenticated GitHub REST request with bounded retries for rate-limit/transient errors only. */
async function githubRequest(url, token, accept) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "omnihub-enrich-repository-descriptions",
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers });
    } catch {
      if (attempt >= MAX_ATTEMPTS) throw new Error("GitHub 请求网络失败");
      await sleep(300 * attempt);
      continue;
    }
    if (response.status === 404) return { status: 404, response: null };
    const rateLimited = response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    if (rateLimited && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
      const resetAt = Number(response.headers.get("x-ratelimit-reset") || 0) * 1000;
      const waitMs = retryAfter || (resetAt ? Math.max(0, resetAt - Date.now()) : 500 * attempt);
      await sleep(Math.min(waitMs, 5000));
      continue;
    }
    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(300 * attempt);
      continue;
    }
    if (!response.ok) return { status: response.status, response: null };
    return { status: response.status, response };
  }
  throw new Error("GitHub 请求在重试后仍然失败");
}

/**
 * Fetch repository metadata and README on demand. Returns { found: false } for
 * 404/private/deleted repositories so callers can continue with the source-grounded
 * fallback instead of treating it as an error.
 */
async function fetchGithubRepository(owner, name, token) {
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repoResult = await githubRequest(base, token);
  if (repoResult.status === 404) return { found: false };
  if (!repoResult.response) throw new Error(`GitHub 仓库元数据请求返回异常状态码 ${repoResult.status}`);
  const repoData = await repoResult.response.json();
  let readme = "";
  const readmeResult = await githubRequest(`${base}/readme`, token, "application/vnd.github.raw");
  if (readmeResult.response) readme = await readmeResult.response.text();
  return {
    found: true,
    description: repoData.description || "",
    topics: Array.isArray(repoData.topics) ? repoData.topics : [],
    readme,
    stars: Number(repoData.stargazers_count || 0),
    defaultBranch: repoData.default_branch || "",
    archived: Boolean(repoData.archived),
    private: Boolean(repoData.private),
  };
}

function isAlreadyEnriched(asset) {
  return Boolean(asset.metadata?.descriptionProvenance);
}

/** Process one repository asset end-to-end, never throwing past this boundary. */
async function processRepository(userId, asset, token) {
  try {
    const detail = getRepositoryAsset(userId, asset.key) || {};
    const sourcePosts = (detail.sources || []).map((source) => ({
      title: source.title || "",
      content: source.excerpt || "",
    }));
    let githubInfo;
    try {
      githubInfo = await fetchGithubRepository(asset.owner, asset.name, token);
    } catch {
      return { key: asset.key, outcome: "error", message: "GitHub 元数据请求失败" };
    }
    const selection = selectRepositoryDescription({
      owner: asset.owner,
      name: asset.name,
      description: githubInfo.found ? githubInfo.description : "",
      readme: githubInfo.found ? githubInfo.readme : "",
      topics: asset.topics && asset.topics.length ? asset.topics : (githubInfo.found ? githubInfo.topics : []),
      sourcePosts,
    });
    const metadata = {
      descriptionProvenance: selection.provenance,
      enrichedAt: new Date().toISOString(),
      github: githubInfo.found ? {
        found: true,
        stars: githubInfo.stars,
        defaultBranch: githubInfo.defaultBranch,
        archived: githubInfo.archived,
        private: githubInfo.private,
        topics: githubInfo.topics,
      } : { found: false },
    };
    const wrote = updateRepositoryEnrichment(userId, asset.key, { description: selection.text, metadata });
    if (!wrote) return { key: asset.key, outcome: "error", message: "写入仓库资产失败" };
    const outcome = selection.provenance === "github_readme" || selection.provenance === "github_description"
      ? "official" : "fallback";
    return { key: asset.key, outcome };
  } catch {
    return { key: asset.key, outcome: "error", message: "处理仓库时发生未知错误" };
  }
}

async function main() {
  const username = option("--username");
  if (!username) {
    throw new Error(
      "用法: node scripts/enrich-repository-descriptions-local.mjs --username <账号> " +
      "[--limit <N>] [--concurrency <N>] [--refresh]",
    );
  }
  const limitRaw = option("--limit");
  const limit = limitRaw ? Math.max(0, Number(limitRaw)) : Infinity;
  const concurrencyRaw = option("--concurrency");
  const concurrency = concurrencyRaw ? Math.max(1, Number(concurrencyRaw)) : 3;
  const refresh = flag("--refresh");

  const user = findUserByName(username);
  if (!user) throw new Error("OmniHub 账号不存在");

  const token = await resolveGithubToken();

  const allAssets = listRepositoryAssets(user.id);
  const candidates = (refresh ? allAssets : allAssets.filter((asset) => !isAlreadyEnriched(asset)))
    .slice(0, Number.isFinite(limit) ? limit : allAssets.length);

  const results = await mapConcurrent(candidates, concurrency,
    (asset) => processRepository(user.id, asset, token));

  let official = 0;
  let fallback = 0;
  let errors = 0;
  const errorDetails = [];
  for (const result of results) {
    const value = result.ok ? result.value : { key: "", outcome: "error", message: "内部任务失败" };
    if (value.outcome === "official") official += 1;
    else if (value.outcome === "fallback") fallback += 1;
    else { errors += 1; errorDetails.push({ key: value.key, message: value.message }); }
  }

  const summary = {
    username,
    totalRepositories: allAssets.length,
    candidates: candidates.length,
    skipped: allAssets.length - candidates.length,
    processed: results.length,
    official,
    fallback,
    errors,
    errorDetails,
    refresh,
    concurrency,
    completedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
