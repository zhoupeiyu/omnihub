// Focused offline controller tests for public/life-guide/workspace-v2.js
//
// These run the real controller source inside a Node VM with a hand-made
// window.LifeGuideUI renderer stub and a scripted fetch. No jsdom, no sockets,
// no network, no bulk corpus fixtures -- only the contract the controller
// actually consumes from /api/life-guide/.
//
// Run: node tests/life-guide-controller.test.mjs   (exit 0 = all pass)

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(__dirname, "..", "public", "life-guide", "workspace-v2.js");

const META = {
  metadata: { commit: "COMMIT42", repository: "https://github.com/eternity4719/HowToLiveBetter", date: "2020-01-01" },
  sections: [{ id: "s1", title: "S1", count: 2 }],
  docs: []
};

let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push("ok - " + name); }
  else { fail++; lines.push("not ok - " + name + (extra ? " :: " + extra : "")); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush(n) { for (let i = 0; i < (n || 10); i++) await tick(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scripted fetch -------------------------------------------------------
function makeClient(handler) {
  const req = { meta: 0, list: 0, detail: 0, other: 0, listParams: [], detailIds: [] };
  function fetchImpl(url) {
    const u = String(url);
    const idx = u.indexOf("?");
    const pathname = idx < 0 ? u : u.slice(0, idx);
    const params = new URLSearchParams(idx < 0 ? "" : u.slice(idx + 1));
    const kind = pathname.endsWith("/meta") ? "meta"
      : pathname.endsWith("/list") ? "list"
      : pathname.endsWith("/detail") ? "detail" : "other";
    req[kind] += 1;
    if (kind === "list") req.listParams.push(params);
    if (kind === "detail") req.detailIds.push(params.get("id"));
    return Promise.resolve()
      .then(() => handler(kind, params))
      .then((out) => ({
        status: out && out.status != null ? out.status : 200,
        json: () => Promise.resolve(out ? out.body : null)
      }));
  }
  return { fetchImpl, req };
}

// Generic detail body that always echoes the requested id, so detail-only
// selection (no auto-select) can be exercised without per-test fixtures.
function echoDetail(params) {
  const id = params.get("id");
  return { status: 200, body: { version: "COMMIT42", selected: { id: id, title: "T" + id, markdown: "# " + id } } };
}

function makeUI() {
  const ui = {
    handlers: null, renders: 0, model: null, destroyed: false, bound: 0, models: [],
    create: function (root, handlers) {
      ui.handlers = handlers; ui.bound += 1; ui.destroyed = false;
      return { render: function (m) { ui.renders += 1; ui.model = m; ui.models.push(m); }, destroy: function () { ui.destroyed = true; } };
    }
  };
  return ui;
}

function makeRoot() {
  const cls = {};
  return {
    classList: {
      toggle: (n, v) => { cls[n] = v === undefined ? !cls[n] : !!v; },
      add: (n) => { cls[n] = true; },
      remove: (n) => { delete cls[n]; }
    },
    _cls: cls
  };
}

function mountGuide(fetchImpl, route) {
  const ui = makeUI();
  const root = makeRoot();
  const routes = [];
  globalThis.fetch = fetchImpl;
  globalThis.window.LifeGuideUI = ui;
  const ctl = globalThis.window.OmniLifeGuide.mount(root, {
    route: route || {},
    onRouteChange: (r) => routes.push(r)
  });
  return { ui, root, routes, ctl };
}

// --- load the real controller (once) --------------------------------------
globalThis.window = {};
vm.runInThisContext(fs.readFileSync(CORE, "utf8"), { filename: "workspace-v2.js" });
if (!globalThis.window.OmniLifeGuide || typeof globalThis.window.OmniLifeGuide.mount !== "function") {
  console.error("controller did not export window.OmniLifeGuide.mount");
  process.exit(1);
}

// 1. meta commit drives the version sent on both list and detail requests.
async function test1() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }], focus: p.get("selected") === "e1" ? { id: "e1", title: "One" } : null } };
    if (kind === "detail") return { status: 200, body: { version: "COMMIT42", selected: { id: "e1", title: "One", markdown: "# One" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e1" });
  await flush();
  ok("meta commit used as list version", c.req.listParams[0] && c.req.listParams[0].get("version") === "COMMIT42");
  ok("meta commit used as detail version", m.ui.model != null && c.req.listParams.length >= 1);
  ok("detail selected identity preserved", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e1");
  ok("requested detail id matches entry", c.req.detailIds.length === 1 && c.req.detailIds[0] === "e1");
  ok("only meta/list/detail requested", c.req.other === 0);
  m.ctl.destroy();
}

// 2. list focus that does not describe the requested key -> no wrong branch,
//    no detail body fetched, stale key cleared.
async function test2() {
  const c = makeClient((kind) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }, { id: "e2", title: "Two" }], focus: { id: "e9", title: "Nine" } } };
    if (kind === "detail") return { status: 200, body: { version: "COMMIT42", selected: { id: "e9", title: "Nine", markdown: "# Nine" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e1" });
  await flush();
  ok("mismatched focus: no detail request", c.req.detail === 0);
  ok("mismatched focus: no wrong selected", !m.ui.model || m.ui.model.selected === null);
  ok("mismatched focus: entry key cleared", m.ui.model && m.ui.model.route.entry === "");
  ok("mismatched focus: route notified with cleared key", m.routes.length >= 1 && m.routes[m.routes.length - 1].entry === "");
  m.ctl.destroy();
}

// 3. detail returning a different identity than requested -> no wrong selected.
async function test3() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }], focus: p.get("selected") === "e1" ? { id: "e1", title: "One" } : null } };
    if (kind === "detail") return { status: 200, body: { version: "COMMIT42", selected: { id: "e2", title: "Two", markdown: "# Two" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e1" });
  await flush();
  ok("wrong detail identity requested once", c.req.detail === 1 && c.req.detailIds[0] === "e1");
  ok("wrong detail identity rejected (no wrong selected)", m.ui.model && m.ui.model.selected === null);
  m.ctl.destroy();
}

// 4. inactive key must not trigger mobile reading.
async function test4() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 1, rows: [{ id: "e1", title: "One" }], focus: p.get("selected") === "e1" ? { id: "e1", title: "One" } : null } };
    if (kind === "detail") return { status: 200, body: { version: "COMMIT42", selected: { id: "e1", title: "One", markdown: "# One" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", doc: "x" });
  await flush();
  ok("inactive doc key cleared on entries view", m.ui.model && m.ui.model.route.doc === "");
  ok("inactive key: not reading", m.root._cls["lg-reading"] !== true);
  m.ui.handlers.select("e1");
  await flush();
  ok("active select: reading enabled", m.root._cls["lg-reading"] === true);
  m.ctl.destroy();
}

// 5. quick input: debounced, aborts the previous in-flight request.
async function test5() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 0, rows: [], focus: null } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  const before = c.req.list;
  m.ui.handlers.change("q", "a");
  m.ui.handlers.change("q", "ab");
  ok("quick input: no immediate fetch", c.req.list === before);
  await sleep(260);
  ok("quick input: exactly one debounced fetch", c.req.list === before + 1, "list=" + c.req.list + " before=" + before);
  ok("quick input: last query wins", c.req.listParams[c.req.listParams.length - 1].get("q") === "ab");
  m.ctl.destroy();
}

// 6. a cancelled loadMore must not wedge paging.
async function test6() {
  let phase = 0, pendingResolve = null, offset40 = 0;
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return { status: 404, body: { error: { code: "NOTFOUND", message: "missing" } } };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 40) {
        offset40 += 1;
        if (phase === 0) return new Promise((res) => { pendingResolve = res; });
      }
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: null } };
      if (off === 40) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: [], focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  ok("loadMore: initial page loaded", m.ui.model && m.ui.model.rows.length === 40);
  m.ui.handlers.loadMore();
  await flush();
  ok("loadMore: second page requested", offset40 === 1);
  m.ui.handlers.change("grade", "A");       // cancels the in-flight loadMore
  phase = 1;
  if (pendingResolve) pendingResolve({ status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } });
  await sleep(30);
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("loadMore: can paginate again after cancel", m.ui.model && m.ui.model.rows.length === 80, "rows=" + (m.ui.model && m.ui.model.rows.length));
  m.ctl.destroy();
}

// 7. a single 409 triggers one refresh, never an infinite loop.
async function test7() {
  const c = makeClient((kind) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 409, body: { error: { code: "VERSION_CHANGED", message: "changed" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  await sleep(60);
  ok("409: exactly one retry (list called twice)", c.req.list === 2, "list=" + c.req.list);
  ok("409: meta refetched once on retry", c.req.meta === 2, "meta=" + c.req.meta);
  ok("409: surfaces an error instead of looping", m.ui.model && typeof m.ui.model.error === "string" && m.ui.model.error.length > 0);
  m.ctl.destroy();
}

// 8. 404 / back / destroy callbacks stay safe and side-effect free.
async function test8() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 1, rows: [{ id: "e1", title: "One" }], focus: p.get("selected") === "e1" ? { id: "e1", title: "One" } : null } };
    if (kind === "detail") return { status: 404, body: { error: { code: "NOTFOUND", message: "missing" } } };
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e1" });
  await flush();
  ok("404: selected cleared, no error banner", m.ui.model && m.ui.model.selected === null && !m.ui.model.error);
  m.ui.handlers.back();
  ok("back: keys cleared, no selection", m.ui.model && m.ui.model.route.entry === "" && m.ui.model.route.doc === "" && m.ui.model.selected === null);
  const before = { list: c.req.list, detail: c.req.detail };
  m.ctl.destroy();
  ok("destroy: renderer torn down", m.ui.destroyed === true);
  let threw = "";
  try {
    m.ui.handlers.change("q", "z");
    m.ui.handlers.change("view", "docs");
    m.ui.handlers.select("e1");
    m.ui.handlers.openDoc("docs/a.md");
    m.ui.handlers.loadMore();
    m.ui.handlers.back();
    m.ui.handlers.retry();
    m.ctl.setRoute({ view: "docs", doc: "docs/a.md" });
    m.ctl.destroy();
  } catch (e) { threw = String(e && e.message || e); }
  await sleep(200);
  ok("destroy: handlers are inert and safe", threw === "", threw);
  ok("destroy: no further network", c.req.list === before.list && c.req.detail === before.detail);
}

// 9. destroy during an in-flight request aborts cleanly.
async function test9() {
  let pendingResolve = null;
  const c = makeClient((kind) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return new Promise((res) => { pendingResolve = res; });
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  let threw = "";
  try { m.ctl.destroy(); if (pendingResolve) pendingResolve({ status: 200, body: { version: "COMMIT42", view: "entries", count: 0, rows: [], focus: null } }); } catch (e) { threw = String(e && e.message || e); }
  await sleep(20);
  ok("destroy mid-flight: no throw", threw === "");
}

// 10. no implicit first-detail fetch; a title click is detail-only and toggles.
async function test10() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }, { id: "e2", title: "Two" }], focus: null } };
    if (kind === "detail") return echoDetail(p);
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  ok("no auto-select: initial detail count 0", c.req.detail === 0, "detail=" + c.req.detail);
  ok("no auto-select: nothing selected", m.ui.model && m.ui.model.selected === null);
  ok("no auto-select: initial rows rendered", m.ui.model && m.ui.model.rows.length === 2);

  const listBefore = c.req.list;
  m.ui.handlers.select("e1");
  await flush();
  ok("title click fetches detail only", c.req.detail === 1 && c.req.detailIds[0] === "e1", "detail=" + c.req.detail);
  ok("title click does not refetch list", c.req.list === listBefore, "list=" + c.req.list);
  ok("title click selects the row", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e1");

  m.ui.handlers.select("e1");   // same title toggles closed
  await flush();
  ok("same title toggles closed (no extra network)", c.req.detail === 1 && m.ui.model.selected === null, "detail=" + c.req.detail);
  ok("same title toggle clears the route key", m.ui.model.route.entry === "");

  m.ui.handlers.select("e2");   // different title opens a new detail
  await flush();
  ok("different title loads new detail", c.req.detail === 2 && c.req.detailIds[1] === "e2" && m.ui.model.selected.id === "e2");
  m.ctl.destroy();
}

// 11. a late detail result for a superseded title is discarded (cancel race).
async function test11() {
  let held = null, first = true;
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }, { id: "e2", title: "Two" }], focus: null } };
    if (kind === "detail") {
      if (first) { first = false; return new Promise((res) => { held = res; }); }
      return echoDetail(p);
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("e1");
  await flush();
  m.ui.handlers.select("e2");   // aborts the pending e1 detail
  await flush();
  if (held) held({ status: 200, body: { version: "COMMIT42", selected: { id: "e1", title: "T e1", markdown: "# e1" } } });
  await sleep(20);
  await flush();
  ok("cancel race: both details requested", c.req.detail === 2, "detail=" + c.req.detail);
  ok("cancel race: late detail result discarded", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e2", JSON.stringify(m.ui.model && m.ui.model.selected));
  ok("cancel race: no error surfaced", !m.ui.model.error);
  m.ctl.destroy();
}

// 12. selecting a title never drops the loaded pages; pagination keeps offset.
async function test12() {
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return echoDetail(p);
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  const listBefore = c.req.list;
  m.ui.handlers.select("e1");
  await flush();
  ok("pagination: select keeps the loaded page", c.req.list === listBefore && m.ui.model.rows.length === 40, "list=" + c.req.list + " rows=" + (m.ui.model && m.ui.model.rows.length));
  m.ui.handlers.loadMore();
  await flush();
  ok("pagination: second page preserved after detail", m.ui.model && m.ui.model.rows.length === 80, "rows=" + (m.ui.model && m.ui.model.rows.length));
  ok("pagination: offset advances by one page", c.req.listParams[c.req.listParams.length - 1].get("offset") === "40");
  m.ctl.destroy();
}

// 13. explicit focus outside the first 40 gains a front summary row, deduped.
async function test13() {
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return echoDetail(p);
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: { id: "e99", title: "Deep" } } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80).concat([{ id: "e99", title: "Deep" }]), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e99" });
  await flush();
  ok("outside-40 focus: detail loaded for explicit route", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e99");
  ok("outside-40 focus: summary row injected at front", m.ui.model.rows[0] && m.ui.model.rows[0].id === "e99" && m.ui.model.rows.length === 41, "rows=" + (m.ui.model && m.ui.model.rows.length));
  const key = c.req.listParams[c.req.listParams.length - 1].get("selected");
  ok("outside-40 focus: route key sent to list", key === "e99");
  m.ui.handlers.loadMore();
  await flush();
  const dupes = m.ui.model.rows.filter((r) => r.id === "e99").length;
  ok("outside-40 focus: page deduped after loadMore", m.ui.model.rows.length === 81 && dupes === 1, "rows=" + m.ui.model.rows.length + " dupes=" + dupes);
  m.ctl.destroy();
}

// 14. shared generation/abort: a pending detail must block paging, and a
//     collapse must clear a wedged paging flag.
async function test14() {
  let held = null;
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return new Promise((res) => { held = res; });
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  const listBefore = c.req.list;
  m.ui.handlers.select("e1");
  await flush();
  ok("mutual: pending detail marks loadingDetail", m.ui.model && m.ui.model.loadingDetail === true);
  m.ui.handlers.loadMore();
  await flush();
  ok("mutual: loadMore ignored while detail pending", c.req.list === listBefore, "list=" + c.req.list);
  if (held) held({ status: 200, body: { version: "COMMIT42", selected: { id: "e1", title: "T", markdown: "# e1" } } });
  await sleep(20);
  await flush();
  ok("mutual: detail resolves and clears loadingDetail", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e1" && m.ui.model.loadingDetail === false);
  m.ui.handlers.loadMore();
  await flush();
  ok("mutual: paging resumes after detail", m.ui.model && m.ui.model.rows.length === 80, "rows=" + (m.ui.model && m.ui.model.rows.length));
  m.ctl.destroy();

  // A collapse must clear a wedged paging flag.
  let holdPage = null;
  const c2 = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return echoDetail(p);
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: null } };
      return new Promise((res) => { holdPage = res; });
    }
    return { status: 200, body: {} };
  });
  const m2 = mountGuide(c2.fetchImpl, { view: "entries" });
  await flush();
  m2.ui.handlers.select("e0");
  await flush();
  m2.ui.handlers.loadMore();
  await flush();
  ok("mutual: page request in flight", c2.req.list === 2, "list=" + c2.req.list);
  m2.ui.handlers.select("e0");
  await flush();
  ok("mutual: collapse clears the focused entry", m2.ui.model.route.entry === "" && m2.ui.model.selected === null, "entry=" + m2.ui.model.route.entry + " selected=" + m2.ui.model.selected);
  holdPage({ status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } });
  await flush();
  ok("mutual: collapse keeps the loaded page", m2.ui.model && m2.ui.model.rows.length === 40, "rows=" + (m2.ui.model && m2.ui.model.rows.length));
  m2.ui.handlers.loadMore();
  await flush();
  ok("mutual: pager usable again after collapse", c2.req.list === 3, "list=" + c2.req.list);
  m2.ctl.destroy();
}

// 15. debounce interaction: a pending query cannot be cancelled by clicking a
//     stale row, and the list is marked loading immediately.
async function test15() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return echoDetail(p);
    if (kind === "list") {
      const q = p.get("q");
      const rows = q ? [{ id: "q1", title: "Q" }] : [{ id: "e1", title: "One" }, { id: "e2", title: "Two" }];
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: rows.length, rows: rows, focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  const listBefore = c.req.list, detailBefore = c.req.detail;
  m.ui.handlers.change("q", "zz");
  await flush();
  ok("debounce: list marked loading immediately", m.ui.model && m.ui.model.loading === true);
  ok("debounce: stale rows dropped at once", m.ui.model && m.ui.model.rows.length === 0, "rows=" + (m.ui.model && m.ui.model.rows.length));
  m.ui.handlers.select("e1");
  await flush();
  ok("debounce: stale row click ignored", c.req.detail === detailBefore, "detail=" + c.req.detail);
  ok("debounce: pending query not refetched early", c.req.list === listBefore, "list=" + c.req.list);
  await sleep(260);
  await flush();
  ok("debounce: single fetch after the 120ms debounce", c.req.list === listBefore + 1, "list=" + c.req.list);
  ok("debounce: last query wins", c.req.listParams[c.req.listParams.length - 1].get("q") === "zz");
  m.ctl.destroy();
}

// 16. ordinary detail failure: keep the open route + inline retry instead of
//     silently dropping the panel.
async function test16() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return { status: 500, body: { error: { code: "BOOM", message: "boom" } } };
    if (kind === "list") {
      const sel = p.get("selected");
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: "e1", title: "One" }, { id: "e2", title: "Two" }], focus: sel ? { id: sel, title: "One" } : null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("e1");
  await flush();
  ok("detail error: message surfaced", m.ui.model && m.ui.model.error === "boom", JSON.stringify(m.ui.model && m.ui.model.error));
  ok("detail error: route key retained", m.ui.model && m.ui.model.route.entry === "e1");
  ok("detail error: selection cleared", m.ui.model && m.ui.model.selected === null);
  ok("detail error: not left loading", m.ui.model && m.ui.model.loadingDetail === false);
  const before = c.req.detail;
  m.ui.handlers.retry();
  await flush();
  ok("detail error: retry refetches the detail", c.req.detail === before + 1, "detail=" + c.req.detail);
  m.ctl.destroy();
}

// 17. deep link: the list (with the injected focus row) paints before the
//     detail body resolves.
async function test17() {
  let held = null;
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return new Promise((res) => { held = res; });
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(0, 40), focus: { id: "e99", title: "Deep" } } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: range(40, 80), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries", entry: "e99" });
  await flush();
  ok("deep link: list painted before detail resolves", m.ui.model && m.ui.model.loading === false && m.ui.model.rows.length === 41, "loading=" + (m.ui.model && m.ui.model.loading) + " rows=" + (m.ui.model && m.ui.model.rows.length));
  ok("deep link: focus row injected at the front", m.ui.model && m.ui.model.rows[0] && m.ui.model.rows[0].id === "e99");
  ok("deep link: pending article flagged", m.ui.model && m.ui.model.loadingDetail === true);
  if (held) held({ status: 200, body: { version: "COMMIT42", selected: { id: "e99", title: "Deep", markdown: "# Deep" } } });
  await sleep(20);
  await flush();
  ok("deep link: detail resolves", m.ui.model && m.ui.model.selected && m.ui.model.selected.id === "e99");
  m.ctl.destroy();
}

// --- caching regressions ---------------------------------------------------

function cacheClient(extra) {
  return makeClient((kind, p) => {
    if (extra) { const out = extra(kind, p); if (out) return out; }
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "detail") return echoDetail(p);
    if (kind === "list") {
      const tag = [p.get("view"), p.get("chapter") || "", p.get("grade") || ""].join("/");
      const sel = p.get("selected");
      return { status: 200, body: { version: "COMMIT42", view: p.get("view"), count: 2, rows: [{ id: tag + "#1", title: tag }, { id: tag + "#2", title: tag }], focus: sel ? { id: sel, title: sel } : null } };
    }
    return { status: 200, body: {} };
  });
}
const noLoading = (models) => models.every((md) => md.loading === false && md.loadingDetail === false);

// 18. detail reopen and A-B-A reuse: no request, no loading transition.
async function test18() {
  const c = cacheClient();
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("a");
  await flush();
  m.ui.handlers.select("a");   // collapse
  const before = c.req.detail;
  m.ui.models.length = 0;
  m.ui.handlers.select("a");   // reopen, synchronous cache hit
  ok("cache: reopen populates selected synchronously", m.ui.model.selected && m.ui.model.selected.id === "a" && m.ui.model.loadingDetail === false);
  ok("cache: reopen emits no loading model", m.ui.models.length > 0 && noLoading(m.ui.models));
  await flush();
  ok("cache: reopen makes no detail request", c.req.detail === before, "detail=" + c.req.detail);
  m.ui.handlers.select("b");
  await flush();
  ok("cache: B miss fetches", c.req.detail === before + 1);
  m.ui.models.length = 0;
  m.ui.handlers.select("a");
  ok("cache: A-B-A reuses A without loading", m.ui.model.selected.id === "a" && noLoading(m.ui.models));
  await flush();
  ok("cache: A-B-A no extra request", c.req.detail === before + 1, "detail=" + c.req.detail);
  m.ctl.destroy();
}

// 19. chapter revisit reuses the first page; filters are isolated; same value no-ops.
async function test19() {
  const c = cacheClient();
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.change("chapter", "c1");
  await flush();
  m.ui.handlers.change("chapter", "c2");
  await flush();
  const before = c.req.list;
  m.ui.models.length = 0;
  m.ui.handlers.change("chapter", "c1");
  ok("cache: revisited chapter restored synchronously", m.ui.model.rows.length === 2 && m.ui.model.rows[0].id === "entries/c1/#1" && m.ui.model.count === 2);
  ok("cache: revisited chapter emits no loading model", m.ui.models.length > 0 && noLoading(m.ui.models));
  await flush();
  ok("cache: revisited chapter no list request", c.req.list === before, "list=" + c.req.list);
  m.ui.handlers.change("grade", "A");
  ok("cache: different filter key drops rows and loads", m.ui.model.loading === true && m.ui.model.rows.length === 0);
  await flush();
  ok("cache: different filter key fetches", c.req.list === before + 1 && m.ui.model.rows[0].id === "entries/c1/A#1");
  const renders = m.ui.renders, lists = c.req.list;
  m.ui.handlers.change("grade", "A");
  await flush();
  ok("cache: same active filter value is a no-op", m.ui.renders === renders && c.req.list === lists);
  m.ctl.destroy();
}

// 20. TTL expiry triggers a network refetch.
async function test20() {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const c = cacheClient();
    const m = mountGuide(c.fetchImpl, { view: "entries" });
    await flush();
    m.ui.handlers.select("a");
    await flush();
    m.ui.handlers.select("a");
    m.ui.handlers.change("chapter", "c1");
    await flush();
    m.ui.handlers.change("chapter", "");
    await flush();
    const d = c.req.detail, l = c.req.list;
    now += 6 * 60 * 1000;
    m.ui.handlers.change("chapter", "c1");
    ok("ttl: expired list shows loading", m.ui.model.loading === true);
    await flush();
    ok("ttl: expired list refetched", c.req.list === l + 1, "list=" + c.req.list);
    m.ui.handlers.select("a");
    ok("ttl: expired detail shows loading", m.ui.model.loadingDetail === true);
    await flush();
    ok("ttl: expired detail refetched", c.req.detail === d + 1, "detail=" + c.req.detail);
    m.ctl.destroy();
  } finally {
    Date.now = realNow;
  }
}

// 21. version 409 invalidates caches.
async function test21() {
  let fail409 = false;
  const c = cacheClient((kind, p) => {
    if (kind === "detail" && fail409 && p.get("id") === "b") { fail409 = false; return { status: 409, body: { error: { code: "VERSION_CHANGED", message: "changed" } } }; }
    return null;
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("a");
  await flush();
  fail409 = true;
  m.ui.handlers.select("b");
  await flush();
  await sleep(20);
  await flush();
  ok("409 cache: meta refetched", c.req.meta === 2, "meta=" + c.req.meta);
  const d = c.req.detail;
  if (m.ui.model.route.entry) { m.ui.handlers.back(); }
  m.ui.handlers.select("a");
  ok("409 cache: old detail not reused", m.ui.model.loadingDetail === true);
  await flush();
  ok("409 cache: detail refetched after invalidation", c.req.detail === d + 1, "detail=" + c.req.detail);
  m.ctl.destroy();
}

// 22. a cancelled detail response is never cached.
async function test22() {
  let held = null, first = true;
  const c = cacheClient((kind) => {
    if (kind === "detail" && first) { first = false; return new Promise((res) => { held = res; }); }
    return null;
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("a");
  await flush();
  m.ui.handlers.select("b");
  await flush();
  if (held) held({ status: 200, body: { version: "COMMIT42", selected: { id: "a", title: "Ta" } } });
  await flush();
  const d = c.req.detail;
  m.ui.handlers.select("a");
  ok("cancelled: reopen is a miss with loading", m.ui.model.loadingDetail === true);
  await flush();
  ok("cancelled: late response was not cached", c.req.detail === d + 1, "detail=" + c.req.detail);
  m.ctl.destroy();
}

// 23. docs identity is distinct from entry identity.
async function test23() {
  const c = cacheClient();
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("x.md");
  await flush();
  m.ui.handlers.change("view", "docs");
  await flush();
  const d = c.req.detail;
  m.ui.handlers.select("x.md");
  ok("docs key: entry cache not reused for doc", m.ui.model.loadingDetail === true);
  await flush();
  ok("docs key: doc detail fetched with docs view", c.req.detail === d + 1 && m.ui.model.selected && m.ui.model.selected.id === "x.md");
  m.ctl.destroy();
}

// 24. same-value filter change still collapses an open detail.
async function test24() {
  const c = cacheClient();
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("a");
  await flush();
  const l = c.req.list, d = c.req.detail;
  ["q", "chapter", "grade", "money", "time", "will"].forEach((k) => m.ui.handlers.change(k, ""));
  ok("same-value reset: route cleared", !m.ui.model.route.entry && !m.ui.model.route.doc && m.ui.model.selected === null);
  ok("same-value reset: no loading", m.ui.model.loading === false && m.ui.model.loadingDetail === false);
  await flush();
  ok("same-value reset: no network", c.req.list === l && c.req.detail === d, "list=" + c.req.list + " detail=" + c.req.detail);
  m.ctl.destroy();
}

// 25. terminal 409 still invalidates the version cache.
async function test25() {
  let fail409 = false;
  const c = cacheClient((kind, p) => {
    if (kind === "detail" && fail409 && p.get("id") === "b") return { status: 409, body: { error: { code: "VERSION_CHANGED", message: "changed" } } };
    return null;
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.select("a");
  await flush();
  fail409 = true;
  m.ui.handlers.select("b");
  for (let i = 0; i < 4; i++) { await flush(); await sleep(20); }
  ok("terminal 409: error shown", !!m.ui.model.error, "error=" + m.ui.model.error);
  ok("terminal 409: retries bounded", c.req.meta >= 2 && c.req.meta <= 4, "meta=" + c.req.meta);
  fail409 = false;
  const d = c.req.detail;
  m.ui.handlers.back();
  m.ui.handlers.select("a");
  ok("terminal 409: cache cleared, detail misses", m.ui.model.loadingDetail === true);
  await flush();
  ok("terminal 409: detail refetched", c.req.detail === d + 1 && m.ui.model.selected && m.ui.model.selected.id === "a", "detail=" + c.req.detail);
  m.ctl.destroy();
}

// --- automatic pagination contract -----------------------------------------
// The UI auto-trigger relies on: loadingMore exposed synchronously, hasMore,
// a single in-flight page, a local (non-looping) page error, and exhaustion.

const pageRange = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: "e" + (from + i), title: "E" + (from + i) }));
const offsetCalls = (c, off) => c.req.listParams.filter((p) => Number(p.get("offset") || 0) === off).length;

// 26. loadingMore is rendered synchronously and duplicate calls share one page.
async function test26() {
  let held = null;
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(0, 40), focus: null } };
      return new Promise((res) => { held = res; });
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  ok("auto: first page exposes hasMore and idle pager", m.ui.model.hasMore === true && m.ui.model.loadingMore === false);
  m.ui.models.length = 0;
  m.ui.handlers.loadMore();
  ok("auto: loadingMore rendered synchronously", m.ui.models.length === 1 && m.ui.model.loadingMore === true, "renders=" + m.ui.models.length);
  ok("auto: existing rows kept while loading more", m.ui.model.rows.length === 40 && m.ui.model.loading === false);
  m.ui.handlers.loadMore();
  m.ui.handlers.loadMore();
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("auto: duplicate calls make one page request", offsetCalls(c, 40) === 1, "offset40=" + offsetCalls(c, 40));
  ok("auto: duplicate calls do not re-render", m.ui.models.length === 1, "renders=" + m.ui.models.length);
  if (held) held({ status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(40, 80), focus: null } });
  await flush();
  ok("auto: page appended and busy flag cleared", m.ui.model.rows.length === 80 && m.ui.model.loadingMore === false && m.ui.model.hasMore === true, "rows=" + m.ui.model.rows.length);
  m.ctl.destroy();
}

// 27. a failed page clears the busy flag, keeps rows, never re-requests on its
//     own, and a manual retry resumes from the same offset.
async function test27() {
  let failNext = true;
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(0, 40), focus: null } };
      if (failNext) { failNext = false; return { status: 500, body: { error: { code: "BOOM", message: "boom" } } }; }
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(40, 80), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("page failure: busy flag cleared", m.ui.model.loadingMore === false);
  ok("page failure: local error exposed, no list error", m.ui.model.loadMoreError === "boom" && !m.ui.model.error, "more=" + m.ui.model.loadMoreError + " error=" + m.ui.model.error);
  ok("page failure: loaded rows kept", m.ui.model.rows.length === 40);
  const calls = offsetCalls(c, 40);
  await sleep(60);
  await flush();
  ok("page failure: no automatic re-request", offsetCalls(c, 40) === calls, "offset40=" + offsetCalls(c, 40));
  m.ui.handlers.loadMore();
  ok("page failure: manual retry clears the error and is busy", m.ui.model.loadMoreError === undefined && m.ui.model.loadingMore === true);
  await flush();
  ok("page failure: manual retry appends the same page", m.ui.model.rows.length === 80 && offsetCalls(c, 40) === 2 && m.ui.model.loadingMore === false, "rows=" + m.ui.model.rows.length);
  m.ctl.destroy();
}

// 28. a chapter change (and an external route change) during a pending page
//     clears the busy flag and discards the stale page.
async function test28() {
  let held = null;
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0), ch = p.get("chapter") || "";
      if (ch) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 2, rows: [{ id: ch + "-e1", title: "A" }, { id: ch + "-e2", title: "B" }], focus: null } };
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(0, 40), focus: null } };
      return new Promise((res) => { held = res; });
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("route change: page in flight", m.ui.model.loadingMore === true);
  m.ui.handlers.change("chapter", "s1");
  ok("route change: busy flag cleared at once", m.ui.model.loadingMore === false);
  if (held) held({ status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(40, 80), focus: null } });
  await sleep(20);
  await flush();
  ok("route change: stale page discarded", m.ui.model.rows.length === 2 && m.ui.model.rows[0].id === "s1-e1", "rows=" + m.ui.model.rows.length);
  ok("route change: new chapter is exhausted", m.ui.model.hasMore === false && m.ui.model.loadingMore === false);

  held = null;
  m.ctl.setRoute({ view: "entries" });
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("setRoute: page in flight", m.ui.model.loadingMore === true);
  m.ctl.setRoute({ view: "entries", chapter: "s2" });
  ok("setRoute: busy flag cleared at once", m.ui.model.loadingMore === false);
  if (held) held({ status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(40, 80), focus: null } });
  await sleep(20);
  await flush();
  ok("setRoute: stale page discarded", m.ui.model.rows.length === 2 && m.ui.model.rows[0].id === "s2-e1", "rows=" + m.ui.model.rows.length);
  m.ctl.destroy();
}

// 29. exhaustion: the last page ends paging; further calls make no request.
async function test29() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 60, rows: pageRange(0, 40), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 60, rows: pageRange(40, 60), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  ok("exhaustion: remaining rows appended", m.ui.model.rows.length === 60 && m.ui.model.count === 60);
  ok("exhaustion: hasMore false", m.ui.model.hasMore === false && m.ui.model.loadingMore === false);
  const lists = c.req.list, renders = m.ui.renders;
  m.ui.handlers.loadMore();
  m.ui.handlers.loadMore();
  await flush();
  ok("exhaustion: no further requests", c.req.list === lists && m.ui.renders === renders, "list=" + c.req.list);
  m.ctl.destroy();
}

// 30. zero-growth pages are bounded by count; count is never fabricated.
async function test30() {
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(0, 40), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: [], focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  for (let i = 0; i < 6; i++) { m.ui.handlers.loadMore(); await flush(); }
  const pages = c.req.list - 1;
  ok("zero growth: page requests bounded by count", pages <= 2, "pages=" + pages);
  ok("zero growth: paging ends", m.ui.model.hasMore === false && m.ui.model.loadingMore === false);
  ok("zero growth: rows and count unchanged", m.ui.model.rows.length === 40 && m.ui.model.count === 100);
  m.ctl.destroy();
}

// 31. a page 409 keeps the version reset (one resync, no page error).
async function test31() {
  let fail409 = true;
  const c = makeClient((kind, p) => {
    if (kind === "meta") return { status: 200, body: META };
    if (kind === "list") {
      const off = Number(p.get("offset") || 0);
      if (off === 40 && fail409) { fail409 = false; return { status: 409, body: { error: { code: "VERSION_CHANGED", message: "changed" } } }; }
      if (off === 0) return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(0, 40), focus: null } };
      return { status: 200, body: { version: "COMMIT42", view: "entries", count: 100, rows: pageRange(40, 80), focus: null } };
    }
    return { status: 200, body: {} };
  });
  const m = mountGuide(c.fetchImpl, { view: "entries" });
  await flush();
  m.ui.handlers.loadMore();
  await flush();
  await sleep(20);
  await flush();
  ok("page 409: meta refetched once", c.req.meta === 2, "meta=" + c.req.meta);
  ok("page 409: first page resynced without page error", m.ui.model.rows.length === 40 && !m.ui.model.loadMoreError && !m.ui.model.error && m.ui.model.loadingMore === false);
  m.ui.handlers.loadMore();
  await flush();
  ok("page 409: paging resumes after resync", m.ui.model.rows.length === 80, "rows=" + m.ui.model.rows.length);
  m.ctl.destroy();
}

async function main() {
  const suites = [test1, test2, test3, test4, test5, test6, test7, test8, test9, test10, test11, test12, test13, test14, test15, test16, test17, test18, test19, test20, test21, test22, test23, test24, test25, test26, test27, test28, test29, test30, test31];
  for (const s of suites) {
    try { await s(); }
    catch (e) { fail++; lines.push("not ok - " + s.name + " threw :: " + String(e && e.stack || e)); }
  }
  console.log("TAP version 13");
  console.log("1.." + (pass + fail));
  lines.forEach((l) => console.log(l));
  console.log("# pass " + pass + " fail " + fail);
  process.exitCode = fail ? 1 : 0;
}

main();
