const OMNIGET_COOKIE_SITES = Object.freeze([
  ['bilibili', '哔哩哔哩'], ['douyin', '抖音'], ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'], ['x', 'X'], ['youtube', 'YouTube'],
]);
const OMNIGET_COOKIE_MAX_BYTES = 256 * 1024;

function omnigetCookieDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '即将失效';
}

function OmnigetCookieManager({ active = true, visible = true }) {
  const [connections, setConnections] = React.useState([]);
  const [site, setSite] = React.useState('youtube');
  const [file, setFile] = React.useState(null);
  const [hours, setHours] = React.useState('24');
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState(null);

  const loadConnections = React.useCallback(async () => {
    const result = await api('/api/omniget/cookies');
    setConnections(Array.isArray(result?.connections) ? result.connections : []);
  }, []);

  React.useEffect(() => {
    if (!active || !visible) return undefined;
    let live = true;
    loadConnections().catch(() => { if (live) setNotice({ type: 'error', text: '暂时无法读取已连接的站点，请稍后刷新。' }); });
    return () => { live = false; };
  }, [active, visible, loadConnections]);

  function chooseFile(event) {
    const next = event.target.files?.[0] || null;
    setNotice(null);
    if (next && next.size > OMNIGET_COOKIE_MAX_BYTES) {
      setFile(null);
      event.target.value = '';
      setNotice({ type: 'error', text: 'cookies.txt 不能超过 256 KiB。' });
      return;
    }
    setFile(next);
  }

  async function saveConnection(event) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy('save');
    setNotice(null);
    try {
      // Deliberately read the local file only after the person explicitly saves it.
      const cookiesTxt = await file.text();
      const result = await api(`/api/omniget/cookies/${encodeURIComponent(site)}`, {
        method: 'POST', body: { cookiesTxt, ttlSeconds: Number(hours) * 60 * 60 },
      });
      const connection = result?.connection;
      setConnections(current => [connection, ...current.filter(item => item.site !== connection?.site)].filter(Boolean));
      setFile(null);
      const chooser = document.getElementById('omniget-cookie-file');
      if (chooser) chooser.value = '';
      setNotice({ type: 'success', text: `${OMNIGET_COOKIE_SITES.find(item => item[0] === site)?.[1] || '该站点'}已连接，到期后会自动撤销。` });
    } catch {
      setNotice({ type: 'error', text: '保存未完成。请确认站点与 Netscape cookies.txt 格式后重试。' });
    } finally { setBusy(''); }
  }

  async function revokeConnection(connectionSite) {
    if (busy) return;
    setBusy(`revoke:${connectionSite}`);
    setNotice(null);
    try {
      const result = await api(`/api/omniget/cookies/${encodeURIComponent(connectionSite)}`, { method: 'DELETE' });
      const connection = result?.connection;
      setConnections(current => current.map(item => item.site === connectionSite ? connection : item).filter(item => item?.configured));
      setNotice({ type: 'success', text: '该站点连接已撤销。' });
    } catch {
      setNotice({ type: 'error', text: '撤销未完成，请稍后重试。' });
    } finally { setBusy(''); }
  }

  if (!active || !visible) return null;
  return <section className="omniget-cookie-manager" aria-labelledby="omniget-cookie-title">
    <header className="omniget-cookie-header"><div><span className="omniget-cookie-eyebrow">登录连接</span><h2 id="omniget-cookie-title">需要登录的内容</h2><p>仅在你主动上传站点对应的 Netscape <code>cookies.txt</code> 后使用。一个站点只连接一个账号，Cookie 加密保存、最长 24 小时，可随时撤销。</p></div><button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={() => loadConnections().catch(() => setNotice({ type: 'error', text: '暂时无法刷新状态，请稍后再试。' }))}>刷新状态</button></header>
    <form className="omniget-cookie-form" onSubmit={saveConnection}>
      <label>选择站点<select value={site} onChange={event => setSite(event.target.value)} disabled={Boolean(busy)}>{OMNIGET_COOKIE_SITES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>有效期<select value={hours} onChange={event => setHours(event.target.value)} disabled={Boolean(busy)}><option value="1">1 小时</option><option value="6">6 小时</option><option value="24">最长 24 小时</option></select></label>
      <label className="omniget-cookie-file-label">Netscape cookies.txt<input id="omniget-cookie-file" type="file" accept=".txt,text/plain" onChange={chooseFile} disabled={Boolean(busy)} aria-describedby="omniget-cookie-file-help" /><span id="omniget-cookie-file-help">仅接受 UTF-8 文本，最大 256 KiB；选中后不会读取，直到你点击保存。</span></label>
      <button className="btn btn-primary" type="submit" disabled={!file || Boolean(busy)}>{busy === 'save' ? '正在加密保存…' : '保存此站点连接'}</button>
    </form>
    {notice && <div className={`omniget-cookie-notice is-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    <div className="omniget-cookie-connections" aria-live="polite"><h3>已连接站点</h3>{connections.length === 0 ? <p className="omniget-cookie-empty">暂无站点连接。公开链接不需要 Cookie。</p> : <ul>{connections.map(connection => <li key={connection.site}><div><strong>{OMNIGET_COOKIE_SITES.find(item => item[0] === connection.site)?.[1] || connection.site}</strong><span>{connection.cookieCount} 条 Cookie · {connection.expiresAt ? `将在 ${omnigetCookieDate(connection.expiresAt)} 自动撤销` : '已失效'}</span></div><button className="btn btn-ghost" type="button" disabled={busy === `revoke:${connection.site}`} onClick={() => revokeConnection(connection.site)}>{busy === `revoke:${connection.site}` ? '正在撤销…' : '撤销连接'}</button></li>)}</ul>}</div>
  </section>;
}
