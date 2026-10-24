#!/usr/bin/env node
// 同步 HowToLiveBetter -> 本地生活指南库 (life_guide_* 表)。
// 仅使用 Node 内置模块；固定公开仓库；绝不执行上游任何代码/钩子/包脚本。
//
// 用法：
//   node scripts/sync-life-guide.mjs --db /abs/app.db --work-dir /abs/work
//   node scripts/sync-life-guide.mjs --db /abs/app.db --work-dir /abs/work --dry-run
//   node scripts/sync-life-guide.mjs --db /abs/app.db --work-dir /abs/work --corpus /abs/corpus
//
// 约定：
//   - 只写 life_guide_* 表；users/knowledge 等其它表一律不动。
//   - --corpus 为离线模式：绝不触网，仅校验并导入。
//   - LICENSE 哈希与冻结值不一致时警告，并保持数据库完全不变。
//   - 跨进程互斥锁位于自有 work-dir，含 owner pid 与死锁回收。
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { buildGuide } from './build-life-guide.mjs';
import { createLifeGuideStore } from '../lib/life-guide-store.js';

const execFileP = promisify(execFile);

// —— 冻结常量 ——
const REPOSITORY = 'https://github.com/eternity4719/HowToLiveBetter';
const FIXED_URL = `${REPOSITORY}.git`;
const LOCKED_LICENSE_SHA256 = '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 120_000;
const ARCHIVE_MAX_BUFFER = 64 * 1024 * 1024; // stdout 上限，仅用于 archive
const LOCK_STALE_MS = 300_000; // 超过即视为僵死锁
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 200;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isUsableCommit = (c) => typeof c === 'string' && COMMIT_RE.test(c) && !/^0{40}$/.test(c);

// 已脱敏的公开错误：code + 安全文本，绝不携带 SQL 或原始路径。
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  err.public = true;
  return err;
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const raw = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run') raw.set('dryRun', true);
    else if (key === 'help') raw.set('help', true);
    else raw.set(key, argv[i + 1]);
  }
  return raw;
}

function requireAbs(value, name) {
  if (!value || typeof value !== 'string' || value.startsWith('--')) {
    throw fail('BAD_ARGS', `${name} 必须是显式绝对路径`);
  }
  if (!path.isAbsolute(value)) throw fail('BAD_ARGS', `${name} 必须是绝对路径`);
  return value;
}

// ---------------------------------------------------------------------------
// 有界、可恢复的互斥锁（位于自有 work-dir 内）
// ---------------------------------------------------------------------------
// —— 跨进程互斥改由自有 work-dir 内的 SQLite sidecar 库实现：
//    BEGIN IMMEDIATE 一旦成功即持有独占锁直至 releaseLock，
//    锁随进程消亡由操作系统回收，绝不 unlink 锁文件。
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA busy_timeout = 200');
  } catch {
    /* 忽略 */
  }
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE'); // 成功即持有跨进程互斥锁，直至 releaseLock
      return db;
    } catch {
      if (Date.now() > deadline) {
        try {
          db.close();
        } catch {
          /* 忽略 */
        }
        throw fail('LOCK_BUSY', '另一个同步进程正在运行，请稍后重试');
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

function releaseLock(db) {
  if (!db) return;
  try {
    db.exec('ROLLBACK'); // 释放 BEGIN IMMEDIATE；进程死亡时由操作系统回收，绝不 unlink 锁文件
  } catch {
    /* 忽略 */
  }
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
}

async function heartbeat() {
  /* SQLite 文件锁随进程消亡由操作系统释放，无需心跳续期。 */
}

// ---------------------------------------------------------------------------
// 语料加载 + 许可证校验（网络与离线共用）
// ---------------------------------------------------------------------------
async function loadCorpus(dir) {
  const corpusPath = path.join(dir, 'corpus.json');
  if (!existsSync(corpusPath)) throw fail('CORPUS_INVALID', 'corpus.json 缺失');
  let corpus;
  try {
    corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
  } catch {
    throw fail('CORPUS_INVALID', 'corpus.json 解析失败');
  }
  if (corpus?.metadata?.repository !== REPOSITORY) throw fail('CORPUS_INVALID', 'corpus repository 与固定仓库不符');
  if (!COMMIT_RE.test(corpus?.metadata?.commit ?? '')) throw fail('CORPUS_INVALID', 'corpus commit 不是 40 位十六进制');
  if (!Array.isArray(corpus?.sections)) throw fail('CORPUS_INVALID', 'corpus sections 无效');

  // LICENSE 双重校验：磁盘真实字节 与 corpus 内 sourceHashes.LICENSE 必须同时等于冻结值。
  const licensePath = path.join(dir, 'LICENSE');
  if (!existsSync(licensePath)) throw fail('LICENSE_MISSING', 'LICENSE 文件缺失，已跳过导入');
  const actualLicense = sha256(await fs.readFile(licensePath));
  const pinnedLicense = corpus?.metadata?.sourceHashes?.LICENSE;
  if (actualLicense !== LOCKED_LICENSE_SHA256 || pinnedLicense !== LOCKED_LICENSE_SHA256) {
    throw fail('LICENSE_CHANGED', 'LICENSE 哈希与冻结值不一致，已跳过导入并保持数据库不变');
  }

  // 用内存库做完整结构/计数/路径/重复校验，随后立即关闭；此时目标库尚未初始化。
  const mem = new DatabaseSync(':memory:');
  try {
    const probe = createLifeGuideStore(mem);
    probe.importCorpus(corpus, {}); // 无条件校验（expectedCommit 省略）
  } catch {
    throw fail('CORPUS_INVALID', 'corpus 结构校验失败');
  } finally {
    try {
      mem.close();
    } catch {
      /* 忽略 */
    }
  }
  return corpus;
}

// ---------------------------------------------------------------------------
// 网络快照：clone/fetch + archive 到自有临时目录（不执行任何上游代码）
// ---------------------------------------------------------------------------
const gitOpts = { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024 };
const gitHardening = ['-c', 'core.hooksPath=/dev/null'];

// 只读探测：确认目录是一个可用的 git 仓库（不修改、不删除任何内容）。
async function isUsableGitDir(dir) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...gitHardening, 'rev-parse', '--absolute-git-dir'], gitOpts);
    const ownGitDir = path.join(path.resolve(dir), '.git');
    const reported = stdout.trim();
    return reported.length > 0 && path.resolve(reported) === ownGitDir;
  } catch {
    return false;
  }
}

// 读取上游 HEAD；仅返回 40 位十六进制提交，绝不执行上游任何代码/钩子/包脚本。
export async function getRemoteHead() {
  const { stdout } = await execFileP('git', [...gitHardening, 'ls-remote', FIXED_URL, 'HEAD'], gitOpts);
  const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
  const sha = first.trim().split(/\s+/)[0] || '';
  if (!isUsableCommit(sha)) throw fail('FETCH_FAILED', '无法解析上游提交');
  return sha;
}

// 把校验通过的临时克隆原子改名到 cache.git；已存在的无效目录一律保留并安全失败。
async function ensureOwnedCacheClone(workDir, cacheDir) {
  if (existsSync(cacheDir)) {
    if (await isUsableGitDir(cacheDir)) return;
    throw fail('CACHE_INVALID', '缓存目录已存在且不可用');
  }
  const tempClone = path.join(workDir, `clone-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await execFileP('git', [...gitHardening, 'clone', '--depth', '1', '--no-checkout', FIXED_URL, tempClone], gitOpts);
    // 先确认是完整仓库，再原子改名，杜绝暴露半成品缓存。
    if (!(await isUsableGitDir(tempClone))) throw fail('CLONE_FAILED', '无法克隆上游仓库');
    await fs.rename(tempClone, cacheDir);
  } catch (err) {
    await fs.rm(tempClone, { recursive: true, force: true }).catch(() => {});
    if (err && err.public) throw err;
    throw fail('CLONE_FAILED', '无法克隆上游仓库');
  }
}

// 受控写入快照元数据：唯一同级临时文件(flag wx) + 原子改名；
// 目标是符号链接时替换链接本体，绝不跟随其外部目标。
export async function writeSnapshotMetadata(directory, metadata) {
  const target = path.join(directory, 'upstream.json');
  const tempPath = path.join(directory, `.upstream-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    const stat = await fs.lstat(target).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (stat && stat.isDirectory()) throw fail('SNAPSHOT_METADATA_FAILED', '快照元数据目标不可用');
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = null;
    await fs.rename(tempPath, target);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if (err && err.public) throw err;
    throw fail('SNAPSHOT_METADATA_FAILED', '无法写入快照元数据');
  }
}

export async function prepareSource(workDir) {
  const cacheDir = path.join(workDir, 'cache.git');
  await ensureOwnedCacheClone(workDir, cacheDir);
  // 始终浅取固定 URL 的 HEAD，FETCH_HEAD 是唯一的提交来源。
  await execFileP('git', ['-C', cacheDir, ...gitHardening, 'fetch', '--depth', '1', FIXED_URL, 'HEAD'], gitOpts);
  const commit = (
    await execFileP('git', ['-C', cacheDir, ...gitHardening, 'rev-parse', 'FETCH_HEAD'], gitOpts)
  ).stdout.trim();
  if (!isUsableCommit(commit)) throw fail('FETCH_FAILED', '无法解析上游提交');

  const tempSource = await fs.mkdtemp(path.join(workDir, 'src-'));
  const tarPath = path.join(workDir, `${path.basename(tempSource)}.tar`);
  let ready = false;
  try {
    // 仅接受 40 位十六进制提交作为 archive 目标，杜绝任意 ref。
    const { stdout: tarBuf } = await execFileP(
      'git',
      ['-C', cacheDir, ...gitHardening, 'archive', '--format=tar', commit],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER, encoding: 'buffer' },
    );
    await fs.writeFile(tarPath, tarBuf);
    await execFileP('tar', ['-xf', tarPath, '-C', tempSource], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024 });

    const dateIso = (
      await execFileP('git', ['-C', cacheDir, ...gitHardening, 'show', '-s', '--format=%cI', commit], gitOpts)
    ).stdout.trim();
    // 与 builder 的约定：写入 {repository(无 .git), commit, date}。
    await writeSnapshotMetadata(tempSource, { repository: REPOSITORY, commit, date: dateIso });
    ready = true;
    return tempSource;
  } finally {
    await fs.rm(tarPath, { force: true }).catch(() => {});
    if (!ready) await fs.rm(tempSource, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// DB 访问
// ---------------------------------------------------------------------------
// 只读检查：不创建库、不建 schema、不经由 factory。
function readContextReadonly(dbPath) {
  if (!existsSync(dbPath)) return { exists: false, commit: null, counts: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // 存在但无法只读打开（损坏/占用）：绝不当作空库，显式标记 invalid
    return { exists: true, commit: null, counts: null, invalid: true };
  }
  try {
    try {
      db.exec('PRAGMA busy_timeout = 200');
    } catch {
      /* 忽略 */
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_guide%'")
      .all()
      .map((r) => r.name);
    for (const candidate of ['life_guide_metadata', 'life_guide_meta']) {
      if (!tables.includes(candidate)) continue;
      let commit = null;
      let counts = null;
      try {
        const row = db.prepare(`SELECT value FROM ${candidate} WHERE key = 'commit'`).get();
        if (row && typeof row.value === 'string') commit = row.value;
      } catch {
        /* 未知结构：保守处理 */
      }
      try {
        const c = { chapters: null, entries: null, docs: null };
        const pairs = [['chapters', 'chapterCount'], ['entries', 'entryCount'], ['docs', 'docCount']];
        for (const [field, key] of pairs) {
          const r = db.prepare(`SELECT value FROM ${candidate} WHERE key = ?`).get(key);
          if (r && r.value != null && Number.isFinite(Number(r.value))) c[field] = Number(r.value);
        }
        counts = c; // 仅只读计数，绝不建表
      } catch {
        /* 忽略 */
      }
      return { exists: true, commit, counts };
    }
    return { exists: true, commit: null, counts: null };
  } catch {
    return { exists: true, commit: null, counts: null, invalid: true };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

function openStore(dbPath) {
  // 仅在显式 --db 目标处允许初始化缺失的数据库；必须在语料完整校验通过后才调用。
  const db = new DatabaseSync(dbPath);
  try {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* WAL 可选 */
    }
    db.exec('PRAGMA busy_timeout = 5000');
    const store = createLifeGuideStore(db);
    return { db, store };
  } catch (err) {
    // 工厂初始化失败也必须关闭句柄
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 同步主流程（可离线导入，便于代表性 fixture 测试）
// ---------------------------------------------------------------------------
export async function syncLifeGuide(options) {
  const startedAt = Date.now();
  const dryRun = options?.dryRun === true;
  const dbPath = requireAbs(options?.db, '--db');
  const workDir = requireAbs(options?.workDir, '--work-dir');
  const corpusDir = options?.corpus ? requireAbs(options.corpus, '--corpus') : null;
  if (!existsSync(workDir)) throw fail('BAD_ARGS', 'work-dir 不存在');

  const lockPath = path.join(workDir, '.life-guide-sync-lock.db');
  let lockDb = null;
  let tempSource = null;
  let tempOut = null;

  try {
    lockDb = await acquireLock(lockPath); // BEGIN IMMEDIATE 持有至 finally

    // —— 锁后立即冻结基线：当前提交只读一次，其后所有比对/CAS 都基于它 ——
    const current = readContextReadonly(dbPath);
    const initial = { previous: isUsableCommit(current?.commit) ? current.commit : null };

    // —— dry-run：只读检查，绝不初始化/写入目标库 ——
    if (dryRun) {
      let next = { commit: null, chapters: null, entries: null, docs: null };
      if (corpusDir) {
        const corpus = await loadCorpus(corpusDir); // 始终完整校验，绝不写库
        next = {
          commit: corpus.metadata.commit,
          chapters: corpus.metadata.chapterCount ?? (corpus.sections?.length ?? null),
          entries: corpus.metadata.entryCount ?? null,
          docs: corpus.metadata.docCount ?? (corpus.docs?.length ?? null),
        };
      } else {
        const remote = await getRemoteHead(); // 在线 dry-run：真正探测远端
        next = { commit: isUsableCommit(remote) ? remote : null, chapters: null, entries: null, docs: null };
      }
      const status = current.commit && next.commit && current.commit === next.commit ? 'unchanged' : 'dry-run';
      const report = {
        status,
        oldCommit: current.commit,
        newCommit: next.commit,
        counts: { chapters: next.chapters, entries: next.entries, docs: next.docs },
        timeMs: Date.now() - startedAt,
      };
      console.log(JSON.stringify(report));
      return report;
    }

    // —— 先取源并完整校验，成功之后才初始化目标库 ——
    let corpus = null; // null 表示在线检测到未变化，无需导入
    let observedRemoteHead = null; // 在线本次观测到的远端提交，未变化fastpath据此判定
    if (corpusDir) {
      corpus = await loadCorpus(corpusDir); // 离线：即使相同提交也始终校验
    } else {
      const remote = await getRemoteHead(); // 固定公开仓库
      observedRemoteHead = isUsableCommit(remote) ? remote : null;
      if (observedRemoteHead && initial.previous && observedRemoteHead === initial.previous) {
        corpus = null; // 未变化：只走 markChecked，绝不 archive/import
      } else {
        tempSource = await prepareSource(workDir);
        tempOut = await fs.mkdtemp(path.join(workDir, 'sync-out-')); // 自有唯一 out，finally 清理
        await buildGuide(tempSource, tempOut);
        corpus = await loadCorpus(tempOut);
      }
    }

    // —— 校验通过：现在才打开实际 store ——
    const { db, store } = openStore(dbPath);
    try {
      // 基线固定为锁后冻结的 initial.previous，绝不重读，避免 CAS 目标漂移
      const previous = initial.previous;
      const commit = corpus ? corpus.metadata.commit : observedRemoteHead;
      const sameCommit = isUsableCommit(previous) && previous === commit;

      if (sameCommit) {
        // 相同提交只刷新 checkedAt；在短暂 IMMEDIATE 事务内复核 live 是否仍等于本次冻结的提交
        db.exec('BEGIN IMMEDIATE');
        try {
          const live = typeof store.getCommit === 'function' ? store.getCommit() : null;
          if (isUsableCommit(live) && live === commit) {
            await store.markChecked();
            db.exec('COMMIT');
          } else {
            db.exec('ROLLBACK');
            throw fail('VERSION_CHANGED', '数据库提交在同步期间发生变化，请重试');
          }
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* 忽略 */
          }
          throw err;
        }
      } else {
        // importCorpus 自带 BEGIN IMMEDIATE 原子导入，切勿再包裹嵌套事务
        await store.importCorpus(corpus, { expectedCommit: previous, recordChecked: true }); // CAS 携带锁后基线（含 null），保护并发写入
      }

      const meta = store.metadata?.() ?? {};
      const m = meta.metadata ?? {};
      const report = {
        status: sameCommit ? 'unchanged' : 'updated',
        oldCommit: isUsableCommit(previous) ? previous : null,
        newCommit: commit,
        counts: {
          chapters: m.chapterCount ?? corpus?.metadata?.chapterCount ?? corpus?.sections?.length ?? null,
          entries: m.entryCount ?? corpus?.metadata?.entryCount ?? null,
          docs: m.docCount ?? corpus?.metadata?.docCount ?? corpus?.docs?.length ?? null,
        },
        timeMs: Date.now() - startedAt,
      };
      console.log(JSON.stringify(report));
      return report;
    } finally {
      if (typeof store.close === 'function') store.close();
      db.close();
    }
  } catch (err) {
    const isPublic = err?.public === true || err?.code === 'DB_INVALID';
    const code = isPublic ? err.code : 'SYNC_FAILED';
    const message = isPublic ? err.message : '同步失败，请稍后重试';
    console.error(JSON.stringify({ status: 'error', error: { code, message } }));
    throw fail(code, message);
  } finally {
    releaseLock(lockDb); // ROLLBACK + close，即使失败也释放
    if (tempSource) await fs.rm(tempSource, { recursive: true, force: true }).catch(() => {});
    if (tempOut) await fs.rm(tempOut, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.get('help')) {
    console.log('usage: node scripts/sync-life-guide.mjs --db <abs> --work-dir <abs> [--dry-run] [--corpus <abs>]');
    process.exit(0);
  }
  syncLifeGuide({
    db: raw.get('db'),
    workDir: raw.get('work-dir') ?? raw.get('workDir'),
    corpus: raw.get('corpus') ?? null,
    dryRun: raw.get('dryRun') === true,
  })
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
}
