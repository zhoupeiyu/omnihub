import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const component = readFileSync(path.join(root, 'public/omniget-cookies.jsx'), 'utf8');
const styles = readFileSync(path.join(root, 'public/omniget-cookies.css'), 'utf8');

test('Cookie manager is explicit, site-scoped, and never renders uploaded plaintext', () => {
  assert.match(component, /function OmnigetCookieManager/);
  assert.match(component, /\/api\/omniget\/cookies/);
  assert.match(component, /method: 'POST'/);
  assert.match(component, /method: 'DELETE'/);
  assert.match(component, /Netscape cookies\.txt/);
  assert.match(component, /256 KiB/);
  assert.match(component, /加密保存、最长 24 小时，可随时撤销/);
  assert.match(component, /await file\.text\(\)/);
  assert.match(component, /if \(!file \|\| busy\) return/);
  assert.doesNotMatch(component, /setNotice\([^\n]*cookiesTxt/);
  assert.match(component, /catch \{\s*setNotice\(\{ type: 'error'/);
});

test('Cookie manager provides responsive styles and visible connection controls', () => {
  assert.match(component, /已连接站点/);
  assert.match(component, /撤销连接/);
  assert.match(component, /aria-describedby="omniget-cookie-file-help"/);
  assert.match(styles, /@media\(max-width:720px\)/);
  assert.match(styles, /@media\(max-width:420px\)/);
});
