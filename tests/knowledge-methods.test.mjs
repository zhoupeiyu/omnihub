import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {decisions} from '../content/library-curation-20260928.mjs';

const source = readFileSync(new URL('../public/refinery.jsx',import.meta.url),'utf8');
const appSource = readFileSync(new URL('../public/app.jsx',import.meta.url),'utf8');
const htmlSource = readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const classificationCss = readFileSync(new URL('../public/classification-editor.css',import.meta.url),'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function knowledgeMethodTools'),source.indexOf('function KnowledgeLibraryView')),context);

test('tool filters include methods combining several tools',()=>{
  assert.equal(JSON.stringify(context.knowledgeMethodTools({type:'method',tags:['Claude Code + Codex','长任务协作']})),JSON.stringify(['Claude Code','Codex']));
  assert.equal(JSON.stringify(context.knowledgeMethodTools({type:'method',tags:['Codex + Canva']})),JSON.stringify(['Codex','Canva']));
  assert.equal(context.knowledgeMethodTools({type:'method'}).length,0);
  assert.equal(context.knowledgeMethodTools({type:'article',tags:['Codex']}).length,0);
});

test('curated methods identify their object and purpose and retain full prose',()=>{
  const methods = decisions.filter(item=>item.type==='method');
  assert.equal(methods.length,24);
  for (const item of methods) {
    assert.ok(item.tags.length>=2,`${item.externalId}: tool and purpose`);
    assert.ok(item.title.length>=14,`${item.externalId}: specific title`);
    assert.ok(item.summary.length>=35,`${item.externalId}: concrete summary`);
    assert.ok(item.body.includes('\n1. '),`${item.externalId}: actionable steps`);
    assert.ok(item.body.length>200,`${item.externalId}: not title-only`);
  }
});

test('method detail includes original instruction text without routing away for citations',()=>{
  const view=source.slice(source.indexOf('function KnowledgeLibraryView'),source.indexOf('function PromptExampleImage'));
  assert.match(view,/适用对象/);
  assert.match(view,/具体用途/);
  assert.match(view,/<pre>\{detail.promptText\}<\/pre>/);
  assert.match(view,/markdownWithCitationLinks\(detail.body, detail.sources\)/);
  assert.doesNotMatch(view,/scrollIntoView/);
});

test('knowledge detail uses one aligned two-column workspace without a duplicate evidence rail',()=>{
  const view=source.slice(source.indexOf('function KnowledgeLibraryView'),source.indexOf('function PromptExampleImage'));
  assert.match(view,/knowledge-workspace-bar/);
  assert.match(view,/scopeSwitch/);
  assert.doesNotMatch(view,/knowledge-evidence|evidenceOpen|setEvidenceOpen|setTab/);
  assert.match(view,/aria-current=/);
  assert.match(appSource,/scopeSwitch=\{user \? <CatalogueSpaceSwitch user=\{user\} \/> : null\}/);
  assert.match(appSource,/\["repositories", "promptLibrary"\]\.includes\(section\)/);
  assert.match(htmlSource,/grid-template-columns: minmax\(280px, 310px\) minmax\(0, 1fr\);/);
  assert.match(htmlSource,/grid-template-rows: 58px minmax\(0, 1fr\)/);
  assert.match(htmlSource,/\.knowledge-index-head \{[^}]*padding: 16px /);
  assert.match(htmlSource,/\.knowledge-reader \{[^}]*padding: 16px /);
  assert.match(htmlSource,/\.knowledge-reader-head \{[^}]*max-width: 800px;[^}]*margin: 0 auto/);
  assert.match(htmlSource,/\.knowledge-article \{[^}]*max-width: 800px;[^}]*margin: 0 auto;[^}]*padding-top: 16px/);
  assert.match(classificationCss,/\.knowledge-method-context\{[^}]*max-width:800px;[^}]*margin:18px auto 0/);
  assert.match(classificationCss,/\.knowledge-method-prompt\{[^}]*max-width:800px;[^}]*margin:0 auto 40px/);
  assert.doesNotMatch(classificationCss,/knowledge-method-(?:context|prompt)[^}]*38px/);
  assert.doesNotMatch(htmlSource,/\.knowledge-evidence(?:\b|[-])/);
});
