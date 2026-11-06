import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const storage = new Map();
const context = vm.createContext({ localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
vm.runInContext(source('interface-polish.js'), context);
const { material, contrast, pointInTriangle, getTint, setTint } = context.OmniSurface;

test('glass chooses stable ink with a hysteresis band and dark mode always uses light ink', () => {
  const samples = Array.from({ length: 15 }, () => [128, 128, 128]);
  assert.equal(material(samples, false, 'light').ink, 'light');
  assert.equal(material(samples, false, 'dark').ink, 'dark');
  assert.equal(material([[255, 255, 255]], true, 'dark').ink, 'light');
});
test('busy backgrounds reach readable contrast at the default setting without fading the ink', () => {
  const samples = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 200], [10, 240, 10]];
  for (const dark of [false, true]) {
    const state = material(samples, dark, null), white = state.ink === 'light';
    for (const p of samples) {
      const background = p.map((v, i) => Math.min(255, v * (white ? .85 : 1.06)) * (1 - state.alpha) + state.tint[i] * state.alpha);
      const ink = background.map(v => white ? 255 * .94 + v * .06 : v * .14);
      assert.ok(contrast(background, ink) >= 4.5);
    }
  }
});
test('zero tint removes the brightness lift and theme values remain independent', () => {
  const state = material([[200, 120, 30]], false, 'dark', 0);
  assert.equal(state.alpha, 0); assert.equal(state.brightness, 1);
  setTint('light', .45); setTint('dark', 1.5);
  assert.equal(getTint().light, .45); assert.equal(getTint().dark, 1.5);
  assert.equal(setTint('other', 1), false); assert.equal(setTint('light', NaN), false);
  setTint('light', 5); assert.equal(getTint().light, 1.5);
});
test('menu safe triangle accepts diagonals in either opening direction and rejects degenerate triangles', () => {
  const a = { x: 0, y: 50 }, b = { x: 100, y: 0 }, c = { x: 100, y: 100 };
  assert.equal(pointInTriangle({ x: 70, y: 65 }, a, b, c), true);
  assert.equal(pointInTriangle({ x: 30, y: 90 }, a, b, c), false);
  assert.equal(pointInTriangle({ x: -70, y: 65 }, a, { x: -100, y: 0 }, { x: -100, y: 100 }), true);
  assert.equal(pointInTriangle({ x: 0, y: 0 }, a, a, c), false);
});
