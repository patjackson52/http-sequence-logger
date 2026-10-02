// Snapshots preserve canonical source documents. Matching belongs only to sequence-diff.
export const SNAPSHOT_LIMITS = Object.freeze({ events: 20000, bytes: 16 * 1024 * 1024, pages: 10000 });
let nextSnapshot = 0;

export const sessionIdentityKey = identity => JSON.stringify([
  identity.namespace ?? identity.session_namespace,
  identity.sessionId ?? identity.session_id ?? identity.id,
]);

export function freezeData(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); pending.push(...Object.values(item)); Object.freeze(item);
  }
  return value;
}

export function createComparisonSnapshot(input, options = {}) {
  if (input?.invalid) throw new Error('Invalid session cannot be compared. Inspect capture diagnostics.');
  if (input?.format === 'http-sequence' && input.schema_version !== '1.0') throw new Error('Unsupported canonical sequence document version.');
  const session = input?.format === 'http-sequence' ? input.session : { namespace: input?.namespace ?? input?.session_namespace, id: input?.sessionId ?? input?.session_id };
  if (!session?.namespace || !session?.id || !Array.isArray(input?.events) || !input.events.length) throw new Error('Comparison requires a nonempty canonical session.');
  if (input.events.length > SNAPSHOT_LIMITS.events) throw new Error(`Comparison exceeds the ${SNAPSHOT_LIMITS.events} event limit; no partial snapshot was created.`);
  const document = structuredClone({ format: 'http-sequence', schema_version: '1.0', session, events: input.events });
  const bytes = new TextEncoder().encode(JSON.stringify(document)).length;
  if (bytes > SNAPSHOT_LIMITS.bytes) throw new Error(`Comparison exceeds the ${SNAPSHOT_LIMITS.bytes} byte snapshot limit; no partial snapshot was created.`);
  const kind = options.kind ?? 'file', sourceId = options.sourceId ?? null;
  if (options.scope === 'source-limited' && !sourceId) throw new Error('Source-limited snapshots require a source identity.');
  const evidence = Object.create(null);
  for (const event of document.events) if (options.sourceLines && Object.hasOwn(options.sourceLines,event.event_id)) evidence[event.event_id] = structuredClone(options.sourceLines[event.event_id]);
  const producers = document.events.filter(event => event.event_type === 'session.started').map(event => ({ recording_id: event.recording_id, name: event.data.name, producer: event.data.producer }));
  return freezeData({
    id: `snapshot-${++nextSnapshot}`, kind, document, sequence: document,
    scope: { kind: options.scope ?? (sourceId ? 'source-limited' : 'whole-session'), source_id: sourceId },
    boundary: kind === 'collector' ? { collector_id: options.collectorId, high_water: options.highWater } : null,
    eventCount: document.events.length, bytes, evidence,
    metadata: structuredClone({ producers, ...options.metadata }),
    ...(input.operations && input.exchanges ? { model: structuredClone(input) } : {}),
  });
}

export function snapshotsFromCapture(capture, options = {}) {
  if (!capture?.valid || capture.diagnostics?.some(item => item.severity === 'error' || /incomplete final JSON line.*ignored/.test(item.message))) throw new Error('The capture contains invalid or skipped input. Resolve its diagnostics before comparison.');
  return capture.sessions.map(session => createComparisonSnapshot(session, { sourceLines: capture.sourceLines, ...options }));
}

/** Resolve each source pointer against the exact snapshot, checking its event ID. */
export function eventsForReference(snapshot, reference) {
  if (!reference) return [];
  const document = snapshot.document ?? snapshot.sequence ?? snapshot;
  if (reference.event_ids.length !== reference.event_pointers.length) throw new Error('Inconsistent comparison source references.');
  return reference.event_pointers.map((pointer, index) => {
    if (!/^\/events\/\d+$/.test(pointer)) throw new Error('Invalid comparison source pointer.');
    const event = document.events[Number(pointer.slice(8))];
    if (!event || event.event_id !== reference.event_ids[index] || event.recording_id !== reference.recording_id) throw new Error('Comparison source reference does not identify the snapshot event.');
    return event;
  });
}

export function validateSourceReferences(diff, primary, secondary) {
  for (const pair of diff.pairs) {
    eventsForReference(primary, pair.primary);
    eventsForReference(secondary, pair.secondary);
  }
  return true;
}

export const sourceIdentityOfPair = pair => ({ primary: pair?.primary?.node_id ?? null, secondary: pair?.secondary?.node_id ?? null });
export function restorePairSelection(diff, identity) {
  if (!identity) return null;
  return diff.pairs.find(pair => identity.primary && pair.primary?.node_id === identity.primary || identity.secondary && pair.secondary?.node_id === identity.secondary)?.id ?? null;
}
