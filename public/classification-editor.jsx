function ClassificationEditor({ target, onClose, onSaved }) {
  const dialog = React.useRef(null);
  const [entry, setEntry] = React.useState(null);
  const [data, setData] = React.useState(null);
  const [taxonomy, setTaxonomy] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const repository = Boolean(target.repositoryKey);
  const endpoint = `/api/library-classification/${repository ? 'repository/' + target.repositoryKey : 'source/' + target.sourceInboxId}`;
  React.useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    let cancelled = false;
    Promise.all([api(endpoint), repository ? loadClassificationTaxonomy() : null]).then(([value, definitions]) => {
      if (!cancelled) { setEntry(value); setData(value.data); setTaxonomy(definitions); }
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; if (previous?.isConnected) previous.focus(); };
  }, [endpoint]);
  const change = (key, value) => { setData(current => ({ ...current, [key]:value })); setDirty(true); };
  const close = () => { if (!busy && (!dirty || window.confirm('尚未保存归类，放弃这次修改？'))) onClose(); };
  const toggle = (key, value) => change(key, data[key].includes(value) ? data[key].filter(x => x !== value) : [...data[key],value]);
  const save = async event => {
    event.preventDefault();
    if (busy || !data) return;
    setBusy(true); setError('');
    try {
      await api(endpoint, {method:'PUT',body:{revision:entry.revision,data:repository ? data : {...data,tags:data.tags.filter(Boolean)}}});
      onSaved();
    } catch (failure) { setError(failure.message); setBusy(false); }
  };
  return ReactDOM.createPortal(<dialog ref={dialog} className="classification-dialog" aria-labelledby="classification-title"
    onCancel={event => {event.preventDefault(); event.stopPropagation(); close();}}
    onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={save}>
      <header><div><h2 id="classification-title">调整归类</h2><p>仅 zane 可修改 · 原始收藏保持不变</p></div>
        <button type="button" className="btn btn-ghost" onClick={close} disabled={busy} aria-label="关闭归类编辑">关闭 ×</button></header>
      {error && <p className="classification-error" role="alert">{error}</p>}
      {!data ? <p role="status">{error ? '请关闭后重新打开。' : '正在读取当前归类…'}</p> : <fieldset disabled={busy} className="classification-fields">
        <p className="classification-source-title">{entry.title}</p>
        {repository ? <React.Fragment>
          <fieldset><legend>工具形态（可多选）</legend><div className="classification-options">{Object.entries(taxonomy.REPOSITORY_FORMS).map(([id,label]) =>
            <label key={id}><input type="checkbox" checked={data.forms.includes(id)} onChange={() => toggle('forms',id)} />{label}</label>)}</div></fieldset>
          <fieldset><legend>按用途分类（可多选）</legend>{taxonomy.REPOSITORY_TOPICS.map(topic => <div key={topic.id} className="classification-topic">
            <strong>{topic.title}</strong><div className="classification-options">{Object.entries(topic.children).map(([id,label]) => {
              const key = `${topic.id}.${id}`;
              return <label key={key}><input type="checkbox" checked={data.uses.includes(key)} onChange={() => toggle('uses',key)} />{label}</label>;
            })}</div></div>)}</fieldset>
        </React.Fragment> : <React.Fragment>
          <label>内容归属<select value={data.type} onChange={e => change('type',e.target.value)}>
            <option value="prompt">提示词：可直接复制使用的指令</option><option value="method">方法技巧：步骤、经验与教程</option>
            <option value="source">仅保留 X 来源：尚未整理或仅作参考</option></select></label>
          <p className="classification-hint">长期行为规则和配置方法进入知识库，配置片段保留在详情中；完成具体任务的指令才进入提示词库。仓库链接仍保留在仓库库。</p>
          <label>整理标题<input value={data.title} maxLength={240} required onChange={e => change('title',e.target.value)} /></label>
          {data.type === 'method' && <React.Fragment>
            <label>一句话说明<textarea value={data.summary} maxLength={1000} required rows={2} onChange={e => change('summary',e.target.value)} /></label>
            <label>方法正文（Markdown）<textarea value={data.body} maxLength={30000} required rows={10} placeholder="适用场景、具体步骤、注意事项与来源依据" onChange={e => change('body',e.target.value)} /></label>
          </React.Fragment>}
          {data.type !== 'source' && <React.Fragment>
            <label>{data.type === 'method' ? '原帖中的配置或任务指令（可留空）' : '可复制的任务提示词'}<textarea value={data.promptText} maxLength={40000}
              required={data.type === 'prompt'} rows={8} onChange={e => change('promptText',e.target.value)} /></label>
            <label>提示词用途<select value={data.promptCategory} onChange={e => change('promptCategory',e.target.value)}>
              {['图像生成','视频生成','Agent 系统','编程','自动化','研究','社媒内容','其他'].map(x => <option key={x} value={x} disabled={data.type === 'prompt' && x === 'Agent 系统'}>{x === 'Agent 系统' ? '长期规则配置（仅在方法详情保留）' : x}</option>)}</select></label>
            <label>主题标签（用逗号分开）<input value={data.tags.join(',')} onChange={e => change('tags',e.target.value.split(/[,，]/).map(x => x.trim()))} /></label>
          </React.Fragment>}
          <details><summary>对照原始收藏</summary><pre className="classification-original">{entry.sourceText}</pre>
            {entry.quotedText && <React.Fragment><h4>原帖引用的内容</h4><pre className="classification-original">{entry.quotedText}</pre></React.Fragment>}</details>
        </React.Fragment>}
      </fieldset>}
      <footer><span>手动归类优先，不被自动整理覆盖。</span><button type="submit" className="btn btn-primary" disabled={!data || busy}>{busy ? '保存中…' : '保存归类'}</button></footer>
    </form>
  </dialog>, document.body);
}
