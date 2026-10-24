import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root = process.env.OMNIHUB_WEB_BUILD_DIR ? new URL(`file://${path.resolve(process.env.OMNIHUB_WEB_BUILD_DIR)}/`) : new URL('../dist/',import.meta.url);
test('production entry uses verified same-origin versioned assets without runtime compilation',()=>{
  const manifest = JSON.parse(readFileSync(new URL('build-manifest.json',root)));
  assert.match(manifest.version,/^[a-f0-9]{16}$/);
  const html=readFileSync(new URL('index.html',root),'utf8');
  assert.doesNotMatch(html,/text\/babel|babel\.min|unpkg\.com|development\.js|\.jsx/);
  for (const file of manifest.artifacts) {
    const content=readFileSync(new URL(file.path,root));
    assert.equal(createHash('sha256').update(content).digest('hex'),file.sha256);
    assert.equal(content.length,file.bytes);
  }
  for (const [,url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(url.startsWith('/assets/'));
    assert.ok(existsSync(new URL(url.slice(1),root)));
  }
  const app=readFileSync(new URL(`assets/build-${manifest.version}/app.js`,root),'utf8');
  assert.doesNotMatch(app,/__OMNIHUB_BUILD__|Download the React DevTools/);
  for (const name of ['repository-explorer-prototype.js','repository-taxonomy.js','repository-tab.html','repository-tab.css','detail-drawer.css']) {
    assert.ok(app.includes(`/assets/build-${manifest.version}/${name}`));
  }
});

test('repository screenshots and attribution ship as same-origin immutable build assets', () => {
  const manifest = JSON.parse(readFileSync(new URL('build-manifest.json',root)));
  const prefix = `assets/build-${manifest.version}/`;
  const renderer = readFileSync(new URL(`${prefix}repository-explorer-prototype.js`,root),'utf8');
  for (const name of ['toonflow-canvas.webp','toonflow-assets.webp','toonflow-setup.webp','NOTICE.txt']) {
    const file = `${prefix}repository-media/${name}`;
    assert.ok(manifest.artifacts.some(artifact => artifact.path === file));
    assert.ok(existsSync(new URL(file,root)));
    if (name.endsWith('.webp')) assert.ok(renderer.includes(`/${file}`));
  }
  assert.doesNotMatch(renderer, /__OMNIHUB_BUILD__|raw\.githubusercontent\.com/);
});

test('guide build policy only admits named legacy assets or generated public guide JSON and hashed WebP', () => {
  const script = readFileSync(new URL('../scripts/build-web.mjs', import.meta.url),'utf8');
  assert.match(script, /legacyGuideAssets/);
  assert.match(script, /\^media-\[a-f0-9\]\{12,64\}\\\.webp\$/);
  assert.match(script, /\^\[a-z0-9_\.\-\]\+~\[a-z0-9_\.\-\]\+\\\.json\$/);
  assert.match(script, /replaceAll\('\/assets\/repository-guides\/'/);
});

test('build rejects a syntactically valid guide absent from the public inventory',()=>{
  const key=`qa-${process.pid}/not-eligible`;
  const file=new URL(`../public/assets/repository-guides/${key.replace('/','~')}.json`,import.meta.url);
  assert.equal(existsSync(file),false);
  const output=mkdtempSync(path.join(tmpdir(),'omnihub-build-guard-'));
  try {
    writeFileSync(file,JSON.stringify({schemaVersion:1,key,status:'unavailable'}));
    const result=spawnSync(process.execPath,[new URL('../scripts/build-web.mjs',import.meta.url).pathname,output],{encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Repository guide outside public inventory/);
  } finally {rmSync(file,{force:true});rmSync(output,{recursive:true,force:true});}
});
