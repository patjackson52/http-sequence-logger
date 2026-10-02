import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { importFiles, filterSessionItems } from '../viewer/src/model.mjs';
import { layoutSequence } from '../viewer/src/layout.mjs';
import { renderSequenceSVG, svgFilename } from '../viewer/src/export-svg.mjs';

const load = path => importFiles([{ name: path, text: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }]).sessions;
const fixture = name => load(`examples/${name}.ndjson`)[0];
const draw = (session, filters = {}, state = {}) => {
  const layout = layoutSequence(session, { ...filters, ...state, visibleIds: filterSessionItems(session, filters).visibleIds });
  return renderSequenceSVG(layout, { name: session.name, selectedId: state.selectedId });
};

test('SVG: all reference sessions render standalone shapes and text without UI or dependencies', () => {
  for (const path of readdirSync(new URL('../examples/', import.meta.url)).filter(name => name.endsWith('.ndjson'))) {
    for (const session of load(`examples/${path}`)) {
      const svg = draw(session);
      assert.match(svg, /^<\?xml.*\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      assert.match(svg, /<text[^>]*>CLIENT<\/text>/);
      assert.match(svg, /App code/);
      assert.match(svg, /SDK/);
      assert.doesNotMatch(svg, /<(script|style|image|foreignObject|button|a)(\s|>)/i);
      assert.doesNotMatch(svg, /\s(?:href|onclick|tabindex)=|role="button"|(?:NaN|undefined)"|Download SVG|Collapse all/);
    }
  }
});

test('SVG: active search and origin filters exclude hidden requests and origins', () => {
  const session = load('examples/viewer-three-origin.ndjson')[0];
  const all = draw(session);
  for (const origin of session.origins) assert.ok(all.includes(new URL(origin).host));
  const selected = draw(session, { search: '/todos/1' });
  assert.match(selected, /tasks.example/);
  assert.match(selected, /GET \/todos\/1/);
  for (const origin of session.origins.filter(origin => !origin.includes('tasks.example'))) assert.ok(!selected.includes(new URL(origin).host));
  const origin = session.origins.find(origin => !origin.includes('tasks.example'));
  assert.doesNotMatch(draw(session, { origins: [origin] }), /GET \/todos\/1/);
});

test('SVG: collapsed methods hide descendants; component expansion and selection follow the layout', () => {
  const session = fixture('handler-http'), handler = session.operations.find(op => op.isHandler);
  const expanded = draw(session, {}, { expandedOwners: new Set(['integrator', 'sdk']), selectedId: handler.id });
  assert.match(expanded, /stroke="#1b6f8f"/);
  assert.match(expanded, /fill="#e3f1f6"/);
  assert.ok(expanded.includes(handler.component));
  assert.match(expanded, /↩ returned/);
  const collapsed = draw(session, {}, { collapsed: new Set([handler.id]) });
  assert.match(collapsed, /1 requests · 0 calls hidden/);
  assert.doesNotMatch(collapsed, /GET \/|↩ returned/);
  const local = draw(session, { kind: 'local' });
  assert.match(local, /↩ returned/);
  assert.doesNotMatch(local, /GET \//);
  const http = draw(session, { kind: 'http' });
  assert.match(http, /↦ inside/);
  assert.doesNotMatch(http, /↩ returned/);
});

test('SVG: no false returns for incomplete calls, and successful headers do not hide body failure', () => {
  assert.match(draw(fixture('handler-stopped')), /observation stopped/);
  for (const name of ['handler-stopped', 'handler-interrupted']) assert.doesNotMatch(draw(fixture(name)), /↩ returned/);
  const timeout = draw(fixture('stream-read-timeout'));
  assert.match(timeout, /200/); assert.match(timeout, /headers only/); assert.match(timeout, /timed out/);
  assert.match(timeout, /fill="#b9382c"/);
  assert.match(draw(fixture('retry')), /503/);
});

test('SVG: selected recording excludes all other recording rows', () => {
  const session = fixture('multi-session');
  assert.equal(session.recordings.length, 2);
  const all = draw(session), single = draw(session, { recordingId: session.recordings[1].id });
  assert.equal((all.match(/<text[^>]*>Recording /g) || []).length, 2);
  assert.equal((single.match(/<text[^>]*>Recording /g) || []).length, 1);
  assert.ok(single.length < all.length);
});

test('SVG: names, payloads and labels stay inert XML text, including malformed Unicode', () => {
  const layout = layoutSequence(fixture('handler-http'));
  const hostile = '<script onload="x">&\u0001\uD800';
  layout.arrows[0].sub = hostile;
  const svg = renderSequenceSVG(layout, { name: hostile });
  assert.ok(svg.includes('&lt;script onload=&quot;x&quot;&gt;&amp;��'));
  assert.doesNotMatch(svg, /<script|\u0001|\uD800/);
  layout.lanes[0].label = 'Name…';
  assert.match(renderSequenceSVG(layout), />Name…<\/text>/);
});

test('SVG: download names cannot contain directory separators and retain valid Unicode', () => {
  assert.equal(svgFilename('../../A/B:C?'), 'A-B-C-sequence.svg');
  assert.equal(svgFilename(''), 'sequence.svg');
  assert.equal(svgFilename('Sign in ✓'), 'Sign-in-sequence.svg');
  assert.equal(svgFilename('漢字'), '漢字-sequence.svg');
  assert.ok(svgFilename('𐐀'.repeat(101)).isWellFormed());
  assert.equal([...svgFilename('𐐀'.repeat(101))].length, 113);
});
