import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRepositoryDescription, getRepositorySummary } from '../public/repository-localization.js';
import { REPOSITORY_TRANSLATIONS_ZH } from '../public/repository-translations.zh.js';

const snapshot = JSON.parse(readFileSync(new URL('../content/repository-description-snapshot.json', import.meta.url)));
const translations = JSON.parse(readFileSync(new URL('../content/repository-translations.zh.json', import.meta.url)));
const englishRepo = snapshot.find(repo => repo.key === 'liyue-aigc/female-portrait-director');

test('saved English introductions have Chinese reading versions and unchanged originals', () => {
  let translated = 0;
  let english = 0;
  for (const repo of snapshot) {
    const localized = getRepositoryDescription(repo);
    assert.equal(localized.original, repo.description);
    assert.match(localized.text, /\p{Script=Han}/u, repo.key);
    if (localized.translated) translated++;
    if (repo.description && !/\p{Script=Han}/u.test(repo.description)) {
      english++;
      assert.equal(localized.translated, true, repo.key);
    }
  }
  assert.equal(english, 398);
  assert.equal(translated, Object.keys(translations).length);
});

test('generated translations match the authored text and exact source snapshot', () => {
  assert.equal(Object.keys(REPOSITORY_TRANSLATIONS_ZH).length, Object.keys(translations).length);
  for (const [key, text] of Object.entries(translations)) {
    assert.equal(REPOSITORY_TRANSLATIONS_ZH[key].text, text);
    assert.equal(REPOSITORY_TRANSLATIONS_ZH[key].source, snapshot.find(repo => repo.key.toLowerCase() === key).description);
  }
});

test('repository keys are case insensitive but translated source matching is exact', () => {
  assert.equal(getRepositoryDescription({...englishRepo, key: englishRepo.key.toUpperCase()}).translated, true);
  const changed = {...englishRepo, description: `${englishRepo.description} Updated.`};
  const result = getRepositoryDescription(changed);
  assert.equal(result.translated, false);
  assert.match(result.text, /原文已更新/);
  assert.equal(result.original, changed.description);
  assert.notEqual(result.text, getRepositoryDescription(englishRepo).text);
});

test('Chinese originals remain unchanged and missing translations are explicit', () => {
  const description = '使用 React 和 Python 制作工具，命令为 npm run dev。';
  assert.deepEqual(getRepositoryDescription({key: 'example/chinese', description}), {text: description, original: description, translated: false, status: 'original'});
  assert.equal(getRepositoryDescription({key: 'example/new', description: 'A new tool.'}).status, 'pending');
  assert.match(getRepositoryDescription({key: 'example/new', description: 'A new tool.'}).text, /中文介绍待整理/);
  assert.equal(getRepositoryDescription({}).status, 'empty');
  assert.match(getRepositoryDescription(null).text, /没有可用/);
});

test('cards use Chinese editorial summaries or the same localized description as details', () => {
  assert.equal(getRepositorySummary(englishRepo, 'A generic English summary.'), getRepositoryDescription(englishRepo).text);
  assert.equal(getRepositorySummary(englishRepo, '专门整理的中文摘要。'), '专门整理的中文摘要。');
});

test('detail originals are escaped and collapsed while search includes Chinese and original text', () => {
  const renderer = readFileSync(new URL('../public/repository-explorer-prototype.js', import.meta.url), 'utf8');
  assert.match(renderer, /<details class="description-original"><summary>查看原文<\/summary>/);
  assert.match(renderer, /escapeHtml\(description\.original\)/);
  assert.match(renderer, /escapeHtml\(description\.text\)/);
  assert.match(renderer, /summary !== description\.text/);
  assert.match(renderer, /repo\.description, getRepositoryDescription\(repo\)\.text/);
  assert.doesNotMatch(renderer, /class="official-description">\$\{escapeHtml\(repo\.description/);
});
