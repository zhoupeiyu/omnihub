(function () {
  var V = "?v=autoload-20261010-14";
  var KEYS = ["q","chapter","grade","money","time","will","view","entry","doc"];
  var ROOT_ID = "life-guide-workspace", CRUMB_ID = "life-guide-breadcrumb";
  var CSS = "/life-guide/workspace-v2.css" + V, UI = "/life-guide/workspace-ui-v2.js" + V, CORE = "/life-guide/workspace-v2.js" + V;
  var lp = null, ok = {}, ctl = null, tkn = 0, on = false, raf = false;
  var locked = false, mraf = 0;
  function $(id) { return document.getElementById(id); }
  function q(s) { return document.querySelector(s); }
  function isG(h) { return (h || location.hash).split("?")[0] === "#life-guide"; }
  function sp(h) { var m = /[?&]space=(mine|public)/.exec(h || location.hash); return m ? m[1] : ""; }
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
  // 专题 › 生活指南 breadcrumb. The guide lives under the 专题 module (no own
  // sidebar entry). The crumb is a sibling placed before the root inside <main>
  // because the guide UI replaces the root's content. Only touches the DOM when
  // something differs, so the MutationObserver below cannot loop.
  function crumbHref() { var s = sp(); return "#topics" + (s ? "?space=" + s : ""); }
  function syncA() {
    var c = $(CRUMB_ID); if (!c) return;
    var root = $(ROOT_ID);
    if (root && root.parentNode && c.nextSibling !== root) root.parentNode.insertBefore(c, root);
    var link = c.querySelector("a"), href = crumbHref();
    if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
    if (c.hidden === on) c.hidden = !on;
  }
  function mkEntry() {
    var main = q("main.main");
    if (!main) return null;
    var c = $(CRUMB_ID);
    if (!c) {
      c = document.createElement("nav");
      c.id = CRUMB_ID; c.className = "topic-breadcrumb"; c.setAttribute("aria-label", "专题导航"); c.hidden = !on;
      c.innerHTML = '<a href="#topics"><span aria-hidden="true">‹</span>专题</a><span aria-hidden="true">/</span><span aria-current="page">生活指南</span>';
      var root = $(ROOT_ID);
      if (root && root.parentNode) root.parentNode.insertBefore(c, root); else main.appendChild(c);
    }
    syncA();
    return c;
  }
  function syncR() { var root = mkRoot(); if (root && root.hidden === on) root.hidden = !on; }
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
  // Leaving the guide (sidebar, 专题 crumb, Back) is a normal hash change owned by
  // the workspace router and its OmniNavigationGuard check; sync() then exits.
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
    if (isG()) enter();
    mkEntry();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    // A cancelled leave restores the URL with pushState (no hashchange).
    window.addEventListener("omnihub:route-restored", sync);
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
