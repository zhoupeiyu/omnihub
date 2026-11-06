function CephalonSettings({ active = true }) {
  const [status,setStatus]=React.useState(null),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(''),[open,setOpen]=React.useState(false);
  const [connection,setConnection]=React.useState({phase:'unconfigured',message:'',models:null});
  const [key,setKey]=React.useState(''),[secret,setSecret]=React.useState(''),[serviceKey,setServiceKey]=React.useState('');
  const load=React.useCallback(async signal=>{setError('');try{const next=await api('/api/cephalon',{signal});if(!signal?.aborted){setStatus(next);if(!next?.configured)setConnection({phase:'unconfigured',message:'',models:null});}}catch(err){if(!signal?.aborted)setError(err.message||'端脑云状态暂时无法读取。');}},[]);
  React.useEffect(()=>{if(!active)return;const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[active,load]);
  async function save(){
    setBusy('save');setError('');setNotice('');
    try { const next=await api('/api/cephalon/config',{method:'POST',body:{key,secret,serviceKey}});setStatus(next);setConnection({phase:'unverified',message:'',models:null});setKey('');setSecret('');setServiceKey('');setOpen(false);setNotice('端脑云凭证已加密保存，等待连接测试。'); }
    catch(err){setError(err.message||'端脑云配置未保存。');} finally {setBusy('');}
  }
  async function testConnection(){
    setBusy('test');setError('');setNotice('');setConnection({phase:'testing',message:'',models:null});
    try{
      const result=await api('/api/cephalon/connection-test',{method:'POST',body:{}});
      if(result?.connected===true){setConnection({phase:'connected',message:'已验证服务密钥，可读取在线模型列表；尚未验证平台公私钥，不表示在线生成可用。',models:Number.isFinite(result.models)?result.models:null});return;}
      const reason={
        service_key_required:'请先配置端脑云服务密钥后再测试。',
        authentication_rejected:'端脑云服务认证未通过，请核对接口配置与已保存的凭证。',
        service_unavailable:'端脑云服务暂不可用，请稍后重试并核对服务状态。',
        invalid_response:'端脑云返回无效响应，请稍后重试；若持续出现请核对接口配置。',
      }[result?.reason]||'端脑云连接未通过，请稍后重试。';
      setConnection({phase:'failed',message:reason,models:null});
    }catch(err){
      const message=err?.status===401?'端脑云服务认证未通过，请核对接口配置与已保存的凭证。':(err.message||'端脑云连接测试失败。');
      setConnection({phase:'failed',message,models:null});
    }finally{setBusy('');}
  }
  async function disconnect(){setBusy('disconnect');setError('');try{const next=await api('/api/cephalon/config',{method:'DELETE',body:{}});setStatus(next);setConnection({phase:'unconfigured',message:'',models:null});setNotice('端脑云凭证已删除。');}catch(err){setError(err.message||'端脑云配置未删除。');}finally{setBusy('');}}
  const configured=Boolean(status?.configured);
  const connectionState=!configured?'unconfigured':connection.phase==='unconfigured'?'unverified':connection.phase;
  const connectionLabel={unconfigured:'未配置',unverified:'已保存，待测试',testing:'测试中',connected:'连接正常',failed:'测试失败'}[connectionState];
  const connectionTone={unconfigured:'warning',unverified:'neutral',testing:'neutral',connected:'success',failed:'warning'}[connectionState];
  const connectionMessage={unconfigured:'尚未配置端脑云密钥。',unverified:'凭证已保存，尚未测试在线模型服务。',testing:'正在读取在线模型列表…',connected:`${connection.message}${connection.models!==null?`（在线模型 ${connection.models} 个）`:''}`,failed:connection.message}[connectionState];
  return <section className="connection-section sync-module cephalon-settings" aria-label="端脑云算力">
    <div className="sync-module-heading"><div><h3>端脑云算力</h3><p className="sync-meta">用于后续接入在线推理工作流；应用实例按 CEP 计费。</p></div><span className="sync-status" data-tone={connectionTone}>{connectionLabel}</span></div>
    {!status&&!error&&<LoadingSkeleton variant="compact" count={2} label="正在读取端脑云状态" />}
    {error&&<div className="connection-error" role="alert"><p>{error}</p><button className="btn" disabled={Boolean(busy)} onClick={()=>load()}>重试</button></div>}
    {status&&<>
      <p className="sync-meta">{status.liveGenerationEnabled?'在线生成已开放':'在线生成尚未开放：需要服务密钥、费用上限及已验证的模型工作流。'}</p>
      <div className={connectionState==='failed'?'connection-error cephalon-connection-status':'account-notice sync-notice cephalon-connection-status'} role={connectionState==='failed'?'alert':'status'} aria-live="polite"><strong>{connectionLabel}</strong><span>{connectionMessage}</span></div>
      <div className="x-heading-actions"><button className="btn btn-ghost" disabled={Boolean(busy)||!configured} onClick={testConnection}>{busy==='test'?'测试中…':'测试连接'}</button><button className="btn" disabled={Boolean(busy)} onClick={()=>setOpen(value=>!value)}>{configured?'更新凭证':'配置端脑云'}</button>{configured&&<button className="btn x-disconnect" disabled={Boolean(busy)} onClick={disconnect}>{busy==='disconnect'?'删除中…':'删除凭证'}</button>}</div>
      {open&&<div className="x-account-tools"><label className="connection-field">平台密钥 Key<input value={key} maxLength="32" autoComplete="off" placeholder={configured?'留空以保留当前值':'32 位十六进制字符'} onChange={event=>setKey(event.target.value)} /></label><label className="connection-field">平台密钥 Secret<input type="password" value={secret} maxLength="64" autoComplete="new-password" placeholder={configured?'留空以保留当前值':'64 位十六进制字符'} onChange={event=>setSecret(event.target.value)} /></label><label className="connection-field">服务密钥（可选）<input type="password" value={serviceKey} maxLength="4096" autoComplete="new-password" placeholder={status.hasServiceKey?'留空以保留当前值':'仅在端脑云在线推理 API 要求时填写'} onChange={event=>setServiceKey(event.target.value)} /></label><div className="x-heading-actions"><button className="btn btn-primary" disabled={Boolean(busy)||(!configured&&(!key||!secret))} onClick={save}>{busy==='save'?'保存中…':'加密保存'}</button><button className="btn btn-ghost" disabled={Boolean(busy)} onClick={()=>setOpen(false)}>取消</button></div></div>}
    </>}
    {notice&&<div className="account-notice sync-notice" role="status"><span>{notice}</span><button className="btn btn-ghost" aria-label="关闭提示" onClick={()=>setNotice('')}><IconX /></button></div>}
  </section>;
}
