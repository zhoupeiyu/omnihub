import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../public/media.jsx', import.meta.url),'utf8');
const css = readFileSync(new URL('../public/media-studio.css', import.meta.url),'utf8');

test('studio gives the prompt the first editing position and keeps metadata progressive', () => {
  assert.ok(source.indexOf('media-prompt-field') < source.indexOf('media-tool-row'));
  assert.ok(source.indexOf('media-tool-row') < source.indexOf('media-advanced'));
  assert.match(source, /<details className="media-title-field">/);
  assert.match(source, /<details className="media-reference-panel" defaultOpen=\{referenceIds\.length > 0\}>/);
  assert.match(css, /\.media-prompt-field textarea \{ min-height:190px/);
  assert.match(css, /@media \(max-width:600px\)/);
});

test('unconfigured service permits a draft but does not present a fake paid generation action', () => {
  assert.match(source, /const mediaConfigured = Boolean\(config\?\.hasAuthentication && config\?\.baseUrl\)/);
  assert.match(source, /还没有可用的媒体服务/);
  assert.match(source, /第三方 API 服务与 ChatGPT 授权额度互不相通/);
  assert.match(source, /<button className="btn" onClick=\{onOpenSettings\}>去配置<\/button>/);
  const unconfigured = source.slice(source.indexOf('!mediaConfigured ?'), source.indexOf(': <React.Fragment>', source.indexOf('!mediaConfigured ?')));
  assert.doesNotMatch(unconfigured, /btn-primary|生成图片|生成视频/);
});

test('image-only GPT controls cannot fall through to video duration or resolution', () => {
  assert.match(source, /module === "image" \? \(model !== "gpt-image-2"/);
  assert.doesNotMatch(source, /module === "image" && model !== "gpt-image-2" \?/);
  const modes = source.slice(source.indexOf('const MEDIA_MODES'));
  const happyHorse = modes.slice(modes.indexOf('hh1:'), modes.indexOf('wan3:'));
  assert.match(happyHorse, /\{ id: "text", label: "文生视频" \}/);
  assert.doesNotMatch(happyHorse, /first_last_frame|video_edit|reference"/);
});

test('job visibility, progress, and recoverable request errors are explicit', () => {
  assert.match(source, /recentJobs\.length > 0 && <aside className="media-job-list">/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /function formatMediaNextPollAt/);
  assert.match(source, /MEDIA_ACTIVE_STATUSES\.has\(job\.status\) && formatMediaNextPollAt\(job\.nextPollAt\)/);
  assert.match(source, /numeric < 10_000_000_000 \? numeric \* 1000/);
  assert.match(source, /请稍后重新查询/);
  assert.match(source, /可再次提交；系统会使用同一个请求标识/);
  assert.match(css, /\.media-studio-layout\.has-jobs/);
  assert.match(css, /\.media-studio \.media-compose \{ display:block/);
  assert.match(css, /\.media-studio-layout:not\(\.has-jobs\) \.media-compose \{ max-width:960px/);
});
