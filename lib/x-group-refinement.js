import path from "node:path";
import { classifyXGroupMember, X_GROUP_MEMBER_VERSION } from "./typesafe.js";
import { atomicWrite, buildViews, cachedRefinement, jsonl, mapConcurrent,
  normalizeXInboxRow, sourceRecord } from "./x-refinement-common.js";

export const X_GROUP_TAXONOMIES = {
  obsidian: {
    id: "obsidian",
    title: "Obsidian",
    version: "obsidian-subgroups-v1",
    purpose: "Separate saved Obsidian sources into specific questions that can become practical knowledge articles.",
    subgroups: {
      ai_context_memory: "Connecting Obsidian with Codex, Claude Code, OpenClaw, Hermes, or other agents for persistent context, memory, or an AI knowledge base.",
      capture_ingestion: "Capturing web pages, X bookmarks, videos, transcripts, social content, or other external sources into Obsidian.",
      reading_learning: "Reading books, EPUBs, WeChat Reading, study material, or turning reading into notes and learning workflows.",
      publishing_sync: "Publishing from Obsidian or syncing Obsidian content to a website, Feishu, or another destination.",
      plugins_visualization: "Plugins, themes, dashboards, graph views, statistics, HTML browsing, or visual presentation inside Obsidian.",
      tasks_personal_system: "Task management, card capture, LifeOS, personal planning, or portable Markdown-based personal systems.",
      setup_evaluation: "Getting started, choosing Obsidian, general tutorials, comparisons, and broad setup guidance.",
      product_update: "Obsidian product, CLI, Headless, Publish, or ecosystem updates that do not fit a more specific workflow.",
      exclude: "Obsidian is incidental, the source lacks usable relation, or it belongs only to another product group.",
    },
  },
  openclaw: {
    id: "openclaw",
    title: "OpenClaw",
    version: "openclaw-subgroups-v1",
    purpose: "Separate saved OpenClaw sources into concrete setup, security, memory, automation, and workflow questions that can become practical knowledge articles.",
    subgroups: {
      installation_deployment: "Installing, deploying, configuring, migrating, or operating OpenClaw on a local machine, server, NAS, container, or cloud host.",
      channels_integrations: "Connecting OpenClaw to Telegram, Feishu, WeChat, Discord, browsers, email, APIs, MCP servers, or other external channels and services.",
      memory_knowledge: "Persistent memory, context management, knowledge bases, retrieval, Obsidian integration, or long-running personal context in OpenClaw.",
      automation_scheduling: "Heartbeat, cron, scheduled jobs, monitoring, proactive follow-up, background agents, or reliable recurring automation in OpenClaw.",
      security_permissions: "Sandboxing, access control, secrets, permissions, isolation, prompt injection, remote exposure, or other OpenClaw security practices.",
      skills_extensions: "Creating, installing, organizing, routing, or maintaining OpenClaw skills, plugins, agents, MCP tools, or extension systems.",
      use_cases_workflows: "Specific personal or professional workflows built with OpenClaw, including research, content, coding, reporting, operations, and assistants.",
      product_update: "OpenClaw releases, product announcements, ecosystem changes, capability demonstrations, or broad evaluations that do not fit a more specific workflow.",
      exclude: "OpenClaw is incidental, the source lacks usable relation, or it belongs only to another product group.",
    },
  },
  seedance: {
    id: "seedance",
    title: "Seedance",
    version: "seedance-subgroups-v1",
    purpose: "Separate saved Seedance sources into reusable video prompting and production questions that can become practical knowledge articles.",
    subgroups: {
      prompt_structure: "Reusable Seedance prompt structures, time-coded instructions, shot descriptions, constraints, or templates for predictable generation.",
      camera_motion: "Camera paths, one-shot movement, transitions, framing, lenses, motion language, pacing, or other cinematography controls in Seedance.",
      character_consistency: "Keeping people, faces, costumes, props, locations, or visual identity consistent across Seedance shots or generated clips.",
      narrative_short_drama: "Story beats, dialogue, performance, conflict, hooks, short-drama scenes, advertisements, or narrative construction in Seedance.",
      reference_multimodal: "Using images, video, audio, first/last frames, character sheets, or other reference material to guide Seedance outputs.",
      effects_transformations: "Transformation, VFX, creatures, destruction, physics, stylization, or other effect-heavy Seedance techniques.",
      workflow_tools: "End-to-end production workflows, batch generation, editing, software, skills, repositories, automation, or collaboration around Seedance.",
      product_capability: "Seedance model releases, comparisons, demonstrations, limitations, access, pricing, or broad capability evaluations.",
      exclude: "Seedance is incidental, the source lacks usable relation, or it belongs only to another product group.",
    },
  },
};

function reviewReasons(decision) {
  const reasons = [];
  const confidence = [decision.subgroup, decision.role, decision.evidenceKind, decision.contentSufficiency]
    .map((entry) => Number(entry?.answer?.confidence ?? 0));
  if (Math.min(...confidence) < 0.5) reasons.push("low_confidence");
  if (decision.subgroup.value === "exclude" || decision.role.value === "exclude") reasons.push("exclude");
  if (decision.contentSufficiency.value !== "self_contained") {
    reasons.push(decision.contentSufficiency.value);
  }
  if (!decision.independentContribution.value) reasons.push("weak_contribution");
  if (Number(decision.synthesisValue.value) < 1.5) reasons.push("low_synthesis_value");
  return [...new Set(reasons)];
}

export function selectXSubjectMembers(rows, subjectId) {
  return rows.map(normalizeXInboxRow).filter((item) => item.source === "x" && item.externalId &&
    item.subjectCollections?.some((subject) => subject.id === subjectId));
}

export async function refineXSubjectGroup({ rows, taxonomy, outDir, concurrency = 3,
  classifyImpl = classifyXGroupMember }) {
  if (!path.isAbsolute(outDir)) throw new Error("组内细分输出目录必须是绝对路径");
  if (!taxonomy?.id || !taxonomy?.version) throw new Error("组内细分分类字典无效");
  const members = selectXSubjectMembers(rows, taxonomy.id);
  if (!members.length) throw new Error(`没有找到 ${taxonomy.title} 组成员`);
  const version = `${X_GROUP_MEMBER_VERSION}:${taxonomy.version}`;
  const cacheRoot = path.join(outDir, "decisions");
  const results = await mapConcurrent(members, concurrency, (item) =>
    cachedRefinement(cacheRoot, version, item, (source) => classifyImpl(source, taxonomy)));
  const refined = [];
  const failures = [];
  results.forEach((result, index) => {
    const item = members[index];
    if (!result.ok) {
      failures.push({ externalId: item.externalId, title: item.title,
        error: String(result.error?.message || "未知错误") });
      return;
    }
    refined.push({ externalId: item.externalId, source: sourceRecord(item), facets: result.value });
  });
  const reviews = refined.flatMap((entry) => {
    const reasons = reviewReasons(entry.facets);
    return reasons.length ? [{ externalId: entry.externalId, title: entry.source.title, reasons }] : [];
  });
  const candidates = refined.filter((entry) => entry.facets.subgroup.value !== "exclude" &&
    entry.facets.role.value !== "exclude" && entry.facets.independentContribution.value &&
    entry.facets.contentSufficiency.value === "self_contained" &&
    Number(entry.facets.synthesisValue.value) >= 1.5);
  const views = {
    subgroups: buildViews(refined, (entry) => [entry.facets.subgroup.value]),
    roles: buildViews(refined, (entry) => [entry.facets.role.value]),
    evidenceKinds: buildViews(refined, (entry) => [entry.facets.evidenceKind.value]),
    synthesisCandidates: buildViews(candidates, (entry) => [entry.facets.subgroup.value]),
  };
  const summary = {
    version,
    subject: { id: taxonomy.id, title: taxonomy.title },
    members: members.length,
    processed: refined.length,
    failed: failures.length,
    needsReview: reviews.length,
    synthesisCandidates: candidates.length,
    usage: refined.reduce((total, entry) => ({
      inputTokens: total.inputTokens + entry.facets.usage.inputTokens,
      outputTokens: total.outputTokens + entry.facets.usage.outputTokens,
    }), { inputTokens: 0, outputTokens: 0 }),
    completedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(outDir, "members.refined.jsonl"), jsonl(refined));
  await atomicWrite(path.join(outDir, "synthesis-candidates.jsonl"), jsonl(candidates));
  await atomicWrite(path.join(outDir, "views.json"), views);
  await atomicWrite(path.join(outDir, "needs-review.jsonl"), jsonl(reviews));
  await atomicWrite(path.join(outDir, "failures.jsonl"), jsonl(failures));
  await atomicWrite(path.join(outDir, "summary.json"), summary);
  return summary;
}
