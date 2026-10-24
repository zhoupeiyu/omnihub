import test from 'node:test';
import assert from 'node:assert/strict';
import {extractDocument, fetchMediaBytes, compileGuide} from '../lib/repository-guide-pipeline.js';
import {repositoryMediaCandidates, isAnimatedWebp} from '../lib/repository-guide-media.js';
import {validateRepositoryGuide, renderRepositoryGuide} from '../public/repository-guides.js';

const document = {repository:'owner/repo',revision:'a'.repeat(40),path:'docs/README.md',sourceUrl:`https://github.com/owner/repo/blob/${'a'.repeat(40)}/docs/README.md`};
const raw = `https://raw.githubusercontent.com/owner/repo/${document.revision}/`;

test('media discovery handles multiline HTML, references and root paths while pinning raw URLs', () => {
  const result = extractDocument({...document,text:`# Demo
<p><img
  src="/assets/demo.gif"
  alt="Animated demo"
>
![Architecture][plan]
![Screenshot](https://raw.githubusercontent.com/owner/repo/main/screen.png)
![Logo](logo.svg)
![installs](https://skills.sh/b/owner/repo)
[plan]: ../assets/architecture.png
`});
  assert.deepEqual(result.media.map(item=>item.url), [raw+'assets/demo.gif',raw+'assets/architecture.png',raw+'screen.png']);
  assert.equal(result.media[0].sourceUrl, document.sourceUrl+'#L2');
  assert.equal(result.media[0].alt, 'Animated demo');
});

test('independent media discovery deduplicates language variants and covers different sections', () => {
  const en = {...document,text:'# Screenshots\n![one](one.png)\n![two](two.png)\n## Workflow\n![diagram](flow.png)'};
  const zh = {...en,path:'docs/README.zh.md',text:en.text+'\n## 示例\n![例子](example.gif)'};
  assert.deepEqual(repositoryMediaCandidates([en,zh]).map(item=>item.url),[raw+'docs/one.png',raw+'docs/flow.png',raw+'docs/example.gif',raw+'docs/two.png']);
});

test('GitHub CDN paths stay pinned and SVG diagrams remain discoverable as source links', () => {
  const parsed=extractDocument({...document,text:'![Flow](https://cdn.jsdelivr.net/gh/owner/repo@main/docs/flow.png)\n![Architecture](architecture.svg)\n```html\n<img src="not-a-real-demo.png">\n```'});
  assert.deepEqual(parsed.media.map(item=>item.url),[raw+'docs/flow.png',raw+'docs/architecture.svg']);
});

test('a model omitting all images no longer removes real README media from a guide', () => {
  const record={key:'owner/repo',canonicalKey:'owner/repo',revision:document.revision,documents:[{...document,text:'# Demo\n官方用法\n![Flow](flow.png)\n![Demo](demo.gif)'}]};
  const guide=compileGuide(record,{key:record.key,status:'partial',summary:'工具介绍',intro:'阅读官方文档',steps:[],mediaIds:[]});
  assert.equal(guide.selectedMedia.length,2);
  assert.equal(guide.selectedMedia[1].url,raw+'docs/demo.gif');
});

test('animation metadata comes from WebP chunks, not a filename or text inside a still image', () => {
  const chunk = (name, body) => { const header=Buffer.alloc(8);header.write(name);header.writeUInt32LE(body.length,4);return Buffer.concat([header,body,...(body.length%2 ? [Buffer.alloc(1)] : [])]); };
  const webp = chunks => { const header=Buffer.from('RIFF0000WEBP');const body=Buffer.concat(chunks);header.writeUInt32LE(body.length+4,4);return Buffer.concat([header,body]); };
  assert.equal(isAnimatedWebp(webp([chunk('VP8 ',Buffer.from('ANIM'))])),false);
  assert.equal(isAnimatedWebp(webp([chunk('VP8X',Buffer.alloc(10)),chunk('ANIM',Buffer.alloc(6))])),true);
  assert.equal(isAnimatedWebp(Buffer.from('not an image')),false);
});

test('media byte budget survives redirects and never adds credentials', async () => {
  let requests=0;
  await assert.rejects(()=>fetchMediaBytes('https://raw.githubusercontent.com/owner/repo/main/demo.gif',{
    maximum:10,
    fetchImpl:async (_url,options)=>{assert.equal(options.headers,undefined);return ++requests===1 ? new Response('',{status:302,headers:{location:'https://github.com/user-attachments/assets/example'}}) : new Response('GIF89a1234567890');},
  }),/response_too_large/);
  assert.equal(requests,2);
});

test('validated guides keep animation and source links, including when every preview failed', () => {
  const value = {schemaVersion:1,key:'owner/repo',status:'partial',reason:'部分说明待补充',checkedAt:'2026-10-24',tested:false,sourceUrl:document.sourceUrl,summary:'工具说明',intro:'用法说明',media:[{url:'/assets/repository-guides/media-123456789012345678901234.webp',alt:'操作演示',sourceUrl:document.sourceUrl,animated:true}],mediaReferences:[{label:'更多说明图',url:document.sourceUrl},{label:'unsafe',url:'javascript:alert(1)'}]};
  const guide=validateRepositoryGuide(value,value.key);
  assert.equal(guide.media[0].animated,true);
  assert.equal(guide.mediaReferences.length,1);
  const html=renderRepositoryGuide(guide);
  assert.match(html,/guide-animation-badge/);
  assert.match(html,/更多原文素材/);
  assert.ok(html.indexOf('演示与说明')<html.indexOf('怎么用'));
  const unavailable=renderRepositoryGuide({...guide,media:[]});
  assert.match(unavailable,/查看原文演示与说明图/);
  assert.doesNotMatch(unavailable,/data-repo-media=/);
});
