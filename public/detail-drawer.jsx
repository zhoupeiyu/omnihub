function DetailDrawer({ title, onClose, actions, children, id, className = '', resizable = false, widthPreference, dirty = false, dirtyMessage }) {
  const panel = React.useRef(null);
  const resizeHandle = React.useRef(null);
  const localWidth = React.useRef(null);
  const [opener] = React.useState(() => window.OmniDetailDrawer.activeElement());
  const close = React.useRef(onClose);
  close.current = onClose;
  const dirtyRef = React.useRef(Boolean(dirty));
  const discarded = React.useRef(false);
  const messageRef = React.useRef(dirtyMessage);
  messageRef.current = dirtyMessage;
  if (dirtyRef.current !== Boolean(dirty)) { dirtyRef.current = Boolean(dirty); discarded.current = false; }
  // Esc, backdrop, the close button and route changes share one discard decision.
  const confirmLeave = React.useRef(() => {
    if (discarded.current) return true;
    const ok = window.OmniNavigationGuard.confirmDiscard(dirtyRef.current, messageRef.current);
    if (ok && dirtyRef.current) discarded.current = true;
    return ok;
  }).current;
  const requestClose = React.useRef(() => { if (confirmLeave()) close.current(); }).current;
  React.useLayoutEffect(() => window.OmniDetailDrawer.mount(panel.current, requestClose, { returnFocus: opener }), []);
  React.useLayoutEffect(() => window.OmniNavigationGuard.register(confirmLeave), []);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  React.useLayoutEffect(() => {
    if (!resizable) return;
    const resize = window.OmniDetailDrawer.resize(panel.current, resizeHandle.current, widthPreference || localWidth);
    return () => resize.dispose();
  }, [resizable, widthPreference]);
  return ReactDOM.createPortal(<div className="detail-drawer-layer">
    <div className="detail-drawer-backdrop" aria-hidden="true" onClick={requestClose} />
    <aside ref={panel} id={id} className={`detail-drawer ${resizable ? 'is-resizable' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-dirty={dirty ? 'true' : undefined}>
      {resizable && <div ref={resizeHandle} className="detail-resize-handle" role="separator" aria-orientation="vertical"
        aria-label="调整详情宽度" aria-controls={id} tabIndex={0} title="拖动或按左右方向键调整宽度，双击或按 Enter 恢复默认" />}
      <header className="detail-drawer-header"><span className="detail-drawer-label">{title}{dirty && <span className="detail-drawer-dirty" role="status"> · 未保存</span>}</span>
        <div className="detail-drawer-actions">{actions}<button type="button" className="detail-drawer-close" onClick={requestClose} aria-label="关闭详情" title="关闭详情（Esc）"><IconX /></button></div>
      </header>
      {children}
    </aside>
  </div>, document.body);
}
