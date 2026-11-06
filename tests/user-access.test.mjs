import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createUserAccessStore } from '../lib/user-access.js';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT "now")');
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(1,'zane');
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(2,'reader');
  return {db,access:createUserAccessStore(db),admin:{id:1,username:'zane'},reader:{id:2,username:'reader'}};
}

test('access preserves legacy tools, normalizes grants, revisions overrides, and never pregrants drive access',()=>{
  const {db,access,admin,reader}=fixture();
  assert.equal(access.isAdmin(admin),true);assert.equal(access.isAdmin(reader),false);
  assert.deepEqual(access.access(reader),{driveCategories:[],tools:['media','markdown','camera','omniget']});
  assert.equal(access.canDrive(reader,'courses'),false);
  assert.equal(access.canTool(reader,'media'),true);
  assert.equal(access.canTool(null,'media'),false);
  const saved=access.update(2,{driveCategories:['courses','courses','unknown'],tools:['media','bogus']},0);
  assert.deepEqual(saved.permissions,{driveCategories:['courses'],tools:['media']});assert.equal(saved.revision,1);
  assert.equal(access.canDrive(reader,'courses'),true);assert.equal(access.canTool(reader,'media'),true);
  assert.throws(()=>access.update(2,null,1),{status:400});
  assert.throws(()=>access.update(2,{driveCategories:[],tools:'media'},1),{status:400});
  assert.throws(()=>access.update(2,{driveCategories:[],tools:[]},0),{status:409});
  assert.throws(()=>access.update(1,{driveCategories:[],tools:[]},0),{status:400});
  assert.deepEqual(access.publicUser(admin).permissions.driveCategories.length,7);
  db.close();
});


test('standalone tools preserve legacy grants but can be independently revoked',()=>{
  const {db,access,reader}=fixture();
  db.prepare('INSERT INTO user_access(user_id,permissions) VALUES(?,?)').run(2,JSON.stringify({driveCategories:['courses'],tools:['media']}));
  assert.equal(access.canTool(reader,'camera'),true);
  assert.equal(access.canTool(reader,'omniget'),true);
  access.update(2,{driveCategories:['courses'],tools:['media']},1);
  assert.equal(access.canTool(reader,'media'),true);
  assert.equal(access.canTool(reader,'camera'),false);
  assert.equal(access.canTool(reader,'omniget'),false);
  access.update(2,{driveCategories:[],tools:['omniget','camera']},2);
  assert.equal(access.canTool(reader,'media'),false);
  assert.equal(access.canTool(reader,'omniget'),true);
  assert.equal(access.canTool(reader,'camera'),true);
  assert.equal(access.canDrive(reader,'courses'),false);
  access.update(2,{driveCategories:[],tools:[]},3);
  assert.equal(access.canTool(reader,'omniget'),false);
  db.close();
});

test('legacy empty grants never acquire standalone tool access',()=>{
  const {db,access,reader}=fixture();
  db.prepare('INSERT INTO user_access(user_id,permissions) VALUES(?,?)').run(2,JSON.stringify({driveCategories:[],tools:[]}));
  assert.equal(access.canTool(reader,'camera'),false);
  assert.equal(access.canTool(reader,'omniget'),false);
  db.close();
});
