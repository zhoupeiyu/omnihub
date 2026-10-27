function AccountSettings({ active = true }) {
  const [xAccount, setXAccount] = React.useState(null);
  const [xError, setXError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState(() => {
    const result = new URLSearchParams(location.hash.split('?')[1] || '').get('result');
    return ({ connected: '', authorization_cancelled: '已取消授权，已有收藏不受影响。',
      invalid_state: '授权已过期或登录会话发生变化，请重新连接。', account_mismatch: 'X 账号与之前绑定的账号不同，没有导入或合并收藏。',
      scope_mismatch: '没有获得完整的只读收藏权限，请重新授权。', connect_budget_missing: '账号校验费用上限不足，请检查服务器配置。',
      connection_changed: '连接状态已变化，请重新授权。', failed: '连接未完成，请检查 X 应用配置后重试。' })[result] || '';
  });
  const [manageX, setManageX] = React.useState(false);
  const [now, setNow] = React.useState(Date.now);
  const xManagementId = React.useId();
  const loadX = React.useCallback(async (signal) => {
    setXError('');
    try {
      const next = await api('/api/account/x', { signal });
      if (signal?.aborted) return;
      setXAccount(next); setNow(Date.now());
    }
    catch (error) { if (!signal?.aborted) setXError(error.message || 'X 连接状态暂时无法读取。'); }
  }, []);
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void loadX(controller.signal);
    return () => controller.abort();
  }, [active, loadX]);
  React.useEffect(() => {
    if (!active || !xAccount?.sync?.running) return;
    const controller = new AbortController();
    const timer = setTimeout(() => loadX(controller.signal), 3000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, xAccount, loadX]);
  React.useEffect(() => {
    if (!active || !(xAccount?.sync?.nextAt > Date.now())) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(xAccount.sync.nextAt - Date.now() + 50, 30000));
    return () => clearTimeout(timer);
  }, [active, xAccount, now]);
  async function xAction(name, body = {}) {
    setBusy(`x:${name}`); setXError(''); setNotice('');
    try {
      const next = await api(`/api/account/x/${name}`, { method: 'POST', body });
      if (name === 'connect') { window.location.assign(next.authorizationUrl); return; }
      setXAccount(next); setNow(Date.now());
      if (name === 'sync') {
        const result = next.result || {};
        if (result.ok) { setNotice(`新增 ${result.imported || 0} 条收藏。`); window.dispatchEvent(new Event('omnihub:collection-updated')); }
        else setNotice(result.skipped === 'not_due' ? '尚未到下次可同步时间。' : result.skipped === 'running' ? '同步正在进行中，请稍后刷新状态。' : result.lastError || '同步未执行，请检查连接与费用上限。');
      }
      if (name === 'disconnect') { setManageX(false); setNotice('X 已断开，已有收藏保留。'); }
    } catch (error) { setXError(error.message || '操作未完成，请重试。'); }
    finally { setBusy(''); }
  }
  const blocked = { client_id_missing: '服务器尚未配置 X OAuth 应用 Client ID。', callback_missing: '服务器尚未配置有效的 X 回调地址。',
    encryption_key_missing: '服务器尚未配置独立的令牌加密密钥。', connect_budget_missing: '服务器尚未设置账号校验费用上限，或已达到上限。' };
  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未同步';
  const connectionState = xError ? ['warning', '待确认']
    : xAccount?.needsReconnect ? ['warning', '需重新授权']
    : xAccount?.connected ? ['success', '已连接'] : ['neutral', '未连接'];
  const syncing = busy === 'x:sync' || Boolean(xAccount?.sync?.running);
  const waiting = Number(xAccount?.sync?.nextAt) > now;
  const syncUnavailable = xAccount?.needsReconnect ? '请先重新授权 X。'
    : !xAccount?.sync?.serverReady ? '服务器同步未就绪，请检查抓取开关与费用上限。'
    : syncing ? '正在同步，请稍候。'
    : waiting ? `可再次同步：${formatTime(xAccount.sync.nextAt)}` : '';

  return <section className="connection-section sync-module account-x-section" aria-label="X 收藏">
    <div className="x-connection-heading">
      <div className="x-connection-identity"><div className="sync-module-title"><h3>X 收藏</h3>{(xAccount || xError) && <span className="sync-status" data-tone={connectionState[0]}>{connectionState[1]}</span>}</div>
        {xAccount?.connected && <span className="sync-meta">@{xAccount.username}</span>}
      </div>
      <div className="x-heading-actions">
        {xAccount?.connected && <button className="btn btn-primary" disabled={Boolean(busy) || Boolean(syncUnavailable)} onClick={() => xAction('sync')}>{syncing ? '同步中…' : '同步一次'}</button>}
        {xAccount?.connected && <button className="btn btn-ghost" aria-expanded={manageX} aria-controls={xManagementId} onClick={() => setManageX(value => !value)}>账号设置</button>}
        {xAccount && !xAccount.connected && <button className="btn btn-primary" disabled={Boolean(busy) || !xAccount.canConnect} onClick={() => xAction('connect')}>{xAccount.needsReconnect ? '重新授权 X' : '连接 X'}</button>}
      </div>
    </div>
    {xError && <div className="connection-error" role="alert"><p>{xError}</p><button className="btn" disabled={Boolean(busy)} onClick={() => loadX()}>重试 X 连接</button></div>}
    {!xAccount && !xError && <p className="sync-meta" role="status">正在读取连接…</p>}
    {xAccount?.connected && <>
      <div id={xManagementId} hidden={!manageX} className="x-account-tools">
        <span className="sync-meta">断开账号会停止同步，已有收藏保留。</span>
        <div className="x-heading-actions"><button className="btn" disabled={Boolean(busy) || !xAccount.canConnect} onClick={() => xAction('connect')}>重新授权 X</button><button className="btn x-disconnect" disabled={Boolean(busy)} onClick={() => xAction('disconnect')}>断开账号</button></div>
        {!xAccount.canConnect && <p className="sync-meta">{blocked[xAccount.blockedReason] || '授权配置尚未完成。'}</p>}
      </div>
      <div className="x-schedule-row">
        <div><strong>自动同步</strong><p className="sync-meta">{xAccount.syncEnabled ? '每 2 小时同步新增收藏' : '关闭时仍可手动同步'}</p></div>
        <div className="sync-toggle-label"><span className="sync-status" data-tone={xAccount.syncEnabled ? 'success' : 'neutral'}>{xAccount.syncEnabled ? '已开启' : '已关闭'}</span><button className="settings-switch" role="switch" aria-label="自动同步 X 收藏" aria-checked={Boolean(xAccount.syncEnabled)} disabled={Boolean(busy) || (!xAccount.syncEnabled && (!xAccount.sync.serverReady || xAccount.needsReconnect))} onClick={() => xAction('sync-settings', { enabled: !xAccount.syncEnabled })}><span /></button></div>
      </div>
      <div className="x-sync-footer"><span>上次成功 · {formatTime(xAccount.sync.lastSuccessAt)}</span><button className="btn btn-ghost" aria-label="刷新同步状态" title="刷新同步状态" disabled={Boolean(busy)} onClick={async () => { setBusy('x:reload'); await loadX(); setNow(Date.now()); setBusy(''); }}><IconRefresh /></button></div>
      {syncUnavailable && <p className="sync-meta" role="status">{syncUnavailable}</p>}
      {xAccount.sync.lastError && <div className="x-sync-error" role="status"><span className="sync-status" data-tone="danger">上次同步失败</span><span>{xAccount.sync.lastError}</span></div>}
    </>}
    {xAccount && !xAccount.connected && <p className="sync-meta">{xAccount.needsReconnect ? '授权已失效，重新连接后可继续同步。' : !xAccount.canConnect ? blocked[xAccount.blockedReason] || '授权配置尚未完成。' : '连接后可同步你的 X 收藏。'}</p>}
    {notice && <div className="account-notice sync-notice" role="status"><span>{notice}</span><button className="btn btn-ghost" aria-label="关闭提示" onClick={() => setNotice('')}><IconX /></button></div>}
  </section>;
}

function LocalCurationSettings() {
  const [connections, setConnections] = React.useState(null);
  const [connectionsError, setConnectionsError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [localError, setLocalError] = React.useState('');
  const [localModel, setLocalModel] = React.useState('');
  const [deviceLabel, setDeviceLabel] = React.useState('我的电脑');
  const [configureLocal, setConfigureLocal] = React.useState(false);
  const localConfigurationId = React.useId();
  const loadConnections = React.useCallback(async (signal) => {
    setConnectionsError('');
    try {
      const next = await api('/api/account/connections', { signal });
      if (signal?.aborted) return;
      setConnections(next);
      setLocalModel(String(next?.localCuration?.model || ''));
    } catch (error) {
      if (!signal?.aborted) setConnectionsError(error.message || '个人连接状态暂时无法读取。');
    }
  }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections]);
  async function saveLocalSettings(enabled) {
    const model = localModel.trim();
    if (!model) { setLocalError('请填写本机将使用的模型标识。'); return; }
    setBusy('local:settings'); setLocalError('');
    try {
      const next = await api('/api/local-curation/settings', { method: 'POST', body: { enabled, model } });
      setConnections(previous => previous ? { ...previous, localCuration: next } : previous);
      setLocalModel(String(next.model || model));
      setNotice(enabled ? '本地整理已启用。' : '本地整理已暂停。');
    } catch (error) { setLocalError(error.message || '本地整理设置未保存，请重试。'); }
    finally { setBusy(''); }
  }
  function downloadDeviceConfig(pair, model) {
    const config = { baseUrl: location.origin, deviceToken: pair.deviceToken, model, transport: 'claude-api' };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'omnihub-local-curation.json';
    anchor.style.display = 'none'; document.body.append(anchor); anchor.click(); anchor.remove();
    // Safari can cancel a download when its object URL disappears in the same
    // turn. Keep it only long enough for the browser to accept the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
  }
  async function createDevice() {
    const label = deviceLabel.trim() || '我的电脑';
    const model = localModel.trim();
    const savedModel = String(localCuration?.model || '').trim();
    if (!model || model !== savedModel) { setLocalError('请先保存当前模型，再创建设备配置。'); return; }
    setBusy('local:device'); setLocalError('');
    try {
      const pair = await api('/api/local-curation/devices', { method: 'POST', body: { label } });
      // The secret is deliberately used only to create the downloaded file.
      // It is never rendered, stored in the URL, localStorage, or component state.
      downloadDeviceConfig(pair, savedModel);
      await loadConnections();
      setNotice('配置已下载，内含设备凭证，请勿分享。');
    } catch (error) { setLocalError(error.message || '设备创建未完成，请重试。'); }
    finally { setBusy(''); }
  }
  async function revokeDevice(id, label) {
    setBusy(`local:revoke:${id}`); setLocalError('');
    try {
      await api(`/api/local-curation/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
      await loadConnections();
      setNotice(`已撤销“${label}”的访问权限。`);
    } catch (error) { setLocalError(error.message || '设备撤销未完成，请重试。'); }
    finally { setBusy(''); }
  }

  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未接入';
  const localCuration = connections?.localCuration;
  const devices = Array.isArray(localCuration?.devices) ? localCuration.devices : [];
  const activeDeviceCount = Array.isArray(localCuration?.devices)
    ? localCuration.devices.filter(device => !device.revokedAt && Number(device.expiresAt) > Date.now()).length
    : 0;
  const savedLocalModel = String(localCuration?.model || '').trim();
  const canCreateDevice = Boolean(savedLocalModel && localModel.trim() === savedLocalModel);
  const deviceState = device => {
    if (device.revokedAt) return { label: '已撤销', detail: `撤销于 ${formatTime(device.revokedAt)}`, inactive: true };
    if (Number(device.expiresAt) <= Date.now()) return { label: '已失效', detail: `失效于 ${formatTime(device.expiresAt)}`, inactive: true };
    return { label: device.lastSeenAt ? '已接入' : '尚未接入', detail: device.lastSeenAt ? `最近在线 ${formatTime(device.lastSeenAt)}` : `有效至 ${formatTime(device.expiresAt)}`, inactive: false };
  };

  return <div className="local-curation-settings">
    {notice && <div className="account-notice sync-notice" role="status"><span>{notice}</span><button className="btn btn-ghost" aria-label="关闭提示" onClick={() => setNotice('')}><IconX /></button></div>}
      <section className="connection-section sync-module local-curation-section" aria-label="本地整理设备">
        <div className="sync-module-heading"><h3>本地整理设备</h3>{localCuration && <div className="sync-toggle-label"><span>接收任务</span><button className="settings-switch" role="switch" aria-label="本地整理设备接收任务" aria-checked={Boolean(localCuration.enabled)} disabled={Boolean(busy) || !canCreateDevice} onClick={() => saveLocalSettings(!localCuration.enabled)}><span /></button></div>}</div>
        {connectionsError && <div className="connection-error" role="alert"><p>{connectionsError}</p><button className="btn" disabled={Boolean(busy)} onClick={() => loadConnections()}>重试个人连接</button></div>}
        {!localCuration && !connectionsError && <p className="sync-meta" role="status">正在读取设备…</p>}
        {localCuration && <>
          <div className="sync-row"><span className="sync-meta">{activeDeviceCount} 台有效设备{!savedLocalModel && ' · 尚未配置模型'}</span><button className="btn btn-ghost" aria-expanded={configureLocal} aria-controls={localConfigurationId} onClick={() => setConfigureLocal(value => !value)}>配置与设备</button></div>
          {localError && <p className="connection-error-text" role="alert">{localError}</p>}
          <div id={localConfigurationId} hidden={!configureLocal} className="sync-expanded">
            <div className="sync-field-action"><label className="connection-field">本机模型<input value={localModel} maxLength="120" placeholder="与本机 API 配置一致" onChange={event => setLocalModel(event.target.value)} /></label><button className="btn" disabled={Boolean(busy) || !localModel.trim() || localModel.trim() === savedLocalModel} onClick={() => saveLocalSettings(Boolean(localCuration.enabled))}>保存模型</button></div>
            <div className="device-list" aria-label="本地整理设备">{devices.length ? devices.map(device => { const state = deviceState(device); return <div className="device-row" key={device.id}><div><strong>{device.label || '未命名设备'}</strong><p><span className={state.inactive ? 'device-state inactive' : 'device-state'}>{state.label}</span> · {state.detail}</p></div>{!state.inactive && <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => revokeDevice(device.id, device.label || '这台设备')}>撤销</button>}</div>; }) : <p className="sync-meta">尚未添加设备。</p>}</div>
            <div className="device-create"><label className="connection-field">设备名称<input value={deviceLabel} maxLength="80" placeholder="例如 我的 Mac" onChange={event => setDeviceLabel(event.target.value)} /></label><button className="btn" disabled={Boolean(busy) || !canCreateDevice} onClick={createDevice}>添加并下载配置</button></div>
            {!canCreateDevice && <p className="sync-meta">请先保存当前模型，再添加设备或更改任务开关。</p>}
            <details className="local-curation-help"><summary>接入方法</summary><p>整理程序在本机运行，调用本机 Claude API；密钥不上传网站，不使用 ChatGPT 网页额度。模型名须与本机配置一致。</p><p>配置文件含设备访问权限，请勿分享。在本站代码目录执行：</p><code>node scripts/run-local-curation.mjs --config /绝对路径/omnihub-local-curation.json --check</code><p>网页不会自动安装或启动它；检查通过后，可在本机设置每 2 小时运行。</p></details>
          </div>
        </>}
      </section>

  </div>;
}
