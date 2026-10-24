// 离线测试：writeSnapshotMetadata 的符号链接替换语义与目标目录失败语义。
// 绝不触网、绝不执行上游代码/钩子/包脚本，也不读写真实 app.db。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSnapshotMetadata } from '../scripts/sync-life-guide.mjs';

const LICENSE_FIXTURE = fileURLToPath(new URL('./fixtures/life-guide-LICENSE', import.meta.url));
const REPOSITORY = 'https://github.com/eternity4719/HowToLiveBetter';
const COMMIT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const DATE = '2024-01-02T03:04:05+00:00';

const makeTempDir = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));
const seedLicense = (dir) => fs.copyFile(LICENSE_FIXTURE, path.join(dir, 'LICENSE'));
const residue = (entries) => entries.filter((name) => name.startsWith('.upstream-'));

test('writeSnapshotMetadata 替换符号链接本体，外部目标保持不变', async () => {
  const sourceDir = await makeTempDir('lg-sync-src-');
  const externalDir = await makeTempDir('lg-sync-ext-');
  try {
    await seedLicense(sourceDir);
    const sentinel = path.join(externalDir, 'sentinel.txt');
    await fs.writeFile(sentinel, 'EXTERNAL-SENTINEL', 'utf8');
    await fs.symlink(sentinel, path.join(sourceDir, 'upstream.json'));

    await writeSnapshotMetadata(sourceDir, { repository: REPOSITORY, commit: COMMIT, date: DATE });

    const target = await fs.lstat(path.join(sourceDir, 'upstream.json'));
    assert.equal(target.isSymbolicLink(), false);
    assert.equal(target.isFile(), true);

    const written = JSON.parse(await fs.readFile(path.join(sourceDir, 'upstream.json'), 'utf8'));
    assert.deepEqual(written, { repository: REPOSITORY, commit: COMMIT, date: DATE });

    assert.equal(await fs.readFile(sentinel, 'utf8'), 'EXTERNAL-SENTINEL');

    await seedLicense(sourceDir);
    assert.deepEqual(
      await fs.readFile(path.join(sourceDir, 'LICENSE')),
      await fs.readFile(LICENSE_FIXTURE),
    );
    assert.deepEqual(residue(await fs.readdir(sourceDir)), []);
  } finally {
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(externalDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('已存在的 upstream.json 目录：安全失败并保留目录，无残留临时文件', async () => {
  const sourceDir = await makeTempDir('lg-sync-src-');
  try {
    await seedLicense(sourceDir);
    const dirTarget = path.join(sourceDir, 'upstream.json');
    await fs.mkdir(dirTarget);
    await fs.writeFile(path.join(dirTarget, 'keep.txt'), 'keep-me', 'utf8');

    const before = (await fs.readdir(sourceDir)).sort();

    await assert.rejects(
      () => writeSnapshotMetadata(sourceDir, { repository: REPOSITORY, commit: COMMIT, date: DATE }),
      (err) => err && err.code === 'SNAPSHOT_METADATA_FAILED',
    );

    assert.equal((await fs.lstat(dirTarget)).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(dirTarget, 'keep.txt'), 'utf8'), 'keep-me');
    assert.deepEqual((await fs.readdir(sourceDir)).sort(), before);
    assert.deepEqual(residue(await fs.readdir(sourceDir)), []);
  } finally {
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  }
});
