(function () {
  var V = "?v=autoload-20261010-14";
  var KEYS = ["q","chapter","grade","money","time","will","view","entry","doc"];
  var ROOT_ID = "life-guide-workspace", ENTRY_ID = "life-guide-entry";
  var CSS = "/life-guide/workspace-v2.css" + V, UI = "/life-guide/workspace-ui-v2.js" + V, CORE = "/life-guide/workspace-v2.js" + V;
  var lp = null, ok = {}, ctl = null, tkn = 0, on = false, ret = null, raf = false;
  var locked = false, mraf = 0;
  function $(id) { return document.getElementById(id); }
  function q(s) { return document.querySelector(s); }
  function isG(h) { return (h || location.hash).split("?")[0] === "#life-guide"; }
  function sp(h) { var m = /[?&]space=(mine|public)/.exec(h || location.hash); return m ? m[1] : ""; }
  function repo() { var s = sp(); return "#repositories" + (s ? "?space=" + s : ""); }
  function parse(h) {
    var p = new URLSearchParams((h || location.hash).split("?")[1] || "");
    return KEYS.reduce(function (o, k) { o[k] = p.get(k) || ""; return o; }, {});
  }
  function gh(r) {
    var p = new URLSearchParams();
    KEYS.forEach(function (k) { if (r && r[k]) p.set(k, r[k]); });
    if (sp()) p.set("space", sp());
    return "#life-guide?" + p.toString();
  }
  // ---- Desktop viewport lock (active guide only) ----
  // CSS bounds the host layout, sidebar and main.main to the viewport below the
  // real header (--lg-main-top) so the document has no overflow; only the
  // chapter/result panes scroll. Mobile keeps natural document scrolling.
  // unlock() releases the attribute, custom variable and listener on exit.
  function top0() {
    if (!(window.scrollY || window.pageYOffset || document.documentElement.scrollTop)) return;
    try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); }
  }
  function measure() {
    var m = q("main.main"); if (!m) return;
    var t = Math.max(0, Math.ceil(m.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0)));
    var de = document.documentElement, v = t + "px";
    if (de.style.getPropertyValue("--lg-main-top") !== v) de.style.setProperty("--lg-main-top", v);
  }
  function onResize() {
    if (mraf) return;
    mraf = requestAnimationFrame(function () { mraf = 0; if (on) measure(); });
  }
  function lock() {
    document.documentElement.setAttribute("data-life-guide-active", "true");
    measure();
    if (locked) return;
    locked = true;
    window.addEventListener("resize", onResize);
  }
  function unlock() {
    var de = document.documentElement;
    de.removeAttribute("data-life-guide-active");
    de.style.removeProperty("--lg-main-top");
    if (mraf) { cancelAnimationFrame(mraf); mraf = 0; }
    if (!locked) return;
    locked = false;
    window.removeEventListener("resize", onResize);
  }
  // Tear down the controller when leaving the guide. Always invalidates the
  // pending mount token so a late load() cannot bind a new controller into a
  // root that React may since have replaced.
  function teardown() {
    tkn += 1;
    if (ctl) { try { ctl.destroy(); } catch (e) {} ctl = null; }
  }
  var nodes = {};
  function dropScript(src) {
    var s = nodes[src];
    if (s && s.parentNode) s.parentNode.removeChild(s);
    delete nodes[src];
    delete ok[src];
  }
  function loadScript(src, name, method) {
    if (ok[src]) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () {
        var ns = window[name];
        if (!ns || typeof ns[method] !== "function") {
          dropScript(src);
          rej(new Error("bad export " + name + "." + method));
          return;
        }
        ok[src] = 1;
        res();
      };
      s.onerror = function () { dropScript(src); rej(new Error("load " + src)); };
      nodes[src] = s;
      document.head.appendChild(s);
    });
  }
  function ensureCss() {
    if (!$("lg-workspace-css")) {
      var l = document.createElement("link");
      l.id = "lg-workspace-css"; l.rel = "stylesheet"; l.href = CSS;
      document.head.appendChild(l);
    }
  }
  function load() {
    var api = window.OmniLifeGuide;
    if (api && api.mount) return Promise.resolve(api);
    if (lp) return lp;
    ensureCss();
    lp = loadScript(UI, "LifeGuideUI", "create").then(function () { return loadScript(CORE, "OmniLifeGuide", "mount"); }).then(function () {
      if (!(window.OmniLifeGuide || {}).mount) throw new Error("no API");
      return window.OmniLifeGuide;
    }).catch(function (e) {
      lp = null;
      dropScript(UI); dropScript(CORE);
      if (!(window.LifeGuideUI || {}).create) delete window.LifeGuideUI;
      if (!(window.OmniLifeGuide || {}).mount) delete window.OmniLifeGuide;
      throw e;
    });
    return lp;
  }
  // Static, non-interactive skeleton shell painted before the scripts load.
  // Mirrors the live single toolbar row: [filters + reset | ... | search].
  // The real UI's create() replaces root.innerHTML automatically.
  function skeleton(root) {
    var card = '<div class="lg-skel-card"><span class="lg-skel lg-skel-index"></span><span class="lg-skel-lines"><span class="lg-skel lg-skel-line"></span></span></div>';
    var cards = ""; for (var i = 0; i < 8; i++) cards += card;
    var chaps = ""; for (var j = 0; j < 7; j++) chaps += '<span class="lg-skel lg-skel-chapter"></span>';
    function ghostFilter(name, chapter) { return '<span class="lg-filter-label' + (chapter ? ' lg-filter-label--chapter' : '') + '"><span class="lg-filter-name">' + name + '</span><span class="lg-filter-mirror"><span class="lg-filter-dot">·</span><span class="lg-filter-value">' + (chapter ? '全部章节' : '全部') + '</span><span class="lg-filter-arrow">⌄</span></span></span>'; }
    var ghosts = ghostFilter("章节", true) + ghostFilter("证据等级") + ghostFilter("金钱") + ghostFilter("时间") + ghostFilter("毅力");
    root.innerHTML = '<div class="lg-skel-shell">'
      + '<div class="lg-top" aria-hidden="true"><h2 class="lg-heading">生活指南</h2></div>'
      + '<div class="lg-toolbar" aria-hidden="true">'
      + '<div class="lg-filters lg-skel-ghost">' + ghosts + '<span class="lg-reset">重置</span></div>'
      + '<span class="lg-skel lg-skel-search"></span>'
      + '</div></div>'
      + '<div class="lg-layout"><nav class="lg-chapters" aria-hidden="true">' + chaps + '</nav>'
      + '<div class="lg-results"><div class="lg-status" aria-hidden="true">&nbsp;</div>'
      + '<div class="lg-grid lg-loading lg-skeleton" role="status" aria-label="加载生活指南" aria-busy="true"><span aria-hidden="true" style="display:contents">' + cards + '</span></div></div></div>';
  }
  function mkRoot() {
    var root = $(ROOT_ID);
    if (root) return root;
    var main = q("main.main");
    if (!main) return null;
    root = document.createElement("section");
    root.id = ROOT_ID; root.className = "lg-workspace"; root.hidden = !on;
    main.appendChild(root);
    return root;
  }
  function syncA() {
    var a = $(ENTRY_ID); if (!a) return;
    var cur = a.getAttribute("aria-current");
    if (on) { if (cur !== "page") a.setAttribute("aria-current", "page"); }
    else if (cur) a.removeAttribute("aria-current");
  }
  function mkEntry() {
    var nav = q("aside#workspace-sidebar nav.module-nav");
    if (!nav) return null;
    var a = $(ENTRY_ID);
    if (!a) {
      a = document.createElement("a");
      a.id = ENTRY_ID; a.className = "nav-item module-button"; a.href = "#life-guide"; a.title = "生活指南"; a.setAttribute("aria-label", "生活指南");
      a.innerHTML = '<span class="module-icon" aria-hidden="true"><svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/></svg></span><span class="module-label">生活指南</span>';
      nav.appendChild(a);
      a.addEventListener("click", onEntry);
    }
    syncA();
    return a;
  }
  function syncR() { var root = mkRoot(); if (root && root.hidden === on) root.hidden = !on; }
  function onEntry(e) {
    e.preventDefault();
    if (!isG()) ret = location.hash || repo();
    history.pushState(null, "", gh({}));
    enter();
    if (window.matchMedia("(max-width: 860px)").matches) {
      var sidebar = document.querySelector("aside#workspace-sidebar");
      if (sidebar && !sidebar.classList.contains("collapsed")) {
        var toggle = document.querySelector("button.header-toggle");
        if (toggle) toggle.click();
      }
    }
  }
  function retry(root) {
    root.setAttribute("aria-busy", "false");
    root.dataset.state = "error";
    root.innerHTML = "<p>加载失败</p>";
    var b = document.createElement("button");
    b.type = "button"; b.className = "lg-retry"; b.textContent = "重试";
    b.addEventListener("click", function () {
      lp = null;
      dropScript(UI); dropScript(CORE);
      delete window.LifeGuideUI; delete window.OmniLifeGuide;
      teardown();
      root.innerHTML = "";
      mount();
    });
    root.appendChild(b);
  }
  function mount() {
    var root = mkRoot(); if (!root) return;
    var mine = ++tkn;
    root.dataset.state = "loading";
    if (on && isG()) {
      ensureCss();
      root.classList.add("lg-workspace");
      root.hidden = false;
      root.setAttribute("aria-busy", "true");
      skeleton(root);
    }
    load().then(function (api) {
      if (mine !== tkn || !on || !isG()) return;
      // Never reuse a controller bound to a detached (React-replaced) root.
      if (!root.isConnected) return;
      if (ctl) { try { ctl.destroy(); } catch (e) {} ctl = null; }
      ctl = api.mount(root, {
        route: parse(),
        onRouteChange: function (r) { if (on && isG() && root.isConnected && ctl) history.replaceState(null, "", gh(r)); }
      });
      root.hidden = false;
      root.setAttribute("aria-busy", "false");
      root.dataset.state = "ready";
    }).catch(function () { if (mine === tkn && on && isG() && root.isConnected) retry(root); else root.setAttribute("aria-busy", "false"); });
  }
  function enter() {
    var first = !on;
    on = true;
    document.body.setAttribute("data-life-guide-active", "true");
    // Reset the outer scroll only on entry, never on in-guide route changes.
    if (first) { top0(); var m = q("main.main"); if (m) m.scrollTop = 0; }
    lock();
    syncR(); syncA();
    var root = $(ROOT_ID);
    if (ctl && root && root.isConnected) { root.hidden = false; ctl.setRoute(parse()); }
    else mount();
  }
  function exit() {
    on = false;
    document.body.removeAttribute("data-life-guide-active");
    unlock();
    var root = $(ROOT_ID); if (root) root.hidden = true;
    // The root is hidden but may be discarded by React while inactive; drop the
    // controller now so a fresh mount binds into whatever root exists next.
    teardown();
    syncA();
  }
  function sync() {
    if (isG()) {
      if (!on) enter();
      else { if (ctl) ctl.setRoute(parse()); syncR(); syncA(); }
    } else if (on) exit();
  }
  document.addEventListener("click", function (e) {
    if (!on) return;
    var item = e.target && e.target.closest ? e.target.closest("nav.module-nav .nav-item") : null;
    if (!item || item.id === ENTRY_ID) return;
    document.body.removeAttribute("data-life-guide-active");
    on = false;
    unlock();
    history.replaceState(null, "", ret || repo());
    // Captured sidebar click: same teardown as exit(), so no controller survives
    // bound to a root that may be replaced while inactive.
    teardown();
    syncA();
    var root = $(ROOT_ID); if (root) root.hidden = true;
  }, true);
  var mo = new MutationObserver(function () {
    if (raf) return;
    raf = true;
    requestAnimationFrame(function () {
      raf = false;
      mkEntry();
      if (on && !$(ROOT_ID)) {
        teardown();
        mount();
      } else if (on) syncR();
      if (on) measure();
    });
  });
  function init() {
    ret = isG() ? repo() : (location.hash || repo());
    if (isG()) enter(); else mkEntry();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
