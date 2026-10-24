import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("refinery store keeps canonical repositories, prompt facets, knowledge citations, and public boundaries", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "omnihub-refinery-store-"));
  const code = `
    import { db } from "./lib/db.js";
    import { getKnowledgeArticle, getRepositoryAsset, listKnowledgeArticles, listPromptAssets,
      listRepositoryAssets, replacePromptRefinements, replaceRepositoryAssets,
      updateRepositoryEnrichment, updateRepositoryStatus, upsertKnowledgeArticle } from "./lib/knowledge-store.js";
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'zane', 'hash', 'salt')").run();
    const insert = db.prepare(\`INSERT INTO inbox
      (id, user_id, source, external_id, title, url, author, content, visibility)
      VALUES (?, 1, 'x', ?, ?, ?, ?, ?, ?)\`);
    insert.run(1, 'x1', '公开来源', 'https://x.com/a/status/x1', '@a', '介绍仓库和完整提示词', 'public');
    insert.run(2, 'x2', '私密来源', 'https://x.com/b/status/x2', '@b', '私密说明', 'private');
    const repo = { key: 'openai/skills', owner: 'OpenAI', name: 'skills',
      repositoryUrl: 'https://github.com/OpenAI/skills', topics: ['software'],
      sourcePosts: [{ externalId: 'x1' }, { externalId: 'x2' }], sourcePostCount: 2,
      targetLinks: [{ url: 'https://github.com/OpenAI/skills', kind: 'repository' }],
      targetLinkCount: 1, linkOccurrenceCount: 2, existingAssetTypes: ['resource'] };
    const first = replaceRepositoryAssets(1, [repo]);
    updateRepositoryEnrichment(1, 'openai/skills', {
      description: 'Official repository introduction.',
      metadata: { descriptionProvenance: 'github_description', github: { found: true },
        classification: { version:'review-test', uses:['agent.skills'], forms:['skill'] } },
    });
    const second = replaceRepositoryAssets(1, [repo]);
    const afterReimport = getRepositoryAsset(1,'openai/skills').metadata.classification;
    replaceRepositoryAssets(1, [{...repo,officialDescription:{text:'Official repository introduction.',provenance:'github_description'}}]);
    updateRepositoryStatus(1, 'openai/skills', 'ready_to_try');
    const publicRepos = listRepositoryAssets(1, { publicOnly: true });
    const detail = getRepositoryAsset(1, 'openai/skills', { publicOnly: true });
    const facets = { version: 'prompt-v1', model: 'jev-test',
      kind: { value: 'agent_system' }, completeness: { value: 'full_prompt' },
      subject: { value: 'agent_or_software' }, scenario: { value: 'system_configuration' },
      style: { value: 'not_applicable' }, reusability: { value: 2.7 },
      signals: { agentInstruction: { value: true } }, needsReview: false };
    const promptResult = replacePromptRefinements(1, [{ externalId: 'x1',
      source: { title: 'Agent 规则', content: '完整提示词', url: 'https://x.com/a/status/x1', author: '@a', media: [] },
      facets, tools: ['Codex'] }]);
    const promptAgain = replacePromptRefinements(1, [{ externalId: 'x1',
      source: { title: 'Agent 规则', content: '完整提示词', url: 'https://x.com/a/status/x1', author: '@a', media: [] },
      facets, tools: ['Codex'] }]);
    const article = upsertKnowledgeArticle(1, { subjectId: 'test-subject',
      markdown: '# 一篇知识\\n\\n状态　草稿\\n\\n正文结论。[S:x1]\\n', tags: ['测试'],
      claims: [{ id: 'claim-1', section: '正文', text: '正文结论', sourceIds: ['x1'],
        check: { verdict: { value: 'supported', answer: { confidence: 0.9 } }, needsReview: false } }] });
    const publicKnowledge = listKnowledgeArticles(1, { publicOnly: true });
    const knowledgeDetail = getKnowledgeArticle(1, article.knowledgeId, { publicOnly: true });
    const savedMedia = [{type:'photo',url:'https://pbs.twimg.com/media/saved.jpg'}];
    db.prepare("UPDATE prompts SET media=?").run(JSON.stringify(savedMedia));
    const fallbackMedia = listPromptAssets(1, {publicOnly:true})[0].media;
    db.prepare("UPDATE inbox SET media='invalid' WHERE id=1").run();
    const malformedSourceMedia = listPromptAssets(1, {publicOnly:true})[0].media;
    db.prepare("UPDATE prompts SET media='{}'").run();
    const emptyMedia = listPromptAssets(1, {publicOnly:true})[0].media;
    console.log(JSON.stringify({ first, second, afterReimport, publicRepos, detail, promptResult, promptAgain,
      prompts: listPromptAssets(1, { publicOnly: true }), publicKnowledge, knowledgeDetail,
      fallbackMedia, malformedSourceMedia, emptyMedia }));
    db.close();
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.dirname(new URL(import.meta.url).pathname) + "/..",
      env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.deepEqual(result.first, { repositories: 1, sources: 2, links: 1 });
    assert.deepEqual(result.second, result.first);
    assert.equal(result.publicRepos.length, 1);
    assert.equal(result.publicRepos[0].sourcePostCount, 1);
    assert.equal(result.publicRepos[0].personalStatus, "ready_to_try");
    assert.equal(result.publicRepos[0].description, "Official repository introduction.");
    assert.equal(result.publicRepos[0].metadata.descriptionProvenance, "github_description");
    assert.deepEqual(result.afterReimport,{version:'review-test',uses:['agent.skills'],forms:['skill']});
    assert.deepEqual(result.publicRepos[0].metadata.classification,result.afterReimport);
    assert.equal(result.detail.sources.length, 1);
    assert.equal(result.detail.sources[0].title, "公开来源");
    assert.equal(JSON.stringify(result.detail).includes("私密"), false);
    assert.equal(result.promptResult.promptsCreated, 1);
    assert.equal(result.promptAgain.promptsUpdated, 1);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].category, "Agent 系统");
    assert.equal(result.fallbackMedia[0].url, 'https://pbs.twimg.com/media/saved.jpg');
    assert.deepEqual(result.malformedSourceMedia, result.fallbackMedia);
    assert.deepEqual(result.emptyMedia, []);
    assert.equal(result.publicKnowledge.length, 1);
    assert.equal(result.knowledgeDetail.sources.length, 1);
    assert.equal(result.knowledgeDetail.claims[0].verdict, "supported");
    assert.equal(result.knowledgeDetail.repositories[0].key, "openai/skills");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
