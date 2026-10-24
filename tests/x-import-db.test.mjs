import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a complete X export upgrades an imported partial post without duplicating it", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "omnihub-x-db-"));
  const code = `
    import { db, importInboxItems } from "./lib/db.js";
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'test', 'hash', 'salt')").run();
    const item = (coverage, content, contentIncomplete) => ({
      source: "x", externalId: "123", title: "Example", url: "https://x.com/writer/status/123",
      author: "@writer", content, media: "[]", links: "[]", metrics: "{}",
      aiType: "knowledge", aiConfidence: 0.9, aiSummary: "",
      aiExtract: JSON.stringify({ xOrganization: { coverage, contentIncomplete, topic: "software", groupId: "123" } }),
    });
    const first = importInboxItems(1, [item("partial_ui_scan", "fragment", true)]);
    const duplicate = importInboxItems(1, [item("partial_ui_scan", "fragment", true)]);
    const scanned = importInboxItems(1, [item("partial_xarchive_scan", "full text from guarded scan", false)]);
    const downgrade = importInboxItems(1, [item("partial_ui_scan", "fragment", true)]);
    const upgrade = importInboxItems(1, [item("complete", "complete text", false)]);
    const row = db.prepare("SELECT id, content, ai_extract AS aiExtract FROM inbox WHERE user_id = 1 AND source = 'x'").get();
    const final = importInboxItems(1, [item("complete", "complete text", false)]);
    console.log(JSON.stringify({ first, duplicate, scanned, downgrade, upgrade, final,
      count: db.prepare("SELECT count(*) AS count FROM inbox WHERE user_id = 1 AND source = 'x'").get().count,
      content: row.content, coverage: JSON.parse(row.aiExtract).xOrganization.coverage }));
    db.close();
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.dirname(new URL(import.meta.url).pathname) + "/..",
      env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.deepEqual(result.first, { imported: 1, updated: 0, skipped: 0, total: 1 });
    assert.deepEqual(result.duplicate, { imported: 0, updated: 0, skipped: 1, total: 1 });
    assert.deepEqual(result.scanned, { imported: 0, updated: 1, skipped: 0, total: 1 });
    assert.deepEqual(result.downgrade, result.duplicate);
    assert.deepEqual(result.upgrade, { imported: 0, updated: 1, skipped: 0, total: 1 });
    assert.deepEqual(result.final, result.duplicate);
    assert.equal(result.count, 1);
    assert.equal(result.content, "complete text");
    assert.equal(result.coverage, "complete");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("X bookmarks sort by actual post time for X's English date format", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "omnihub-x-sort-"));
  const code = `
    import { db, importInboxItems, listInbox } from "./lib/db.js";
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'test', 'hash', 'salt')").run();
    const item = (id, date) => ({ source: "x", externalId: id, title: id,
      content: id, metrics: JSON.stringify({ postCreatedAt: date }),
      aiExtract: JSON.stringify({ xOrganization: { coverage: "partial_xarchive_scan" } }) });
    importInboxItems(1, [
      item("1", "Fri Sep 18 06:23:35 +0000 2026"),
      item("2", "Wed Sep 16 14:29:00 +0000 2026"),
      item("3", ""),
    ]);
    console.log(JSON.stringify(listInbox(1).map((row) => row.externalId)));
    db.close();
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.dirname(new URL(import.meta.url).pathname) + "/..",
      env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), ["1", "2", "3"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("link-only X captures stay out of the inbox and recover when text arrives", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "omnihub-x-empty-"));
  const code = `
    import { db, addInboxItem, archiveContentlessXInboxItems, importInboxItems, listInbox } from "./lib/db.js";
    db.prepare("INSERT INTO users (id, username, password_hash, salt) VALUES (1, 'test', 'hash', 'salt')").run();
    const item = (id, content, media = "[]") => ({
      source: "x", externalId: id, title: id, url: "https://x.com/example/status/" + id,
      author: "@example",
      content, media, links: "[]", metrics: "{}", aiType: "knowledge",
      aiConfidence: 0.5, aiSummary: "",
      aiExtract: JSON.stringify({ xOrganization: { coverage: "partial_xarchive_scan" } }),
    });
    const skipped = importInboxItems(1, [item("link", "https://t.co/example"), item("empty", "")]);
    const media = importInboxItems(1, [item("image", "", '[{"url":"https://example.com/image.jpg"}]')]);
    addInboxItem(1, item("legacy", "https://t.co/old"));
    addInboxItem(1, item("normal", "Useful original text"));
    const archived = archiveContentlessXInboxItems(1);
    const afterArchive = listInbox(1).map((row) => row.externalId);
    const restored = importInboxItems(1, [item("legacy", "Recovered original text")]);
    const afterRestore = listInbox(1).map((row) => row.externalId);
    addInboxItem(1, item("late", "https://t.co/late"));
    const afterLateInsert = listInbox(1).map((row) => row.externalId);
    const legacy = db.prepare("SELECT status, ai_extract AS aiExtract FROM inbox WHERE external_id = 'legacy'").get();
    console.log(JSON.stringify({ skipped, media, archived, afterArchive, restored, afterRestore, afterLateInsert,
      legacyStatus: legacy.status, omission: JSON.parse(legacy.aiExtract).xOmission || null }));
    db.close();
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.dirname(new URL(import.meta.url).pathname) + "/..",
      env: { ...process.env, OMNIHUB_DATA_DIR: dataDir }, encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.deepEqual(result.skipped, { imported: 0, updated: 0, skipped: 2, total: 2 });
    assert.deepEqual(result.media, { imported: 1, updated: 0, skipped: 0, total: 1 });
    assert.deepEqual(result.archived, { scanned: 3, archived: 1 });
    assert.deepEqual(result.afterArchive, ["normal", "image"]);
    assert.deepEqual(result.restored, { imported: 0, updated: 1, skipped: 0, total: 1 });
    assert.deepEqual(result.afterRestore, ["normal", "legacy", "image"]);
    assert.deepEqual(result.afterLateInsert, result.afterRestore);
    assert.equal(result.legacyStatus, "pending");
    assert.equal(result.omission, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
