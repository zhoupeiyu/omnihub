import { REPOSITORY_TRANSLATIONS_ZH } from './repository-translations.zh.js';

const hasChinese = text => typeof text === 'string' && /\p{Script=Han}/u.test(text);

export function getRepositoryDescription(repo) {
  const original = typeof repo?.description === 'string' ? repo.description : '';
  if (!original.trim()) return {text: '当前没有可用的介绍。', original, translated: false, status: 'empty'};
  const key = String(repo?.key || '').toLowerCase();
  const entry = REPOSITORY_TRANSLATIONS_ZH[key];
  if (entry?.source === original) {
    return {text: entry.text, original, translated: true, status: 'translated'};
  }
  // Never reuse a translation after the stored source changes.
  if (hasChinese(original)) return {text: original, original, translated: false, status: 'original'};
  return {
    text: entry ? '原文已更新，中文介绍待更新。可展开查看原文。' : '中文介绍待整理，可展开查看原文。',
    original,
    translated: false,
    status: 'pending',
  };
}

export function getRepositorySummary(repo, summary) {
  return hasChinese(summary) ? summary : getRepositoryDescription(repo).text;
}
