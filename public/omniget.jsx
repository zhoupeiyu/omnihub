function omnigetFileSize(bytes) { return Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : ''; }
function omnigetQueueStatus(state) { return ({ queued: '等待队列', parsing: '正在解析', parsed: '已解析', awaiting_choice: '等待下载', downloading: '正在下载', ready: '已完成', failed: '处理失败', cancelling: '正在取消', cancelled: '已取消', interrupted: '已中断', expired: '文件已过期' })[state] || '处理中'; }
function omnigetQueueActive(state) { return ['queued', 'parsing', 'parsed', 'awaiting_choice', 'downloading', 'cancelling'].includes(state); }
function omnigetQueueLabel(item) { if (item.metadata?.title) return item.metadata.title; try { const parsed = new URL(item.url); return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname || '/'}`; } catch { return '公开作品'; } }
// Local .txt import only fills the batch textarea; nothing is uploaded or queued until the user submits.
const OMNIGET_BATCH_LIMIT = 10;
const OMNIGET_IMPORT_MAX_BYTES = 64 * 1024;
function omnigetBatchLines(text) { return [...new Set(String(text || '').split(/\r\n|\r|\n/).map(value => value.trim()).filter(Boolean))]; }
function omnigetReadTextFile(file) { if (typeof file.text === 'function') return file.text(); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error || new Error('read failed')); reader.readAsText(file, 'utf-8'); }); }
// NUL bytes or U+FFFD replacement characters mean the file is binary or not valid UTF-8.
function omnigetTextUnreadable(text) { return text.includes(String.fromCharCode(0)) || text.includes(String.fromCharCode(0xfffd)); }
function omnigetStripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function omnigetShortName(name) { const value = String(name || '文件'); return value.length > 40 ? `${value.slice(0, 18)}…${value.slice(-18)}` : value; }
// race-logic:start — plain JS (no JSX) so tests/access-queue-races.test.mjs can run it in node:vm.
// Queue snapshots vs. mutations: every mutation bumps the generation, so a GET already in flight is discarded
// when it lands, and no GET is issued while a mutation is pending (polls skip instead of fetching a
// pre-mutation snapshot). Only a GET started after all mutations settle may replace the queue. Mutations are
// never aborted, so server-side jobs keep running. A failed mutation rethrows to its caller; once nothing is
// pending any more, one fresh GET reconciles whatever the server actually applied.
function omnigetMergeBatch(current, next) { const jobs = Array.isArray(next?.jobs) ? next.jobs : []; return [...jobs, ...current.filter(item => !jobs.some(incoming => incoming.id === item.id))]; }
function omnigetMergeAction(current, next) { return next?.id ? current.map(item => item.id === next.id ? next : item) : current; }
function createOmnigetQueueSync({ load, apply }) {
  let generation = 0; let pending = 0; let reconcile = false;
  async function refresh() { if (pending > 0) return false; const ticket = generation; const next = await load(); if (ticket !== generation) return false; apply(Array.isArray(next?.jobs) ? next.jobs : []); return true; }
  async function mutate(run, merge) { generation += 1; pending += 1; let failed = true; try { const result = await run(); apply(current => merge(current, result)); failed = false; return result; } finally { if (failed) reconcile = true; pending -= 1; if (pending === 0 && reconcile) { reconcile = false; refresh().catch(() => {}); } } }
  return { refresh, mutate, pending: () => pending };
}
// race-logic:end

function OmnigetWorkspace({ active = true, visible = true, onSave }) {
  const [saving, setSaving] = React.useState('');
  const [connectionsOpen, setConnectionsOpen] = React.useState(false);
  const [savedIds, setSavedIds] = React.useState([]);
  async function saveToLibrary(sourceType, sourceId) {
    if (saving) return;
    setSaving(sourceId);
    setError('');
    try {
      const result = onSave
        ? await onSave(sourceType, sourceId)
        : await api('/api/creative-library/imports', { method: 'POST', body: { sourceType, sourceId } });
      if (result !== false) setSavedIds(current => [...current, sourceId]);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving('');
    }
  }
  const saveButton = (type, id) => savedIds.includes(id)
    ? <a href="#studio?space=mine&view=materials">查看已保存素材</a>
    : <button className="btn" type="button" disabled={Boolean(saving)} onClick={() => saveToLibrary(type, id)}>
        {saving === id ? '正在保存…' : '保存到素材库'}
      </button>;
  const [url, setUrl] = React.useState(''); const [job, setJob] = React.useState(null); const [status, setStatus] = React.useState(null); const [error, setError] = React.useState(''); const [busy, setBusy] = React.useState(false); const [options, setOptions] = React.useState({ quality: 720, format: 'mp4', audioOnly: false }); const [batchUrls, setBatchUrls] = React.useState(''); const [queue, setQueue] = React.useState([]); const [queueBusy, setQueueBusy] = React.useState('');
  const [importing, setImporting] = React.useState(false); const [importNotice, setImportNotice] = React.useState(null); const fileInputRef = React.useRef(null); const importToken = React.useRef(0); const batchUrlsRef = React.useRef(batchUrls); batchUrlsRef.current = batchUrls;
  React.useEffect(() => { if (!active || !visible) return undefined; let live = true; api('/api/omniget/status').then(next => { if (live) setStatus(next); }).catch(reason => { if (live) setError(reason.message); }); return () => { live = false; }; }, [active, visible]);
  const [queueSync] = React.useState(() => createOmnigetQueueSync({ load: () => api('/api/omniget/queue'), apply: setQueue }));
  const refreshQueue = React.useCallback(() => queueSync.refresh(), [queueSync]);
  React.useEffect(() => { if (!active || !visible) return undefined; let live = true; refreshQueue().catch(reason => { if (live) setError(reason.message); }); return () => { live = false; }; }, [active, visible, refreshQueue]);
  React.useEffect(() => { if (!active || !visible || !queue.some(item => omnigetQueueActive(item.state))) return undefined; const timer = setInterval(() => refreshQueue().catch(() => {}), 1800); return () => clearInterval(timer); }, [active, visible, queue, refreshQueue]);
  React.useEffect(() => { if (!active || !visible || !job || !['parsing', 'downloading'].includes(job.status)) return undefined; let live = true; const timer = setInterval(() => api(`/api/omniget/jobs/${job.id}`).then(next => { if (live) setJob(next); }).catch(reason => { if (live) { setError(reason.message); clearInterval(timer); } }), 1800); return () => { live = false; clearInterval(timer); }; }, [active, visible, job?.id, job?.status]);
  React.useEffect(() => () => { importToken.current += 1; }, []);
  async function submit(download = false) { if (download && !job?.id) return; setBusy(true); setError(''); try { const downloadOptions = options.audioOnly ? { audioOnly: true } : { quality: Number(options.quality), format: options.format, audioOnly: false }; const next = await api(download ? `/api/omniget/jobs/${job.id}/download` : '/api/omniget/jobs', { method: 'POST', body: download ? downloadOptions : { url } }); setJob(next); } catch (reason) { setError(reason.message); } finally { setBusy(false); } }
  async function submitBatch(event) { event.preventDefault(); const urls = [...new Set(batchUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]; if (!urls.length || urls.length > 10) { setError('请粘贴 1 至 10 条不同的公开作品链接。'); return; } setQueueBusy('batch'); setError(''); setImportNotice(null); try { const body = options.audioOnly ? { urls, audioOnly: true } : { urls, quality: Number(options.quality), format: options.format, audioOnly: false }; await queueSync.mutate(() => api('/api/omniget/queue/batch', { method: 'POST', body }), omnigetMergeBatch); setBatchUrls(''); } catch (reason) { setError(reason.message); } finally { setQueueBusy(current => current === 'batch' ? '' : current); } }
  async function importBatchFile(event) {
    const input = event.target; const file = input.files?.[0];
    // Clearing the value lets the same file be chosen again after an edit or a failed read.
    input.value = '';
    if (!file) return;
    const token = ++importToken.current; const fail = text => { if (token !== importToken.current) return; setImportNotice({ type: 'error', text }); setImporting(false); };
    setImportNotice(null);
    if (!/\.txt$/i.test(file.name || '') || (file.type && !/^text\/plain\b/i.test(file.type))) return fail('仅支持导入 .txt 纯文本文件，请重新选择。');
    if (file.size > OMNIGET_IMPORT_MAX_BYTES) return fail(`文件超过 ${OMNIGET_IMPORT_MAX_BYTES / 1024} KB 上限，请删减或拆分后再导入。`);
    if (file.size === 0) return fail('文件为空，未导入任何链接。');
    setImporting(true);
    try {
      const text = await omnigetReadTextFile(file);
      if (token !== importToken.current) return;
      if (omnigetTextUnreadable(text)) return fail('无法识别文件内容，请使用 UTF-8 编码的纯文本文件。');
      const imported = omnigetBatchLines(omnigetStripBom(text));
      if (!imported.length) return fail('文件中没有找到链接，请确认每行一个公开作品链接。');
      const existing = omnigetBatchLines(batchUrlsRef.current); const merged = [...new Set([...existing, ...imported])]; const skipped = imported.length - (merged.length - existing.length);
      setBatchUrls(merged.join('\n'));
      const summary = `已从「${omnigetShortName(file.name)}」读取 ${imported.length} 条链接${skipped ? `，其中 ${skipped} 条与已有内容重复已合并` : ''}。`;
      setImportNotice(merged.length > OMNIGET_BATCH_LIMIT ? { type: 'warning', text: `${summary}当前共 ${merged.length} 条不同链接，超过每批 ${OMNIGET_BATCH_LIMIT} 条上限，请删减后再加入下载队列。` } : { type: 'success', text: `${summary}请检查或编辑下方内容，确认后点击“加入下载队列”。` });
    } catch { fail('读取文件失败，请重新选择文件。'); }
    finally { if (token === importToken.current) setImporting(false); }
  }
  async function queueAction(id, action) { const key = `${action}:${id}`; setQueueBusy(key); setError(''); try { await queueSync.mutate(() => api(`/api/omniget/queue/${id}/${action}`, { method: 'POST', body: {} }), omnigetMergeAction); } catch (reason) { setError(reason.message); } finally { setQueueBusy(current => current === key ? '' : current); } }
  if (!active || !visible) return null;
  const running = busy || ['parsing', 'downloading'].includes(job?.status);
  const batchCount = omnigetBatchLines(batchUrls).length;
  const step = { parsing: ['正在解析链接', '正在读取公开作品信息，请稍候。'], parsed: ['链接已解析', '已确认文件信息，可以开始准备下载。'], downloading: ['正在准备文件', '正在获取可下载文件，请保持此页面打开。'], ready: ['文件已准备好', '下载链接仅对当前账号有效，并将在 1 小时后失效。'], failed: ['处理未完成', '这条公开链接暂时无法处理。可检查链接后重试。'] }[job?.status];
  return <section className="omniget-workspace" aria-labelledby="omniget-title">
    <div className="omniget-hero"><span className="omniget-eyebrow"><IconDownload aria-hidden="true" /> OmniGet 下载</span><h1 id="omniget-title">粘贴链接，获取文件。</h1><p>先确认一个公开作品的信息，再由你决定是否下载；多个链接可在下方加入队列。</p>
      <form className="omniget-input-row" onSubmit={event => { event.preventDefault(); submit(); }}><label className="omniget-url-field"><IconSearch aria-hidden="true" /><span className="sr-only">公开作品链接</span><input value={url} onChange={event => setUrl(event.target.value)} type="url" inputMode="url" autoComplete="url" placeholder="粘贴 YouTube、B站、抖音、X 等公开作品链接" aria-label="公开作品链接" /></label><button className="btn btn-primary omniget-submit" disabled={running || !url.trim() || !status?.enabled}>{running && job?.status === 'parsing' ? '解析中…' : '解析链接'}</button></form>
      <div className="omniget-facts" aria-label="下载规则"><span>公开作品链接</span><span>单项最多 100 MB</span><span>保留 1 小时</span></div><p className="omniget-limit">合集、主页和磁力链接暂不支持。部分站点可通过下方设置使用本人 Cookie。</p>
    </div>
    {status?.enabled && status.capabilities && <fieldset className="omniget-options" disabled={running} aria-label="下载设置"><legend>下载设置</legend><div className="omniget-option-row">{Array.isArray(status.capabilities.qualities) && status.capabilities.qualities.length > 0 && !options.audioOnly && <label>最高画质偏好<select value={options.quality} onChange={event => setOptions(current => ({ ...current, quality: Number(event.target.value) }))}>{status.capabilities.qualities.map(quality => <option key={quality} value={quality}>{quality}p</option>)}</select></label>}{Array.isArray(status.capabilities.videoFormats) && status.capabilities.videoFormats.length > 0 && !options.audioOnly && <label>视频格式<select value={options.format} onChange={event => setOptions(current => ({ ...current, format: event.target.value }))}>{status.capabilities.videoFormats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>}{status.capabilities.audioOnly && <label className="omniget-audio-option"><input type="checkbox" checked={options.audioOnly} onChange={event => setOptions(current => ({ ...current, audioOnly: event.target.checked }))} />仅下载音频</label>}</div><p>{options.audioOnly ? '音频格式由源站决定；此模式不使用画质或视频格式偏好。' : '这是最高画质偏好，不代表源站一定提供该清晰度。'}</p></fieldset>}
    {status?.enabled && <details className="omniget-connections" onToggle={event => setConnectionsOpen(event.currentTarget.open)}>
      <summary>站点连接<span>需要登录时设置</span></summary>
      {connectionsOpen && <OmnigetCookieManager active={active} visible={visible} />}
    </details>}
    {status?.enabled && <details className="omniget-batch"><summary>批量添加链接 <span>最多 10 条</span></summary><form onSubmit={submitBatch}><label><span>每行一个公开作品链接</span><textarea value={batchUrls} onChange={event => { setBatchUrls(event.target.value); setImportNotice(null); }} placeholder={'https://example.com/video/1\nhttps://example.com/video/2'} rows="5" aria-describedby="omniget-batch-count" /></label>
      <div className="omniget-batch-import"><div className="omniget-batch-import-row"><input ref={fileInputRef} type="file" accept=".txt,text/plain" hidden tabIndex={-1} aria-label="选择本地 .txt 链接文件" onChange={importBatchFile} /><button className="btn btn-ghost" type="button" disabled={importing || queueBusy === 'batch'} aria-describedby="omniget-batch-import-hint" onClick={() => fileInputRef.current?.click()}>{importing ? '正在读取…' : '从 .txt 文件导入'}</button><span id="omniget-batch-import-hint" className="omniget-batch-import-hint">仅在本机浏览器读取，不会上传或自动开始下载；UTF-8 纯文本，最多 {OMNIGET_IMPORT_MAX_BYTES / 1024} KB。</span><span id="omniget-batch-count" className={`omniget-batch-count${batchCount > OMNIGET_BATCH_LIMIT ? ' is-over' : ''}`}>{batchCount}/{OMNIGET_BATCH_LIMIT} 条不同链接</span></div>
        <div role="status" aria-live="polite">{importNotice && importNotice.type !== 'error' && <p className={`omniget-batch-notice is-${importNotice.type}`}>{importNotice.text}</p>}</div>{importNotice?.type === 'error' && <p className="omniget-batch-notice is-error" role="alert">{importNotice.text}</p>}</div>
      <div><p>同一批次共用上方下载设置；每项最多 100 MB，完成文件保留 1 小时。</p><button className="btn btn-primary" disabled={queueBusy === 'batch' || importing || !batchUrls.trim()}>{queueBusy === 'batch' ? '正在加入…' : '加入下载队列'}</button></div></form></details>}
    {!status && !error && <div className="omniget-service-state" role="status"><i className="omniget-spinner" />正在检查下载服务…</div>}{status && !status.enabled && <div className="omniget-service-state is-disabled" role="status">下载服务尚未启用，请稍后再试。</div>}{error && <div className="omniget-notice is-error" role="alert">{error}</div>}
    {job && <article className={`omniget-job omniget-job-${job.status}`} aria-live="polite"><div className="omniget-job-icon">{job.status === 'ready' ? <IconCheck aria-hidden="true" /> : <IconDownload aria-hidden="true" />}</div><div className="omniget-job-copy"><span className="omniget-job-status">{step?.[0] || '下载任务'}</span><h2>{job.title || '正在解析作品信息'}</h2>{job.platform && <span className="omniget-platform">{job.platform}</span>}<p>{step?.[1]}</p>{job.error && <p className="omniget-job-error">{job.error}</p>}</div><div className="omniget-job-action">{job.status === 'parsed' && <button className="btn btn-primary" type="button" disabled={running} onClick={() => submit(true)}>准备下载</button>}{job.status === 'ready' && <a className="btn btn-primary" href={job.downloadUrl} download><IconDownload aria-hidden="true" />下载文件{omnigetFileSize(job.size) && ` · ${omnigetFileSize(job.size)}`}</a>}{job.status === 'ready' && saveButton('job', job.id)}{job.status === 'failed' && <button className="btn btn-ghost" type="button" disabled={running || !url.trim()} onClick={() => submit(false)}>重新解析</button>}{running && <span className="omniget-running"><i className="omniget-spinner" />处理中</span>}</div></article>}
    {queue.length > 0 && <section className="omniget-queue" aria-label="下载队列"><header><div><h2>下载队列</h2><p>任务按当前账号独立保存；已完成文件将在 1 小时后失效。</p></div><button className="btn btn-ghost" type="button" disabled={Boolean(queueBusy)} onClick={() => refreshQueue().catch(reason => setError(reason.message))}>刷新</button></header><div>{queue.map(item => <article key={item.id} className={`omniget-queue-item is-${item.state}`}><div><strong>{omnigetQueueLabel(item)}</strong><span>{omnigetQueueStatus(item.state)}{item.metadata?.platform && ` · ${item.metadata.platform}`}{item.attempts > 1 && ` · 第 ${item.attempts} 次尝试`}</span>{item.state === 'expired' && <em>文件已过期，保留任务记录。</em>}{item.error && <em>{item.error}</em>}</div><div className="omniget-queue-actions">{item.state === 'ready' && <a href={`/api/omniget/queue/${item.id}/file`} download>下载{omnigetFileSize(item.metadata?.size) && ` · ${omnigetFileSize(item.metadata.size)}`}</a>}{item.state === 'ready' && saveButton('queue', item.id)}{['queued', 'parsing', 'parsed', 'awaiting_choice', 'downloading'].includes(item.state) && <button type="button" disabled={queueBusy === `cancel:${item.id}`} onClick={() => queueAction(item.id, 'cancel')}>取消</button>}{['failed', 'cancelled', 'interrupted'].includes(item.state) && <button type="button" disabled={queueBusy === `retry:${item.id}`} onClick={() => queueAction(item.id, 'retry')}>重试</button>}</div></article>)}</div></section>}
  </section>;
}
