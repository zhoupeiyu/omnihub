import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve('public/video-tools.jsx'), 'utf8');
const css = readFileSync(resolve('public/video-tools.css'), 'utf8');
const creatorWorkbench = readFileSync(resolve('public/creator-workbench.jsx'), 'utf8');
const mediaStudio = readFileSync(resolve('public/media.jsx'), 'utf8');
const shotcraft = JSON.parse(readFileSync(resolve('public/assets/creator-skills/shotcraft-cards.json'), 'utf8'));

test('camera prompt library stays original, searchable and reachable as an independent tool', () => {
  assert.match(source, /const CAMERA_MOVE_LIBRARY = Object\.freeze/);
  assert.doesNotMatch(source.slice(source.indexOf('const VIDEO_TOOL_TABS'), source.indexOf('const videoLegacyTab')), /id: "camera"/);
  assert.match(source, /function StandaloneVideoToolWorkspace/);
  assert.match(source, /route === "camera-recipes"/);
  assert.match(source, /href=\{`#camera-recipes\?space=\$\{space\}`\}/);
  assert.match(source, /搜索运镜、意图或英文术语/);
  assert.match(source, /复制提示词/);
  assert.match(source, /提示词为本站原创整理/);
  const cameraSource = source.slice(source.indexOf('const CAMERA_MOVE_LIBRARY'), source.indexOf('const SHOTCRAFT_METADATA_URL'));
  assert.equal((cameraSource.match(/\{ id: /g) || []).length, 46);
  assert.equal(new Set([...cameraSource.matchAll(/category: "([^"]+)"/g)].map(match => match[1])).size, 7);
  assert.match(css, /\.camera-move-grid/);
});

test('each camera move has a preview and every bundled preview asset exists', () => {
  const extract = pattern => {
    const match = source.match(pattern);
    assert.ok(match, `Missing preview definition: ${pattern}`);
    return runInNewContext(`(${match[1]})`);
  };
  const moves = extract(/const CAMERA_MOVE_LIBRARY = Object\.freeze\((\[[\s\S]*?\])\);/);
  const remote = extract(/const CAMERA_PREVIEWS = Object\.freeze\((\{[\s\S]*?\})\);/);
  const whitebox = extract(/const CAMERA_WHITEBOX_PREVIEWS = Object\.freeze\((\{[\s\S]*?\})\);/);
  const fallbacks = extract(/const CAMERA_WHITEBOX_FALLBACKS = Object\.freeze\((\{[\s\S]*?\})\);/);
  const external = extract(/const external = (\{[\s\S]*?\})\[item\.id\];/);
  for (const move of moves) {
    assert.ok(remote[move.id] || whitebox[move.id] || external[move.id] || move.id === 'rack-and-push', `Missing preview: ${move.id}`);
  }
  for (const [id, clip] of Object.entries(fallbacks)) {
    assert.ok(remote[id], `Fallback without remote primary: ${id}`);
    assert.ok(clip, `Missing fallback clip: ${id}`);
  }
  assert.match(source, /usingFallback \? CAMERA_WHITEBOX_FALLBACKS\[item\.id\] : clip/);
  assert.match(source, /!usingFallback && CAMERA_WHITEBOX_FALLBACKS\[item\.id\]/);
  for (const clip of [...Object.values(whitebox), ...Object.values(fallbacks), '34_rack_focus', '01_dolly_in']) {
    for (const extension of ['mp4', 'jpg']) {
      assert.ok(existsSync(resolve(`public/assets/camera-whitebox-preview/${clip}.${extension}`)), `Missing ${clip}.${extension}`);
    }
  }
  for (const preview of Object.values(external)) {
    for (const asset of [preview.video, preview.poster]) {
      if (asset.startsWith('/')) assert.ok(existsSync(resolve(`public${asset}`)), `Missing ${asset}`);
    }
  }
});

test('Shotcraft imports its actual licensed card metadata and transfers a selected card through the creator-workbench contract', () => {
  assert.equal(shotcraft.source.license, 'Apache-2.0');
  assert.equal(shotcraft.source.repository, 'https://github.com/Vincentwei1021/video-shotcraft');
  assert.equal(shotcraft.stats.cardCount, 124);
  assert.equal(shotcraft.stats.styleCount, 150);
  assert.equal(shotcraft.cards.length, 124);
  assert.ok(shotcraft.cards.every(card => card.name && card.category && card.summary && card.source));
  assert.match(source, /SHOTCRAFT_METADATA_URL/);
  assert.match(source, /setItem\("omnihub:creator-source"/);
  assert.match(source, /#studio\?space=mine&view=content/);
  assert.match(source, /window\.dispatchEvent\(new Event\("omnihub:creator-source"\)\)/);
  assert.match(source, /已导入 \$\{shotcraft\.data\.stats\.cardCount\} 张镜头卡/);
  assert.match(source, /镜头卡只用于策划与创作台材料，不会直接生成视频/);
  assert.match(source, /github\.com\/Vincentwei1021\/video-shotcraft/);
  assert.match(css, /\.shotcraft-recipe-grid/);
  assert.match(creatorWorkbench, /sessionStorage\.getItem\('omnihub:creator-source'\)/);
  assert.match(creatorWorkbench, /window\.addEventListener\('omnihub:creator-source',read\)/);
  assert.match(creatorWorkbench, /source\.title,source\.summary,'来源：'\+source\.origin,source\.url/);
  assert.match(mediaStudio, /window\.addEventListener\('omnihub:creator-source',\s*sync\)/);
  assert.match(mediaStudio, /const view = new URLSearchParams\(location\.hash\.split\('\?'\)\[1\]\)\.get\('view'\)/);
  assert.match(mediaStudio, /'content'[\s\S]*\.includes\(view\) \? view : 'input'/);
});

test('OmniGet is exposed as an independent tool and legacy media links still render it', () => {
  const tabSource = source.slice(source.indexOf('const VIDEO_TOOL_TABS'), source.indexOf('const videoLegacyTab'));
  assert.doesNotMatch(tabSource, /id: "omniget"/);
  assert.match(source, /route === "omniget"/);
  assert.match(source, /tab === "camera" \|\| tab === "omniget"/);
  assert.match(source, /href=\{`#omniget\?space=\$\{space\}`\}/);
  assert.match(source, /<OmnigetWorkspace active=\{active\} \/>/);
});
