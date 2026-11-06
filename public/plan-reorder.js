function usePlanReorder(onMove) {
  const state = React.useRef(null), callback = React.useRef(onMove), cleanup = React.useRef(() => {});
  callback.current = onMove;
  React.useEffect(() => () => cleanup.current(), []);
  return function begin(event, id, index) {
    if (event.button !== 0 || state.current) return;
    const handle = event.currentTarget, card = handle.closest('.creator-plan-shot'), list = card?.parentElement;
    if (!list) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    const items = [...list.children].filter(node => node.matches('.creator-plan-shot')), rects = items.map(node => node.getBoundingClientRect());
    const start = { x: event.clientX, y: event.clientY }, listRect = list.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(list).rowGap) || 12, slot = rects[index].height + gap;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let target = index, active = false;
    state.current = { id }; handle.setPointerCapture?.(event.pointerId);
    const reset = () => {
      for (const item of items) { item.style.removeProperty('transform'); item.style.removeProperty('transition'); item.style.removeProperty('transition-delay'); item.classList.remove('is-dragging'); }
      list.removeAttribute('data-reordering'); list.style.removeProperty('--drop-y');
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel); state.current = null; cleanup.current = () => {};
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    const cancel = () => { reset(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    const move = e => {
      if (e.pointerId !== event.pointerId) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!active && Math.hypot(dx, dy) < 5) return;
      active = true; list.dataset.reordering = 'true'; card.classList.add('is-dragging');
      const remaining = rects.map((rect, i) => ({ rect, index: i })).filter(item => item.index !== index);
      target = remaining.filter(({ rect, index: i }) => e.clientY > rect.top - (i > index ? slot : 0) + rect.height / 2).length;
      const edge = remaining[target];
      const y = edge ? edge.rect.top - (edge.index > index ? slot : 0) - gap / 2 : (remaining.at(-1)?.rect.bottom || listRect.top) - (index < items.length - 1 ? slot : 0) + gap / 2;
      list.style.setProperty('--drop-y', (y - listRect.top) + 'px'); list.dataset.sameSlot = String(target === index);
      if (!reduced) {
        card.style.transition = 'none'; card.style.transform = `translate(${dx + Math.min(56, rects[index].width * .08)}px, ${dy}px) scale(.9)`;
        remaining.forEach(({ index: i }, n) => {
          const distance = n < target ? target - n - 1 : n - target, ripple = (n < target ? -1 : 1) * 8 * .7 ** distance;
          items[i].style.transition = 'transform 250ms var(--ease-spring)'; items[i].style.transitionDelay = Math.min(distance * 24, 120) + 'ms';
          items[i].style.transform = `translateY(${(i > index ? -slot : 0) + (target === index ? 0 : ripple)}px)`;
        });
      }
    };
    const end = e => {
      if (e.pointerId !== event.pointerId) return;
      const inside = e.clientX >= listRect.left && e.clientX <= listRect.right && e.clientY >= listRect.top && e.clientY <= listRect.bottom;
      const changed = active && inside && target !== index;
      const before = reduced ? [] : items.map(item => ({ item, rect: item.getBoundingClientRect() }));
      reset();
      if (changed) callback.current(id, target - index);
      if (!reduced) requestAnimationFrame(() => {
        for (const { item, rect } of before) {
          if (!item.isConnected) continue;
          const next = item.getBoundingClientRect();
          item.animate([{ transform: `translate(${rect.left - next.left}px, ${rect.top - next.top}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
        }
        handle.focus({ preventScroll: true });
      });
    };
    cleanup.current = reset;
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key, false); window.addEventListener('blur', cancel);
  };
}
