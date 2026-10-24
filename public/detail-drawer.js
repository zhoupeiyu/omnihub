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
  window.OmniDetailDrawer = { mount, activeElement };
})();
