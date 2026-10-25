// Render options in the page so their position never depends on an OS popup window.
export function createRepositoryFilter(select) {
  const lifetime = new AbortController();
  const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, {...options, signal:lifetime.signal});
  const control = document.createElement('span');
  control.className = 'filter-control';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'filter-select';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  value.className = 'filter-value';
  const arrow = document.createElement('span');
  arrow.className = 'filter-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  trigger.append(value, arrow);
  const menu = document.createElement('div');
  menu.id = `${select.id}-options`;
  menu.className = 'filter-options';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.setAttribute('aria-controls', menu.id);
  select.replaceWith(control);
  control.append(trigger, select, menu);
  select.style.display = 'none';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  let options = [];
  let activeIndex = -1;
  let search = '';
  let searchTime = 0;

  function close() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    search = '';
  }

  function position() {
    if (menu.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8;
    const viewportTop = viewport?.offsetTop || 0;
    const headerBottom = document.querySelector('.header-bar')?.getBoundingClientRect().bottom || 0;
    const top = Math.max(viewportTop, headerBottom) + 8;
    const right = left + (viewport?.width || document.documentElement.clientWidth) - 16;
    const bottom = viewportTop + (viewport?.height || window.innerHeight) - 8;
    // Local offsets also work when a host applies CSS zoom to the catalogue.
    const scale = rect.width / trigger.offsetWidth || 1;
    menu.style.minWidth = `${Math.min(rect.width, right - left) / scale}px`;
    menu.style.maxWidth = `${Math.min(320, (right - left) / scale)}px`;
    menu.style.left = '0px';
    const below = Math.max(0, bottom - rect.bottom - 6 * scale);
    const above = Math.max(0, rect.top - top - 6 * scale);
    const upward = below < Math.min(200 * scale, menu.scrollHeight * scale) && above > below;
    menu.style.top = upward ? 'auto' : 'calc(100% + 6px)';
    menu.style.bottom = upward ? 'calc(100% + 6px)' : 'auto';
    menu.style.maxHeight = `${Math.min(320, (upward ? above : below) / scale)}px`;
    const menuRect = menu.getBoundingClientRect();
    const offset = Math.max(left - menuRect.left, Math.min(0, right - menuRect.right));
    menu.style.left = `${offset / scale}px`;
  }

  function activate(index) {
    activeIndex = Math.max(0, Math.min(index, options.length - 1));
    [...menu.children].forEach((item, i) => item.classList.toggle('is-active', i === activeIndex));
    const item = menu.children[activeIndex];
    if (!item) return;
    trigger.setAttribute('aria-activedescendant', item.id);
    // Scroll only the option list, never the page behind the sticky toolbar.
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
  }

  function open() {
    options = [...select.options].filter(option => !option.disabled && !option.hidden);
    if (!options.length) return;
    menu.replaceChildren(...options.map((option, index) => {
      const item = document.createElement('div');
      item.id = `${menu.id}-${index}`;
      item.className = 'filter-option';
      item.dataset.index = index;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-label', option.textContent);
      item.setAttribute('aria-selected', String(option.selected));
      item.textContent = option.textContent;
      return item;
    }));
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    activate(Math.max(0, options.findIndex(option => option.selected)));
  }

  function choose(index) {
    const option = options[index];
    if (!option) return;
    const changed = select.value !== option.value;
    select.value = option.value;
    close();
    value.textContent = option.textContent;
    if (changed) select.dispatchEvent(new Event('change', {bubbles:true}));
  }

  listen(trigger, 'click', () => menu.hidden ? open() : close());
  listen(trigger, 'keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      close();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = !menu.hidden;
      if (!wasOpen) open();
      if (event.key === 'Home') activate(0);
      else if (event.key === 'End') activate(options.length - 1);
      else if (wasOpen) activate(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (menu.hidden) open(); else choose(activeIndex);
    } else if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (menu.hidden) open();
      const now = Date.now();
      search = (now - searchTime < 700 ? search : '') + event.key.toLocaleLowerCase();
      searchTime = now;
      const index = options.findIndex(option => option.textContent.trim().toLocaleLowerCase().startsWith(search));
      if (index >= 0) activate(index);
    }
  });
  listen(menu, 'pointerdown', event => event.preventDefault());
  listen(menu, 'click', event => {
    const item = event.target.closest('[role="option"]');
    if (item) choose(Number(item.dataset.index));
  });
  listen(control, 'focusout', event => { if (!control.contains(event.relatedTarget)) close(); });
  listen(document, 'pointerdown', event => { if (!event.composedPath().includes(control)) close(); });
  listen(window, 'resize', position);
  listen(document, 'scroll', position, {capture:true, passive:true});
  listen(select.getRootNode(), 'scroll', event => { if (event.target !== menu) position(); }, {capture:true, passive:true});
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', position);
    listen(window.visualViewport, 'scroll', position);
  }
  const resize = new ResizeObserver(position);
  resize.observe(trigger);
  return {
    select,
    close,
    update(hidden) {
      close();
      control.hidden = hidden;
      trigger.disabled = select.disabled;
      value.textContent = select.selectedOptions[0]?.textContent || '';
    },
    destroy() { close(); lifetime.abort(); resize.disconnect(); },
  };
}
