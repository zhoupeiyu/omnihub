import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPdfCompressionJob, getPdfCompressionJob } from '../lib/pdf_tools.js';

function response() {
  const result = { status: 0, body: '' };
  return { result, writeHead(status) { result.status = status; }, end(body = '') { result.body = String(body); } };
}

test('PDF compression job lookup is scoped to its creating user', async () => {
  const boundary = '----omnihub-test-boundary';
  const pdf = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdf}\r\n--${boundary}--\r\n`);
  const req = Readable.from([body]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  const created = response();
  await createPdfCompressionJob(req, created, 'user:10');
  const id = JSON.parse(created.result.body).id;
  const denied = response();
  getPdfCompressionJob(denied, id, 'user:20');
  assert.equal(denied.result.status, 404);
  const owner = response();
  getPdfCompressionJob(owner, id, 'user:10');
  assert.equal(owner.result.status, 200);
});
