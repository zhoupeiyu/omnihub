import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/media-discovery.jsx', import.meta.url), 'utf8');
const hookSource = source.slice(source.indexOf('function useDiscoveryJobs('), source.indexOf('function DiscoveryItem('));

test('active discovery job retries polling after one request failure', async () => {
  const cells = [], timers = new Map();
  let cursor = 0, nextTimer = 0, jobReads = 0, pendingEffects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { value: { current: initial } };
      return cells[index].value;
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!(index in cells) || !same(cells[index].deps, deps)) cells[index] = { value: fn, deps };
      return cells[index].value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!(index in cells) || !same(cells[index].deps, deps)) pendingEffects.push({ index, fn, deps });
    },
  };
  const context = vm.createContext({
    React, AbortController,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    videoBusy: job => job.state === 'running',
    async videoToolApi(path) {
      if (path.endsWith('/status')) return { available: true, scope: 'private' };
      assert.match(path, /jobs\?kind=discovery/);
      jobReads++;
      if (jobReads === 2) throw new Error('temporary upstream error');
      return { scope: 'private', jobs: [{ id: 'job-1', state: jobReads === 3 ? 'ready' : 'running', created: 1 }] };
    },
  });
  vm.runInContext(hookSource, context);
  const render = () => {
    cursor = 0; pendingEffects = [];
    const value = context.useDiscoveryJobs(true);
    for (const { index, fn, deps } of pendingEffects) {
      cells[index]?.cleanup?.();
      cells[index] = { deps, cleanup: fn() };
    }
    return value;
  };
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const fire = () => { assert.equal(timers.size, 1); const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };

  render(); await flush();
  let value = render();
  assert.equal(jobReads, 1);
  assert.equal(value.jobs[0].state, 'running');
  fire(); await flush();
  value = render();
  assert.equal(jobReads, 2);
  assert.equal(value.error, 'temporary upstream error');
  assert.equal(timers.size, 1, 'failed poll must schedule another check');
  fire(); await flush();
  value = render();
  assert.equal(jobReads, 3);
  assert.equal(value.jobs[0].state, 'ready');
  assert.equal(timers.size, 0);
});
