function CascadeMenu({ items, title, ownerId, onNavigate, onKeepOpen, onScheduleClose }) {
  const [path, setPath] = React.useState([]), [highlight, setHighlight] = React.useState({});
  const [positions, setPositions] = React.useState({});
  const rows = React.useRef(new Map()), panels = React.useRef(new Map()), pointer = React.useRef([]), timer = React.useRef(null);
  const id = React.useId(), timing = window.OmniSurface.TIMING;
  const cancel = () => { clearTimeout(timer.current); timer.current = null; };
  React.useEffect(() => () => cancel(), []);
  React.useEffect(() => {
    const track = e => { pointer.current = [...pointer.current.slice(-1), { x: e.clientX, y: e.clientY }]; };
    document.addEventListener('pointermove', track);
    return () => document.removeEventListener('pointermove', track);
  }, []);
  const levels = [{ items, title }];
  for (const index of path) { const folder = levels.at(-1)?.items[index]; if (!folder?.children?.length) break; levels.push({ items: folder.children, title: folder.label }); }
  React.useLayoutEffect(() => {
    const next = {};
    for (let level = 1; level < levels.length; level++) {
      const row = rows.current.get(`${level - 1}:${path[level - 1]}`), panel = panels.current.get(level);
      if (!row || !panel) continue;
      const a = row.getBoundingClientRect(), b = panel.getBoundingClientRect(), parent = panels.current.get(level - 1)?.getBoundingClientRect();
      const right = (parent?.right || a.right) - 8, flip = right + b.width > innerWidth - 8;
      next[level] = { left: Math.max(8, flip ? (parent?.left || a.left) - b.width + 8 : right), top: Math.max(8, Math.min(a.top - 28, innerHeight - b.height - 12)) };
    }
    setPositions(next);
  }, [path.join(':'), items]);
  function focusRow(level, index) { requestAnimationFrame(() => rows.current.get(`${level}:${index}`)?.focus()); }
  function activate(level, index, focus) {
    cancel(); const entry = levels[level].items[index];
    setHighlight(current => ({ ...current, [level]: index }));
    setPath(current => [...current.slice(0, level), ...(entry.children?.length ? [index] : [])]);
    if (focus && entry.children?.length) focusRow(level + 1, 0);
  }
  function protectedMove(level) {
    const points = pointer.current, submenu = panels.current.get(level + 1), parent = panels.current.get(level);
    if (!submenu || points.length < 2 || !parent) return false;
    const near = submenu.getBoundingClientRect(), box = parent.getBoundingClientRect(), p = points[1], a = points[0];
    if (p.x >= near.left && p.x <= near.right && p.y >= near.top && p.y <= near.bottom) return false;
    const right = near.left > box.left, edge = right ? near.left : near.right, width = Math.min(90, Math.max(56, box.width * .43));
    const inBand = right ? p.x >= box.right - width : p.x <= box.left + width;
    return inBand && window.OmniSurface.pointInTriangle(p, a, { x: edge, y: near.top }, { x: edge, y: near.bottom });
  }
  function hover(level, index, delay = timing.open) {
    cancel(); const began = performance.now();
    const check = () => {
      if (protectedMove(level) && performance.now() - began < timing.safe) { timer.current = setTimeout(check, timing.recheck); return; }
      activate(level, index, false);
    };
    timer.current = setTimeout(check, delay);
  }
  function keyDown(event, level, index) {
    const list = levels[level].items;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      focusRow(level, event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
    } else if (event.key === 'ArrowRight' || event.key === 'Enter' && list[index].children?.length) { event.preventDefault(); event.stopPropagation(); activate(level, index, true); }
    else if (event.key === 'ArrowLeft' && level) { event.preventDefault(); event.stopPropagation(); cancel(); setPath(current => current.slice(0, level - 1)); focusRow(level - 1, path[level - 1]); }
  }
  function renderLevel(level) {
    const data = levels[level];
    return <div key={level} ref={node => { if (node) panels.current.set(level, node); else panels.current.delete(level); }}
      className={level ? 'module-flyout cascade-level' : 'cascade-menu'} data-cascade-owner={ownerId}
      style={level ? positions[level] || { left: -9999, top: 0 } : undefined}
      onFocus={onKeepOpen}
      onPointerEnter={() => { cancel(); onKeepOpen(); }} onPointerLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) { cancel(); onScheduleClose(); } }}
      role="menu" aria-label={data.title}>
      {level > 0 && <strong className="module-flyout-title">{data.title}</strong>}
      {data.items.map((entry, index) => {
        const folder = Boolean(entry.children?.length), open = path[level] === index && folder;
        const props = { key: entry.href || entry.label, id: `${id}-${level}-${index}`, role: 'menuitem', tabIndex: -1,
          ref: node => { if (node) rows.current.set(`${level}:${index}`, node); else rows.current.delete(`${level}:${index}`); },
          className: ['cascade-row', entry.active ? 'active' : '', highlight[level] === index ? 'is-hovered' : ''].filter(Boolean).join(' '),
          'aria-haspopup': folder ? 'menu' : undefined, 'aria-expanded': folder ? open : undefined, 'aria-current': entry.active ? 'page' : undefined,
          onPointerEnter: event => { onKeepOpen(); if (event.pointerType !== 'touch') hover(level, index); },
          onPointerLeave: cancel, onDragEnter: () => hover(level, index, timing.drag), onKeyDown: event => keyDown(event, level, index),
          onClick: event => { if (folder) { event.preventDefault(); activate(level, index, true); return; } if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); cancel(); onNavigate(entry.href); },
        };
        const content = <><span>{entry.label}</span>{folder && <span className="cascade-chevron" aria-hidden="true">›</span>}</>;
        return folder ? <button {...props} type="button">{content}</button> : <a {...props} href={entry.href}>{content}</a>;
      })}
    </div>;
  }
  return <>{renderLevel(0)}{levels.slice(1).map((_, index) => ReactDOM.createPortal(renderLevel(index + 1), document.body))}</>;
}
