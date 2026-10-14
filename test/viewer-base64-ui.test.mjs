import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { importFiles } from '../viewer/src/model.mjs';
import { inspectCapturedBody, inspectRequestMetadata, inspectRequestBodyData } from '../viewer/src/request-base64.mjs';

const server = await createServer({ configFile: new URL('../viewer/vite.config.mjs', import.meta.url).pathname, server: { middlewareMode: true, hmr: false } });
after(() => server.close());
const { default: Inspector } = await server.ssrLoadModule('/src/Inspector.jsx');
const { default: Base64Value } = await server.ssrLoadModule('/src/Base64Value.jsx');
const encoded = Buffer.from('hello world').toString('base64');
const body = { availability: 'captured', redacted: false, truncated: false, stored_bytes: 16, observed_bytes: 16, total_bytes: 16, content: { encoding: 'utf-8', data: encoded } };

test('ordinary scalar values render without indicators or additional markup', () => {
  for (const value of ['hello', '', 'request-id-123', '<img src=x>']) {
    const actual = renderToStaticMarkup(React.createElement(Base64Value, { value }));
    const expected = renderToStaticMarkup(React.createElement(React.Fragment, null, value));
    assert.equal(actual, expected);
  }
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Base64Value, { value: encoded, disabled: true })), /base64-control/);
});

test('body previews skip redacted, incomplete and unavailable captures', () => {
  assert.equal(inspectCapturedBody(body).decoded, 'hello world');
  for (const override of [{ redacted: true }, { truncated: true }, { reason: 'read_failure' }, { reason: 'partial_capture' }, { total_bytes: 20 }, { availability: 'unavailable' }]) {
    assert.equal(inspectCapturedBody({ ...body, ...override }), null);
  }
});

test('paired projections preserve raw URLs, repeat order, values and capture metadata', () => {
  const request = { method: 'POST', url: `https://example.test/?q=${encoded}&q=plain`, headers: { entries: [{ name: 'X-Data', value: encoded }, { name: 'Secret', value: encoded, redacted: true }] } };
  const before = JSON.stringify(request);
  const preview = inspectRequestMetadata(request);
  assert.equal(preview.count, 2);
  const decoded = JSON.parse(preview.decoded);
  assert.equal(decoded.url, request.url);
  assert.deepEqual(decoded.decoded_query_parameters, [{ name: 'q', value: 'hello world' }, { name: 'q', value: 'plain' }]);
  assert.equal(decoded.headers.entries[0].value, 'hello world');
  assert.equal(decoded.headers.entries[1].value, encoded);
  assert.equal(JSON.stringify(request), before);
  const data = { direction: 'request', body };
  const value = JSON.parse(inspectRequestBodyData(data).decoded);
  assert.equal(value.body.content.data, 'hello world');
  assert.equal(body.content.data, encoded);
  assert.equal(value.body.stored_bytes, body.stored_bytes);
  assert.equal(inspectRequestMetadata({ ...request, url_redacted: true }).count, 1);
  assert.equal(inspectRequestMetadata({ url: 'https://example.test/?a=plain' }), null);
});

test('actual Request inspector exposes only detected controls without mutating its model', async () => {
  const text = await readFile(new URL('../examples/success.ndjson', import.meta.url), 'utf8');
  const session = importFiles([{ name: 'success.ndjson', text }]).sessions[0];
  const item = session.exchanges[0];
  item.request = { ...item.request, url: `https://example.test/?q=${encoded}&word=ordinary`, headers: { ...item.request.headers, entries: [{ name: 'X-Data', value: encoded }, { name: 'X-Plain', value: 'ordinary' }] } };
  item.requestBody = body;
  const before = JSON.stringify(session);
  const html = renderToStaticMarkup(React.createElement(Inspector, { item, session }));
  assert.equal((html.match(/class="base64-control"/g) || []).length, 3);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 3);
  assert.equal(JSON.stringify(session), before);
});

test('paired metadata preview limits refuse excessive values without partial decoding', () => {
  assert.equal(inspectRequestMetadata({ url: 'https://example.test/', headers: { entries: Array.from({ length: 65 }, () => ({ name: 'X', value: encoded })) } }), null);
  assert.equal(inspectRequestMetadata({ url: `https://example.test/?q=${'x'.repeat(256 * 1024)}` }), null);
  assert.equal(inspectRequestMetadata({ headers: { entries: Array.from({ length: 10001 }, () => ({ name: 'X', value: 'plain' })) } }), null);
});
