import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = path.resolve('data/deployment/2026-09-28-repository-tab');
const read = file => readFileSync(file, 'utf8');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected production UI baseline');
  return source.replace(before, after);
}
let components = read(path.join(directory, 'baseline/components.jsx'));
components = replaceOnce(components, ', href: "/repositories.html"', '');
components = replaceOnce(components, 'm.href ? window.location.assign(m.href) : onSectionChange(m.id)', 'onSectionChange(m.id)');
writeFileSync(path.join(directory, 'payload/public/components.jsx'), components);
let app = read(path.join(directory, 'baseline/app.jsx'));
app = replaceOnce(app, 'const SEARCH_PLACEHOLDERS = {', 'const SEARCH_PLACEHOLDERS = {\n  repositories: "搜索仓库名称、用途或主题……",');
app = replaceOnce(app, 'useAppState(() => user && user.fullAccess ? "inbox" : "feed")', 'useWorkspaceSection(user && user.fullAccess ? "inbox" : "feed")');
app = replaceOnce(app, '!["feed", "inbox"].includes(section)', '!["repositories", "feed", "inbox"].includes(section)');
app = replaceOnce(app, '<main className="main">', '<main className="main">\n          {section === "repositories" && <RepositoryExplorerTab query={query} onQueryChange={setQuery} userKey={user?.id || "guest"} />}');
writeFileSync(path.join(directory, 'payload/public/app.jsx'), app);
let index = read(path.join(directory, 'baseline/index.html'));
index = replaceOnce(index, '<script type="text/babel" src="app.jsx"></script>', '<script src="repository-tab.js"></script>\n<script type="text/babel" src="app.jsx"></script>');
writeFileSync(path.join(directory, 'payload/public/index.html'), index);
const reused = ['app.jsx', 'components.jsx', 'index.html'];
const copied = ['repository-tab.js', 'repository-tab.html', 'repository-tab.css', 'repository-explorer-prototype.js', 'repository-explorer-prototype.html', 'repositories.html'];
for (const file of copied) copyFileSync(path.resolve('public', file), path.join(directory, 'payload/public', file));
const previous = JSON.parse(read(path.resolve('data/deployment/2026-09-28-repositories/deployed.json'))).files;
const files = [...reused, ...copied].map(file => ({ path: `public/${file}`, sha256: hash(path.join(directory, 'payload/public', file)), before: reused.includes(file) ? hash(path.join(directory, 'baseline', file)) : previous.find(item => item.path === `public/${file}`)?.sha256 ?? null }));
writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ files }, null, 2));
console.log(JSON.stringify({ files: files.length, databaseChanges: false }));
