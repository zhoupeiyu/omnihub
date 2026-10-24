import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("X import API labels partial data and upgrades it when complete data arrives", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-x-api-"));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(port), OMNIHUB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError = "";
  child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) { ready = true; break; }
      } catch { /* wait for local server */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, `local server did not start: ${serverError}`);

    const register = await fetch(`${base}/api/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "zane", password: "temporary-test-password" }),
    });
    assert.equal(register.status, 200);
    const cookie = register.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const post = (coverage, content, contentIncomplete) => JSON.stringify({
      externalId: "123", content, url: "https://x.com/writer/status/123", author: "@writer",
      media: [], links: [], metrics: {},
      organization: { coverage, groupId: "123", assetType: "knowledge", topic: "software",
        assetConfidence: 0.9, contentIncomplete },
    });
    const importBatch = async (text, allowPartial = false) => fetch(`${base}/api/inbox/import/x`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text, allowPartial }),
    });

    assert.equal((await importBatch(post("partial_ui_scan", "fragment", true))).status, 400);
    const partial = await importBatch(post("partial_ui_scan", "fragment", true), true);
    assert.deepEqual(await partial.json(), { imported: 1, updated: 0, skipped: 0, total: 1 });
    const full = await importBatch(post("complete", "complete text", false));
    assert.deepEqual(await full.json(), { imported: 0, updated: 1, skipped: 0, total: 1 });
    const inbox = await fetch(`${base}/api/inbox`, { headers: { Cookie: cookie } });
    const rows = await inbox.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "complete text");
    assert.equal(JSON.parse(rows[0].aiExtract).xOrganization.coverage, "complete");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
