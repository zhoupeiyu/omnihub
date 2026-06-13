/// 登录 / 注册页
const { useState: useAuthState } = React;

function AuthView({ onLoggedIn }) {
  const [mode, setMode] = useAuthState("login"); // login | register
  const [username, setUsername] = useAuthState("");
  const [password, setPassword] = useAuthState("");
  const [error, setError] = useAuthState("");
  const [busy, setBusy] = useAuthState(false);

  function handleSubmit() {
    if (!username.trim()) { setError("请填写用户名"); return; }
    if (!password) { setError("请填写密码"); return; }
    setBusy(true);
    api(mode === "login" ? "/api/login" : "/api/register", {
      method: "POST",
      body: { username: username.trim(), password },
    })
      .then((user) => onLoggedIn(user))
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="logo-mark">万</div>
          <h1>万象台</h1>
        </div>
        <p className="auth-sub">登录后，你的收藏、提示词和 AI 配置都跟着账号走</p>
        <div className="auth-tabs">
          <button className={"auth-tab" + (mode === "login" ? " active" : "")}
            onClick={() => { setMode("login"); setError(""); }}>登录</button>
          <button className={"auth-tab" + (mode === "register" ? " active" : "")}
            onClick={() => { setMode("register"); setError(""); }}>注册新账号</button>
        </div>
        <div className="form-field">
          <label>用户名</label>
          <input className="input" placeholder="2–20 个字符" value={username} autoFocus
            onChange={(e) => { setUsername(e.target.value); setError(""); }} />
        </div>
        <div className="form-field">
          <label>密码</label>
          <input className="input" type="password" placeholder={mode === "register" ? "至少 6 位" : "你的密码"}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }} />
        </div>
        {error && <p className="auth-error">{error}</p>}
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
          onClick={handleSubmit} disabled={busy}>
          {busy ? "请稍候…" : (mode === "login" ? "登录" : "注册并进入")}
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { AuthView });
