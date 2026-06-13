/// 前端请求封装 —— 统一 JSON、错误抛出 { status, message }
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  let payload = null;
  try { payload = await response.json(); } catch (err) { /* 空响应 */ }
  if (!response.ok) {
    const error = new Error((payload && payload.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

window.api = api;
