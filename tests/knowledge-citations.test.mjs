import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/refinery.jsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function knowledgeSourceUrl'), source.indexOf('function knowledgeMethodTools'));
let sanitized = '';
const context = vm.createContext({URL,DOMPurify:{sanitize(html) { sanitized = html; return html; }}});
vm.runInContext(readFileSync(new URL('../public/vendor/marked.min.js', import.meta.url), 'utf8'), context);
vm.runInContext(helpers, context);
const sources = [{id:42, externalId:'2020788951678607813', citationKey:'S:2020788951678607813',
  title:'Seedance 分镜与运镜示例', author:'@author', excerpt:'原帖中的完整提示词',
  url:'https://x.com/author/status/2020788951678607813'}];
const marker = '[S:2020788951678607813]';
const render = (body, entries = sources) => context.markdownWithCitationLinks(body, entries);

test('repeated references open the archived original in the same workspace', () => {
  const html = render(`第一段${marker}\n\n第二段${marker}`);
  assert.equal((html.match(/class="knowledge-citation"/g) || []).length, 2);
  assert.equal((html.match(/href="#inbox\?source=42"/g) || []).length, 2);
  assert.match(html, /引用原文：Seedance 分镜与运镜示例/);
  assert.doesNotMatch(html, /target=|href="https:/);
  assert.match(html, /原文摘录：原帖中的完整提示词/);
  assert.doesNotMatch(html, /S:2020788951678607813|#source-/);
  assert.equal(html, sanitized);
});

test('missing or malformed archive IDs never fall back to an external link', () => {
  for (const id of ['', undefined, 0, -1, '42&other=1', 'javascript:alert(1)']) {
    const html = render(marker, [{...sources[0], id}]);
    assert.match(html, /来源待补全/);
    assert.doesNotMatch(html, /<a\b|S:2020788951678607813/);
  }
  assert.match(context.markdownWithCitationLinks(marker), /来源待补全/);
  assert.match(render('[S:missing]'), /来源待补全/);
});

test('anonymous citation links show the source title and point to public X without exposing an archive excerpt', () => {
  const html = render(marker, [{...sources[0],private:true,title:'公开收藏标题',excerpt:''}]);
  assert.match(html,/href="https:\/\/x.com\/author\/status\/2020788951678607813"/);
  assert.match(html,/在 X 查看公开原帖/);
  assert.match(html,/引用原文：公开收藏标题/);
  assert.doesNotMatch(html,/#inbox|原文摘录/);
});

test('titles and excerpts are escaped and external source URLs are not used as the destination', () => {
  const html = render(marker, [{...sources[0], title:'<b>" & test', author:'<author>',
    excerpt:'"><img src=x onerror="bad">', url:'https://example.com/?a=1&b=2'}]);
  assert.match(html, /href="#inbox\?source=42"/);
  assert.doesNotMatch(html, /example.com/);
  assert.match(html, /引用原文：&lt;b&gt;&quot; &amp; test/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<b>/);
});

test('long Unicode titles render in full as the visible citation label', () => {
  const title = '😱'.repeat(28);
  const html = render(marker, [{...sources[0], title}]);
  assert.ok(html.includes(`引用原文：${title}<span`));
  assert.doesNotMatch(html, /…/);
  assert.ok(html.includes(`aria-label="查看站内原文：${title}"`));
  assert.doesNotMatch(source, /characters\.length > 26|slice\(0, 26\)/);
  assert.match(render(marker, [{...sources[0], title:''}]), /引用原文：@author 的原帖/);
});

test('inline and fenced code plus existing links preserve their literal reference examples', () => {
  const body = `\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\`\n\n[${marker}](https://example.com)\n\n${marker}`;
  const html = render(body);
  assert.match(html, /<code>\[S:2020788951678607813\]<\/code>/);
  assert.match(html, /<code class="language-text">\[S:2020788951678607813\]/);
  assert.match(html, /<a href="https:\/\/example.com">\[S:2020788951678607813\]<\/a>/);
  assert.equal((html.match(/class="knowledge-citation"/g) || []).length, 1);
});

test('citations in emphasis, lists and tables use the same readable links', () => {
  const html = render(`**${marker}**\n\n- item ${marker}\n\n| Source |\n| --- |\n| ${marker} |`);
  assert.equal((html.match(/class="knowledge-citation"/g) || []).length, 3);
  assert.doesNotMatch(html, /\[S:/);
  assert.match(html, /<strong><a class="knowledge-citation"/);
  assert.match(html, /<table>/);
});

test('article body citations are the only source entry point without a duplicate evidence rail', () => {
  const view = source.slice(source.indexOf('function KnowledgeLibraryView'), source.indexOf('function PromptExampleImage'));
  assert.match(view, /markdownWithCitationLinks\(detail.body, detail.sources\)/);
  assert.doesNotMatch(view, /evidenceOpen|setEvidenceOpen|setTab/);
  assert.doesNotMatch(view, /knowledge-evidence|knowledge-source-list|knowledge-claim-list|knowledge-related-repos/);
  assert.doesNotMatch(view, /event\.key === 'Escape'|source.citationKey|#source-|scrollIntoView/);
});
