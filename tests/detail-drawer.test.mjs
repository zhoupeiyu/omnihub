import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
function fixture(shadow = false, autoFocus = false) {
  const handlers = new Map();
  const document = { overlay: null, activeElement: null,
    addEventListener(name, fn) { handlers.set(name, fn); },
    removeEventListener(name) { handlers.delete(name); },
    querySelector() { return this.overlay; },
  };
  class Element {
    constructor(parent = null, tag = 'DIV') {
      this.parentNode = parent; this.parentElement = parent instanceof Element ? parent : null;
      this.children = []; this.dataset = {}; this.tagName = tag;
      this.inert = false; this.isConnected = true; this.tabIndex = 0;
      parent?.children.push(this);
    }
    querySelectorAll() { return this.children; }
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    closest() { return this.inert ? this : this.parentElement?.closest(); }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { document.activeElement = this; }
  }
  document.body = new Element();
  const root = new Element(document.body);
  const trigger = new Element(root, 'BUTTON');
  trigger.focus();
  let contentRoot = document.body;
  if (shadow) {
    const host = new Element(root);
    contentRoot = { host, children: [] };
    host.shadowRoot = contentRoot;
  }
  const background = new Element(contentRoot);
  const layer = new Element(contentRoot);
  const backdrop = new Element(layer);
  const panel = new Element(layer, 'ASIDE');
  const first = new Element(panel, 'BUTTON'), last = new Element(panel, 'A');
  if (autoFocus) first.focus();
  let closed = 0;
  const window = {};
  vm.runInNewContext(read('detail-drawer.js'), { window, document, Element });
  const release = window.OmniDetailDrawer.mount(panel, () => closed++, { returnFocus: trigger });
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    handlers.get('keydown')?.(event);
    return event;
  }
  return { document, background, root, trigger, layer, backdrop, panel, first, last, release, handlers, key, closed: () => closed };
}

for (const shadow of [false, true]) {
  test(`drawer isolates background and restores focus/lock (${shadow ? 'shadow' : 'portal'})`, () => {
    const f = fixture(shadow);
    assert.equal(f.background.inert, true);
    assert.equal(f.panel.inert, false);
    assert.equal(f.backdrop.inert, false);
    assert.equal(f.document.activeElement, f.panel);
    assert.equal(f.document.body.dataset.detailDrawerOpen, 'true');
    assert.equal(f.key('Escape').prevented, true);
    assert.equal(f.closed(), 1);
    f.release(); f.release();
    assert.equal(f.background.inert, false);
    assert.equal(f.document.body.dataset.detailDrawerOpen, undefined);
    assert.equal(f.document.activeElement, f.trigger);
    assert.equal(f.handlers.size, 0);
  });
}

test('Tab wraps within the drawer and skips hidden or disabled controls', () => {
  const f = fixture();
  f.last.focus();
  assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, f.first);
  f.key('Tab', true);
  assert.equal(f.document.activeElement, f.last);
  f.last.hidden = true;
  f.first.focus(); f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  f.first.disabled = true;
  f.key('Tab');
  assert.equal(f.document.activeElement, f.panel);
  f.release();
});

test('a child autoFocus is preserved and cleanup still returns to the opener', () => {
  const f = fixture(false, true);
  assert.equal(f.document.activeElement, f.first);
  f.release();
  assert.equal(f.document.activeElement, f.trigger);
});

test('image previews and native dialogs own Escape and focus until dismissed', () => {
  const f = fixture(true);
  f.document.overlay = {};
  assert.equal(f.key('Escape').prevented, false);
  assert.equal(f.closed(), 0);
  f.trigger.focus();
  f.handlers.get('focusin')({ composedPath: () => [f.trigger] });
  assert.equal(f.document.activeElement, f.trigger);
  f.document.overlay = null;
  f.handlers.get('focusin')({ composedPath: () => [f.trigger] });
  assert.equal(f.document.activeElement, f.panel);
  f.key('Escape');
  assert.equal(f.closed(), 1);
  f.release();
});

test('all detail drawers share the same shell instead of defining competing geometry', () => {
  for (const name of ['refinery.jsx', 'inbox.jsx', 'prompts.jsx', 'media.jsx', 'app.jsx']) assert.match(read(name), /<DetailDrawer/);
  assert.match(read('repository-tab.html'), /class="repository-detail detail-drawer"/);
  assert.match(read('repository-explorer-prototype.js'), /window.OmniDetailDrawer.mount\(dialog, closeDetail\)/);
  assert.match(read('detail-drawer.jsx'), /aria-modal="true"/);
  assert.match(read('detail-drawer.jsx'), /detail-drawer-backdrop.*onClick=\{onClose\}/);
  assert.match(read('detail-drawer.css'), /width:min\(680px,100vw\)/);
  assert.match(read('detail-drawer.css'), /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(read('prompt-library.css'), /\.prompt-refinery-detail \{[^}]*position/);
  assert.doesNotMatch(read('repository-tab.css'), /\.repository-detail \{[^}]*position/);
  assert.match(read('repository-explorer-prototype.js'), /detailLayer.hidden = true; releaseDetailShell\(\)/);
});
