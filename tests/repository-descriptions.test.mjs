import assert from "node:assert/strict";
import test from "node:test";
import {
  DESCRIPTION_PROVENANCE,
  extractReadmeIntroduction,
  selectOfficialDescription,
  selectRepositoryDescription,
  synthesizeSourceFallback,
  synthesizeTopicsFallback,
} from "../lib/repository-descriptions.js";

const NOISY_README = `---
title: skills
---

[![Build](https://img.shields.io/badge/build-passing-green)](https://ci.example.com)
[![Stars](https://img.shields.io/github/stars/openai/skills)](https://github.com/openai/skills)

# Skills

## Table of Contents
- [Installation](#installation)
- [Usage](#usage)

Skills is a command-line toolkit that lets you package, version, and share reusable agent
skills across projects. It parses a manifest file, validates each skill against a schema,
and generates a ready-to-publish bundle for distribution.

It also ships a small runtime that automatically discovers installed skills and exposes
them through one CLI so teams can compose agent workflows without writing glue code.

| Feature | Support |
| --- | --- |
| CLI | yes |
| Schema validation | yes |

## Installation

\`\`\`bash
npm install -g @openai/skills
git clone https://github.com/openai/skills
\`\`\`

$ skills init

## License

MIT

[docs]: https://example.com/docs
`;

test("README extraction ignores badges, headings, nav, code fences, tables, install commands, boilerplate", () => {
  const intro = extractReadmeIntroduction(NOISY_README);
  assert.ok(intro, "expected a non-null introduction");
  assert.ok(intro.length <= 500);
  assert.ok(!/img\.shields\.io/.test(intro));
  assert.ok(!/^#/.test(intro));
  assert.ok(!/Table of Contents/i.test(intro));
  assert.ok(!/```/.test(intro));
  assert.ok(!/\|\s*Feature\s*\|/.test(intro));
  assert.ok(!/npm install/.test(intro));
  assert.ok(!/git clone/.test(intro));
  assert.ok(!/^\$ /.test(intro));
  assert.ok(!/License/i.test(intro));
  assert.ok(/lets you package, version, and share reusable agent/.test(intro));
});

test("description-only selection is used when no usable README is available", () => {
  const official = selectOfficialDescription({
    description: "A fast static site generator built with speed and simplicity in mind.",
    readme: "",
  });
  assert.equal(official.provenance, DESCRIPTION_PROVENANCE.DESCRIPTION);
  assert.equal(official.text, "A fast static site generator built with speed and simplicity in mind.");

  const placeholder = selectOfficialDescription({ description: "No description provided", readme: "" });
  assert.equal(placeholder, null);

  const urlOnly = selectOfficialDescription({ description: "https://example.com", readme: "" });
  assert.equal(urlOnly, null);
});

test("README introduction is enriched with a distinct repository description", () => {
  const official = selectOfficialDescription({
    description: "Reusable agent skill packaging toolkit.",
    readme: NOISY_README,
  });
  assert.equal(official.provenance, DESCRIPTION_PROVENANCE.README);
  assert.ok(official.text.startsWith("Reusable agent skill packaging toolkit."));
  assert.ok(official.text.length <= 360);
  assert.doesNotMatch(official.text, /\*\*|\[[^\]]+\]\([^)]+\)/);
});

test("official description stays primary and sponsor paragraphs are excluded", () => {
  const official = selectOfficialDescription({
    description: "AI video generator.",
    readme: `# Video tool

只需提供主题，即可自动生成视频脚本、匹配素材、生成字幕和背景音乐，并合成高清短视频。

感谢 Kimi 赞助本项目！Kimi 是我们最强的开源朋友。`,
  });
  assert.ok(official.text.startsWith("AI video generator."));
  assert.match(official.text, /自动生成视频脚本/);
  assert.doesNotMatch(official.text, /赞助|开源朋友/);
});

test("source fallback selects specific functional sentences and rejects noise", () => {
  const sourcePosts = [
    { title: "Found a gem", content: "Check this out!! Amazing repo, give it a star ⭐ https://github.com/foo/bar" },
    { title: "Repo notes", content: "This automates converting Figma files into React components and generates a full design system." },
    { title: "More stars", content: "Already at 12k stars and climbing, absolute must-have." },
    { title: "Second detail", content: "It also schedules nightly exports and syncs the output to an S3 bucket automatically." },
  ];
  const fallback = synthesizeSourceFallback({ sourcePosts });
  assert.ok(fallback);
  assert.equal(fallback.provenance, DESCRIPTION_PROVENANCE.SOURCES);
  assert.ok(fallback.text.length <= 320);
  assert.ok(/automates converting Figma files/.test(fallback.text));
  assert.ok(/schedules nightly exports/.test(fallback.text));
  assert.ok(!/https?:\/\//.test(fallback.text));
  assert.ok(!/star/i.test(fallback.text));
  assert.ok(!/Check this out/i.test(fallback.text));
});

test("source fallback extracts specific Chinese capabilities without keeping collection hype", () => {
  const sourcePosts = [
    { title: "值得收藏的技能合集", content: "我精心整理了 12 个必装项目，已经 3.6 万星。" },
    { title: "实际用途", content: "这个仓库教 AI 正确使用 Obsidian，并帮助它保留双链、属性和 Callout。" },
  ];
  const fallback = synthesizeSourceFallback({ sourcePosts });
  assert.ok(fallback);
  assert.equal(fallback.provenance, DESCRIPTION_PROVENANCE.SOURCES);
  assert.match(fallback.text, /教 AI 正确使用 Obsidian/);
  assert.doesNotMatch(fallback.text, /必装|万星|精心整理/);
});

test("source fallback returns null when only marketing or generic collection language is available", () => {
  const sourcePosts = [
    { title: "List", content: "A curated list of awesome developer tools you must try." },
    { title: "Promo", content: "Follow us and retweet to win, this is a game-changer!" },
  ];
  assert.equal(synthesizeSourceFallback({ sourcePosts }), null);
});

test("generic fallback is honest about missing official and source-grounded text", () => {
  const fallback = synthesizeTopicsFallback({ owner: "acme", name: "widgets", topics: ["software", "workflow"] });
  assert.equal(fallback.provenance, DESCRIPTION_PROVENANCE.TOPICS);
  assert.equal(fallback.text,
    "acme/widgets：目前只确认它与软件开发、工作流与自动化有关，官方介绍与可用的来源总结仍待补充。");

  const emptyTopics = synthesizeTopicsFallback({ owner: "acme", name: "widgets", topics: [] });
  assert.match(emptyTopics.text, /还没有确认具体用途/);
});

test("selectRepositoryDescription follows official GitHub > sources > topics priority", () => {
  const withReadme = selectRepositoryDescription({
    owner: "acme", name: "widgets", description: "", readme: NOISY_README, topics: [], sourcePosts: [],
  });
  assert.equal(withReadme.provenance, DESCRIPTION_PROVENANCE.README);

  const withSourcesOnly = selectRepositoryDescription({
    owner: "acme", name: "widgets", description: "", readme: "",
    topics: ["software"],
    sourcePosts: [{ title: "Detail", content: "It automatically converts markdown notes into a searchable knowledge base." }],
  });
  assert.equal(withSourcesOnly.provenance, DESCRIPTION_PROVENANCE.SOURCES);

  const withNothing = selectRepositoryDescription({ owner: "acme", name: "widgets", topics: [] });
  assert.equal(withNothing.provenance, DESCRIPTION_PROVENANCE.TOPICS);
});
