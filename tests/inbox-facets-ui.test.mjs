import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

const source=readFileSync(new URL('../public/inbox.jsx',import.meta.url),'utf8');

test('X 收藏 uses counted facet chips and keeps sort as a compact select',()=>{
  assert.doesNotThrow(()=>transformSync(source,{loader:'jsx',target:'es2020'}));
  assert.match(source,/function InboxFacetRow/);
  assert.match(source,/label="归类"/);
  assert.match(source,/label="主题"/);
  assert.match(source,/label="合集"/);
  assert.match(source,/展开 \$\{items\.length - collapsedAt\} 个/);
  assert.match(source,/className="inbox-sort-facet"/);
  assert.match(source,/aria-label="X 收藏排序"/);
  assert.doesNotMatch(source,/aria-label="按跨作者主题合集筛选 X 收藏"/);
});
