import test from 'node:test';
import assert from 'node:assert/strict';
import { canFocusRepositorySearch, groupRepositoriesByOwner, repositoryDetailWidthLimits } from '../public/repository-explorer-prototype.js';

const ready = { active:true, detailOpen:false, editable:false, overlayOpen:false };

test('the search shortcut accepts a slash, including keyboard layouts that require Shift', () => {
  assert.equal(canFocusRepositorySearch({key:'/'}, ready), true);
  assert.equal(canFocusRepositorySearch({key:'/', shiftKey:true}, ready), true);
  assert.equal(canFocusRepositorySearch({key:'?'}, ready), false);
});

for (const property of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented', 'repeat']) {
  test(`the search shortcut respects ${property}`, () => {
    assert.equal(canFocusRepositorySearch({key:'/', [property]:true}, ready), false);
  });
}

test('the search shortcut cannot steal focus from editors, dialogs or another workspace tab', () => {
  for (const context of [{active:false}, {editable:true}, {detailOpen:true}, {overlayOpen:true}]) {
    assert.equal(canFocusRepositorySearch({key:'/'}, {...ready, ...context}), false);
  }
});

test('owner groups combine case variants without combining different authors with the same repository name', () => {
  const first = {owner:'Example', name:'skills'};
  const other = {owner:'another-author', name:'skills'};
  const last = {owner:'example', name:'second-skill'};
  const groups = groupRepositoriesByOwner([first, other, last]);
  assert.deepEqual(groups.map(group => group.key), ['another-author','example']);
  assert.deepEqual(groups[1].repositories, [first,last]);
  assert.deepEqual(groups[0].repositories, [other]);
});

test('owner groups sort alphabetically by default, ignoring capitalization', () => {
  const groups = groupRepositoriesByOwner([
    {owner:'charlie', name:'skill'},
    {owner:'Beta', name:'skill'},
    {owner:'alpha', name:'skill'},
    {owner:'ALPHA', name:'another-skill'},
  ]);
  assert.deepEqual(groups.map(group => group.owner), ['alpha','Beta','charlie']);
  assert.deepEqual(groups[0].repositories.map(repo => repo.name), ['skill','another-skill']);
});

test('owner grouping preserves repository order and does not mutate its input', () => {
  const repos = Object.freeze([
    Object.freeze({owner:'z-owner',name:'first'}),
    Object.freeze({owner:'a-owner',name:'second'}),
    Object.freeze({owner:'z-owner',name:'third'}),
  ]);
  const groups = groupRepositoriesByOwner(repos);
  assert.deepEqual(groups.map(group => group.owner), ['a-owner','z-owner']);
  assert.deepEqual(groups[1].repositories.map(repo => repo.name), ['first','third']);
  assert.equal(repos[0].owner, 'z-owner');
});

test('pagination by owner retains every matching repository in a displayed group', () => {
  const repos = Array.from({length:40}, (_,i) => ({owner:`owner-${String(i).padStart(2,'0')}`, name:'skill'}));
  const later = {owner:'owner-00', name:'another-skill'};
  const visible = groupRepositoriesByOwner([...repos,later]).slice(0,36);
  assert.equal(visible.length, 36);
  assert.deepEqual(visible[0].repositories, [repos[0],later]);
  assert.equal(visible.some(group => group.key === 'owner-39'), false);
});

test('an empty filtered result has no owner groups', () => {
  assert.deepEqual(groupRepositoriesByOwner([]), []);
});


test('repository drawer starts at its current width and can expand to half a wide viewport', () => {
  assert.deepEqual(repositoryDetailWidthLimits(1920), {enabled:true,defaultWidth:680,min:420,max:960});
  assert.equal(repositoryDetailWidthLimits(1440).max, 720);
  assert.equal(repositoryDetailWidthLimits(2561).max, 1280);
});

test('narrow screens retain the readable default and mobile never enables resizing', () => {
  assert.deepEqual(repositoryDetailWidthLimits(1200), {enabled:true,defaultWidth:680,min:420,max:680});
  assert.equal(repositoryDetailWidthLimits(860).enabled, false);
  assert.deepEqual(repositoryDetailWidthLimits(390), {enabled:false,defaultWidth:390,min:390,max:390});
});
