(function (root) {
  'use strict';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const luminance = ([r, g, b]) => (.299 * r + .587 * g + .114 * b) / 255;
  const relativeLuminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(relativeLuminance(a), relativeLuminance(b)) + .05) / (Math.min(relativeLuminance(a), relativeLuminance(b)) + .05);
  function material(samples, dark, previousInk, strength = 1) {
    const sorted = samples.slice().sort((a, b) => luminance(a) - luminance(b));
    const middle = sorted.length >= 7 ? sorted.slice(2, -2) : sorted;
    const rgb = middle.length ? [0, 1, 2].map(i => middle.reduce((sum, p) => sum + p[i], 0) / middle.length) : dark ? [40, 40, 44] : [180, 180, 180];
    const light = luminance(rgb), texture = sorted.length ? luminance(sorted.at(-1)) - luminance(sorted[0]) : 1;
    const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
    const ink = dark || (previousInk === 'light' ? light < .55 : previousInk === 'dark' ? light < .45 : light < .5) ? 'light' : 'dark';
    const isLight = ink === 'light', tint = isLight ? [20, 20, 24] : [255, 255, 255];
    const density = clamp(.55 * (isLight ? light : 1 - light) + .7 * texture + .3 * chroma, 0, 1);
    const thin = dark ? .16 : isLight ? .1 : .06, dense = dark ? .38 : isLight ? .3 : .22;
    let alpha = clamp((thin + (dense - thin) * (samples.length ? density : 1)) * strength, 0, 1);
    // Contrast uses every sample, including extremes discarded from the ink decision.
    // Keep the requested transparency at zero; the setting deliberately removes tint.
    if (strength > 0) {
      const filtered = (samples.length ? samples : [rgb]).map(p => p.map(v => clamp(v * (isLight ? .85 : 1.06), 0, 255)));
      const passes = a => filtered.every(p => {
        const background = p.map((v, i) => v * (1 - a) + tint[i] * a);
        const foreground = background.map(v => isLight ? 255 * .94 + v * .06 : v * .14);
        return contrast(background, foreground) >= 4.5;
      });
      while (alpha < .92 && !passes(alpha)) alpha = Math.min(.92, alpha + .04);
    }
    return { ink, tint, alpha, brightness: 1 + (isLight ? (dark ? -.2 : -.15) : .06) * Math.min(strength, 1), saturation: (dark ? 1.6 : 1.8) * Math.max(.45, 1 - .75 * chroma) };
  }
  function pointInTriangle(p, a, b, c) {
    const cross = (u, v, w) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
    if (Math.abs(cross(a, b, c)) < .01) return false;
    const signs = [cross(p, a, b), cross(p, b, c), cross(p, c, a)];
    return !(signs.some(n => n < 0) && signs.some(n => n > 0));
  }
  const TIMING = Object.freeze({ open: 220, close: 360, recheck: 80, safe: 1200, drag: 420, tooltip: 500 });
  const settingsKey = 'omnihub.glass-tint';
  let strengths = { light: 1, dark: 1 };
  try { const saved = JSON.parse(root.localStorage?.getItem(settingsKey) || '{}'); for (const key of ['light', 'dark']) if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) strengths[key] = clamp(saved[key], 0, 1.5); } catch {}
  const api = { material, contrast, pointInTriangle, TIMING, getTint: () => ({ ...strengths }), setTint(theme, value) {
    if (!['light', 'dark'].includes(theme) || !Number.isFinite(value)) return false;
    strengths = { ...strengths, [theme]: clamp(value, 0, 1.5) };
    let persisted = true;
    try { root.localStorage.setItem(settingsKey, JSON.stringify(strengths)); } catch { persisted = false; }
    root.dispatchEvent?.(new Event('omnihub:glass-change'));
    schedule();
    return persisted;
  } };
  root.OmniSurface = api;
  if (!root.document) return;
  const doc = root.document, tracked = new Set(), lensCache = new Map();
  let pending = false, nextId = 0;
  const darkMode = () => doc.documentElement.dataset.theme === 'dark';
  const sampleCanvas = doc.createElement('canvas'); sampleCanvas.width = 5; sampleCanvas.height = 3;
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  function backgroundSamples(surface) {
    const container = surface.closest('.cl-frame') || surface.parentElement;
    const source = container?.querySelector('img');
    if (!source?.complete || !source.naturalWidth || !sampleContext) return [];
    const rect = source.getBoundingClientRect(), box = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const fit = getComputedStyle(source).objectFit;
    const scale = fit === 'cover' ? Math.max(rect.width / source.naturalWidth, rect.height / source.naturalHeight) : Math.min(rect.width / source.naturalWidth, rect.height / source.naturalHeight);
    const width = source.naturalWidth * scale, height = source.naturalHeight * scale;
    const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    // A control over letterboxing uses the theme's dense material instead.
    if (box.left < left || box.right > left + width || box.top < top || box.bottom > top + height) return [];
    try {
      sampleContext.clearRect(0, 0, 5, 3);
      sampleContext.drawImage(source, (box.left - left) / scale, (box.top - top) / scale, box.width / scale, box.height / scale, 0, 0, 5, 3);
      const data = sampleContext.getImageData(0, 0, 5, 3).data;
      return Array.from({ length: 15 }, (_, i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    } catch { return []; }
  }
  function schedule() {
    if (!root.document || !root.requestAnimationFrame || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const surface of tracked) {
        if (!surface.isConnected) { tracked.delete(surface); resize.unobserve(surface); surface._glassSvg?.remove(); continue; }
        const dark = darkMode(), hover = surface.matches(':hover') ? .14 : 0;
        const state = material(backgroundSamples(surface), dark, surface.dataset.glassInk, strengths[dark ? 'dark' : 'light']);
        surface.dataset.glassInk = state.ink;
        const vars = { alpha: Math.min(1, state.alpha * (1 + hover)), brightness: state.brightness, saturation: state.saturation, r: state.tint[0], g: state.tint[1], b: state.tint[2] };
        for (const [key, value] of Object.entries(vars)) surface.style.setProperty('--glass-' + key, String(value));
      }
    });
  }
  function displacement(w, h, radius) {
    const rim = Math.max(4, Math.min(44, Math.min(w, h) / 3.5)), max = 1.1 * rim;
    const key = [w, h, radius, rim].join(':');
    if (lensCache.has(key)) return lensCache.get(key);
    const canvas = doc.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(w, h);
    const distance = (x, y) => { const qx = Math.abs(x - w / 2) - (w / 2 - radius), qy = Math.abs(y - h / 2) - (h / 2 - radius); return radius - (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = distance(x + .5, y + .5), bend = d >= 0 && d < rim ? max * (1 - d / rim) ** 2.6 : 0;
      const dx = distance(x + 1, y + .5) - distance(x, y + .5), dy = distance(x + .5, y + 1) - distance(x + .5, y), length = Math.hypot(dx, dy) || 1, i = (y * w + x) * 4;
      pixels.data[i] = 128 + dx / length * bend / max * 127;
      pixels.data[i + 1] = 128 + dy / length * bend / max * 127;
      pixels.data[i + 2] = 128; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const value = { url: canvas.toDataURL(), scale: max * 2 };
    if (lensCache.size >= 32) lensCache.delete(lensCache.keys().next().value);
    lensCache.set(key, value); return value;
  }
  async function lens(surface) {
    if (surface.dataset.glass !== 'lens' || !CSS.supports('backdrop-filter', 'url(#a)') || !/Chrome|Chromium/.test(navigator.userAgent)) return;
    const css = getComputedStyle(surface), rect = surface.getBoundingClientRect();
    if (Math.min(rect.width, rect.height) < 32 || css.willChange !== 'auto' || css.transform !== 'none') return;
    const w = Math.round(rect.width), h = Math.round(rect.height), radius = Math.min(parseFloat(css.borderTopLeftRadius) || 0, h / 2, w / 2);
    const key = [w, h, radius].join(':');
    if (surface._glassSize === key) return;
    surface._glassSize = key;
    const map = displacement(w, h, radius), decoded = new Image(); decoded.src = map.url;
    try { await decoded.decode(); } catch { return; }
    if (!surface.isConnected || surface._glassSize !== key) return;
    surface._glassSvg?.remove();
    const id = 'glass-rim-' + (++nextId), svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('glass-filter-defs'); svg.setAttribute('aria-hidden', 'true');
    const split = .08; // Keep chromatic separation narrow on small controls.
    svg.innerHTML = `<defs><filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="${map.url}" width="100%" height="100%" preserveAspectRatio="none" result="map"/>${[1 + split, 1, 1 - split].map((factor, i) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${map.scale * factor}" xChannelSelector="R" yChannelSelector="G"/><feColorMatrix type="matrix" values="${[0, 1, 2, 3].map(row => Array.from({ length: 5 }, (_, col) => row === 3 && col === 3 || row === i && col === i ? 1 : 0).join(' ')).join(' ')}" result="c${i}"/>`).join('')}<feBlend in="c0" in2="c1" mode="screen"/><feBlend in2="c2" mode="screen"/></filter></defs>`;
    doc.body.append(svg); surface._glassSvg = svg;
    surface.style.setProperty('--glass-lens', `url(#${id})`);
  }
  const resize = new ResizeObserver(entries => { for (const { target } of entries) lens(target); schedule(); });
  function scan() {
    for (const surface of doc.querySelectorAll('[data-glass]')) if (!tracked.has(surface)) {
      tracked.add(surface); resize.observe(surface);
      surface.addEventListener('pointerenter', schedule); surface.addEventListener('pointerleave', schedule);
    }
    schedule();
  }
  function start() {
    scan();
    new MutationObserver(scan).observe(doc.body, { childList: true, subtree: true });
    new MutationObserver(schedule).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] });
    doc.addEventListener('load', schedule, true);
    root.addEventListener('resize', schedule); root.addEventListener('scroll', schedule, { passive: true, capture: true });
    root.addEventListener('storage', event => { if (event.key !== settingsKey) return; try { const saved = JSON.parse(event.newValue || '{}'); for (const key of ['light', 'dark']) if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) strengths[key] = clamp(saved[key], 0, 1.5); } catch {} schedule(); });
    let tip = null, target = null, tipTimer = null, lastClosed = 0, originalTitle = null, originalDescription = null;
    const hideTip = () => {
      clearTimeout(tipTimer);
      if (target) {
        if (originalTitle != null) target.setAttribute('title', originalTitle);
        if (originalDescription) target.setAttribute('aria-describedby', originalDescription); else target.removeAttribute('aria-describedby');
      }
      if (tip) { tip.remove(); lastClosed = Date.now(); }
      tip = target = null;
    };
    const showTip = event => {
      const next = event.target.closest?.('.cl-name, .cl-nav-name, .media-result-title, .studio-activity-row > span, .fav-name');
      if (!next || next === target || next.scrollWidth <= next.clientWidth + 1) return;
      hideTip(); target = next; originalTitle = next.getAttribute('title'); originalDescription = next.getAttribute('aria-describedby'); next.removeAttribute('title');
      tipTimer = setTimeout(() => {
        if (!next.isConnected) return hideTip();
        tip = doc.createElement('span'); tip.id = 'polish-tooltip'; tip.className = 'module-tooltip polish-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = next.textContent;
        doc.body.append(tip); next.setAttribute('aria-describedby', [originalDescription, tip.id].filter(Boolean).join(' '));
        const rect = next.getBoundingClientRect(), size = tip.getBoundingClientRect();
        tip.style.left = clamp(rect.left, 8, innerWidth - size.width - 8) + 'px';
        tip.style.top = (rect.bottom + size.height + 12 < innerHeight ? rect.bottom + size.height / 2 + 8 : rect.top - size.height / 2 - 8) + 'px';
      }, event.type === 'focusin' || Date.now() - lastClosed < 1000 ? 0 : TIMING.tooltip);
    };
    doc.addEventListener('pointerover', showTip); doc.addEventListener('focusin', showTip);
    doc.addEventListener('pointerout', event => { if (target?.contains(event.target) && !target.contains(event.relatedTarget)) hideTip(); });
    doc.addEventListener('focusout', hideTip); doc.addEventListener('keydown', event => { if (event.key === 'Escape') hideTip(); });
    root.addEventListener('scroll', hideTip, { passive: true, capture: true }); root.addEventListener('hashchange', hideTip);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})(typeof window === 'undefined' ? globalThis : window);
