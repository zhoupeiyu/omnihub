import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'lib/ai.js'), 'utf8');

test('AI proxy only forwards completion after a provider completion signal', () => {
  assert.match(source, /let upstreamDone = false/);
  assert.match(source, /if \(data === "\[DONE\]"\)[\s\S]*upstreamDone = true/);
  assert.match(source, /if \(payload\.done === true \|\| payload\.finish_reason \|\| choice\?\.finish_reason\)/);
  assert.match(source, /if \(!upstreamDone\) res\.write\(`data: \$\{JSON\.stringify\(\{ error: "AI 服务传输中断，请重试" \}\)\}/);
  assert.doesNotMatch(source, /res\.write\("data: \[DONE\]\\n\\n"\);\n  res\.end\(\);/,
    'a premature upstream EOF must not be converted into a successful client completion');
});
