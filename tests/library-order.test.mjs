import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {createLibraryCuration} from '../lib/library-curation.js';
import '../public/library-order.js';
import {readRepositoryLocation,repositoryLocation} from '../public/repository-navigation.js';
const {compare,timestamp}=globalThis.OmniHubLibraryOrder;
test('libraries order by organization date, not source publication time, across UTC formats',()=>{
 const rows=[{id:'old',updatedAt:'2026-10-23T09:00:00Z',publishedAt:'2030-01-01'},
 {id:'missing',updatedAt:'invalid'},{id:'sqlite',updatedAt:'2026-10-25 04:00:00'},
 {id:'new',updatedAt:'2026-10-25T12:30:00+08:00'},{id:'fallback',updatedAt:'invalid',createdAt:'2026-10-24T00:00:00Z'}];
 assert.deepEqual([...rows].sort(compare).map(x=>x.id),['new','sqlite','fallback','old','missing']);
 assert.equal(rows[0].id,'old');assert.equal(timestamp({updatedAt:'2026-10-25 04:00:00'}),Date.parse('2026-10-25T04:00:00Z'));
 assert.ok(compare({id:'2'},{id:'10'})<0);
});
test('owner groups and cards use recent organization dates while alphabetical sorting remains explicit',()=>{
 const text=readFileSync(new URL('../public/repository-explorer-prototype.js',import.meta.url),'utf8');
 const fn=text.slice(text.indexOf('export function groupRepositoriesByOwner'),text.indexOf('\nexport function mountRepositoryExplorer')).replace('export ','');
 const context={OmniHubLibraryOrder:globalThis.OmniHubLibraryOrder};vm.createContext(context);vm.runInContext(fn+'; this.group = groupRepositoriesByOwner;',context);
 const rows=[{owner:'A',key:'a/old',updatedAt:'2026-10-01'},{owner:'Z',key:'z/new',updatedAt:'2026-10-25'},{owner:'A',key:'a/next',updatedAt:'2026-10-24'}];
 const grouped=context.group(rows);
 assert.equal(grouped[0].owner,'Z');assert.equal(grouped[1].repositories[0].key,'a/next');
 assert.equal(context.group(rows,'name')[0].owner,'A');
});
test('manual repository sort choices survive navigation and unspecified sort is recent',()=>{
 assert.equal(readRepositoryLocation('#repositories').sort,'default');
 for(const sort of ['name','topic'])assert.equal(readRepositoryLocation(repositoryLocation({section:'all',sort},'#repositories?space=mine')).sort,sort);
});
test('repository organization dates include later classification reviews and never regress to an older correction',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);');
  const curation=createLibraryCuration(db);
  const row={key:'owner/repo',createdAt:'2026-09-20 00:00:00',updatedAt:'2026-09-24 08:00:00',metadata:{classification:{reviewedAt:'2026-09-28'}}};
  const reviewed=curation.repository(1,row);
  assert.equal(reviewed.organizedAt,'2026-09-28');
  assert.equal(reviewed.updatedAt,row.updatedAt);
  assert.ok(compare(reviewed,{key:'other/repo',updatedAt:'2026-09-25 00:00:00'})<0);
  db.prepare('INSERT INTO library_curation VALUES(?,?,?,?,?,?,?)').run(1,'repository',row.key,'{"uses":["agent.coding"],"forms":["skill"]}',1,'manual','2026-10-01T12:00:00Z');
  assert.equal(curation.repository(1,row).organizedAt,'2026-10-01T12:00:00Z');
  assert.equal(curation.repository(1,{...row,updatedAt:'2026-10-25 04:00:00'}).organizedAt,'2026-10-25 04:00:00');
  assert.equal(curation.repository(1,{key:'other/repo',metadata:{classification:{reviewedAt:'invalid'}},createdAt:'2026-10-24'}).organizedAt,'2026-10-24');
 } finally {db.close();}
});
test('collection timelines use organization dates before original post dates',()=>{
 const text=readFileSync(new URL('../public/inbox.jsx',import.meta.url),'utf8');
 const fn=text.slice(text.indexOf('function inboxTime(item)'),text.indexOf('\nfunction inboxDayLabel'));
 const context={OmniHubLibraryOrder:globalThis.OmniHubLibraryOrder,inboxDate:item=>item.publishedAt};
 vm.createContext(context);vm.runInContext(fn+';this.time=inboxTime;',context);
 assert.equal(context.time({updatedAt:'2026-10-25 04:00:00',publishedAt:'2020-01-01'}),Date.parse('2026-10-25T04:00:00Z'));
 assert.equal(context.time({publishedAt:'2020-01-01'}),Date.parse('2020-01-01'));
});
