function DetailDrawer({ title, onClose, actions, children, id, className = '' }) {
  const panel = React.useRef(null);
  const [opener] = React.useState(() => window.OmniDetailDrawer.activeElement());
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useLayoutEffect(() => window.OmniDetailDrawer.mount(panel.current, () => close.current(), { returnFocus: opener }), []);
  return ReactDOM.createPortal(<div className="detail-drawer-layer">
    <div className="detail-drawer-backdrop" aria-hidden="true" onClick={onClose} />
    <aside ref={panel} id={id} className={`detail-drawer ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="detail-drawer-header"><span className="detail-drawer-label">{title}</span>
        <div className="detail-drawer-actions">{actions}<button type="button" className="detail-drawer-close" onClick={onClose} aria-label="关闭详情" title="关闭详情（Esc）"><IconX /></button></div>
      </header>
      {children}
    </aside>
  </div>, document.body);
}
