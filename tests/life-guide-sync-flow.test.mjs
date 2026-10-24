// 同步主流程代表性测试：真实 fixture 与真实 LICENSE，仅用临时目录，离线不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { syncLifeGuide } from '../scripts/sync-life-guide.mjs';
import { createLifeGuideStore } from '../lib/life-guide-store.js';

const FIX_CORPUS = fileURLToPath(new URL('./fixtures/life-guide-small.json', import.meta.url));
const FIX_LICENSE = fileURLToPath(new URL('./fixtures/life-guide-LICENSE', import.meta.url));

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// 复制真实 fixture 到临时 corpus 目录：corpus.json + 原样 LICENSE。
async function makeCorpus() {
  const root = await tmp('lg-root-');
  const dir = path.join(root, 'corpus');
  await fs.mkdir(dir);
  const corpusPath = path.join(dir, 'corpus.json');
  await fs.copyFile(FIX_CORPUS, corpusPath); // 真实 fixture，绝不发明哈希/镜像
  await fs.copyFile(FIX_LICENSE, path.join(dir, 'LICENSE')); // 真实冻结 LICENSE 字节
  return { root, dir, corpusPath };
}

function readMetadata(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return createLifeGuideStore(db).metadata();
  } finally {
    db.close();
  }
}

function seedUsers(dbPath, note) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, note TEXT)');
    db.prepare('INSERT INTO users(note) VALUES (?)').run(note);
  } finally {
    db.close();
  }
}

test('初始导入 -> 重复导入 updatedAt 稳定、checkedAt 变化、用户哨兵保留', async () => {
  const { root, dir } = await makeCorpus();
  const work = await tmp('lg-work-');
  const dbPath = path.join(root, 'app.db');
  try {
    seedUsers(dbPath, 'sentinel');

    const first = await syncLifeGuide({ db: dbPath, workDir: work, corpus: dir });
    assert.equal(first.status, 'updated');
    assert.ok(existsSync(dbPath));
    const before = readMetadata(dbPath).metadata;

    await new Promise((r) => setTimeout(r, 30)); // 等待时间戳推进
    const second = await syncLifeGuide({ db: dbPath, workDir: work, corpus: dir });
    assert.equal(second.status, 'unchanged');
    const after = readMetadata(dbPath).metadata;

    assert.equal(after.commit, before.commit);
    assert.equal(after.updatedAt, before.updatedAt); // 未变化保留 updatedAt
    assert.notEqual(after.checkedAt, before.checkedAt); // 仅 checkedAt 变化

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT note FROM users WHERE id = 1').get().note, 'sentinel');
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('dry-run 完整校验且不创建目标 DB 文件', async () => {
  const { root, dir } = await makeCorpus();
  const work = await tmp('lg-work-');
  const dbPath = path.join(root, 'dry.db');
  try {
    const report = await syncLifeGuide({ db: dbPath, workDir: work, corpus: dir, dryRun: true });
    assert.equal(report.status, 'dry-run');
    assert.equal(existsSync(dbPath), false); // 绝不初始化目标库
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('meta/LICENSE 不符、重复项、计数错误：校验先于建库并保留既有数据', async () => {
  const work = await tmp('lg-work-');
  const corruptions = [
    // 1) corpus 记录（metadata.sourceHashes.LICENSE）错误
    async ({ corpusPath }) => {
      const j = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
      j.metadata.sourceHashes = { ...(j.metadata.sourceHashes || {}), LICENSE: '0'.repeat(64) };
      await fs.writeFile(corpusPath, JSON.stringify(j));
    },
    // 2) 磁盘真实 LICENSE 被篡改
    async ({ dir }) => {
      await fs.writeFile(path.join(dir, 'LICENSE'), 'tampered license bytes\n');
    },
    // 3) 重复 entry
    async ({ corpusPath }) => {
      const j = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
      const s = j.sections?.[0];
      assert.ok(s?.entries?.length, 'fixture 应含至少一个 entry 以构造重复项');
      s.entries.push({ ...s.entries[0] });
      await fs.writeFile(corpusPath, JSON.stringify(j));
    },
    // 4) 计数与内容不符
    async ({ corpusPath }) => {
      const j = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
      j.metadata.entryCount = (j.metadata.entryCount ?? 0) + 999;
      await fs.writeFile(corpusPath, JSON.stringify(j));
    },
  ];

  try {
    for (const corrupt of corruptions) {
      const { root, dir, corpusPath } = await makeCorpus();
      const dbPath = path.join(root, 'app.db');
      try {
        seedUsers(dbPath, 'keep');
        await corrupt({ dir, corpusPath });

        await assert.rejects(() => syncLifeGuide({ db: dbPath, workDir: work, corpus: dir }));

        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const lg = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_guide%'")
            .all();
          assert.equal(lg.length, 0); // 校验失败前未创建任何 life_guide 表
          assert.equal(db.prepare('SELECT note FROM users WHERE id = 1').get().note, 'keep');
        } finally {
          db.close();
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});
