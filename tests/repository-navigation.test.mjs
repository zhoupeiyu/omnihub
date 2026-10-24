import test from 'node:test';
import assert from 'node:assert/strict';
import { readRepositoryLocation, repositoryLocation } from '../public/repository-navigation.js';

test('category, filters and detail survive a shareable URL round trip', () => {
  const state = { section:'design', use:'design.portrait', form:'skill', query:'女性 & 人像', sort:'name', detail:'liyue-aigc/female-portrait-director' };
  assert.deepEqual(readRepositoryLocation(repositoryLocation(state)), state);
});
test('unknown or incompatible URL filters fall back safely', () => {
  assert.equal(readRepositoryLocation('#inbox'), null);
  assert.deepEqual(readRepositoryLocation('#repositories?topic=design&use=audio.tts&form=bad&sort=bad'), {
    section:'design', use:'all', form:'all', query:'', sort:'default', detail:'',
  });
  assert.equal(readRepositoryLocation('#repositories?topic=missing').section, 'overview');
});
test('closing a detail preserves the underlying category and search', () => {
  const state = readRepositoryLocation('#repositories?topic=design&use=design.portrait&q=portrait&repo=a%2Fb');
  const closed = readRepositoryLocation(repositoryLocation({ ...state, detail:'' }));
  assert.equal(closed.use, 'design.portrait');
  assert.equal(closed.query, 'portrait');
  assert.equal(closed.detail, '');
});
