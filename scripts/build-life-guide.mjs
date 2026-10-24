#!/usr/bin/env node
// Assembles corpus.json from a read-only HowToLiveBetter source snapshot.
// Builtins only (fs/path/crypto): no network, no source execution, no content rewriting.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GRADES = new Set(['A', 'B', 'C']);
const sha = (data) => createHash('sha256').update(data).digest('hex');

// Value of a `- <label>：...` bullet, trimmed; null when the line is absent.
const line = (chunk, label) => {
  const m = new RegExp(`^-\\s*${label}：\\s*(.*)$`, 'm').exec(chunk);
  return m ? m[1].trim() : null;
};

// Leading grade letter of a `证据等级` bullet. Corpus values carry annotations, e.g.
// `C（争议）` or `B (含推测)`; the letter counts only when what follows it is the end of
// the value, whitespace, or an ASCII/fullwidth opening paren. Anything else is not a grade.
const gradeLetter = (raw) => {
  const m = raw === null ? null : /^([ABC])(?=$|\s|[（(])/.exec(raw);
  return m ? m[1] : null;
};

// `<!-- 成本标签: 钱=0 时间=少 毅力=否 收益=中 口径=时间 -->` -> plain object.
const costTags = (chunk) => {
  const raw = /<!--\s*成本标签:\s*([\s\S]*?)\s*-->/.exec(chunk)?.[1];
  return Object.fromEntries(
    (raw ?? '')
      .split(/\s+/)
      .filter((kv) => kv.includes('='))
      .map((kv) => kv.split('=')),
  );
};

export function parseChapter(markdown, file) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error(`empty source: ${file}`);
  const head = /^#\s+(\d+)\.\s+(.+?)\s*$/m.exec(markdown);
  if (!head) throw new Error(`missing chapter heading "# N. title": ${file}`);
  const number = Number(head[1]);
  const id = `s${number}`;
  const marks = [...markdown.matchAll(/^### (\d+)\. (.+?)\s*$/gm)];
  const intro = marks.length ? markdown.slice(0, marks[0].index) : markdown;
  const entries = marks.map((m, i) => {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    const chunk = markdown.slice(start, end); // original chunk, unchanged
    const entryNumber = Number(m[1]);
    const rawGrade = line(chunk, '证据等级');
    const grade = gradeLetter(rawGrade);
    if (!grade || !GRADES.has(grade)) {
      throw new Error(`${file}: entry ${entryNumber} has invalid or missing 证据等级 (got ${rawGrade})`);
    }
    const tags = costTags(chunk);
    return {
      id: `${id}-e${entryNumber}`,
      number: entryNumber,
      title: m[2],
      sectionId: id,
      file,
      markdown: chunk,
      human: line(chunk, '说人话'),
      cost: line(chunk, '成本'),
      grade,
      money: tags['钱'] ?? null,
      time: tags['时间'] ?? null,
      will: tags['毅力'] ?? null,
    };
  });
  return { id, number, title: head[2], file, markdown, intro, entries };
}

export async function buildGuide(sourceDir, outDir) {
  const root = path.resolve(sourceDir);
  if (!existsSync(root)) throw new Error(`source directory missing: ${root}`);

  const safe = async (abs) => {
    const target = path.resolve(abs);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path traversal rejected: ${abs}`);
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) throw new Error(`symlink rejected: ${abs}`);
    return st;
  };
  const walk = async (abs) => {
    if (!existsSync(abs)) return [];
    const st = await safe(abs);
    if (!st.isDirectory()) throw new Error(`expected directory: ${abs}`);
    const out = [];
    for (const name of (await fs.readdir(abs)).sort()) out.push(...(await collect(path.join(abs, name))));
    return out;
  };
  const collect = async (abs) => {
    const st = await safe(abs);
    if (st.isDirectory()) return walk(abs);
    return st.isFile() && abs.endsWith('.md') ? [abs] : [];
  };
  const readText = async (abs) => {
    await safe(abs);
    return fs.readFile(abs, 'utf8');
  };
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');

  const upstreamRaw = await readText(path.join(root, 'upstream.json'));
  const upstream = JSON.parse(upstreamRaw);
  for (const key of ['repository', 'commit', 'date']) {
    if (!upstream?.[key]) throw new Error(`upstream.json missing ${key}`);
  }
  const readme = await readText(path.join(root, 'README.md'));

  const licenses = {};
  const hashes = { 'README.md': sha(readme), 'upstream.json': sha(upstreamRaw) };
  for (const name of ['LICENSE', 'LICENSE-CODE']) {
    const abs = path.join(root, name);
    await safe(abs);
    licenses[name] = await fs.readFile(abs);
    hashes[name] = sha(licenses[name]);
  }

  const bookDir = path.join(root, 'book');
  if (!existsSync(bookDir)) throw new Error('empty sources: book/ directory is missing');
  const bookFiles = await walk(bookDir);
  if (!bookFiles.length) throw new Error('empty sources: no book/*.md found');

  const ids = new Set();
  const sections = [];
  for (const abs of bookFiles) {
    const rel = relOf(abs);
    const text = await fs.readFile(abs, 'utf8');
    const section = parseChapter(text, rel);
    if (ids.has(section.id)) throw new Error(`duplicate section id: ${section.id}`);
    ids.add(section.id);
    for (const entry of section.entries) {
      if (ids.has(entry.id)) throw new Error(`duplicate entry id: ${entry.id}`);
      ids.add(entry.id);
    }
    hashes[rel] = sha(text);
    sections.push(section);
  }
  sections.sort((a, b) => a.number - b.number);

  const docs = [];
  for (const abs of await walk(path.join(root, 'docs'))) {
    const rel = relOf(abs);
    const text = await fs.readFile(abs, 'utf8');
    hashes[rel] = sha(text);
    docs.push({
      file: rel,
      title: /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? path.basename(rel, '.md'),
      markdown: text,
    });
  }

  const featuredDocs = [...new Set([...readme.matchAll(/docs\/[^\s)"'<>\]]+\.md/g)].map((m) => m[0]))];
  const entryCount = sections.reduce((n, s) => n + s.entries.length, 0);
  const corpus = {
    metadata: {
      repository: upstream.repository,
      commit: upstream.commit,
      date: upstream.date,
      generatedAt: new Date().toISOString(),
      chapterCount: sections.length,
      entryCount,
      sourceHashes: hashes,
    },
    sections,
    docs,
    readme,
    featuredDocs,
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  for (const [name, buf] of Object.entries(licenses)) await fs.writeFile(path.join(outDir, name), buf);
  return { chapters: sections.length, entries: entryCount, docs: docs.length, outDir: path.resolve(outDir) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [sourceDir, outDir] = process.argv.slice(2);
  if (!sourceDir || !outDir) {
    console.error('usage: node scripts/build-life-guide.mjs <sourceDir> <outDir>');
    process.exit(1);
  }
  buildGuide(sourceDir, outDir)
    .then((r) => console.log(`corpus.json written: ${r.chapters} sections, ${r.entries} entries, ${r.docs} docs -> ${r.outDir}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
