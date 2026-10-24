import { REPOSITORY_TOPICS, REPOSITORY_FORMS, SUBTOPICS } from './repository-taxonomy.js';

const sections = new Set(['overview', 'all', 'unfiled', ...REPOSITORY_TOPICS.map(topic => topic.id)]);
export function readRepositoryLocation(hash) {
  if (hash.split('?')[0] !== '#repositories') return null;
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const section = sections.has(params.get('topic')) ? params.get('topic') : 'all';
  const use = params.get('use');
  return {
    section,
    use: SUBTOPICS.has(use) && (['all', 'overview'].includes(section) || SUBTOPICS.get(use).topic === section) ? use : 'all',
    form: Object.hasOwn(REPOSITORY_FORMS, params.get('form')) ? params.get('form') : 'all',
    query: params.get('q') || '',
    sort: ['name','topic'].includes(params.get('sort')) ? params.get('sort') : 'default',
    detail: params.get('repo') || '',
  };
}

export function repositoryLocation(state, currentHash = '') {
  const current = new URLSearchParams(String(currentHash).split('?')[1] || '');
  const params = new URLSearchParams();
  // `space` is not a repository filter, but it is the privacy boundary for
  // the whole catalogue. Keep it when the explorer writes a deep-link.
  if (['mine', 'public'].includes(current.get('space'))) params.set('space', current.get('space'));
  if (sections.has(state.section)) params.set('topic', state.section);
  if (state.use && state.use !== 'all') params.set('use', state.use);
  if (state.form && state.form !== 'all') params.set('form', state.form);
  if (state.query) params.set('q', state.query);
  if (['name','topic'].includes(state.sort)) params.set('sort', state.sort);
  if (state.detail) params.set('repo', state.detail);
  return '#repositories' + (params.size ? `?${params}` : '');
}
