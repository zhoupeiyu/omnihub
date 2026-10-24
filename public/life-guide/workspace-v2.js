(function () {
  "use strict";

  var API = "/api/life-guide/";
  var PAGE = 40;
  var DEBOUNCE = 120;
  var MAX_VERSION_RETRY = 1;
  var CACHE_TTL = 5 * 60 * 1000;
  var DETAIL_CACHE_MAX = 100;
  var LIST_CACHE_MAX = 24;

  var FIELDS = ["q", "chapter", "grade", "money", "time", "will", "view", "entry", "doc"];
  var RESET = ["q", "chapter", "grade", "money", "time", "will"];
  var DEFAULTS = { q: "", chapter: "", grade: "", money: "", time: "", will: "", view: "entries", entry: "", doc: "" };

  function copyRoute(route) {
    var out = {}, i;
    for (i = 0; i < FIELDS.length; i++) out[FIELDS[i]] = route[FIELDS[i]];
    return out;
  }

  function normalizeRoute(input) {
    var route = copyRoute(DEFAULTS), i, key, value;
    if (input) for (i = 0; i < FIELDS.length; i++) {
      key = FIELDS[i]; value = input[key];
      if (value !== undefined && value !== null && value !== "") route[key] = value;
    }
    if (route.view !== "docs") {
      route.view = "entries";
      route.doc = "";
    } else {
      route.entry = "";
    }
    return route;
  }

  function sameRoute(a, b) {
    for (var i = 0; i < FIELDS.length; i++) if (a[FIELDS[i]] !== b[FIELDS[i]]) return false;
    return true;
  }

  function encode(obj) {
    var parts = [], keys = Object.keys(obj), i, k, v;
    for (i = 0; i < keys.length; i++) {
      k = keys[i]; v = obj[k];
      if (v === undefined || v === null || v === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
    return parts.join("&");
  }

  function httpError(status, code, message) {
    var e = new Error(message || "请求失败，请重试。");
    e.status = status; e.code = code || "";
    return e;
  }

  function errorFrom(res, fallback) {
    var body = res && res.body;
    var raw = body && body.error;
    var flat = (typeof raw === "string");
    var msg = flat ? (body.message ? String(body.message) : fallback) : (raw && raw.message ? String(raw.message) : fallback);
    var code = flat ? String(raw) : (raw && raw.code ? String(raw.code) : "");
    return httpError(res ? res.status : 0, code, msg || fallback);
  }

  // Resolve the identity a list body reports for the currently requested key.
  // Entries key on `id`; docs key on `file` (falling back to `id`).
  function focusTarget(view, source) {
    if (!source || typeof source !== "object") return null;
    var raw = view === "docs" ? (source.file || source.id) : source.id;
    return (raw === undefined || raw === null || raw === "") ? null : raw;
  }

  function detailMatches(view, id, selected) {
    if (selected === undefined || selected === null) return false;
    if (typeof selected !== "object") return String(selected) === String(id);
    var raw = view === "docs" ? (selected.file || selected.id) : selected.id;
    return raw !== undefined && raw !== null && String(raw) === String(id);
  }

  // Row identity keyed the same way the API keys list rows: entries on `id`,
  // docs on `file` (falling back to `id`). Used for focus injection + dedupe.
  function rowIdentity(view, row) {
    if (!row || typeof row !== "object") return null;
    var raw = view === "docs" ? (row.file || row.id) : row.id;
    return (raw === undefined || raw === null || raw === "") ? null : String(raw);
  }

  function rowPresent(view, rows, id) {
    var target = String(id);
    for (var i = 0; i < rows.length; i++) if (rowIdentity(view, rows[i]) === target) return true;
    return false;
  }

  function dedupeRows(view, rows) {
    var seen = {}, out = [], i, id;
    for (i = 0; i < rows.length; i++) {
      id = rowIdentity(view, rows[i]);
      if (id === null) { out.push(rows[i]); continue; }
      if (seen[id]) continue;
      seen[id] = true; out.push(rows[i]);
    }
    return out;
  }

  // Small per-mount in-memory cache: finite TTL, oldest-first eviction.
  function makeCache(max) {
    var map = new Map();
    return {
      get: function (key) {
        var e = map.get(key);
        if (!e) return null;
        if (Date.now() - e.t > CACHE_TTL) { map.delete(key); return null; }
        return e.v;
      },
      put: function (key, value) {
        map.delete(key);
        map.set(key, { t: Date.now(), v: value });
        while (map.size > max) map.delete(map.keys().next().value);
      },
      clear: function () { map.clear(); }
    };
  }

  function mount(root, options) {
    options = options || {};
    if (!window.LifeGuideUI || typeof window.LifeGuideUI.create !== "function") {
      throw new Error("LifeGuideUI renderer is not available.");
    }

    var state = {
      route: normalizeRoute(options.route),
      meta: null,
      sections: [],
      version: null,
      rows: [],
      count: 0,
      offset: 0,
      selected: null,
      loading: true,
      loadingMore: false,
      moreError: "",
      loadingDetail: false,
      error: "",
      reading: false,
      wantReading: false,
      destroyed: false,
      timer: null,
      gen: 0,
      abort: null,
      versionRetries: 0
    };
    var ui = null;
    var detailCache = makeCache(DETAIL_CACHE_MAX);
    var listCache = makeCache(LIST_CACHE_MAX);

    function isCurrent(gen) { return !state.destroyed && gen === state.gen; }
    function viewOf() { return state.route.view === "docs" ? "docs" : "entries"; }
    function keyOf() { return viewOf() === "docs" ? "doc" : "entry"; }
    function wantsReading() { return !!state.route[keyOf()]; }
    function detailKey(view, id) { return String(state.version) + "|" + view + "|" + String(id); }
    // Another page exists only while rows are short of count AND the next page
    // offset is still inside count, so empty/duplicate pages cannot page forever.
    function hasMore() { return state.rows.length < state.count && state.offset + PAGE < state.count; }

    // Version reset (409): drop metadata and every cached response.
    function resetVersion() {
      state.meta = null;
      state.sections = [];
      state.version = null;
      detailCache.clear();
      listCache.clear();
    }

    function begin() {
      state.gen += 1;
      if (state.abort) { try { state.abort.abort(); } catch (e) {} }
      state.loadingMore = false;
      state.moreError = "";
      state.abort = (typeof AbortController !== "undefined") ? new AbortController() : null;
      return state.gen;
    }

    function getJSON(url) {
      var opts = { credentials: "same-origin" };
      if (state.abort) opts.signal = state.abort.signal;
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          return { status: res.status, body: body };
        });
      });
    }

    function clearTimer() {
      if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    }

    function notify() {
      if (state.destroyed) return;
      if (typeof options.onRouteChange === "function") options.onRouteChange(copyRoute(state.route));
    }

    function resetPaging() {
      state.offset = 0;
      state.rows = [];
      state.count = 0;
    }

    function listParams(offset) {
      var view = viewOf();
      var p = { view: view, limit: PAGE, offset: (offset == null ? state.offset : offset) };
      if (state.route.q) p.q = state.route.q;
      if (view === "entries") {
        if (state.route.chapter) p.chapter = state.route.chapter;
        if (state.route.grade) p.grade = state.route.grade;
        if (state.route.money) p.money = state.route.money;
        if (state.route.time) p.time = state.route.time;
        if (state.route.will) p.will = state.route.will;
      }
      var sel = state.route[keyOf()];
      if (sel) p.selected = sel;
      if (state.version) p.version = state.version;
      return encode(p);
    }

    function applyFirstPage(body) {
      state.version = body.version || state.version;
      state.count = body.count || 0;
      state.offset = 0;
      state.rows = (body.rows || []).slice();
    }

    function mergeSection(section) {
      if (!section || !section.id) return;
      var id = String(section.id);
      var found = false;
      state.sections = state.sections.map(function (s) {
        if (s && String(s.id) === id) {
          found = true;
          return {
            id: s.id,
            number: (s.number != null ? s.number : section.number),
            title: (s.title || section.title),
            file: (s.file || section.file),
            count: s.count,
            intro: section.intro
          };
        }
        return s;
      });
      if (!found) state.sections = state.sections.concat([section]);
    }

    function ensureMeta(gen) {
      if (state.meta) return Promise.resolve();
      return getJSON(API + "meta").then(function (res) {
        if (!isCurrent(gen)) return;
        if (res.status !== 200 || !res.body || !res.body.metadata) {
          throw errorFrom(res, "无法加载生活指南数据。");
        }
        state.meta = res.body;
        state.sections = (res.body.sections || []).slice();
        if (res.body.metadata && res.body.metadata.commit) state.version = res.body.metadata.commit;
      });
    }

    // Only validated, still-current first-page responses are cached.
    function loadList(gen, offset) {
      var key = listParams(offset);
      return getJSON(API + "list?" + key).then(function (res) {
        if (!isCurrent(gen)) return null;
        if (res.status === 409) throw errorFrom(res, "内容已更新，正在刷新。");
        if (res.status !== 200 || !res.body) throw errorFrom(res, "无法加载列表。");
        if (!offset) listCache.put(key, res.body);
        return res.body;
      });
    }

    // Detail-only fetch. Never refetches the list, so already loaded pages are
    // preserved when a title is opened.
    function loadDetail(gen, id) {
      var view = viewOf();
      var p = { view: view, id: id };
      if (state.version) p.version = state.version;
      return getJSON(API + "detail?" + encode(p)).then(function (res) {
        if (!isCurrent(gen)) return;
        if (res.status === 409) throw errorFrom(res, "内容已更新，正在刷新。");
        if (res.status === 404) { state.selected = null; state.reading = false; return; }
        if (res.status !== 200 || !res.body || !res.body.selected) {
          throw errorFrom(res, "无法加载内容。");
        }
        if (!detailMatches(view, id, res.body.selected)) {
          // Server returned a body that is not the identity we asked for:
          // fail safe rather than render the wrong entry/doc.
          state.selected = null;
          state.reading = false;
          return;
        }
        if (!res.body.version || !state.version || res.body.version === state.version) {
          detailCache.put(detailKey(view, id), { selected: res.body.selected, section: res.body.section || null });
        }
        state.version = res.body.version || state.version;
        state.selected = res.body.selected;
        if (res.body.section) mergeSection(res.body.section);
      });
    }

    // Synchronously apply a cached detail; returns false on miss.
    function applyCachedDetail(id) {
      var hit = detailCache.get(detailKey(viewOf(), id));
      if (!hit) return false;
      state.selected = hit.selected;
      if (hit.section) mergeSection(hit.section);
      state.loadingDetail = false;
      return true;
    }

    // Restore the whole first-page view (and focused detail, if any) from the
    // per-mount caches without network or a loading render. False on any miss.
    function syncFromCache() {
      if (!state.meta) return false;
      var body = listCache.get(listParams(0));
      if (!body) return false;
      var view = viewOf(), id = state.route[keyOf()];
      if (id) {
        var fid = focusTarget(view, body.focus);
        if (fid === null || String(fid) !== String(id)) return false;
        if (!detailCache.get(detailKey(view, id))) return false;
      }
      applyFirstPage(body);
      if (id) {
        if (!rowPresent(view, state.rows, id)) state.rows = [body.focus].concat(state.rows);
        state.reading = true;
        applyCachedDetail(id);
      } else {
        state.selected = null;
        state.reading = false;
      }
      state.loading = false;
      state.loadingDetail = false;
      state.error = "";
      render();
      return true;
    }

    // An explicit route key is only honoured when the list focus summary also
    // describes it. When focus sits outside the first 40 rows its summary row is
    // injected at the front so the opened title stays visible in the list.
    function resolveSelection(gen, body) {
      var view = viewOf(), key = keyOf();
      var explicitId = state.route[key];
      if (!explicitId) {
        state.selected = null;
        state.reading = false;
        state.loadingDetail = false;
        return Promise.resolve();
      }
      var focus = body ? body.focus : null;
      var fid = focusTarget(view, focus);
      if (fid === null || String(fid) !== String(explicitId)) {
        state.route[key] = "";
        state.selected = null;
        state.reading = false;
        state.loadingDetail = false;
        state.wantReading = false;
        notify();
        return Promise.resolve();
      }
      if (!rowPresent(view, state.rows, explicitId)) {
        state.rows = [focus].concat(state.rows);
      }
      state.reading = true;
      if (applyCachedDetail(explicitId)) return Promise.resolve();
      state.loadingDetail = true;
    // Deep link: the list (with the injected focus row) is ready before the
    // article body resolves, so paint it with the pending article now.
    state.loading = false;
    render();
      return loadDetail(gen, explicitId).then(function () {
        if (!isCurrent(gen)) return;
        state.loadingDetail = false;
        if (!state.selected) { state.reading = false; state.wantReading = false; }
      });
    }

    function run(gen, opts, attempt) {
      ensureMeta(gen).then(function () {
        if (!isCurrent(gen)) return null;
        return loadList(gen, 0);
      }).then(function (body) {
        if (!isCurrent(gen) || !body) return null;
        applyFirstPage(body);
        return resolveSelection(gen, body);
      }).then(function () {
        if (!isCurrent(gen)) return;
        state.loading = false;
        state.error = "";
        state.versionRetries = 0;
        render();
      }).catch(function (err) {
        if (!isCurrent(gen)) return;
        if (err && err.status === 409) {
          resetVersion();
          if (attempt < MAX_VERSION_RETRY) {
            var g = begin();
            state.loading = true;
            state.loadingDetail = false;
            state.error = "";
            render();
            run(g, opts, attempt + 1);
            return;
          }
        }
        state.loading = false;
        state.loadingDetail = false;
        state.error = (err && err.message) ? err.message : "加载失败，请重试。";
        render();
      });
    }

    function startSync(opts) {
      if (state.destroyed) return;
      clearTimer();
      var gen = begin();
      if (!(opts && opts.force) && syncFromCache()) return;
      state.loading = true;
      state.loadingDetail = false;
      state.error = "";
      state.selected = null;
      render();
      run(gen, opts || {}, 0);
    }

    // Collapse the open/pending detail: invalidate the pending generation, abort
    // its fetch, clear selection + route keys, but keep the list and paging.
    function collapse() {
      clearTimer();
      if (state.abort) { try { state.abort.abort(); } catch (e) {} state.abort = null; }
      state.gen += 1;
      state.route.entry = "";
      state.route.doc = "";
      state.selected = null;
      state.loadingDetail = false;
    state.loadingMore = false;
      state.reading = false;
      state.wantReading = false;
      state.error = "";
      render();
    }

    function fetchDetail(gen, id) {
      state.loadingDetail = true;
      loadDetail(gen, id).then(function () {
        if (!isCurrent(gen)) return;
        state.loadingDetail = false;
        if (!state.selected) {
          state.route[keyOf()] = "";
          state.reading = false;
          state.wantReading = false;
          notify();
        }
        render();
      }).catch(function (err) {
        if (!isCurrent(gen)) return;
        state.loadingDetail = false;
        if (err && err.status === 409) {
          resetVersion();
          if (state.versionRetries < MAX_VERSION_RETRY) {
            state.versionRetries += 1;
            startSync({});
            return;
          }
        }
      // Keep the open route on a normal detail failure so the inline retry
      // stays visible instead of vanishing with the cleared key.
        state.wantReading = false;
        state.error = (err && err.message) ? err.message : "加载失败，请重试。";
        notify();
        render();
      });
    }

    function buildModel() {
      var route = copyRoute(state.route);
      var model = {
        metadata: state.meta ? state.meta.metadata : {},
        sections: state.sections || [],
        docs: state.meta ? (state.meta.docs || []) : [],
        rows: state.rows,
        selected: state.selected,
        count: state.count,
        limit: state.rows.length,
        view: route.view,
        route: route,
        loading: !!state.loading,
        loadingMore: !!state.loadingMore,
        loadingDetail: !!state.loadingDetail,
        hasMore: hasMore()
      };
      if (state.error) model.error = state.error;
      if (state.moreError) model.loadMoreError = state.moreError;
      return model;
    }

    function render() {
      if (state.destroyed || !ui) return;
      if (root && root.classList) root.classList.toggle("lg-reading", !!state.reading && !state.error);
      ui.render(buildModel());
    }

    var handlers = {
      change: function (key, value) {
        if (state.destroyed) return;
        if (state.route[key] === value && !state.error && !wantsReading()) return; // already active: no-op
        state.route[key] = value;
        if (key === "view" || RESET.indexOf(key) !== -1) {
          state.route.entry = "";
          state.route.doc = "";
        }
        if (key === "view") {
          var other = keyOf() === "doc" ? "entry" : "doc";
          state.route[other] = "";
        }
        state.wantReading = false;
        state.reading = false;
        state.selected = null;
        state.loadingDetail = false;
        state.error = "";
        clearTimer();
        begin();
        // Fresh cached first page: restore synchronously, no loading render.
        if (syncFromCache()) { notify(); return; }
      // A new query invalidates the old page immediately: mark the list as
      // loading and drop stale rows so no clickable row survives the debounce.
      state.loading = true;
      resetPaging();
        render();
        var delay = (key === "q") ? DEBOUNCE : 0;
        state.timer = setTimeout(function () {
          state.timer = null;
          if (state.destroyed) return;
          notify();
          startSync({});
        }, delay);
      },
      // Detail-only selection: toggles the focused title, keeps the loaded list.
      select: function (id) {
        if (state.destroyed) return;
        var key = keyOf();
        if (state.reading && state.route[key] && String(state.route[key]) === String(id)) {
          collapse();
          notify();
          return;
        }
      // While a fresh list sync is pending (debounce/paging) the visible rows
      // are stale; ignore the click so the pending query is not cancelled.
      if (state.loading || state.loadingMore) return;
        clearTimer();
        var gen = begin();
        state.route[key] = id;
        state.wantReading = true;
        state.reading = true;
        state.error = "";
        if (applyCachedDetail(id)) { render(); notify(); return; }
        state.selected = null; // clear the previous body before loading the new one
        state.loadingDetail = true;
        render();
        notify();
        fetchDetail(gen, id);
      },
      openDoc: function (file) {
        if (state.destroyed) return;
        clearTimer();
        state.route = normalizeRoute({ view: "docs", doc: file });
        RESET.forEach(function (k) { state.route[k] = ""; });
        state.wantReading = true;
        state.selected = null;
        state.loadingDetail = false;
        resetPaging();
        notify();
        startSync({});
      },
      // One page at a time. The busy flag is rendered before the request so the
      // UI keeps the current rows and shows a loading footer; an ordinary page
      // failure is kept local (loadMoreError) so the rows stay and a manual
      // retry resumes from the same offset. A 409 still resets the version.
      loadMore: function () {
      if (state.destroyed || state.loading || state.loadingMore || state.loadingDetail || state.error) return;
        if (!hasMore()) return;
        var view = viewOf();
        var target = state.offset + PAGE; // offsets always advance by one page
        var gen = begin();
        state.loadingMore = true;
        render();
        getJSON(API + "list?" + listParams(target)).then(function (res) {
          if (!isCurrent(gen)) return;
          if (res.status === 409) throw errorFrom(res, "内容已更新，正在刷新。");
          if (res.status !== 200 || !res.body) throw errorFrom(res, "无法加载更多。");
          state.offset = target;
          state.version = res.body.version || state.version;
          state.count = res.body.count || state.count;
          // Dedupe: an injected focus row may reappear on a later page.
          state.rows = dedupeRows(view, state.rows.concat(res.body.rows || []));
          state.loadingMore = false;
          render();
        }).catch(function (err) {
          if (!isCurrent(gen)) return;
          state.loadingMore = false;
          if (err && err.status === 409) {
            resetVersion();
            if (state.versionRetries < MAX_VERSION_RETRY) {
              state.versionRetries += 1;
              startSync({});
              return;
            }
            state.error = (err && err.message) ? err.message : "加载失败，请重试。";
            render();
            return;
          }
          state.moreError = (err && err.message) ? err.message : "加载失败，请重试。";
          render();
        });
      },
      back: function () {
        if (state.destroyed) return;
        collapse();
        notify();
      },
      retry: function () {
        if (state.destroyed) return;
        state.error = "";
        state.wantReading = wantsReading();
        startSync({ force: true });
      }
    };

    ui = window.LifeGuideUI.create(root, handlers);
    state.wantReading = wantsReading();
    startSync({});

    return {
      setRoute: function (next) {
        if (state.destroyed) return;
        var route = normalizeRoute(next);
        if (sameRoute(route, state.route)) return;
        clearTimer();
        state.route = route;
        state.wantReading = wantsReading();
        state.reading = false;
        state.selected = null;
        state.loadingDetail = false;
        resetPaging();
        startSync({});
      },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        clearTimer();
        if (state.abort) { try { state.abort.abort(); } catch (e) {} state.abort = null; }
        state.loadingMore = false;
        detailCache.clear();
        listCache.clear();
        if (ui && typeof ui.destroy === "function") ui.destroy();
        if (root && root.classList) root.classList.remove("lg-reading");
      }
    };
  }

  window.OmniLifeGuide = { mount: mount };
})();
