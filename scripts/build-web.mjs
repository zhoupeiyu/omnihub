import { build, transform } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(root, process.argv[2] || 'dist');
if (out === root || out === path.join(root,'public')) throw new Error('Build output must not overwrite source files');
const read = name => readFileSync(path.join(root, 'public', name), 'utf8');
const template = read('index.html');
const scriptNames = [...template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]
  .map(match => match[1]).filter(name => !name.startsWith('https:') && !name.startsWith('vendor/'));
const baseToken = '/__OMNIHUB_BUILD__';
const repositoryFiles = ['repository-explorer-prototype.js', 'repository-tab.html', 'repository-explorer-prototype.css', 'repository-tab.css', 'repository-taxonomy.js', 'detail-drawer.css'];
const inputs = await Promise.all(scriptNames.map(async name => {
  let source = read(name);
  if (name === 'repository-tab.js') for (const file of repositoryFiles) source = source.replaceAll(`/${file}`, `${baseToken}/${file}`);
  // The existing Babel scripts share globals and allow repeated var declarations.
  const result = await build({stdin:{contents:source,loader:'jsx',sourcefile:name,resolveDir:root},
    bundle:true,write:false,format:'esm',treeShaking:false,target:'es2020',external:[`${baseToken}/*`]});
  return result.outputFiles[0].text;
}));
// Keep the existing shared-script scope; compile it once instead of in each browser.
const source = `import React from 'react'; import * as ReactDOM from 'react-dom';\n${inputs.join('\n;\n')}`;
const app = await build({ stdin: { contents:source, loader:'jsx', resolveDir:root, sourcefile:'workspace.jsx' },
  bundle:true, write:false, outfile:'app.js', format:'iife', platform:'browser', target:'es2020',
  minify:true, define:{'process.env.NODE_ENV':'"production"'}, external:[`${baseToken}/*`], legalComments:'eof' });
const files = new Map([['app.js', app.outputFiles[0].text]]);
files.set('tool-covers/media-tools-v1.png', readFileSync(path.join(root, 'public/assets/tool-covers/media-tools-v1.png')));
const mediaRuntime = await build({stdin:{contents:"import { Input, BlobSource, ALL_FORMATS, CanvasSink, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, Conversion, Quality } from 'mediabunny'; window.Mediabunny = { Input, BlobSource, ALL_FORMATS, CanvasSink, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, Conversion, Quality };",resolveDir:root,sourcefile:'media-runtime.js'},
  bundle:true,write:false,format:'iife',platform:'browser',target:'es2020',minify:true,legalComments:'eof'});
files.set('media-runtime.js',mediaRuntime.outputFiles[0].text);
for (const name of ['repository-explorer-prototype.js', 'repository-taxonomy.js']) {
  const result = await build({entryPoints:[path.join(root,'public',name)],bundle:true,write:false,format:'esm',
    platform:'browser',target:'es2020',minify:true,legalComments:'eof'});
  files.set(name,result.outputFiles[0].text.replaceAll('/assets/repository-guides/',`${baseToken}/repository-media/`));
}
// Include official screenshots in the content hash and release manifest, not only
// the unversioned assets copy. Browsing the guide never needs a GitHub image host.
const guideAssets = path.join(root,'public/assets/repository-guides');
const legacyGuideAssets = new Set(['NOTICE.txt','toonflow-canvas.webp','toonflow-assets.webp','toonflow-setup.webp']);
const guideInventoryPath = path.join(root,'content/repository-guide-inventory.json');
const eligibleGuideKeys = new Set(existsSync(guideInventoryPath) ? JSON.parse(readFileSync(guideInventoryPath,'utf8')).keys : []);
for (const name of readdirSync(guideAssets).sort()) {
  const isLegacyAsset = legacyGuideAssets.has(name);
  const isGeneratedMedia = /^media-[a-f0-9]{12,64}\.webp$/.test(name);
  const isGeneratedGuide = /^[a-z0-9_.-]+~[a-z0-9_.-]+\.json$/.test(name);
  if (!isLegacyAsset && !isGeneratedMedia && !isGeneratedGuide) throw new Error(`Unexpected repository guide asset: ${name}`);
  let content = readFileSync(path.join(guideAssets,name));
  // Generated guide JSON contains local media paths. Version them together
  // with the guide itself so a deployed page cannot mix a new guide with an
  // old image after the immutable build switches over.
  if (isGeneratedGuide) {
    const guide = JSON.parse(content.toString('utf8'));
    if (!eligibleGuideKeys.has(guide.key) || guide.key.replace('/','~')+'.json' !== name) throw new Error(`Repository guide outside public inventory: ${name}`);
    content = content.toString('utf8').replaceAll('/assets/repository-guides/',`${baseToken}/repository-media/`);
  }
  files.set(`repository-media/${name}`,content);
}
for (const name of ['repository-tab.html','repository-explorer-prototype.css','repository-tab.css','detail-drawer.css','vendor/marked.min.js','vendor/purify.min.js']) files.set(name,read(name));
const inlineStyles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match=>match[1]);
const styleFiles = [...template.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match=>match[1].replace(/^\//,''));
files.set('app.css',(await transform([...inlineStyles,...styleFiles.map(read)].join('\n').replaceAll('/assets/tool-covers/', `${baseToken}/tool-covers/`),{loader:'css',minify:true,target:'es2020'})).code);
const digest = createHash('sha256');
for (const [name, content] of files) digest.update(name).update('\0').update(content).update('\0');
const version = digest.digest('hex').slice(0,16);
const relative = `assets/build-${version}`;
const base = `/${relative}`;
mkdirSync(out,{recursive:true});
for (const [name, raw] of files) {
  const file = path.join(out,relative,name);
  const content = typeof raw === 'string' ? raw.replaceAll(baseToken,base) : raw;
  mkdirSync(path.dirname(file),{recursive:true});
  if (existsSync(file) && !readFileSync(file).equals(Buffer.from(content))) throw new Error('Immutable build collision');
  writeFileSync(file,content);
}
let html = template.replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g,'')
  .replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g,'');
html = html.replace('</head>',`<link rel="stylesheet" href="${base}/app.css">\n</head>`)
  .replace('</body>',`<script defer src="${base}/vendor/marked.min.js"></script>\n<script defer src="${base}/vendor/purify.min.js"></script>\n<script defer src="${base}/media-runtime.js"></script>\n<script defer src="${base}/app.js"></script>\n</body>`);
writeFileSync(path.join(out,'index.html'),html);
cpSync(path.join(root,'public/assets'),path.join(out,'assets'),{recursive:true});
if (existsSync(path.join(root,'public/life-guide'))) cpSync(path.join(root,'public/life-guide'),path.join(out,'life-guide'),{recursive:true});
for (const name of ['repositories.html','repository-explorer-prototype.html']) cpSync(path.join(root,'public',name),path.join(out,name));
const artifacts = ['index.html','repositories.html','repository-explorer-prototype.html',...files.keys()].map(name=>{
  const relativePath = files.has(name) ? `${relative}/${name}` : name;
  const content = readFileSync(path.join(out,relativePath));
  return {path:relativePath,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};
});
writeFileSync(path.join(out,'build-manifest.json'),JSON.stringify({version,artifacts},null,2));
console.log(JSON.stringify({out,version,appBytes:Buffer.byteLength(files.get('app.js')),htmlBytes:Buffer.byteLength(html),runtimeCompiler:false,thirdPartyBootScripts:false}));
