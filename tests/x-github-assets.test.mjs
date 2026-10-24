import assert from "node:assert/strict";
import test from "node:test";
import { extractXGitHubAssets, parseGitHubRepositoryLink,
  summarizeXGitHubAssets } from "../lib/x-github-assets.js";

test("normalizes repository and deep GitHub links", () => {
  assert.deepEqual(parseGitHubRepositoryLink("https://github.com/OpenAI/skills/tree/main/examples"), {
    key: "openai/skills", owner: "OpenAI", name: "skills",
    repositoryUrl: "https://github.com/OpenAI/skills",
    targetUrl: "https://github.com/OpenAI/skills/tree/main/examples", kind: "directory",
  });
  assert.equal(parseGitHubRepositoryLink("https://github.com/topics/ai"), null);
  assert.equal(parseGitHubRepositoryLink("https://example.com/openai/skills"), null);
});

test("deduplicates repositories while preserving every source post and deep link", () => {
  const rows = [
    { id: 1, externalId: "x1", source: "x", title: "Skills", content: "first", author: "@a",
      media: "[]", links: "[\"https://github.com/OpenAI/skills\"]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "resource", topic: "software" } }) },
    { id: 2, externalId: "x2", source: "x", title: "One skill", content: "second", author: "@b",
      media: "[]", links: "[\"https://github.com/openai/skills/blob/main/SKILL.md\"]", metrics: "{}",
      aiExtract: JSON.stringify({ xOrganization: { assetType: "knowledge", topic: "workflow" } }) },
  ];
  const assets = extractXGitHubAssets(rows);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].key, "openai/skills");
  assert.equal(assets[0].sourcePostCount, 2);
  assert.equal(assets[0].targetLinkCount, 2);
  assert.equal(assets[0].linkOccurrenceCount, 2);
  assert.deepEqual(assets[0].topics, ["software", "workflow"]);
  assert.deepEqual(summarizeXGitHubAssets(assets), {
    repositories: 1,
    rawLinkOccurrences: 2,
    uniqueTargetLinks: 2,
    uniqueSourcePosts: 2,
    sourcePostReferences: 2,
    repositoriesWithMultipleSourcePosts: 1,
    uniqueLinkKinds: { repository: 1, file: 1 },
    topics: { software: 1, workflow: 1 },
  });
});
