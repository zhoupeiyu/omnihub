// Shared lifecycle for React drawers and the repository's Shadow DOM drawer.
(function () {
  const openDrawers = [];
  const focusable = 'button, a[href], input, select, textarea, summary, video[controls], audio[controls], [tabindex]';
  const nestedOverlay = '.lightbox, .inbox-media-overlay, .modal-overlay, dialog[open]';
  function activeElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }
  function mount(panel, onClose, { returnFocus } = {}) {
    let disposed = false;
    const previous = returnFocus || activeElement();
    const entry = { panel };
    const disabled = [];
    // Disable the list/navigation, not the drawer's own Shadow DOM host.
    let node = panel.parentElement;
    while (node && node !== document.body) {
      const parent = node.parentNode;
      for (const sibling of parent?.children || []) {
        if (sibling !== node && !sibling.inert && !['STYLE', 'SCRIPT', 'LINK'].includes(sibling.tagName)) {
          sibling.inert = true;
          disabled.push(sibling);
        }
      }
      node = parent?.host || (parent instanceof Element ? parent : null);
    }
    openDrawers.push(entry);
    document.body.dataset.detailDrawerOpen = 'true';
    const ownsFocus = () => openDrawers.at(-1) === entry && !document.querySelector(nestedOverlay);
    const items = () => [...panel.querySelectorAll(focusable)].filter(element =>
      !element.disabled && element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[inert]'));
    const onKey = event => {
      if (!ownsFocus() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); onClose();
      } else if (event.key === 'Tab') {
        const targets = items();
        const first = targets[0], last = targets.at(-1), current = activeElement();
        if (!first || (event.shiftKey && (current === first || current === panel || !panel.contains(current)))) {
          event.preventDefault(); (last || panel).focus({ preventScroll: true });
        } else if (!event.shiftKey && (current === last || !panel.contains(current))) {
          event.preventDefault(); first.focus({ preventScroll: true });
        }
      }
    };
    const onFocus = event => {
      if (ownsFocus() && !event.composedPath().includes(panel)) panel.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    if (!panel.contains(activeElement())) panel.focus({ preventScroll: true });
    return () => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      openDrawers.splice(openDrawers.indexOf(entry), 1);
      for (const element of disabled) element.inert = false;
      if (!openDrawers.length) delete document.body.dataset.detailDrawerOpen;
      if (previous?.isConnected && !previous.closest('[hidden], [inert]')) previous.focus({ preventScroll: true });
    };
  }
  function widthLimits(viewportWidth) {
    const defaultWidth = Math.min(680, viewportWidth);
    // Keep the readable default on smaller desktops; wide screens can use half the viewport.
    return { enabled: viewportWidth > 860, defaultWidth, min: Math.min(420, defaultWidth), max: Math.max(defaultWidth, Math.floor(viewportWidth / 2)) };
  }
  function resize(panel, handle, preference = { current: null }) {
    const lifetime = new AbortController();
    const listen = (target, type, callback) => target.addEventListener(type, callback, { signal: lifetime.signal });
    let drag = null, frame = 0, pendingWidth = null;
    function sync() {
      const limits = widthLimits(window.innerWidth);
      const width = preference.current == null ? limits.defaultWidth : Math.max(limits.min, Math.min(limits.max, preference.current));
      if (limits.enabled && preference.current != null) panel.style.setProperty('--detail-drawer-width', `${width}px`);
      else panel.style.removeProperty('--detail-drawer-width');
      handle.hidden = !limits.enabled;
      handle.setAttribute('aria-valuemin', String(limits.min));
      handle.setAttribute('aria-valuemax', String(limits.max));
      handle.setAttribute('aria-valuenow', String(Math.round(width)));
      handle.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
    }
    function setWidth(width) {
      const limits = widthLimits(window.innerWidth);
      preference.current = width == null ? null : Math.max(limits.min, Math.min(limits.max, width));
      sync();
    }
    function flush() {
      cancelAnimationFrame(frame); frame = 0;
      if (pendingWidth != null) setWidth(pendingWidth);
      pendingWidth = null;
    }
    function stop(cancel = false) {
      const previous = drag;
      drag = null;
      if (cancel && previous) { pendingWidth = null; setWidth(previous.widthPreference); }
      flush();
      panel.classList.remove('is-resizing');
      if (previous && handle.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
    }
    listen(handle, 'pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !widthLimits(window.innerWidth).enabled) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      drag = { pointerId: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width, widthPreference: preference.current };
      handle.setPointerCapture(event.pointerId); panel.classList.add('is-resizing');
    });
    listen(handle, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      pendingWidth = drag.width + drag.x - event.clientX;
      if (!frame) frame = requestAnimationFrame(flush);
    });
    listen(handle, 'pointerup', () => stop());
    listen(handle, 'pointercancel', () => stop(true));
    listen(handle, 'lostpointercapture', () => stop());
    listen(handle, 'dblclick', () => { stop(); setWidth(null); });
    listen(handle, 'keydown', event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault(); event.stopPropagation(); stop(true); return;
      }
      const limits = widthLimits(window.innerWidth);
      if (!limits.enabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const width = panel.getBoundingClientRect().width, step = event.shiftKey ? 64 : 24;
      setWidth(event.key === 'Enter' ? null : event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : width + (event.key === 'ArrowLeft' ? step : -step));
    });
    listen(window, 'resize', () => { stop(); sync(); });
    sync();
    return { sync, stop, dispose() { stop(); lifetime.abort(); } };
  }
  window.OmniDetailDrawer = { mount, activeElement, widthLimits, resize };
})();
