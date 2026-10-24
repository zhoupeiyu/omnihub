import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 1]);

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("media settings, uploads, generation recovery and private files", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-media-test-"));
  const appPort = await availablePort();
  let createCalls = 0;
  let queryCalls = 0;
  const remoteKinds = new Map();
  let remoteRequest = null;
  const upstream = createServer(async (req, res) => {
    if (req.url === "/result.png" || req.url === "/result.mp4") {
      const video = req.url === "/result.mp4";
      res.writeHead(200, { "Content-Type": video ? "video/mp4" : "image/png" });
      res.end(video ? MP4 : PNG);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/support/open_api/create") {
      createCalls += 1;
      remoteRequest = req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(body.toString()) : body.toString();
      remoteKinds.set(`remote-${createCalls}`, remoteRequest.module === "seedance" ? "video" : "image");
      res.end(JSON.stringify({ code: 0, msg: "success", body: { id: `remote-${createCalls}`, status: "init" } }));
    } else if (req.url === "/support/open_api/query") {
      queryCalls += 1;
      const remoteId = JSON.parse(body.toString()).ids[0];
      res.end(JSON.stringify({ code: 0, msg: "success", body: [{
        id: remoteId, status: "success", error: "",
        result: { url: `http://127.0.0.1:${upstream.address().port}/${remoteKinds.get(remoteId) === "video" ? "result.mp4" : "result.png"}` },
      }] }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(appPort), OMNIHUB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, `server did not start: ${stderr}`);
    const register = await fetch(`${base}/api/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "zane", password: "temporary-test-password" }),
    });
    assert.equal(register.status, 200);
    const cookie = register.headers.get("set-cookie").split(";")[0];
    const request = (route, method = "GET", body) => fetch(`${base}${route}`, {
      method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    assert.equal((await request("/api/media/config")).status, 200);
    const crossSiteWrite = await fetch(`${base}/api/media/config`, {
      method: "PUT", headers: { Cookie: cookie, Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://attacker.example", authentication: "not-written" }),
    });
    assert.equal(crossSiteWrite.status, 403);
    const insecure = await request("/api/media/config", "PUT", {
      baseUrl: "http://example.com:9001", authentication: "private-test-token",
    });
    assert.equal(insecure.status, 400);
    const documented = await request("/api/media/config", "PUT", {
      baseUrl: "http://39.96.116.239:9001", authentication: "private-test-token",
    });
    assert.equal(documented.status, 200);
    assert.equal((await documented.json()).baseUrl, "http://39.96.116.239:9001");
    const authOnly = await request("/api/media/config", "PUT", {
      baseUrl: "", authentication: "private-test-token",
    });
    assert.equal(authOnly.status, 200);
    const savedAuth = await authOnly.json();
    assert.equal(savedAuth.baseUrl, "");
    assert.equal(savedAuth.hasAuthentication, true);
    assert.ok(!JSON.stringify(savedAuth).includes("private-test-token"));
    const noEndpoint = await request("/api/media/jobs", "POST", {
      requestKey: "media-no-endpoint-001", module: "image", model: "nano-banana-pro",
      mode: "image", prompt: "山间日出", acceptUnknownCost: true,
    });
    assert.equal(noEndpoint.status, 400);
    assert.match((await noEndpoint.json()).error, /接口地址/);
    assert.equal(createCalls, 0);
    const configured = await request("/api/media/config", "PUT", {
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      authentication: "private-test-token", sysToken: "test-platform-token",
    });
    assert.equal(configured.status, 200);
    const config = await configured.json();
    assert.equal(config.hasAuthentication, true);
    assert.ok(!JSON.stringify(config).includes("private-test-token"));
    assert.ok(!JSON.stringify(config).includes("test-platform-token"));

    const prompt = await request("/api/prompts", "POST", { title: "山间提示词", text: "山间日出" });
    assert.equal(prompt.status, 200);
    const promptId = (await prompt.json()).id;
    const imagePrompt = await request("/api/prompts", "POST", {
      title: "带效果图的提示词", text: "蓝色的花", image: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    assert.equal(imagePrompt.status, 200);
    const imagePromptId = (await imagePrompt.json()).id;
    const imported = await request("/api/media/assets/import-source", "POST", {
      sourceType: "prompt", sourceId: imagePromptId, mediaIndex: 0,
    });
    assert.equal(imported.status, 201);
    const importedReference = await imported.json();
    assert.equal(importedReference.origin, "reference");
    assert.equal(importedReference.promptId, imagePromptId);
    assert.deepEqual(Buffer.from(await (await request(`/api/media/assets/${importedReference.id}/file`)).arrayBuffer()), PNG);
    const upload = await fetch(`${base}/api/media/assets/upload?title=reference&sourceType=prompt&sourceId=${promptId}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "image/png" }, body: PNG,
    });
    assert.equal(upload.status, 201);
    const reference = await upload.json();
    assert.equal(reference.kind, "image");
    assert.equal(reference.sourceId, promptId);
    assert.ok(!("fileName" in reference));
    const file = await request(`/api/media/assets/${reference.id}/file`);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
    const partial = await fetch(`${base}/api/media/assets/${reference.id}/file`, {
      headers: { Cookie: cookie, Range: "bytes=0-7" },
    });
    assert.equal(partial.status, 206);
    assert.equal((await partial.arrayBuffer()).byteLength, 8);
    assert.equal((await fetch(`${base}/api/media/assets/${reference.id}/file`)).status, 401);

    const key = "media-test-idempotent-001";
    const input = {
      requestKey: key, module: "image", model: "nano-banana-pro", mode: "image",
      title: "山间图片", prompt: "山间日出", size: "1k", aspectRatio: "16:9",
      sourceType: "prompt", sourceId: promptId, acceptUnknownCost: true,
    };
    assert.equal((await request("/api/media/jobs", "POST", { ...input, acceptUnknownCost: false })).status, 400);
    const create = await request("/api/media/jobs", "POST", input);
    assert.equal(create.status, 201);
    const job = await create.json();
    assert.equal(job.status, "init");
    assert.equal(remoteRequest.authentication, "private-test-token");
    assert.equal(remoteRequest.sys_token, "test-platform-token");
    assert.equal(remoteRequest.module, "image");
    assert.equal(remoteRequest.args.prompt, "山间日出");
    const again = await request("/api/media/jobs", "POST", input);
    assert.equal((await again.json()).id, job.id);
    assert.equal(createCalls, 1);
    // A manual refresh reads the durable cooldown; it cannot force a paid
    // provider query immediately after submission.
    const refresh = await request(`/api/media/jobs/${job.id}/refresh`, "POST");
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json()).status, "init");
    assert.equal(createCalls, 1);
    const testDb = new DatabaseSync(path.join(dataDir, "app.db"));
    testDb.prepare("UPDATE media_jobs SET next_poll_at=0 WHERE id=?").run(job.id);
    testDb.close();
    const dueRefresh = await request(`/api/media/jobs/${job.id}/refresh`, "POST");
    assert.equal(dueRefresh.status, 200);
    const finished = await dueRefresh.json();
    assert.equal(finished.status, "success");
    assert.ok(finished.assetId);
    const asset = (await (await request(`/api/media/assets/${finished.assetId}`)).json());
    assert.equal(asset.origin, "generated");
    assert.equal(asset.promptId, promptId);
    assert.equal(asset.prompt, "山间日出");
    assert.ok(!JSON.stringify(asset).includes("private-test-token"));
    assert.deepEqual(Buffer.from(await (await request(`/api/media/assets/${asset.id}/file`)).arrayBuffer()), PNG);

    const acceptedDb = new DatabaseSync(path.join(dataDir, "app.db"));
    acceptedDb.exec(`CREATE TRIGGER reject_remote_id_after_provider BEFORE UPDATE OF remote_id ON media_jobs
      WHEN NEW.request_key='media-test-local-update-fail-001'
      BEGIN SELECT RAISE(FAIL, 'fixture remote id write failure'); END;`);
    acceptedDb.close();
    const acceptedInput = { ...input, requestKey: "media-test-local-update-fail-001", title: "本地写入失败" };
    const createsBeforeAcceptedWriteFailure = createCalls;
    const acceptedWriteFailure = await request("/api/media/jobs", "POST", acceptedInput);
    assert.equal(acceptedWriteFailure.status, 201);
    const acceptedJob = await acceptedWriteFailure.json();
    assert.equal(acceptedJob.status, "needs_review");
    assert.equal(createCalls, createsBeforeAcceptedWriteFailure + 1);
    const acceptedAgain = await request("/api/media/jobs", "POST", acceptedInput);
    assert.equal((await acceptedAgain.json()).id, acceptedJob.id);
    assert.equal(createCalls, createsBeforeAcceptedWriteFailure + 1);
    const dropTriggerDb = new DatabaseSync(path.join(dataDir, "app.db"));
    dropTriggerDb.exec("DROP TRIGGER reject_remote_id_after_provider");
    dropTriggerDb.close();

    const exhaustedCreate = await request("/api/media/jobs", "POST", {
      ...input, requestKey: "media-test-poll-limit-001", title: "暂停轮询",
    });
    assert.equal(exhaustedCreate.status, 201);
    const exhaustedJob = await exhaustedCreate.json();
    const limitDb = new DatabaseSync(path.join(dataDir, "app.db"));
    limitDb.prepare("UPDATE media_jobs SET poll_attempts=40,next_poll_at=0 WHERE id=?").run(exhaustedJob.id);
    limitDb.close();
    const queriesBeforeLimit = queryCalls;
    const exhaustedRefresh = await request(`/api/media/jobs/${exhaustedJob.id}/refresh`, "POST");
    assert.equal(exhaustedRefresh.status, 200);
    assert.equal((await exhaustedRefresh.json()).status, "needs_review");
    assert.equal(queryCalls, queriesBeforeLimit);

    const nextUpload = await fetch(`${base}/api/media/assets/upload?title=second-version&parentAssetId=${asset.id}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "image/png" }, body: PNG,
    });
    assert.equal(nextUpload.status, 201);
    const secondVersion = await nextUpload.json();
    assert.equal(secondVersion.parentAssetId, asset.id);
    assert.equal(secondVersion.sourceType, "");

    const videoCreate = await request("/api/media/jobs", "POST", {
      requestKey: "media-video-test-001", module: "seedance", model: "seedance2.0",
      mode: "text_video", title: "短视频", prompt: "花开", duration: 5,
      acceptUnknownCost: true,
    });
    assert.equal(videoCreate.status, 201);
    const videoJob = await videoCreate.json();
    assert.equal(remoteRequest.module, "seedance");
    assert.equal(remoteRequest.args.task_type, "text_video");
    const videoDb = new DatabaseSync(path.join(dataDir, "app.db"));
    videoDb.prepare("UPDATE media_jobs SET next_poll_at=0 WHERE id=?").run(videoJob.id);
    videoDb.close();
    const videoRefresh = await request(`/api/media/jobs/${videoJob.id}/refresh`, "POST");
    assert.equal(videoRefresh.status, 200);
    const finishedVideo = await videoRefresh.json();
    assert.equal(finishedVideo.status, "success");
    const videoAsset = await (await request(`/api/media/assets/${finishedVideo.assetId}`)).json();
    assert.equal(videoAsset.kind, "video");
    assert.deepEqual(Buffer.from(await (await request(`/api/media/assets/${videoAsset.id}/file`)).arrayBuffer()), MP4);

    const other = await fetch(`${base}/api/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other", password: "temporary-test-password" }),
    });
    const otherCookie = other.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/api/media/assets/${asset.id}/file`, {
      headers: { Cookie: otherCookie },
    })).status, 404);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
