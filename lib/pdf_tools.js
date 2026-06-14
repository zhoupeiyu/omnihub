import { createReadStream } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const MAX_PDF_BYTES = 80 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;

const PRESETS = {
  screen: {
    id: "screen",
    label: "高压缩",
    description: "体积最小，适合传输和归档",
    setting: "/screen",
  },
  ebook: {
    id: "ebook",
    label: "推荐",
    description: "平衡清晰度和文件大小",
    setting: "/ebook",
  },
  printer: {
    id: "printer",
    label: "高质量",
    description: "优先保留细节，压缩较温和",
    setting: "/printer",
  },
};

const jobs = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
  return true;
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function stripEdgeNewline(buffer) {
  let start = 0;
  let end = buffer.length;
  if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
  if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
  return buffer.subarray(start, end);
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rest.length) continue;
    const key = rawKey.toLowerCase();
    result[key] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  return result;
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    const boundaryMatch = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      reject({ status: 400, message: "缺少上传边界，请重新选择 PDF" });
      return;
    }
    const boundary = Buffer.from("--" + (boundaryMatch[1] || boundaryMatch[2]));
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PDF_BYTES + 1024 * 1024) {
        reject({ status: 413, message: "PDF 不能超过 80MB" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const fields = {};
        let file = null;
        for (const rawPart of splitBuffer(body, boundary)) {
          let part = stripEdgeNewline(rawPart);
          if (!part.length || part.equals(Buffer.from("--"))) continue;
          if (part.subarray(0, 2).toString() === "--") continue;
          const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
          if (headerEnd === -1) continue;
          const headerText = part.subarray(0, headerEnd).toString("utf8");
          const content = stripEdgeNewline(part.subarray(headerEnd + 4));
          const headers = Object.fromEntries(headerText.split("\r\n").map((line) => {
            const idx = line.indexOf(":");
            return idx === -1 ? ["", ""] : [line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim()];
          }));
          const disposition = parseContentDisposition(headers["content-disposition"] || "");
          if (!disposition.name) continue;
          if (disposition.filename != null) {
            file = {
              field: disposition.name,
              filename: path.basename(disposition.filename || "document.pdf"),
              contentType: headers["content-type"] || "application/pdf",
              buffer: content,
            };
          } else {
            fields[disposition.name] = content.toString("utf8");
          }
        }
        resolve({ fields, file });
      } catch (err) {
        reject({ status: 400, message: "解析上传文件失败" });
      }
    });
    req.on("error", () => reject({ status: 400, message: "读取上传文件失败" }));
  });
}

function safePdfName(name) {
  const base = path.basename(name || "document.pdf").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return base.toLowerCase().endsWith(".pdf") ? base : base + ".pdf";
}

function compressedName(name) {
  const safe = safePdfName(name);
  return safe.replace(/\.pdf$/i, "_compressed.pdf");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    return false;
  }
}

async function resolveGhostscript() {
  const candidates = [
    process.env.GS_PATH,
    "/opt/homebrew/bin/gs",
    "/usr/local/bin/gs",
    "/usr/bin/gs",
    "/Users/zhoupeiyu/Path/playground/PDFCompression/third_party/ghostscript/bin/gs",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "gs";
}

function updateProgressFromGhostscript(job, line) {
  const rangeMatch = line.match(/Processing pages\s+\d+\s+through\s+(\d+)/i);
  if (rangeMatch) {
    job.totalPages = Number(rangeMatch[1]) || job.totalPages;
    job.phase = "compressing";
    job.message = line.trim();
  }
  const pageMatch = line.match(/Page\s+(\d+)/i);
  if (pageMatch) {
    job.currentPage = Number(pageMatch[1]) || job.currentPage;
    job.phase = "compressing";
    job.message = line.trim();
  }
  if (job.totalPages && job.currentPage) {
    job.progress = Math.min(92, 12 + Math.round((job.currentPage / job.totalPages) * 78));
  } else if (job.phase === "compressing") {
    job.progress = Math.min(85, job.progress + 3);
  }
}

async function cleanupJob(job) {
  if (!job || job.cleaned) return;
  job.cleaned = true;
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

function scheduleCleanup(job) {
  setTimeout(() => {
    jobs.delete(job.id);
    cleanupJob(job);
  }, JOB_TTL_MS).unref?.();
}

async function runCompression(job, preset) {
  try {
    const gs = await resolveGhostscript();
    job.phase = "preparing";
    job.progress = 8;
    const args = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      `-dPDFSETTINGS=${preset.setting}`,
      "-dNOPAUSE",
      "-dBATCH",
      "-sOutputFile=" + job.outputPath,
      job.inputPath,
    ];
    const child = spawn(gs, args, { cwd: job.dir });
    job.progress = 12;
    job.phase = "compressing";
    const logs = [];
    const onData = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        logs.push(line.trim());
        updateProgressFromGhostscript(job, line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      job.status = "error";
      job.phase = "error";
      job.error = err.code === "ENOENT"
        ? "找不到 Ghostscript。请先在服务器安装 ghostscript，或设置 GS_PATH。"
        : err.message;
      job.progress = 100;
      scheduleCleanup(job);
    });
    child.on("close", async (code) => {
      if (job.status === "error") return;
      if (code !== 0) {
        job.status = "error";
        job.phase = "error";
        job.error = logs.slice(-8).join("\n") || "PDF 压缩失败";
        job.progress = 100;
        scheduleCleanup(job);
        return;
      }
      const output = await stat(job.outputPath).catch(() => null);
      if (!output || output.size <= 0) {
        job.status = "error";
        job.phase = "error";
        job.error = "压缩完成但没有生成文件";
        job.progress = 100;
        scheduleCleanup(job);
        return;
      }
      job.status = "done";
      job.phase = "done";
      job.progress = 100;
      job.outputBytes = output.size;
      job.savedBytes = Math.max(0, job.inputBytes - job.outputBytes);
      job.compressionRatio = job.inputBytes
        ? Math.max(0, Math.round((job.savedBytes / job.inputBytes) * 1000) / 10)
        : 0;
      scheduleCleanup(job);
    });
  } catch (err) {
    job.status = "error";
    job.phase = "error";
    job.error = err.message || "PDF 压缩失败";
    job.progress = 100;
    scheduleCleanup(job);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    currentPage: job.currentPage,
    totalPages: job.totalPages,
    message: job.message,
    error: job.error,
    file: {
      name: job.originalName,
      size: job.inputBytes,
      type: "application/pdf",
    },
    result: job.status === "done" ? {
      outputName: job.outputName,
      outputBytes: job.outputBytes,
      savedBytes: job.savedBytes,
      compressionRatio: job.compressionRatio,
      downloadUrl: `/api/tools/pdf-compress/${job.id}/download`,
    } : null,
  };
}

export async function createPdfCompressionJob(req, res) {
  const { fields, file } = await readMultipart(req);
  if (!file || file.field !== "pdf") throw { status: 400, message: "请选择 PDF 文件" };
  if (file.buffer.length > MAX_PDF_BYTES) throw { status: 413, message: "PDF 不能超过 80MB" };
  const header = file.buffer.subarray(0, 1024).toString("latin1");
  if (!header.includes("%PDF")) throw { status: 400, message: "文件不是有效 PDF" };
  const preset = PRESETS[fields.preset] || PRESETS.ebook;
  const id = randomUUID();
  const dir = path.join(os.tmpdir(), "omnihub-pdf-" + id);
  await mkdir(dir, { recursive: true });
  const originalName = safePdfName(file.filename);
  const inputPath = path.join(dir, "input.pdf");
  const outputName = compressedName(originalName);
  const outputPath = path.join(dir, outputName);
  await writeFile(inputPath, file.buffer);
  const job = {
    id,
    status: "running",
    phase: "queued",
    progress: 3,
    dir,
    inputPath,
    outputPath,
    outputName,
    originalName,
    inputBytes: file.buffer.length,
    outputBytes: 0,
    savedBytes: 0,
    compressionRatio: 0,
    currentPage: 0,
    totalPages: null,
    message: "准备压缩",
    error: "",
  };
  jobs.set(id, job);
  runCompression(job, preset);
  return sendJson(res, 200, publicJob(job));
}

export function getPdfCompressionJob(res, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: "任务不存在或已过期" });
  return sendJson(res, 200, publicJob(job));
}

export async function downloadPdfCompressionJob(res, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: "任务不存在或已过期" });
  if (job.status !== "done") return sendJson(res, 409, { error: "任务还没有完成" });
  const exists = await stat(job.outputPath).then(() => true).catch(() => false);
  if (!exists) return sendJson(res, 404, { error: "压缩文件已清理，请重新压缩" });
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.outputName)}`,
    "Cache-Control": "no-store",
  });
  createReadStream(job.outputPath).pipe(res);
  return true;
}
