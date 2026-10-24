function DetailDrawer({ title, onClose, actions, children, id, className = '', resizable = false, widthPreference }) {
  const panel = React.useRef(null);
  const resizeHandle = React.useRef(null);
  const localWidth = React.useRef(null);
  const [opener] = React.useState(() => window.OmniDetailDrawer.activeElement());
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useLayoutEffect(() => window.OmniDetailDrawer.mount(panel.current, () => close.current(), { returnFocus: opener }), []);
  React.useLayoutEffect(() => {
    if (!resizable) return;
    const resize = window.OmniDetailDrawer.resize(panel.current, resizeHandle.current, widthPreference || localWidth);
    return () => resize.dispose();
  }, [resizable, widthPreference]);
  return ReactDOM.createPortal(<div className="detail-drawer-layer">
    <div className="detail-drawer-backdrop" aria-hidden="true" onClick={onClose} />
    <aside ref={panel} id={id} className={`detail-drawer ${resizable ? 'is-resizable' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      {resizable && <div ref={resizeHandle} className="detail-resize-handle" role="separator" aria-orientation="vertical"
        aria-label="调整详情宽度" aria-controls={id} tabIndex={0} title="拖动或按左右方向键调整宽度，双击或按 Enter 恢复默认" />}
      <header className="detail-drawer-header"><span className="detail-drawer-label">{title}</span>
        <div className="detail-drawer-actions">{actions}<button type="button" className="detail-drawer-close" onClick={onClose} aria-label="关闭详情" title="关闭详情（Esc）"><IconX /></button></div>
      </header>
      {children}
    </aside>
  </div>, document.body);
}
