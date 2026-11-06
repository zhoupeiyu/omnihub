/*! SVG Spinners — https://github.com/n3r4zzurr0/svg-spinners
The MIT License (MIT)

Copyright (c) Utkarsh Verma

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
// Spinner: svg-spinners by Utkarsh Verma, MIT. License: /assets/image-loading/LICENSE.
// Track native images without wrappers, duplicate downloads or changing their sources.
(function () {
  let styles = "img[data-image-state=\"loading\"],img[data-image-state=\"error\"]{object-position:-100000px -100000px!important;background-color:var(--bg-sunken,#ededf0)!important;background-repeat:no-repeat!important;background-position:center;background-size:24px 24px!important;color:transparent!important;min-height:16px}\nimg[data-image-state=\"loading\"]{background-image:url(\"data:image/svg+xml,%3Csvg%20fill%3D%22%238b8b94%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cstyle%3E.spinner_ajPY%7Btransform-origin%3Acenter%3Banimation%3Aspinner_AtaB%20.75s%20infinite%20linear%7D%40keyframes%20spinner_AtaB%7B100%25%7Btransform%3Arotate%28360deg%29%7D%7D%3C%2Fstyle%3E%3Cpath%20d%3D%22M12%2C1A11%2C11%2C0%2C1%2C0%2C23%2C12%2C11%2C11%2C0%2C0%2C0%2C12%2C1Zm0%2C19a8%2C8%2C0%2C1%2C1%2C8-8A8%2C8%2C0%2C0%2C1%2C12%2C20Z%22%20opacity%3D%22.25%22%2F%3E%3Cpath%20d%3D%22M10.14%2C1.16a11%2C11%2C0%2C0%2C0-9%2C8.92A1.59%2C1.59%2C0%2C0%2C0%2C2.46%2C12%2C1.52%2C1.52%2C0%2C0%2C0%2C4.11%2C10.7a8%2C8%2C0%2C0%2C1%2C6.66-6.61A1.42%2C1.42%2C0%2C0%2C0%2C12%2C2.69h0A1.57%2C1.57%2C0%2C0%2C0%2C10.14%2C1.16Z%22%20class%3D%22spinner_ajPY%22%2F%3E%3C%2Fsvg%3E\")!important}\nimg[data-image-state=\"error\"]{background-image:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%238b8b94%22%20stroke-width%3D%221.5%22%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%2218%22%20height%3D%2218%22%20rx%3D%223%22%2F%3E%3Cpath%20d%3D%22m3%2017%205-5%204%204%203-3%206%206M8%207h.01M4%204l16%2016%22%2F%3E%3C%2Fsvg%3E\")!important}\n@media(prefers-reduced-motion:reduce){img[data-image-state=\"loading\"]{background-image:url(\"data:image/svg+xml,%3Csvg%20fill%3D%22%238b8b94%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M12%2C1A11%2C11%2C0%2C1%2C0%2C23%2C12%2C11%2C11%2C0%2C0%2C0%2C12%2C1Zm0%2C19a8%2C8%2C0%2C1%2C1%2C8-8A8%2C8%2C0%2C0%2C1%2C12%2C20Z%22%20opacity%3D%22.25%22%2F%3E%3Cpath%20d%3D%22M10.14%2C1.16a11%2C11%2C0%2C0%2C0-9%2C8.92A1.59%2C1.59%2C0%2C0%2C0%2C2.46%2C12%2C1.52%2C1.52%2C0%2C0%2C0%2C4.11%2C10.7a8%2C8%2C0%2C0%2C1%2C6.66-6.61A1.42%2C1.42%2C0%2C0%2C0%2C12%2C2.69h0A1.57%2C1.57%2C0%2C0%2C0%2C10.14%2C1.16Z%22%20class%3D%22spinner_ajPY%22%2F%3E%3C%2Fsvg%3E\")!important}}\n";
  styles += `
img[data-image-state="loading"]{background-image:linear-gradient(90deg,var(--bg-sunken,#ededf0) 0%,color-mix(in oklch,var(--bg-sunken,#ededf0) 70%,var(--surface,#fff)) 50%,var(--bg-sunken,#ededf0) 100%)!important;background-size:200% 100%!important;animation:mediaSkeletonShimmer 1.8s ease-in-out infinite}
@keyframes mediaSkeletonShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){img[data-image-state="loading"]{animation:none!important}}
`;
  const roots = new WeakMap();
  const tracked = new WeakMap();
  const key = image => [image.getAttribute('src'), image.getAttribute('srcset'), image.getAttribute('sizes')].join('|');
  function track(image) {
    const source = key(image);
    if (!image.getAttribute('src') && !image.getAttribute('srcset')) return;
    if (tracked.get(image)?.source === source) return;
    const state = { source, generation: 0 };
    tracked.set(image, state);
    const update = async () => {
      if (tracked.get(image) !== state || key(image) !== source) return;
      const generation = ++state.generation;
      if (!image.complete) { image.dataset.imageState = 'loading'; return; }
      if (!image.naturalWidth) { image.dataset.imageState = 'error'; return; }
      try { await image.decode(); } catch { /* Some supported formats do not expose decoding. */ }
      if (tracked.get(image) === state && key(image) === source && generation === state.generation)
        image.dataset.imageState = image.naturalWidth ? 'ready' : 'error';
    };
    if (!image.dataset.imageListener) {
      image.dataset.imageListener = '1';
      image.addEventListener('load', () => { track(image); tracked.get(image)?.update(); });
      image.addEventListener('error', () => { track(image); tracked.get(image)?.update(); });
    }
    state.update = update;
    image.dataset.imageState = image.complete && image.naturalWidth ? 'ready' : 'loading';
    update();
  }
  function observe(root) {
    const existing = roots.get(root);
    if (existing) { if (!existing.style.isConnected) root.append(existing.style); scan(root); return; }
    const style = document.createElement('style');
    style.textContent = styles;
    (root === document ? document.head : root).append(style);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target.tagName === 'IMG') track(record.target);
          else if (record.target.tagName === 'SOURCE') record.target.parentElement?.querySelectorAll('img').forEach(track);
        } else for (const node of record.addedNodes) scan(node);
      }
    });
    roots.set(root, { observer, style });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes'] });
    scan(root);
  }
  function scan(node) {
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.tagName === 'IMG') track(node);
    node.querySelectorAll?.('img').forEach(track);
    if (node.shadowRoot) observe(node.shadowRoot);
    node.querySelectorAll?.('*').forEach(child => { if (child.shadowRoot) observe(child.shadowRoot); });
  }
  window.OmniImageLoading = { observe };
  observe(document);
})();
