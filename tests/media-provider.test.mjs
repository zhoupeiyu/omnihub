import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createProviderJob, DOCUMENTED_MEDIA_BASE_URL, normalizeGeneration, parseProviderResponse, queryProviderJobs, validateMediaBaseUrl, validateMediaResultUrl,
} from "../lib/media-provider.js";

test("provider validation keeps each model's request contract", () => {
  assert.throws(() => validateMediaBaseUrl("http://example.com"), (error) => /HTTPS/.test(error.message));
  assert.equal(validateMediaBaseUrl(`${DOCUMENTED_MEDIA_BASE_URL}/`), DOCUMENTED_MEDIA_BASE_URL);
  assert.throws(() => validateMediaBaseUrl(`${DOCUMENTED_MEDIA_BASE_URL}/other`), (error) => /HTTPS/.test(error.message));
  assert.throws(() => validateMediaBaseUrl("http://39.96.116.239:9002"), (error) => /HTTPS/.test(error.message));
  assert.throws(() => validateMediaBaseUrl("https://user:pass@example.com"), (error) => /账号/.test(error.message));
  for(const url of ['https://127.0.0.1:9000','https://10.0.0.1','https://192.168.1.1','https://[::1]','https://[fd00::1]'])
    assert.throws(()=>validateMediaBaseUrl(url),(error)=>/内网|IPv6/.test(error.message));
  assert.equal(validateMediaBaseUrl("http://127.0.0.1:9000/"), "http://127.0.0.1:9000");
  assert.throws(()=>validateMediaResultUrl('https://[::1]/image.png','https://media.example.test'),/不安全/);
  assert.throws(()=>validateMediaResultUrl('https://169.254.169.254/image.png','https://media.example.test'),/不安全/);

  const horse = normalizeGeneration({
    module: "hh1", mode: "text", model: "hh1", prompt: "夜空", duration: 5,
  }, []);
  assert.equal(horse.args.generation_mode, "text");
  assert.equal(horse.args.model, undefined);

  assert.throws(() => normalizeGeneration({
    module: "image", model: "seedream-5.0-pro", prompt: "海边", size: "4k", aspectRatio: "1:1",
  }, []), (error) => /尺寸/.test(error.message));
  assert.throws(() => normalizeGeneration({
    module: "seedance", model: "seedance2.0", mode: "reference_images",
    prompt: "人物行走", faceProcessing: 1,
  }, [{ kind: "image" }]), (error) => /人脸处理参数/.test(error.message));
  assert.throws(() => normalizeGeneration({
    module: "image", model: "nano-banana-pro", prompt: "花".repeat(10001),
  }, []), (error) => /最多 10000/.test(error.message));
});

test("local references use documented multipart create request, query checks business code", async () => {
  let requestBody = "";
  let requestType = "";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = Buffer.concat(chunks).toString("latin1");
    requestType = req.headers["content-type"] || "";
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/create")) {
      res.end(JSON.stringify({ code: 0, body: { id: "test-remote", status: "init" } }));
    } else {
      res.end(JSON.stringify({ code: 1004, msg: "record not found", body: [] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    base_url: `http://127.0.0.1:${server.address().port}`,
    authentication: "test-auth", sys_token: "",
  };
  try {
    const normalized = normalizeGeneration({
      module: "seedance", model: "seedance2.0", mode: "first_last_frame",
      prompt: "花开", duration: 5,
    }, [{ kind: "image" }]);
    const result = await createProviderJob(config, { id: "local-job", ...normalized }, [{
      kind: "image", mimeType: "image/png", name: "reference.png",
      read: async () => Buffer.from("test-image"),
    }]);
    assert.equal(result.id, "test-remote");
    assert.match(requestType, /^multipart\/form-data; boundary=/);
    assert.match(requestBody, /name="authentication"/);
    assert.match(requestBody, /test-auth/);
    assert.match(requestBody, /name="images"; filename="reference.png"/);
    assert.match(requestBody, /"task_type":"first_last_frame"/);
    await assert.rejects(queryProviderJobs(config, ["missing"]), (error) => /业务码 1004/.test(error.message));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('creation treats sent-but-unreadable provider responses as unknown, not retry-safe failures', async () => {
  const config = { base_url: 'http://127.0.0.1:1', authentication: 'test-auth', sys_token: '' };
  for (const response of [
    { status: 502, ok: false, json: async () => { throw new Error('html'); } },
    { status: 200, ok: true, json: async () => { throw new Error('invalid json'); } },
    { status: 200, ok: true, json: () => new Promise(() => {}) },
    { status: 200, ok: true, json: async () => ({}) },
    { status: 200, ok: true, json: async () => [] },
    { status: 200, ok: true, json: async () => ({ code: '0' }) },
  ]) {
    await assert.rejects(() => parseProviderResponse(response, { submission: true, timeoutMs: 10 }), error => error.uncertain === true && /核对任务/.test(error.message));
  }
  await assert.rejects(() => parseProviderResponse({ status: 400, ok: false, json: async () => ({ code: 401 }) }, { submission: true }), error => error.uncertain !== true && /业务码 401/.test(error.message));
  await assert.rejects(() => createProviderJob(config, { id: 'no-network', module: 'image', args: { prompt: 'x' } }, []), error => error.uncertain === true);
});
