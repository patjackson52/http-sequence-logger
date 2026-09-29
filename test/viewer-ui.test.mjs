import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { importFiles } from '../viewer/src/model.mjs';

// Compile the real JSX through the declared build dependency. No browser, DOM
// emulator, copied rendering implementation, or outbound request is involved.
let server, Inspector;
before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL('../viewer/vite.config.mjs', import.meta.url)),
    server: { middlewareMode: true },
    logLevel: 'silent',
  });
  Inspector = (await server.ssrLoadModule('/src/Inspector.jsx')).default;
});
after(async () => { await server?.close(); });

function fixture(name) {
  const text = readFileSync(new URL(`../examples/${name}.ndjson`, import.meta.url), 'utf8');
  return importFiles([{ name: `${name}.ndjson`, text }]).sessions[0];
}
function render(item, session) {
  return renderToStaticMarkup(React.createElement(Inspector, {
    item, session, onSelect() {}, onClose() {}, onPrior() {},
    onToggleCollapse() {}, hasPrior: false, collapsed: false,
  }));
}

test('request inspection treats hostile body, header and decoded query data as literal text', () => {
  const session = fixture('success'), item = session.exchanges[0];
  const hostile = '<img src="https://capture.invalid/leak" onerror="alert(1)">';
  item.requestBody.content.data = hostile;
  item.requestBody.media_type = 'text/html';
  item.request.headers.entries = [
    { name: 'x-note', value: hostile, redacted: false },
    { name: 'x-note', value: 'second observed value', redacted: false },
  ];
  item.request.url = `https://api.example/verify?tag=first&tag=${encodeURIComponent(hostile)}`;
  const html = render(item, session);
  assert.match(html, /&lt;img src=/);
  assert.doesNotMatch(html, /<img\b|<script\b|<iframe\b|<a\b/);
  assert.equal((html.match(/<th>x-note<\/th>/g) ?? []).length, 2);
  assert.equal((html.match(/<th>tag<\/th>/g) ?? []).length, 2);
  assert.ok(html.indexOf('first</td>') < html.indexOf('&lt;img', html.indexOf('<th>tag</th>')));
});

test('handler inspection never displays arguments, return values or business results from input', () => {
  const session = fixture('handler-no-http'), item = session.handlers[0];
  item.arguments = 'untrusted-argument-secret';
  item.returnValue = 'untrusted-return-secret';
  item.businessResult = 'untrusted-business-secret';
  item.invocation.arguments = 'untrusted-nested-secret';
  const html = render(item, session);
  assert.equal((html.match(/<dd>Not captured<\/dd>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /untrusted-(?:argument|return|business|nested)-secret/);
  assert.match(html, /Method exit does not indicate that a business result was accepted/);
});

test('stopped and unfinished handler inspection does not claim a completed duration or return', () => {
  for (const name of ['handler-stopped', 'handler-interrupted']) {
    const session = fixture(name), html = render(session.handlers[0], session);
    assert.match(html, /— elapsed/);
    assert.match(html, /The handler exit was not observed/);
    assert.doesNotMatch(html, /40 ms|↩ Returned/);
    assert.match(html, name === 'handler-stopped' ? /Observation stopped/ : /Unfinished/);
  }
});

test('a thrown handler keeps the successful caller outcome visible', () => {
  const session = fixture('handler-throw'), html = render(session.handlers[0], session);
  assert.match(html, /↯ Threw/);
  assert.match(html, /caller&#x27;s own outcome is success/);
  assert.match(html, /exception unwound to/);
});

test('HTTP 200 inspection exposes body-read timeout and separate application failure', () => {
  const timed = fixture('stream-read-timeout');
  const timeoutHtml = render(timed.exchanges[0], timed);
  assert.match(timeoutHtml, /HTTP 200/);
  assert.match(timeoutHtml, /◷ Timeout/);
  assert.match(timeoutHtml, /Header arrival is not completion/);

  const session = fixture('success'), item = session.exchanges[0];
  item.applicationOutcome = 'error';
  item.end.data.application_outcome = 'error';
  const html = render(item, session);
  assert.match(html, /HTTP 200/);
  assert.match(html, /class="badge failed">✕ Application error/);
  assert.doesNotMatch(html, /class="badge success"/);
});
