import { randomBytes, createHash } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { createEncryptedTokenFile } from "../lib/x-bookmark-sync.js";

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? "" : process.argv[index + 1] || ""; }
const clientId = option("--client-id"); const redirectUri = option("--redirect-uri"); const file = option("--token-file"); const key = process.env.OMNIHUB_X_BOOKMARK_TOKEN_KEY || "";
const stateFile = option("--state-file"); const exchange = process.argv.includes("--exchange"); const clientSecret = process.env.OMNIHUB_X_BOOKMARK_CLIENT_SECRET || "";
const connectBudget = Number(process.env.OMNIHUB_X_BOOKMARK_CONNECT_USD || 0);
if (!clientId || !redirectUri || !file || !stateFile || !key) {
  console.error("用法: OMNIHUB_X_BOOKMARK_TOKEN_KEY=... node scripts/connect-x-bookmarks.mjs --client-id <id> --redirect-uri <精确回调地址> --token-file <绝对路径> --state-file <绝对路径> [--exchange]；机密客户端密钥仅从 OMNIHUB_X_BOOKMARK_CLIENT_SECRET 读取。"); process.exit(2);
}
if (!file.startsWith("/") || !stateFile.startsWith("/")) { console.error("令牌与 PKCE 状态文件必须使用绝对路径"); process.exit(2); }
if (!exchange) {
  const generated = randomBytes(48).toString("base64url"); const challenge = createHash("sha256").update(generated).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "tweet.read users.read bookmark.read offline.access", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  await rm(`${stateFile}.exchange-lock`, { force: true });
  await createEncryptedTokenFile(stateFile, key).set({ verifier: generated, state, client_id: clientId, redirect_uri: redirectUri, created_at: Date.now() });
  console.log("已写入加密 PKCE 状态文件。浏览器授权后，把完整回调 URL 通过标准输入交给本命令的 --exchange 模式；不要把 URL、code、state、密钥发送到聊天。"); console.log(url.toString()); process.exit(0);
}
if (!Number.isFinite(connectBudget) || connectBudget < 0.01) { console.error("OMNIHUB_X_BOOKMARK_CONNECT_USD 至少需覆盖一次账号读取的 0.01 美元保守预留，才会进行 X 账号核对请求"); process.exit(2); }
const callback = (await readFile(0, "utf8")).trim(); let lock;
try { lock = await open(`${stateFile}.exchange-lock`, "wx", 0o600); } catch { console.error("该 PKCE 授权已被使用或正在交换，请重新开始连接"); process.exit(2); }
await lock.close();
const saved = await createEncryptedTokenFile(stateFile, key).get(); let code = ""; let callbackState = ""; let callbackUrl;
try { callbackUrl = new URL(callback); code = callbackUrl.searchParams.get("code") || ""; callbackState = callbackUrl.searchParams.get("state") || ""; } catch { /* handled below */ }
const expected = new URL(redirectUri);
if (!code || !saved?.verifier || callbackState !== saved.state || !callbackUrl || callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname || saved.client_id !== clientId || saved.redirect_uri !== redirectUri || Date.now() - Number(saved.created_at || 0) > 10 * 60_000) { console.error("授权回调或 PKCE 状态无效/已过期，请重新开始连接"); process.exit(2); }
const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: saved.verifier });
const headers = { "content-type": "application/x-www-form-urlencoded" }; if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
const response = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(45_000) });
if (!response.ok) { console.error(`X 授权交换失败（HTTP ${response.status}）`); process.exit(1); }
const token = await response.json(); if (!token.access_token || !token.refresh_token) { console.error("X 未返回离线刷新令牌，请确认 offline.access scope"); process.exit(1); }
const me = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${token.access_token}` }, redirect: "error", signal: AbortSignal.timeout(45_000) });
const profile = me.ok ? await me.json() : null;
if (!/^\d{1,19}$/.test(String(profile?.data?.id || ""))) { console.error("无法核对当前 X 授权账号，未写入令牌文件"); process.exit(1); }
await createEncryptedTokenFile(file, key).set({ ...token, x_user_id: String(profile.data.id), expires_at: Date.now() + Number(token.expires_in || 7200) * 1000 });
console.log(`已核对 X 账号 ${profile.data.id}，并将加密令牌写入指定文件（0600）。请将同一加密密钥仅配置在服务器环境变量中。`);
