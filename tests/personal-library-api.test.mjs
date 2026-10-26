import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('manual prompt and knowledge assets join only the full-access owner mine libraries', async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'omnihub-personal-library-'));
  process.env.OMNIHUB_DATA_DIR = dataDir;
  process.env.OMNIHUB_CONTENT_WORKER = 'false';
  process.env.OMNIHUB_X_BOOKMARK_SYNC = 'false';
  process.env.OMNIHUB_X_WATCH_ENABLED = 'false';
  const { db } = await import('../lib/db.js');
  const { handleApi } = await import('../lib/api.js');

  db.prepare("INSERT INTO users(id,username,password_hash,salt) VALUES(1,'zane','fixture','fixture'),(2,'alice','fixture','fixture')").run();
  db.prepare("INSERT INTO sessions(token,user_id) VALUES('owner-token',1),('alice-token',2)").run();
  const insertInbox = db.prepare(`
    INSERT INTO inbox(id,user_id,source,external_id,title,url,author,content,media,visibility)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `);
  insertInbox.run(101, 1, 'x', '101', '派生提示词来源', 'https://x.com/writer/status/101', '@writer',
    '已有自动派生内容', '[]', 'public');
  insertInbox.run(102, 1, 'x', '102', '待整理提示词', 'https://x.com/writer/status/102', '@writer',
    '来源中的完整提示词正文', JSON.stringify([{type:'photo',url:'https://pbs.twimg.com/media/manual.jpg'}]), 'private');
  insertInbox.run(103, 1, 'x', '103', '待整理知识', 'https://x.com/writer/status/103', '@writer',
    '来源中的知识正文', '[]', 'private');
  insertInbox.run(201, 2, 'manual', '201', '其他账号来源', 'https://example.com/alice', 'alice',
    '其他账号原文', '[]', 'private');

  db.prepare(`
    INSERT INTO prompts(user_id,title,text,category,tags,source_url,source_author,source_content,
      source_inbox_id,facet_data,updated_at)
    VALUES(1,'已有派生提示词','自动派生内容','编程','derived','https://x.com/writer/status/101',
      '@writer','已有自动派生内容',101,'{}',datetime('now'))
  `).run();
  const legacyDerivedKnowledgeId = Number(db.prepare(`
    INSERT INTO knowledge(user_id,title,summary,body,status,subject_id,verification_status)
    VALUES(1,'已有来源知识','来源整理摘要','来源整理正文','ready','','verified')
  `).run().lastInsertRowid);
  db.prepare(`INSERT INTO knowledge_sources(knowledge_id,inbox_id,external_id,citation_key)
    VALUES(?,?,?,?)`).run(legacyDerivedKnowledgeId, 101, '101', 'S:101');
  db.prepare(`INSERT INTO prompts(user_id,title,text,category,facet_data)
    VALUES(2,'Alice 手工提示词','不能泄露','其他','{"manualAsset":true}')`).run();
  db.prepare(`INSERT INTO knowledge(user_id,title,body,subject_id)
    VALUES(2,'Alice 手工知识','不能泄露','')`).run();

  const server = http.createServer(async (req, res) => {
    if (!await handleApi(req, res, new URL(req.url, 'http://localhost').pathname)) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dataDir, { recursive:true, force:true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = { zane:'owner-token', alice:'alice-token' };
  const request = (route, { user, method = 'GET', body } = {}) => fetch(base + route, {
    method,
    headers:{
      ...(user ? { cookie:`omnihub_session=${token[user]}` } : {}),
      ...(body ? { 'content-type':'application/json' } : {}),
    },
    body:body ? JSON.stringify(body) : undefined,
  });
  const json = async (route, options) => {
    const response = await request(route, options);
    if (response.status !== 200) assert.fail(`${route}: ${response.status} ${await response.text()}`);
    return response.json();
  };

  const before = await json('/api/prompt-library?scope=mine', {user:'zane'});
  assert.deepEqual(before.map((item) => item.title), ['已有派生提示词']);

  const promptResponse = await json('/api/prompts', {user:'zane', method:'POST', body:{
    title:'手工提示词', text:'手工整理后的正文', category:'图像生成', tags:'portrait,cinematic',
    media:JSON.stringify([{type:'photo',url:'https://example.com/result.jpg'}]),
    sourceInboxId:101, sourceUrl:'https://x.com/writer/status/101',
    sourceAuthor:'@writer', sourceContent:'保留的原始正文',
  }});
  assert.equal(promptResponse.manualAssetId, promptResponse.id);
  assert.equal(promptResponse.libraryId, `manual-prompt-${promptResponse.id}`);

  const knowledgeResponse = await json('/api/knowledge', {user:'zane', method:'POST', body:{
    title:'手工知识', summary:'人工摘要', body:'## 结论\n\n保留正文。', tags:'研究,AI',
    sourceUrl:'https://x.com/writer/status/101', sourceAuthor:'@writer', sourceContent:'保留的来源正文',
  }});
  assert.equal(knowledgeResponse.manualAssetId, knowledgeResponse.id);
  assert.equal(knowledgeResponse.libraryId, `manual-knowledge-${knowledgeResponse.id}`);

  const promptEdit = await json(`/api/prompts/${promptResponse.id}`, {user:'zane', method:'PUT', body:{
    title:'手工提示词（已编辑）',
  }});
  assert.equal(promptEdit.manualAssetId, promptResponse.id);
  assert.equal(promptEdit.libraryId, promptResponse.libraryId);
  const knowledgeEdit = await json(`/api/knowledge/${knowledgeResponse.id}`, {user:'zane', method:'PUT', body:{
    title:'手工知识（已编辑）',
  }});
  assert.equal(knowledgeEdit.manualAssetId, knowledgeResponse.id);
  assert.equal(knowledgeEdit.libraryId, knowledgeResponse.libraryId);

  const prompts = await json('/api/prompt-library?scope=mine', {user:'zane'});
  const derived = prompts.find((item) => item.title === '已有派生提示词');
  const manualPrompt = prompts.find((item) => item.id === promptResponse.libraryId);
  assert.ok(derived, 'the source-derived prompt remains present');
  assert.ok(manualPrompt, 'the manual prompt is added without replacing the derived prompt');
  assert.equal(manualPrompt.manualAssetId, promptResponse.id);
  assert.equal(manualPrompt.title, '手工提示词（已编辑）');
  assert.equal(manualPrompt.text, '手工整理后的正文');
  assert.deepEqual(manualPrompt.tags, ['portrait','cinematic']);
  assert.equal(manualPrompt.media[0].url, 'https://example.com/result.jpg');
  assert.equal(manualPrompt.sourceUrl, 'https://x.com/writer/status/101');
  assert.equal(manualPrompt.sourceContent, '保留的原始正文');
  assert.equal(manualPrompt.sourceInboxId, 101);

  const knowledge = await json('/api/knowledge-library?scope=mine', {user:'zane'});
  assert.ok(knowledge.some((item) => item.id === legacyDerivedKnowledgeId && item.title === '已有来源知识'));
  const manualKnowledge = knowledge.find((item) => item.id === knowledgeResponse.libraryId);
  assert.ok(manualKnowledge);
  assert.equal(manualKnowledge.type, 'manual');
  assert.equal(manualKnowledge.title, '手工知识（已编辑）');
  assert.deepEqual(manualKnowledge.tags, ['研究','AI']);
  assert.equal(manualKnowledge.sourceCount, 1);
  const knowledgeDetail = await json(`/api/knowledge-library/${knowledgeResponse.libraryId}`, {user:'zane'});
  assert.equal(knowledgeDetail.body, '## 结论\n\n保留正文。');
  assert.equal(knowledgeDetail.sources[0].url, 'https://x.com/writer/status/101');
  assert.equal(knowledgeDetail.sources[0].excerpt, '保留的来源正文');
  assert.deepEqual(knowledgeDetail.claims, []);
  assert.deepEqual(knowledgeDetail.repositories, []);

  const dispatchedPrompt = await json('/api/inbox/102/dispatch', {user:'zane', method:'POST', body:{
    targetType:'prompt', data:{title:'来源整理提示词', text:'可复用正文', category:'视频生成', tags:'video'},
  }});
  assert.equal(dispatchedPrompt.libraryId, `manual-prompt-${dispatchedPrompt.targetId}`);
  const dispatchedPromptRow = (await json('/api/prompt-library?scope=mine', {user:'zane'}))
    .find((item) => item.id === dispatchedPrompt.libraryId);
  assert.equal(dispatchedPromptRow.sourceInboxId, 102);
  assert.equal(dispatchedPromptRow.sourceContent, '来源中的完整提示词正文');
  assert.equal(dispatchedPromptRow.media[0].url, 'https://pbs.twimg.com/media/manual.jpg');
  const repeatedPrompt = await request('/api/inbox/102/dispatch', {user:'zane', method:'POST', body:{
    targetType:'prompt', data:{title:'重复', text:'不应写入'},
  }});
  assert.equal(repeatedPrompt.status, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prompts WHERE title='来源整理提示词'").get().n, 1);

  const dispatchedKnowledge = await json('/api/inbox/103/dispatch', {user:'zane', method:'POST', body:{
    targetType:'knowledge', data:{title:'来源整理知识', body:'来源整理后的正文', tags:'资料'},
  }});
  const dispatchedDetail = await json(`/api/knowledge-library/${dispatchedKnowledge.libraryId}`, {user:'zane'});
  assert.equal(dispatchedDetail.manualAssetId, dispatchedKnowledge.targetId);
  assert.equal(dispatchedDetail.sources[0].id, 103);
  assert.equal(dispatchedDetail.sources[0].url, 'https://x.com/writer/status/103');
  assert.equal(dispatchedDetail.sources[0].excerpt, '来源中的知识正文');
  const repeatedKnowledge = await request('/api/inbox/103/dispatch', {user:'zane', method:'POST', body:{
    targetType:'knowledge', data:{title:'重复', body:'不应写入'},
  }});
  assert.equal(repeatedKnowledge.status, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge WHERE title='来源整理知识'").get().n, 1);

  for (const options of [{}, {user:'zane'}]) {
    const publicPrompts = await json('/api/prompt-library?scope=public', options);
    assert.ok(publicPrompts.some((item) => item.title === '已有派生提示词'));
    assert.equal(publicPrompts.some((item) => item.type === 'manual'), false);
    assert.equal((await json('/api/knowledge-library?scope=public', options))
      .some((item) => item.type === 'manual'), false);
    assert.ok((await json('/api/knowledge-library?scope=public', options))
      .some((item) => item.id === legacyDerivedKnowledgeId));
  }
  assert.equal((await json('/api/prompt-library', {user:'zane'})).some((item) => item.type === 'manual'), false);
  assert.equal((await json('/api/knowledge-library', {user:'zane'})).some((item) => item.type === 'manual'), false);
  assert.equal((await request(`/api/knowledge-library/${knowledgeResponse.libraryId}`)).status, 404);
  assert.equal((await request(`/api/knowledge-library/${knowledgeResponse.libraryId}`, {user:'alice'})).status, 404);
  assert.deepEqual(await json('/api/prompt-library?scope=mine', {user:'alice'}), []);
  assert.deepEqual(await json('/api/knowledge-library?scope=mine', {user:'alice'}), []);
  assert.equal((await request('/api/prompts', {user:'alice', method:'POST', body:{title:'No',text:'No'}})).status, 403);
  assert.equal((await request('/api/knowledge', {user:'alice', method:'POST', body:{title:'No',body:'No'}})).status, 403);
  assert.equal((await request('/api/prompts', {user:'zane', method:'POST', body:{
    title:'跨账号来源', text:'不应保存', sourceInboxId:201,
  }})).status, 404);
});
