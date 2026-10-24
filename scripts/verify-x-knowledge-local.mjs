import path from "node:path";
import { readKnowledgeVerificationInputs,
  verifyKnowledgeDraft } from "../lib/x-citation-verification.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

const articleFile = option("--article");
const sourcesFile = option("--sources");
const outDir = option("--out");
const concurrency = Number(option("--concurrency") || 3);
if (![articleFile, sourcesFile, outDir].every(path.isAbsolute) || !Number.isInteger(concurrency) ||
    concurrency < 1 || concurrency > 8) {
  console.error("用法: node scripts/verify-x-knowledge-local.mjs --article <绝对路径> --sources <绝对路径> --out <绝对目录> [--concurrency 3]");
  process.exit(2);
}

try {
  const inputs = await readKnowledgeVerificationInputs(articleFile, sourcesFile);
  const result = await verifyKnowledgeDraft({ ...inputs, outDir, concurrency });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
