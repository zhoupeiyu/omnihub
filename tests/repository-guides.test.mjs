import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {getRepositoryGuide, loadRepositoryGuide, renderRepositoryGuide, renderGuideInstallation, validateRepositoryGuide, renderRepositoryGuideMeta, renderRepositoryGuideSources} from '../public/repository-guides.js';

test('only verified repositories have a guide; original API records stay untouched', () => {
  assert.equal(getRepositoryGuide('unreviewed/repository'), null);
  assert.equal(getRepositoryGuide(undefined), null);
  const guide = getRepositoryGuide('HBAI-Ltd/Toonflow-app');
  assert.equal(guide, getRepositoryGuide('hbai-ltd/toonflow-app'));
  assert.equal(guide.tested, false);
  assert.match(guide.sourceUrl, /\/blob\/[a-f0-9]{40}\/README.md/);
  assert.match(guide.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('official screenshots are local assets with source attribution, not badges or placeholders', () => {
  const guide = getRepositoryGuide('hbai-ltd/toonflow-app');
  assert.equal(guide.media.length, 3);
  for (const media of guide.media) {
    assert.ok(media.url.startsWith('/assets/repository-guides/'));
    assert.ok(existsSync(new URL(`../public${media.url}`, import.meta.url)));
    assert.match(media.sourceUrl, /\/docs\/screenshots\//);
    assert.ok(media.alt.length > 4);
  }
  const html = renderRepositoryGuide(guide);
  assert.match(html, /data-repo-media="2"/);
  assert.match(html, /3 张 · 点击放大/);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /暂未收录演示|<iframe|autoplay/i);
  assert.ok(html.indexOf('演示与说明') < html.indexOf('怎么用'));
});

test('guides supply concrete instructions and distinguish examples from tested results', () => {
  const app = renderRepositoryGuide(getRepositoryGuide('hbai-ltd/toonflow-app'));
  assert.match(app, /添加私有提供商/);
  assert.match(app, /docker compose up -d --build/);
  assert.match(app, /没有独立登录鉴权/);
  assert.doesNotMatch(app, /未实测|核对于|guide-provenance|guide-references/);
  assert.match(renderRepositoryGuideSources(getRepositoryGuide('hbai-ltd/toonflow-app')), /未实测/);
  const guide = getRepositoryGuide('obra/superpowers');
  const skill = renderRepositoryGuide(guide);
  assert.doesNotMatch(skill, /演示与说明|data-repo-media/);
  assert.match(skill, /示例任务/);
  assert.match(skill, /根据官方流程整理/);
  assert.match(skill, /data-guide-platform/);
  assert.match(renderGuideInstallation(guide, 0), /superpowers@claude-plugins-official/);
  assert.match(renderGuideInstallation(guide, 1), /Coding/);
  assert.match(renderGuideInstallation(guide, 2), /add-plugin superpowers/);
  assert.equal(renderGuideInstallation(guide, 99), renderGuideInstallation(guide, 0));
});

test('guide text is escaped and unsafe links cannot become executable HTML', () => {
  const guide = {...getRepositoryGuide('obra/superpowers'), sourceUrl: 'javascript:alert(1)',
    intro:'<img src=x onerror=alert(1)>', example: {prompt:'</code><script>alert(1)</script>', result:'<b>unsafe</b>'}};
  const html = renderRepositoryGuide(guide);
  assert.doesNotMatch(html, /<script|<img src=x|javascript:/);
  assert.match(html, /&lt;script&gt;/);
});

test('generated guides are lazily cached, require the matching public key, and reject unsafe media or links', async () => {
  const key = 'sample.owner/repo_name';
  let requests = 0;
  const payload = {
    schemaVersion:1, key, status:'partial', reason:'官方文档只有安装说明，尚未找到可核对的完整示例。',
    checkedAt:'2026-10-01', tested:false, sourceUrl:'https://github.com/sample.owner/repo_name/blob/a'.padEnd(58, 'a'),
    summary:'一个已核对但仍待补齐的仓库。', intro:'先阅读安装说明，再决定是否在测试项目中使用。', requirements:'需要一个测试项目。',
    platforms:[], steps:[{title:'阅读说明',text:'先查看官方 README。',link:{label:'官方说明',url:'https://github.com/sample.owner/repo_name'}}],
    example:null, cautions:[], references:[], media:[],
  };
  const fetchImpl = async url => { requests += 1; assert.match(url, /sample\.owner~repo_name\.json$/); return {ok:true,json:async()=>payload}; };
  const [first, second] = await Promise.all([loadRepositoryGuide(key,{fetchImpl}), loadRepositoryGuide(key,{fetchImpl})]);
  assert.equal(first, second);
  assert.equal(requests, 1);
  assert.equal(getRepositoryGuide(key)?.status, 'partial');
  const html = renderRepositoryGuide(first);
  assert.match(html, /这份使用说明还不完整/);
  assert.doesNotMatch(html, /示例任务/);
  assert.equal(validateRepositoryGuide({...payload,key:'other/repo'}, key), null);
  assert.equal(validateRepositoryGuide({...payload,media:[{url:'https://example.com/unsafe.webp',alt:'外链',sourceUrl:'https://example.com'}]}, key)?.media.length, 0);
  assert.equal(validateRepositoryGuide({...payload,steps:[{title:'x',text:'y',link:{label:'坏链接',url:'javascript:alert(1)'}}]}, key)?.steps[0].link, undefined);
});

test('unavailable guides keep the original entry honest instead of inventing steps', () => {
  const guide = validateRepositoryGuide({
    schemaVersion:1,key:'no-docs/repository',status:'unavailable',reason:'仓库没有公开可读取的使用文档。',
    checkedAt:'2026-10-01',tested:false,sourceUrl:'https://github.com/no-docs/repository',summary:'',intro:'',requirements:'',platforms:[],steps:[],example:null,cautions:[],references:[],media:[],
  },'no-docs/repository');
  const html = renderRepositoryGuide(guide,{introFallback:'来自当前仓库记录的中文介绍。'});
  assert.match(html, /暂时无法核对使用方法/);
  assert.match(html, /仓库介绍/);
  assert.match(html, /暂时无法核对使用方法/);
  assert.match(renderRepositoryGuideSources(guide), /保留收藏介绍，官方用法暂不可用/);
  assert.doesNotMatch(html, /整理自官方文档/);
  assert.match(html, /来自当前仓库记录的中文介绍/);
  assert.doesNotMatch(html, /guide-example|示例任务/);
});

test('a public 404 is negatively cached but a network failure remains retryable', async () => {
  let missingRequests = 0;
  const missingFetch = async () => ({ok:false,status:(missingRequests += 1, 404)});
  await loadRepositoryGuide('missing/repository',{fetchImpl:missingFetch});
  await loadRepositoryGuide('missing/repository',{fetchImpl:missingFetch});
  assert.equal(missingRequests, 1);
  let retryRequests = 0;
  const offline = async () => { retryRequests += 1; throw new TypeError('offline'); };
  await loadRepositoryGuide('retry/repository',{fetchImpl:offline});
  await loadRepositoryGuide('retry/repository',{fetchImpl:offline});
  assert.equal(retryRequests, 2);
});

test('detail removes generic trial filler and keeps citations folded', () => {
  const source = readFileSync(new URL('../public/repository-explorer-prototype.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /暂未收录演示素材|<h3>可以怎么开始/);
  assert.match(source, /renderRepositoryGuide\(guide/);
  assert.match(source, /<details class="detail-sources"><summary>资料来源/);
  assert.doesNotMatch(source, /原始收藏与引用|没有可展示的来源/);
  assert.match(source, /onPreviewMedia\?\.\(null\)/);
});


test('guide date and document link belong in the header, with provenance available separately', () => {
  const guide = getRepositoryGuide('hbai-ltd/toonflow-app');
  const meta = renderRepositoryGuideMeta(guide);
  assert.match(meta, /<time datetime="2026-10-01">核对 2026-10-01<\/time>/);
  assert.match(meta, /官方文档/);
  assert.doesNotMatch(meta, /未实测|AI 整理/);
  const fallback = renderRepositoryGuideMeta(null, {readmeUrl:'https://github.com/owner/repo#readme'});
  assert.match(fallback, /github.com\/owner\/repo#readme/);
  assert.doesNotMatch(fallback, /<time/);
  assert.equal(renderRepositoryGuideMeta(null, {readmeUrl:'javascript:alert(1)'}), '');
  const sources = renderRepositoryGuideSources({...guide,references:[...guide.references,...guide.references]});
  assert.equal(sources.split(guide.references[0].label).length - 1, 1);
  for (const item of guide.media) assert.ok(sources.includes(item.sourceUrl));
  const body = renderRepositoryGuide(guide);
  assert.doesNotMatch(body, /guide-provenance|guide-references|官方文档与素材出处/);
});
