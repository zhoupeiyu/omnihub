function PromptUseDialog({ item, onClose, onUse, canChat, canCreateMedia }) {
  const [values,setValues] = React.useState({});
  const [status,setStatus] = React.useState('');
  const names = promptTemplateNames(item.text);
  const missing = names.filter(name => !String(values[name] || '').trim());
  const text = fillPromptTemplate(item.text,values);
  const module = promptCreationModule(item);
  const prepared = {...item,text,promptTextClean:text,promptTextRaw:text};
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('已复制填写后的提示词'); }
    catch { setStatus('复制失败，请选择下方文字复制'); }
  }
  return <DetailDrawer title="使用提示词" onClose={onClose}>
    <div className="detail-drawer-body prompt-use-body"><h2>{item.title}</h2>
      {names.length > 0 && <div className="prompt-variable-fields">{names.map((name,index) => <label key={name}>{name}<input className="input" autoFocus={index === 0} value={values[name] || ''} onChange={event => setValues(previous => ({...previous,[name]:event.target.value}))} placeholder={`填写${name}`} /></label>)}</div>}
      <div className="prompt-use-preview"><h3>本次使用的提示词</h3><pre>{text}</pre></div>
      <p className="muted">本次填写不会修改原模板。带入对话或创作台后，由你确认发送。</p>
      <p role="status">{status || (missing.length ? `还有 ${missing.length} 项待填写` : '内容已准备好')}</p>
    </div>
    <div className="drawer-foot prompt-use-actions"><button className="btn" onClick={onClose}>返回</button><span className="spacer" />
      <button className="btn" disabled={missing.length > 0} onClick={copy}><IconCopy />复制</button>
      {canChat && <button className="btn" disabled={missing.length > 0} onClick={() => onUse(prepared,'chat')}><IconSend />带入对话</button>}
      {canCreateMedia && module && <button className="btn btn-primary" disabled={missing.length > 0} onClick={() => onUse(prepared,'media')}>{module === 'seedance' ? '创作视频' : '生成图片'}</button>}
    </div>
  </DetailDrawer>;
}
