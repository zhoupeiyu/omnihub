import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tools = readFileSync(new URL('../public/video-tools.jsx', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../public/repository-tab.js', import.meta.url), 'utf8');

test('camera recipes and OmniGet use independent tool routes', () => {
  const tabBlock = tools.slice(tools.indexOf('const VIDEO_TOOL_TABS'), tools.indexOf('const videoLegacyTab'));
  assert.doesNotMatch(tabBlock, /id: "camera"/);
  assert.doesNotMatch(tabBlock, /id: "omniget"/);
  assert.match(tools, /href=\{`#camera-recipes\?space=\$\{space\}`\}/);
  assert.match(tools, /href=\{`#omniget\?space=\$\{space\}`\}/);
  assert.match(routes, /'camera-recipes', 'omniget'/);
});

test('old media-tool bookmarks still resolve to the matching independent workspace', () => {
  assert.match(tools, /route === "media-tools" \|\| route === "video-tools"/);
  assert.match(tools, /if \(tab === "camera" \|\| tab === "omniget"\) return tab/);
  assert.match(tools, /<StandaloneVideoToolWorkspace kind=\{standaloneTool\}/);
});
