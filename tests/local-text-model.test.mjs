import assert from 'node:assert/strict';
import test from 'node:test';
import { checkClaudeApiTransport, createClaudeApiTransport } from '../lib/local-text-model.js';

const worker = { transport: 'claude-api', model: 'claude-opus-5-5' };
const schema = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['method'] } }, additionalProperties: false };
const task = { id: 'task', stage: 'classify', model: 'claude-opus-5-5', instructions: '分类', input: { content: '原文' }, schema };
const configLoader = () => ({ url: 'https://model.example/v1/messages', token: 'private-fixture', bearer: false, model: 'claude-opus-5-5', provider: 'model.example' });

test('Claude API transport sends a text-only JSON request and accepts schema-valid JSON', async () => {
  let options;
  const transport = createClaudeApiTransport({ configLoader, fetchImpl: async (_url, request) => { options = request; return new Response(JSON.stringify({ model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"kind":"method"}' }] })); } });
  const result = await transport.run(worker, task);
  assert.deepEqual(result, { model: 'claude-opus-5-5', value: { kind: 'method' } });
  const body = JSON.parse(options.body);
  assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.messages.length, 1); assert.equal(options.redirect, 'error');
});

test('Claude API transport rejects tool responses, schema violations, oversized input, and model mismatch without fallback', async () => {
  let calls = 0;
  const transport = createClaudeApiTransport({ configLoader, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'shell' }] })); } });
  await assert.rejects(transport.run(worker, task), error => error.code === 'invalid_result');
  const wrong = { ...task, model: 'other' };
  await assert.rejects(transport.run(worker, wrong), error => error.code === 'invalid_result');
  await assert.rejects(transport.run(worker, { ...task, input: { text: 'x'.repeat(300 * 1024) } }), error => error.code === 'invalid_result');
  assert.equal(calls, 1);
  const badSchema = createClaudeApiTransport({ configLoader, fetchImpl: async () => new Response(JSON.stringify({ model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"kind":"other"}' }] })) });
  await assert.rejects(badSchema.run(worker, task), error => error.code === 'invalid_result');
});

test('Claude API transport rejects configuration mismatch and oversized responses before accepting output', async () => {
  await assert.rejects(Promise.resolve().then(() => checkClaudeApiTransport({ ...worker, model: 'other' }, { configLoader })), error => error.code === 'configuration');
  let called = false;
  const tooLarge = createClaudeApiTransport({
    configLoader,
    fetchImpl: async () => {
      called = true;
      return new Response('x'.repeat(1024 * 1024 + 1));
    },
  });
  await assert.rejects(tooLarge.run(worker, task), error => error.code === 'invalid_result');
  assert.equal(called, true);
});
