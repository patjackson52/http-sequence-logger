import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sequencesFromCapture, diffSequences } from '../sequence-diff/index.mjs';

// Load the actual JSX through the viewer's production transform, not copied helpers.
const server = await createServer({ configFile: new URL('../viewer/vite.config.mjs', import.meta.url).pathname, server: { middlewareMode: true } });
after(() => server.close());
const inspector = await server.ssrLoadModule('/src/PairInspector.jsx');
const dialogs = await server.ssrLoadModule('/src/ComparisonDialogs.jsx');
const primary = sequencesFromCapture(await readFile(new URL('../examples/success.ndjson', import.meta.url), 'utf8'))[0];
const secondary = structuredClone(primary);
secondary.session.id = 'secondary-session';
for (const event of secondary.events) {
  event.session_id = secondary.session.id;
  event.recording_id = 'secondary-recording';
  event.event_id = `secondary/${event.event_id}`;
}
secondary.events.find(event => event.event_type === 'operation.started').data.name = 'Checkout.submitFromSwift';
const diff = diffSequences(primary, secondary);
const sourcePair = diff.pairs.find(pair => pair.primary?.label === 'Checkout.submit');
const snapshots = { primary: { document: primary }, secondary: { document: secondary } };

test('paired values distinguish absent, null, empty string, zero, false and capture states', () => {
  assert.equal(inspector.pairedValueText({ present: false, value: null }), 'Absent · not observed');
  assert.equal(inspector.pairedValueText({ present: true, value: null }), 'null');
  assert.equal(inspector.pairedValueText({ present: true, value: '' }), '"" · empty string');
  assert.equal(inspector.pairedValueText({ present: true, value: 0 }), '0');
  assert.equal(inspector.pairedValueText({ present: true, value: false }), 'false');
  for (const value of [{ availability: 'unavailable' }, { availability: 'captured', redacted: true }, { truncated: true }]) {
    assert.deepEqual(JSON.parse(inspector.pairedValueText({ present: true, value })), value);
  }
});

test('source evidence validates pointer, event ID, recording and session identity and retains original lines', () => {
  const ref = sourcePair.primary;
  const snapshot = { document: primary, evidence: { [ref.event_ids[0]]: [{ fileName: 'capture.ndjson', line: 2, text: 'original raw line' }] } };
  const evidence = inspector.sourceEvidence(ref, snapshot);
  assert(evidence.every(item => item.valid));
  assert.equal(evidence[0].original.line, 2);
  for (const field of ['event_id', 'recording_id', 'session_id', 'session_namespace']) {
    const bad = structuredClone(primary);
    bad.events[Number(ref.event_pointers[0].split('/').at(-1))][field] = 'wrong';
    const item = inspector.sourceEvidence(ref, { document: bad })[0];
    assert.equal(item.valid, false, field);
    assert.equal(item.event, null, field);
  }
  const inconsistent = { ...ref, event_ids: [...ref.event_ids, 'extra-id'] };
  assert.equal(inspector.sourceEvidence(inconsistent, snapshot).at(-1).valid, false);
  assert.equal(inspector.sourceEvidence(ref, null)[0].valid, false);
});

test('explicit cross-platform correspondence preserves names and recomputes through the standalone engine', () => {
  const candidates = dialogs.matchCandidates(sourcePair, diff);
  const valid = candidates.filter(candidate => !candidate.conflict);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].reference.label, 'Checkout.submitFromSwift');
  assert.equal(valid[0].suggested, false);
  const next = dialogs.profileWithMatch(diff.profile, sourcePair.primary, valid[0].reference, 'primary');
  assert.equal(diff.profile.matches.length, 0, 'preview does not mutate the profile');
  const output = diffSequences(primary, secondary, next);
  const paired = output.pairs.find(pair => pair.primary?.node_id === sourcePair.primary.node_id);
  assert.equal(paired.matching.basis, 'explicit');
  assert.equal(paired.primary.label, 'Checkout.submit');
  assert.equal(paired.secondary.label, 'Checkout.submitFromSwift');
  assert(paired.changes.some(change => change.path === '/operation/name'));
});

test('candidate selection rejects descendants of unpaired ancestors and one-to-one conflicts', () => {
  const descendant = diff.pairs.find(pair => pair.primary?.label === 'VerificationClient.verify');
  assert(dialogs.matchCandidates(descendant, diff).every(candidate => candidate.conflict === 'Pair recordings and ancestors first.'));
  const valid = dialogs.matchCandidates(sourcePair, diff).find(candidate => !candidate.conflict);
  const conflict = { ...diff.profile, matches: [{ primary: sourcePair.primary.node_id, secondary: 'already-explicit' }] };
  assert.throws(() => dialogs.profileWithMatch(conflict, sourcePair.primary, valid.reference, 'primary'), /one-to-one/);
  const pairedDiff = diffSequences(primary, secondary, dialogs.profileWithMatch(diff.profile, sourcePair.primary, valid.reference, 'primary'));
  const root = pairedDiff.pairs.find(pair => pair.primary?.label === 'Checkout.submit');
  assert(dialogs.matchCandidates(root, pairedDiff).every(candidate => candidate.reference.kind === 'operation'));
});

test('copy finding is traceable to exact canonical snapshots and preserves engine rules', () => {
  const finding = inspector.findingFor(sourcePair, diff, snapshots);
  assert.equal(finding.pair_id, sourcePair.id);
  assert.deepEqual(finding.profile, diff.profile);
  assert.deepEqual(finding.uncertainties, sourcePair.uncertainties);
  assert(finding.sources.primary.evidence.every(item => item.verified));
  for (const item of finding.sources.primary.evidence) {
    assert.equal(primary.events[Number(item.pointer.slice(8))].event_id, item.event_id);
  }
});

test('all five inspector panels render real evidence and keep execution distinct from comparison status', () => {
  for (const tab of ['Changes', 'Request', 'Response', 'Context', 'Evidence']) {
    const html = renderToStaticMarkup(React.createElement(inspector.default, { pair: sourcePair, diff, snapshots, tab }));
    assert.match(html, /Paired details inspector/);
    assert.match(html, /Execution:/);
    assert.match(html, /Observed difference/);
    assert.match(html, new RegExp(`aria-selected="true"[^>]*>${tab}<`));
    if (tab === 'Evidence') { assert.match(html, /Copy finding/); assert.match(html, /Pointer and event ID verified/); }
  }
});
