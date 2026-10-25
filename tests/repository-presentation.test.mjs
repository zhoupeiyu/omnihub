import test from 'node:test';
import assert from 'node:assert/strict';
import { canFocusRepositorySearch, groupRepositoriesByOwner, repositoryOrganizationDay, buildRepositoryTimeline } from '../public/repository-explorer-prototype.js';

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

test('organization days preserve date-only reviews and fall back past invalid dates', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(repositoryOrganizationDay({organizedAt:'2026-10-25'}), '2026-10-25');
    assert.equal(repositoryOrganizationDay({organizedAt:'invalid',updatedAt:'2026-10-25 04:00:00'}), '2026-10-24');
    assert.equal(repositoryOrganizationDay({created_at:'2026-10-25'}), '2026-10-25');
    assert.equal(repositoryOrganizationDay({}), 'undated');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('dates precede author groups and an author can appear on multiple days', () => {
  const repos = Object.freeze([
    {owner:'alpha',key:'alpha/old',organizedAt:'2026-10-01'},
    {owner:'zeta',key:'zeta/new',organizedAt:'2026-10-25'},
    {owner:'alpha',key:'alpha/new',organizedAt:'2026-10-25'},
    {owner:'ALPHA',key:'alpha/second',organizedAt:'2026-10-25'},
    {owner:'unknown',key:'unknown/repo'},
  ].map(Object.freeze));
  const units = buildRepositoryTimeline(repos, {sort:'name'});
  assert.deepEqual(units.map(({date,item}) => [date,item.key]), [
    ['2026-10-25','alpha'], ['2026-10-25','zeta'], ['2026-10-01','alpha'], ['undated','unknown'],
  ]);
  assert.deepEqual(units[0].item.repositories, [repos[2],repos[3]]);
  assert.equal(units[0].count, 3);
  assert.deepEqual(units.flatMap(unit => unit.item.repositories).map(repo => repo.key).sort(), repos.map(repo => repo.key).sort());
});

test('pagination retains complete authors within a day and stable date identity across batches', () => {
  const rows = Array.from({length:40}, (_,i) => ({owner:`owner-${String(i).padStart(2,'0')}`,key:`owner-${i}/skill`,organizedAt:'2026-10-25'}));
  rows.push({owner:'owner-00',key:'owner-0/second',organizedAt:'2026-10-25'});
  rows.push({owner:'owner-00',key:'owner-0/older',organizedAt:'2026-10-24'});
  const units = buildRepositoryTimeline(rows, {sort:'name'});
  assert.equal(units[0].item.repositories.length, 2);
  assert.equal(units[35].date, units[36].date);
  assert.equal(units[40].date, '2026-10-24');
  assert.equal(units.slice(0,36).flatMap(unit => unit.item.repositories).length, 37);
  assert.equal(units.flatMap(unit => unit.item.repositories).length, rows.length);
});

test('ungrouped and empty timelines keep date nodes without inventing authors', () => {
  const old = {owner:'alpha',key:'alpha/old',organizedAt:'2026-10-01'};
  const recent = {owner:'zeta',key:'zeta/new',organizedAt:'2026-10-25'};
  const units = buildRepositoryTimeline([old,recent], {group:'none',sort:'name'});
  assert.deepEqual(units.map(unit => unit.item), [recent,old]);
  assert.deepEqual(buildRepositoryTimeline([]), []);
});
