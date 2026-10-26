import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("public refinery APIs expose only public evidence and keep owner mutations protected", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-refinery-api-"));
  const setup = `
    import { db } from "./lib/db.js";
    import { replacePromptRefinements, replaceRepositoryAssets, upsertKnowledgeArticle } from "./lib/knowledge-store.js";
    import { planXImages, prepareXImages } from './lib/x-cos-archive.js';
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'zane', 'hash', 'salt')").run();
    const insert = db.prepare(\`INSERT INTO inbox
      (id, user_id, source, external_id, title, url, author, content, visibility)
      VALUES (?, 1, 'x', ?, ?, ?, ?, ?, ?)\`);
    insert.run(1, '101', '公开收藏', 'https://x.com/a/status/101', '@a', '公开来源正文', 'public');
    insert.run(2, '202', '私密收藏', 'https://x.com/b/status/202', '@b', '不能公开的正文', 'private');
    replaceRepositoryAssets(1, [{ key: 'openai/skills', owner: 'OpenAI', name: 'skills',
      repositoryUrl: 'https://github.com/OpenAI/skills', topics: ['software'], sourcePostCount: 2,
      sourcePosts: [{ externalId: '101' }, { externalId: '202' }], targetLinkCount: 1,
      targetLinks: [{ url: 'https://github.com/OpenAI/skills', kind: 'repository' }] }]);
    const facets = { version: 'test', model: 'jev-test', kind: { value: 'coding' },
      completeness: { value: 'full_prompt' }, subject: { value: 'agent_or_software' },
      scenario: { value: 'system_configuration' }, style: { value: 'not_applicable' },
      reusability: { value: 2.8 }, signals: {}, needsReview: false };
    replacePromptRefinements(1, [{ externalId: '101', source: { title: '代码检查任务', content: '完整提示词',
      url: 'https://x.com/a/status/101', author: '@a', media: [] }, facets }]);
    insert.run(3, '303', '已归档提示词', 'https://x.com/c/status/303', '@c', '已归档的正文', 'public');
    replacePromptRefinements(1, ['202', '303'].map(externalId => ({ externalId,
      source: { title: '不能公开的提示词', content: '不能公开的正文', media: [{type:'photo',url:'https://pbs.twimg.com/media/private.jpg'}] }, facets })));
    db.prepare("UPDATE inbox SET status='ignored' WHERE id=3").run();
    db.prepare("UPDATE prompts SET media=? WHERE source_inbox_id=1").run(JSON.stringify([{type:'photo',url:'https://pbs.twimg.com/media/old.jpg'}]));
    db.prepare("UPDATE inbox SET media=? WHERE id=1").run(JSON.stringify([
      {type:'photo',url:'https://pbs.twimg.com/media/current.jpg',alt_text:'原始效果图',privateField:'not-public'},
      {type:'video',preview_image_url:'https://pbs.twimg.com/media/poster.jpg',variants:[
        {content_type:'video/mp4',bitrate:100,url:'https://video.twimg.com/example.mp4'},
        {content_type:'video/mp4',bitrate:900,url:'https://untrusted.example/video.mp4'}
      ]}
    ]));
    db.prepare("UPDATE inbox SET media=? WHERE id=2").run(JSON.stringify([{type:'photo',url:'https://pbs.twimg.com/media/private.jpg'}]));
    insert.run(4, '405', '未整理的收藏', 'https://x.com/d/status/405', '@d', '只有原始收藏没有发布提示词', 'public');
    db.prepare("UPDATE inbox SET media=? WHERE id=4").run(JSON.stringify([{type:'photo',url:'https://pbs.twimg.com/media/unpublished.jpg'}]));
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII=','base64');
    await prepareXImages(planXImages(db.prepare('SELECT * FROM inbox').all()),process.env.OMNIHUB_DATA_DIR+'/archive',
      {fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
    upsertKnowledgeArticle(1, { subjectId: 'subject', markdown: '# 公开知识\\n\\n正文结论。[S:101]\\n',
      tags: ['测试'], claims: [{ id: 'c1', text: '正文结论', sourceIds: ['101'],
        check: { verdict: { value: 'supported', answer: { confidence: .9 } }, needsReview: false } }] });
    for (const [subjectId, externalId] of [['private-subject','202'], ['ignored-subject','303'], ['missing-subject','404']]) {
      upsertKnowledgeArticle(1, { subjectId, markdown: '# 不能公开的知识\\n\\n敏感结论。[S:' + externalId + ']\\n',
        claims: [{ id:'secret', text:'敏感结论', sourceIds:[externalId],
          check:{verdict:{value:'supported',answer:{confidence:.9}},needsReview:false} }] });
    }
    console.log(JSON.stringify(db.prepare("SELECT id FROM knowledge WHERE subject_id IN ('private-subject','ignored-subject','missing-subject')").all().map(row=>row.id)));
    db.close();
  `;
  const hiddenArticleIds = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", setup], {
    cwd: root, env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: "utf8",
  }));
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(port), OMNIHUB_DATA_DIR: dataDir,
      OMNIHUB_X_MEDIA_ARCHIVE:path.join(dataDir,'archive'), OMNIHUB_CONTENT_WORKER:'false', OMNIHUB_X_BOOKMARK_SYNC:'false' },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError = "";
  child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await request("/")).ok) { ready = true; break; } } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, serverError);
    const guestSession = await request("/api/me");
    assert.equal(guestSession.status, 200);
    assert.equal(await guestSession.json(), null);
    const repositories = await (await request("/api/repositories")).json();
    assert.equal(repositories.length, 1);
    assert.equal(repositories[0].sourcePostCount, 1);
    const repository = await (await request("/api/repositories/openai/skills")).json();
    assert.equal(repository.sources.length, 1);
    assert.equal(repository.sources[0].url, "https://x.com/a/status/101");
    assert.equal(repository.sources[0].excerpt, '');
    assert.equal(repository.sources[0].private, true);
    assert.equal(JSON.stringify(repository).includes('公开来源正文'), false);
    assert.equal(JSON.stringify(repository).includes("不能公开"), false);
    const knowledge = await (await request("/api/knowledge-library")).json();
    assert.equal(knowledge.length, 1);
    const article = await (await request(`/api/knowledge-library/${knowledge[0].id}`)).json();
    assert.equal(article.sources.length, 1);
    assert.equal(article.sources[0].externalId, "101");
    assert.equal(article.sources[0].title, "公开收藏");
    assert.equal(article.sources[0].excerpt, '');
    assert.equal(article.sources[0].private, true);
    assert.equal(article.claims[0].verdict, "supported");
    const compact = await (await request('/api/knowledge-library?view=compact')).json();
    assert.deepEqual(compact.map(row=>row.id),knowledge.map(row=>row.id));
    assert.deepEqual(compact[0].initialDetail,article);
    assert.equal(JSON.stringify(compact).includes('不能公开'),false);
    assert.equal(compact[0].initialDetail.sources[0].excerpt,'');
    for (const id of hiddenArticleIds) assert.equal((await request(`/api/knowledge-library/${id}`)).status,404);
    const prompts = await (await request("/api/prompt-library")).json();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].category, "编程");
    assert.equal(prompts[0].media.length,2);
    assert.equal(prompts[0].mediaPrivate, false);
    assert.equal(prompts[0].media[1].video_url,'https://video.twimg.com/example.mp4');
    const imageUrl=prompts[0].media[0].url;
    assert.match(imageUrl,/^\/api\/x-media\/1\/[a-f0-9]{64}$/);
    const image=await request(imageUrl);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    assert.ok((await image.arrayBuffer()).byteLength>0);
    const etag=image.headers.get('etag');
    assert.equal((await request(imageUrl,{method:'HEAD'})).status,200);
    assert.equal((await request(imageUrl,{headers:{'If-None-Match':etag}})).status,304);
    assert.equal((await request('/api/x-bookmarks')).status,401);
    assert.equal((await request('/api/inbox/1')).status,401);
    for(const source of ['private','unpublished']){
      const {createHash}=await import('node:crypto');
      const digest=createHash('sha256').update('https://pbs.twimg.com/media/'+source+'.jpg').digest('hex');
      for(const id of [1,source==='private'?2:4])assert.equal((await request('/api/x-media/'+id+'/'+digest)).status,401);
    }
    for (const hidden of ['private.jpg', 'old.jpg', 'current.jpg', 'poster.jpg', 'not-public', 'variants', 'sourceMedia', 'savedMedia', 'untrusted.example', '不能公开']) {
      assert.equal(JSON.stringify(prompts).includes(hidden), false, hidden);
    }
    assert.equal((await request("/api/repositories/openai/skills/status", { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "using" }) })).status, 401);
    execFileSync(process.execPath,["--input-type=module","-e",`import {db} from './lib/db.js'; db.prepare("UPDATE inbox SET visibility='private' WHERE id=1").run(); db.close();`],
      {cwd:root,env:{...process.env,OMNIHUB_DATA_DIR:dataDir},encoding:'utf8'});
    assert.deepEqual(await (await request('/api/knowledge-library')).json(),[]);
    assert.deepEqual(await (await request('/api/knowledge-library?view=compact')).json(),[]);
    assert.equal((await request(`/api/knowledge-library/${article.id}`)).status,404);
    assert.deepEqual(await (await request('/api/prompt-library')).json(),[]);
    for(const method of ['GET','HEAD'])assert.equal((await request(imageUrl,{method,headers:{'If-None-Match':etag}})).status,401);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
