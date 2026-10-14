import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBase64, inspectBase64Body, inspectBase64Header, BASE64_MAX_LENGTH } from '../viewer/src/base64.mjs';

const encoded = text => Buffer.from(text).toString('base64');

test('detects canonical padded and unpadded standard and URL-safe text', () => {
  for (const text of ['hello world', '{"answer":42}', 'こんにちは 🌍', '<script>alert(1)</script>']) {
    const value = encoded(text);
    assert.equal(detectBase64(value)?.decoded, text);
    assert.equal(detectBase64(value.replace(/=+$/, ''))?.decoded, text);
  }
  const urlSafe = encoded('🌍 > hello?').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(detectBase64(urlSafe)?.variant, 'url-safe');
  assert.equal(detectBase64(urlSafe)?.decoded, '🌍 > hello?');
});

test('canonical padding permits short known encoded values; ambiguous unpadded IDs stay raw', () => {
  for (const text of ['1', '{}', 'a', 'hello']) assert.equal(detectBase64(encoded(text))?.decoded, text);
  for (const text of ['hello', 'user1234', '123456']) assert.equal(detectBase64(encoded(text).replace(/=+$/, '')), null);
});

test('ordinary request values and malformed encodings have no detection', () => {
  for (const value of [null, 123, {}, '', 'hello', 'password', 'application/json', 'GET', '200', '550e8400-e29b-41d4-a716-446655440000', 'abcdef0123456789', 'Zm9vYmFy', 'aGVsbG8gd29ybGR=', 'aGVsbG8gd29ybGQ===', 'aGVsbG8=extra', 'a', 'TQ=', 'TQ===', 'TR==', 'Zm9v=', 'aGVsbG8gd29ybGQ=\n', ' aGVsbG8gd29ybGQ=', '8J+M_j4gaGVsbG8/']) {
    assert.equal(detectBase64(value), null, `Unexpected detection for ${JSON.stringify(value)}`);
  }
});

test('rejects binary bytes, invalid UTF-8 and unreadable controls; preserves Unicode exactly', () => {
  for (const bytes of [[0, 1, 2, 3], [0xc3, 0x28], [0xff], [0xef, 0xbf, 0xbd, 0x00]]) assert.equal(detectBase64(Buffer.from(bytes).toString('base64')), null);
  for (const text of ['hello\0world', 'hello\u007fworld', 'hello\u200bworld']) assert.equal(detectBase64(encoded(text)), null);
  for (const text of ['line 1\nline 2\tvalue\r\n', 'café e\u0301 🧑🏽', 'family 👨‍👩‍👧‍👦', 'فارسی نیم\u200cفاصله']) assert.equal(detectBase64(encoded(text))?.decoded, text);
  assert.equal(detectBase64(encoded('x'.repeat(BASE64_MAX_LENGTH))), null);
});

test('header inspection preserves a Basic prefix and ignores arbitrary token/prose wrappers', () => {
  assert.deepEqual(inspectBase64Header(`Basic ${encoded('user:password')}`), { decoded: 'Basic user:password', count: 1, format: 'basic' });
  assert.equal(inspectBase64Header(`bAsIc\t${encoded('user:password')}`)?.decoded, 'bAsIc\tuser:password');
  assert.equal(inspectBase64Header(encoded('hello world'))?.format, 'text');
  assert.equal(inspectBase64Header(`Bearer ${encoded('hello world')}`), null);
  assert.equal(inspectBase64Header(`prefix ${encoded('hello world')} suffix`), null);
  assert.equal(inspectBase64Header('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature'), null);
});

test('body previews decode JSON values once, retaining names, values and hostile keys as inert data', () => {
  const raw = JSON.stringify({ plain: 'normal text', nested: [encoded('hello world'), { value: encoded('café') }], '__proto__': 'unused', constructor: encoded('safe value'), number: 42 });
  const match = inspectBase64Body(raw, { mediaType: 'application/json' });
  assert.equal(match.count, 3);
  assert.equal(match.format, 'json');
  const decoded = JSON.parse(match.decoded);
  assert.deepEqual(decoded.nested, ['hello world', { value: 'café' }]);
  assert.equal(decoded.constructor, 'safe value');
  assert.equal(decoded.plain, 'normal text');
  assert.equal(decoded.number, 42);
  assert.deepEqual(JSON.parse(raw).nested, [encoded('hello world'), { value: encoded('café') }]);
  const hostile = inspectBase64Body(`{"__proto__":"${encoded('safe value')}"}`);
  assert.equal(JSON.parse(hostile.decoded).__proto__, 'safe value');
  assert.equal({}.polluted, undefined);
  assert.equal(inspectBase64Body(JSON.stringify({ value: 'ordinary' })), null);
});

test('form previews preserve repeated fields and render decoded reserved characters unambiguously', () => {
  const params = new URLSearchParams([['value', encoded('hello & world=42')], ['value', encoded('café')], ['plain', 'a+b']]);
  const match = inspectBase64Body(params.toString(), { mediaType: 'application/x-www-form-urlencoded; charset=UTF-8' });
  assert.equal(match.format, 'form');
  assert.equal(match.count, 2);
  assert.deepEqual(JSON.parse(match.decoded), [{ name: 'value', value: 'hello & world=42' }, { name: 'value', value: 'café' }, { name: 'plain', value: 'a+b' }]);
  assert.equal(inspectBase64Body('value=ordinary', { mediaType: 'application/x-www-form-urlencoded' }), null);
});

test('JSON previews preserve unrelated numeric lexemes, duplicate keys, names, escapes and whitespace', () => {
  const token = encoded('hello world');
  const raw = ` { "large":9007199254740993,"overflow":1e400,"n":1.00,"n":2,"${token}":"raw", "value":"${token}", "escape":"a\\\\b\\\"c" } `;
  const match = inspectBase64Body(raw, { mediaType: 'application/json' });
  assert.equal(match.count, 1);
  assert.equal(match.decoded, raw.replace(`"value":"${token}"`, '"value":"hello world"'));
  assert.equal(inspectBase64Body(`"${token}"`).decoded, '"hello world"');
  const unicodeToken = token.replace('a', '\\u0061');
  assert.equal(inspectBase64Body(`{"value":"${unicodeToken}"}`).decoded, '{"value":"hello world"}');
});

test('explicit Base64 capture encoding relaxes ambiguous-text heuristics but never decodes binary', () => {
  assert.equal(inspectBase64Body('SGVsbG8', { encoding: 'base64' })?.decoded, 'Hello');
  assert.equal(inspectBase64Body('TQ==', { encoding: 'base64' })?.decoded, 'M');
  assert.equal(inspectBase64Body('AAECAw==', { encoding: 'base64' }), null);
  assert.equal(inspectBase64Body('{"value":"aGVsbG8gd29ybGQ="}', { encoding: 'base64' }), null);
  assert.equal(inspectBase64Body('plain text'), null);
});

test('bounded body scans reject incomplete previews', () => {
  let nested = encoded('hello world');
  for (let i = 0; i < 33; i++) nested = [nested];
  assert.equal(inspectBase64Body(JSON.stringify(nested)), null);
  assert.equal(inspectBase64Body(JSON.stringify(Array(65).fill(encoded('hello world')))), null);
  assert.equal(inspectBase64Body(JSON.stringify(Array(10001).fill('plain'))), null);
  assert.equal(inspectBase64Body('x'.repeat(BASE64_MAX_LENGTH + 1)), null);
  assert.equal(inspectBase64Body(JSON.stringify(Array(64).fill(encoded('hello world')))).count, 64);
});
