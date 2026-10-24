import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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

test("X originals and media are owner-only even for legacy public rows", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "omnihub-public-x-"));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(port), OMNIHUB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError = "";
  child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  const request = (route, { method = "GET", cookie = "", body, headers = {} } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) break;
      try { if ((await request("/")).ok) { ready = true; break; } }
      catch { /* wait for local server */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, `local server did not start: ${serverError}`);
    assert.equal((await request("/api/x-bookmarks")).status, 401);

    const register = async (username) => {
      const response = await request("/api/register", {
        method: "POST", body: { username, password: "temporary-test-password" },
      });
      assert.equal(response.status, 200);
      return { user: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
    };
    const owner = await register("zane");
    const guest = await register("viewer");
    const nameVariant = await register("Zane");
    assert.ok(owner.cookie && guest.cookie);
    assert.equal(nameVariant.user.fullAccess, false);

    const saved = await request("/api/inbox/import", { method: "POST", cookie: owner.cookie, body: {
      items: [
        { source: "manual", externalId: "private-note", title: "私有笔记", content: "不能公开的正文" },
        { source: "x", externalId: "123", title: "可看的 X 收藏", author: "@writer",
          url: "https://user:pass@x.com/writer/status/123?token=private#frag", content: "介绍一个有用的方法",
          media: [{ type: "photo", url: "https://pbs.twimg.com/media/example.jpg", privateField: "hidden" },
            { type: "video", preview_image_url: "https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg",
              variants: [
                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/playlist.m3u8", bitrate: 9000 },
                { content_type: "video/mp4", url: "https://untrusted.example/unsafe.mp4", bitrate: 9000 },
                { content_type: "video/mp4", url: "http://video.twimg.com/insecure.mp4", bitrate: 8000 },
                { content_type: "video/mp4", url: "https://video.twimg.com/low.mp4", bitrate: 2000 },
                { content_type: "video/mp4", url: "https://video.twimg.com/high.mp4?tag=12#fragment", bitrate: 4000 },
              ] },
            { type: "animated_gif", preview_image_url: "https://pbs.twimg.com/gif-poster.jpg",
              variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/gif.mp4" }] }],
          links: ["https://example.com/reference"],
          metrics: { postCreatedAt: "2026-09-19T10:00:00Z", likes: 5, authorId: "private-id" },
          aiType: "knowledge", aiSummary: "简短总结",
          aiExtract: { xOrganization: { topic: "software", assetType: "knowledge", groupId: "g1",
            groupTitle: "同一主题", coverage: "complete", typeSafe: { privateDecision: "hidden" } },
          xDigest: { summary: "内容提要", status: "source_excerpt", sourceHash: "internal" } } },
        { source: "x", externalId: "x-ignored", title: "不展示的 X 收藏", content: "已有处理的正文" },
      ],
    } });
    assert.equal(saved.status, 200);
    const { ids } = await saved.json();
    assert.equal(ids.length, 3);
    assert.equal((await request(`/api/inbox/${ids[2]}/ignore`, { method: "POST", cookie: owner.cookie, body:{} })).status, 200);

    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    try {
      db.prepare(`INSERT INTO inbox (user_id, source, external_id, title, content)
        VALUES (?, 'x', 'guest-x', 'Other user X', 'Other user content')`).run(guest.user.id);
      db.prepare(`INSERT INTO inbox (user_id, source, external_id, title, url, content)
        VALUES (?, 'x', '999', 'Not an X permalink', 'javascript:alert(1)', 'Private manual text')`)
        .run(owner.user.id);
      db.prepare(`INSERT INTO inbox_subjects
        (user_id, inbox_id, subject_id, subject_title, confidence, relationship, model)
        VALUES (?, ?, 'g1', '跨作者合集', 0.9, 'related', 'test-model')`)
        .run(owner.user.id, ids[1]);
      db.prepare(`INSERT INTO inbox (user_id, source, external_id, title, url, content, media, visibility)
        VALUES (?, 'x', '456', '私密锻炼', 'https://x.com/coach/status/456',
          '仅本人查看的锻炼内容', '[{"type":"video","preview_image_url":"https://pbs.twimg.com/media/private.jpg","variants":[{"content_type":"video/mp4","url":"https://video.twimg.com/private.mp4"}]}]', 'private')`)
        .run(owner.user.id);
      db.prepare(`INSERT INTO inbox (user_id, source, external_id, title, url, content)
        VALUES (?, 'x', '789', '待审核内容', 'https://x.com/writer/status/789', '尚未公开')`)
        .run(owner.user.id);
    } finally { db.close(); }

    assert.equal((await request("/api/x-bookmarks")).status, 401);
    assert.equal((await request(`/api/inbox/${ids[1]}/visibility`, { method: "PUT", cookie: guest.cookie,
      body: { visibility: "public" } })).status, 403);
    assert.equal((await request(`/api/inbox/${ids[1]}/visibility`, { method: "PUT", cookie: nameVariant.cookie,
      body: { visibility: "public" } })).status, 403);
    assert.equal((await request(`/api/inbox/${ids[1]}/visibility`, { method: "PUT", cookie: owner.cookie,
      body: { visibility: "everyone" } })).status, 400);
    assert.equal((await request(`/api/inbox/${ids[1]}/visibility`, { method: "PUT", cookie: owner.cookie,
      body: { visibility: "public" } })).status, 200);

    for (const cookie of ["", guest.cookie, nameVariant.cookie]) {
      const expected = cookie ? 200 : 401;
      for (const route of ["/api/x-bookmarks", "/api/account/x", "/api/x-media/1/" + "a".repeat(64)]) {
        const response = await request(route, { cookie, headers: { "If-None-Match": '"previously-public"' } });
        assert.equal(response.status, route.startsWith("/api/x-media/") && cookie ? 404 : expected);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.doesNotMatch(await response.text(), /介绍一个有用的方法|private.jpg|私密锻炼/);
      }
      assert.equal((await request("/api/account/x/connect", { method:"POST", cookie, body:{} })).status,cookie ? 409 : 401);
    }
    const ownerRows = await (await request("/api/x-bookmarks", {cookie:owner.cookie})).json();
    assert.equal(ownerRows.length,4);
    assert.ok(ownerRows.some(row=>row.content==="介绍一个有用的方法"));
    assert.ok(ownerRows.some(row=>row.content==="仅本人查看的锻炼内容"));
    assert.ok(ownerRows.every(row=>row.source==="x" && row.userId!==guest.user.id));
    const connection=await (await request("/api/account/x", {cookie:owner.cookie})).json();
    assert.equal(connection.connected,false);
    assert.equal((await request("/api/account/x/connect", {method:"POST",cookie:owner.cookie,body:{},headers:{Origin:"https://evil.example"}})).status,403);
    assert.equal((await request("/api/account/x/connect", {method:"POST",cookie:owner.cookie,body:{}})).status,409);
    assert.equal((await request("/api/account/x/sync-settings", {method:"POST",cookie:owner.cookie,body:{enabled:true}})).status,409);

    assert.equal((await request("/api/inbox")).status, 401);
    const guestInbox = await (await request("/api/inbox", {cookie:guest.cookie})).json();
    assert.equal(guestInbox.length,1);
    assert.equal(guestInbox[0].content,"Other user content");
    assert.deepEqual(await (await request("/api/inbox", {cookie:nameVariant.cookie})).json(),[]);
    assert.equal((await request(`/api/inbox/${ids[1]}`, { cookie: guest.cookie })).status, 404);
    assert.equal((await request("/api/inbox/import", { method: "POST", cookie: guest.cookie,
      body: { content: "own note" } })).status, 200);
    assert.equal((await request(`/api/inbox/${ids[1]}/ignore`, { method: "POST", cookie: guest.cookie, body:{} })).status, 409);
    assert.equal((await request("/api/x-bookmarks", { method: "POST", body: {} })).status, 404);
    const privateInbox = await request("/api/inbox", { cookie: owner.cookie });
    assert.equal(privateInbox.status, 200);
    assert.equal((await privateInbox.json()).length, 5);
    assert.equal((await request(`/api/inbox/${ids[1]}/visibility`, { method: "PUT", cookie: owner.cookie,
      body: { visibility: "private" } })).status, 200);
    assert.equal((await request("/api/x-bookmarks")).status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
