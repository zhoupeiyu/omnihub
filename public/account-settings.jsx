function AccountSettings({ user, onClose }) {
  const [xAccount, setXAccount] = React.useState(null);
  const [connections, setConnections] = React.useState(null);
  const [xError, setXError] = React.useState('');
  const [connectionsError, setConnectionsError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState(() => {
    const result = new URLSearchParams(location.hash.split('?')[1] || '').get('result');
    return ({ connected: 'X 已连接。确认账号后，可以启用收藏同步。', authorization_cancelled: '已取消授权，已有收藏不受影响。',
      invalid_state: '授权已过期或登录会话发生变化，请重新连接。', account_mismatch: 'X 账号与之前绑定的账号不同，没有导入或合并收藏。',
      scope_mismatch: '没有获得完整的只读收藏权限，请重新授权。', connect_budget_missing: '账号校验费用上限不足，请检查服务器配置。',
      connection_changed: '连接状态已变化，请重新授权。', failed: '连接未完成，请检查 X 应用配置后重试。' })[result] || '';
  });
  const [localError, setLocalError] = React.useState('');
  const [localModel, setLocalModel] = React.useState('');
  const [deviceLabel, setDeviceLabel] = React.useState('我的电脑');

  const loadX = React.useCallback(async (signal) => {
    setXError('');
    try { setXAccount(await api('/api/account/x', { signal })); }
    catch (error) { if (!signal?.aborted) setXError(error.message || 'X 连接状态暂时无法读取。'); }
  }, []);
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
    void loadX(controller.signal); void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections, loadX]);

  async function xAction(name, body = {}) {
    setBusy(`x:${name}`); setXError(''); setNotice('');
    try {
      const next = await api(`/api/account/x/${name}`, { method: 'POST', body });
      if (name === 'connect') { window.location.assign(next.authorizationUrl); return; }
      setXAccount(next);
      if (name === 'sync') {
        const result = next.result || {};
        if (result.ok) { setNotice(`本轮新增 ${result.imported || 0} 条收藏。会进入你自己的本地整理队列；设备在线且启用整理时才会处理。`); window.dispatchEvent(new Event('omnihub:collection-updated')); }
        else setNotice(result.skipped === 'not_due' ? '距离上次同步未满 2 小时，无需重复读取。' : result.skipped === 'running' ? '同步正在进行中，请稍后刷新状态。' : result.lastError || '同步未执行，请检查连接、开关和服务器费用上限。');
      }
      if (name === 'disconnect') setNotice('本站已断开 X 连接并停止抓取；已有收藏和已发布成果均会保留。');
    } catch (error) { setXError(error.message || '操作未完成，请重试。'); }
    finally { setBusy(''); }
  }
  async function saveLocalSettings(enabled) {
    const model = localModel.trim();
    if (!model) { setLocalError('请填写本机将使用的模型标识。'); return; }
    setBusy('local:settings'); setLocalError('');
    try {
      const next = await api('/api/local-curation/settings', { method: 'POST', body: { enabled, model } });
      setConnections(previous => previous ? { ...previous, localCuration: next } : previous);
      setLocalModel(String(next.model || model));
      setNotice(enabled ? '本地整理已启用。等待你自己的设备按配置来领取任务。' : '本地整理已暂停；不会再由设备领取新任务。');
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
      setNotice('私有设备配置已下载。文件含设备访问权限，只保存到你自己的电脑，不要分享或上传。');
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

  const blocked = { client_id_missing: '服务器尚未配置 X OAuth 应用 Client ID。', callback_missing: '服务器尚未配置有效的 X 回调地址。',
    encryption_key_missing: '服务器尚未配置独立的令牌加密密钥。', connect_budget_missing: '服务器尚未设置账号校验费用上限，或已达到上限。' };
  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未同步';
  const connectionUser = connections?.user || user;
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

  return <DetailDrawer title="账号与连接" onClose={onClose} className="account-settings">
    <div className="detail-drawer-body account-settings-body">
      <p className="account-settings-intro">当前空间：<strong>{connectionUser?.username || '当前用户'}</strong>。原始收藏、未发布媒体与草稿仅属于这个账号；只有已发布的成果可公开浏览。</p>
      {notice && <p className="account-notice" role="status">{notice}</p>}

      <section className="connection-section account-x-section">
        <div className="connection-section-heading"><div><span className="connection-eyebrow">个人数据</span><h3>X 连接与收藏同步</h3></div><button className="btn btn-ghost" disabled={busy === 'x:reload'} onClick={async () => { setBusy('x:reload'); await loadX(); setBusy(''); }}>刷新状态</button></div>
        {xError ? <div className="connection-error" role="alert"><p>{xError}</p><button className="btn" onClick={() => loadX()}>重试 X 连接</button></div> : !xAccount ? <p className="muted">正在读取 X 连接状态…</p> : <>
          <p className="connection-summary">{xAccount.connected ? `已连接 @${xAccount.username}` : '尚未连接 X'}。只读取你授权账号的收藏，不发帖、不点赞、不修改收藏。</p>
          {xAccount.needsReconnect && <p role="status">已有授权不可用，请重新连接 X。</p>}
          {!xAccount.canConnect && <p className="muted">{blocked[xAccount.blockedReason] || '授权配置尚未完成。'} 密钥只保存在服务器，不要在此粘贴。</p>}
          <div className="connection-actions"><button className="btn btn-primary" disabled={Boolean(busy) || !xAccount.canConnect} onClick={() => xAction('connect')}>{xAccount.connected ? '重新授权 X' : '授权我的 X 账号'}</button>
            {xAccount.connected && <button className="btn" disabled={Boolean(busy)} onClick={() => xAction('disconnect')}>断开连接</button>}</div>
          {xAccount.connected ? <div className="connection-subsection"><div><strong>自动同步</strong><p>每 2 小时检查一次新增收藏。某次未返回旧收藏不会删除已有数据。</p></div>
            {!xAccount.sync.serverReady && <p className="muted">服务器尚未启用自动抓取或配置费用上限，当前不会调用 X 读取收藏。</p>}
            <div className="connection-actions"><button className="btn" disabled={Boolean(busy) || (!xAccount.syncEnabled && !xAccount.sync.serverReady)} onClick={() => xAction('sync-settings', { enabled: !xAccount.syncEnabled })}>{xAccount.syncEnabled ? '暂停自动同步' : '启用每 2 小时同步'}</button>
              <button className="btn" disabled={Boolean(busy) || !xAccount.syncEnabled || !xAccount.sync.serverReady} onClick={() => xAction('sync')}>检查新增收藏</button></div>
            <p className="muted">上次成功：{formatTime(xAccount.sync.lastSuccessAt)}</p>{xAccount.sync.lastError && <p role="status">{xAccount.sync.lastError}</p>}
          </div> : <p className="muted">连接后可设置每 2 小时同步，已有收藏保留。</p>}
        </>}
      </section>

      <section className="connection-section local-curation-section">
        <div className="connection-section-heading"><div><span className="connection-eyebrow">只在你的设备上运行</span><h3>本地整理</h3></div></div>
        {connectionsError ? <div className="connection-error" role="alert"><p>{connectionsError}</p><button className="btn" onClick={() => loadConnections()}>重试个人连接</button></div> : !localCuration ? <p className="muted">正在读取本地整理状态…</p> : <>
          <p className="connection-summary">新收藏会进入当前账号自己的队列；整理程序在本机运行，并调用这台电脑已有的 Claude API。API 密钥不上传网站，也不使用 ChatGPT 网页额度。</p>
          <label className="connection-field">本机模型标识<input value={localModel} maxLength="120" placeholder="例如 claude-opus-5-5" onChange={event => setLocalModel(event.target.value)} /></label>
          <p className="muted">模型名必须与本机 Claude API 配置一致。</p>
          <div className="connection-actions"><button className="btn" disabled={Boolean(busy) || !localModel.trim()} onClick={() => saveLocalSettings(Boolean(localCuration.enabled))}>保存模型</button>
            <button className={localCuration.enabled ? 'btn' : 'btn btn-primary'} disabled={Boolean(busy) || !localModel.trim()} onClick={() => saveLocalSettings(!localCuration.enabled)}>{localCuration.enabled ? '暂停本地整理' : '启用本地整理'}</button></div>
          {localError && <p className="connection-error-text" role="alert">{localError}</p>}
          <div className="device-summary"><span>{localCuration.enabled ? '本地整理已启用' : '本地整理尚未启用'}</span><span>有效设备 {activeDeviceCount} 台</span></div>
          <div className="device-list" aria-label="本地整理设备">{devices.length ? devices.map(device => { const state = deviceState(device); return <div className="device-row" key={device.id}><div><strong>{device.label || '未命名设备'}</strong><p><span className={state.inactive ? 'device-state inactive' : 'device-state'}>{state.label}</span> · {state.detail}</p></div>{!state.inactive && <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => revokeDevice(device.id, device.label || '这台设备')}>撤销</button>}</div>; }) : <p className="muted">尚未接入设备。先保存模型，再在你自己的电脑上创建设备配置。</p>}</div>
          <div className="device-create"><label className="connection-field">设备名称<input value={deviceLabel} maxLength="80" placeholder="例如 我的 Mac" onChange={event => setDeviceLabel(event.target.value)} /></label><button className="btn" disabled={Boolean(busy) || !canCreateDevice} onClick={createDevice}>创建设备并下载配置</button></div>
          {!canCreateDevice && <p className="muted">请先保存当前模型，再创建设备配置。</p>}
          <details className="local-curation-help"><summary>在本机继续接入</summary><p>下载后的配置文件含设备访问权限。仅保存到你自己的电脑，设为私有文件后，在已安装本站代码的目录执行：</p><code>node scripts/run-local-curation.mjs --config /绝对路径/omnihub-local-curation.json --check</code><p>检查通过后，是否安装每 2 小时的本机计划任务由你自己决定；此网页不会自动安装或启动它。</p></details>
        </>}
      </section>

      <LocalImageDevices />
      <section className="connection-section chatgpt-section">
        <div className="connection-section-heading"><div><span className="connection-eyebrow">官方托管能力</span><h3>ChatGPT 连接</h3></div></div>
        {connectionsError ? <p className="muted">个人连接状态暂时无法读取；不会因此影响 X 连接或本地整理的已有配置。</p> : !connections?.chatgpt ? <p className="muted">正在读取 ChatGPT 连接状态…</p> : <>
          <p className="connection-summary">{connections.chatgpt.status === 'unavailable' ? '当前不可连接。' : '连接状态正在由服务器确认。'} 不会共用其他人的 ChatGPT、Codex 或 API 额度。</p>
          {connections.chatgpt.status === 'unavailable' && <details className="chatgpt-limitations"><summary>为什么现在不能授权？</summary><p>本站尚未获得 ChatGPT 托管应用的正式接入资格。即使将来开通，当前官方通道也不支持图像生成；因此这里不会显示无法完成的授权或生图按钮。</p></details>}
        </>}
      </section>
    </div>
  </DetailDrawer>;
}
