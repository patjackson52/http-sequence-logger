// Copied by scripts/build-diff-schema.mjs from shared/validate.mjs. Do not edit.
import validateEvent from './event-validator.mjs';

const stable = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k])]));
  return value;
}
const spanKey = (context) => `${context.trace_id}/${context.span_id}`;
const sessionKey = (event) => JSON.stringify([event.session_namespace, event.session_id]);
const observedUrls = (event) => [event.data.request?.url, event.data.response?.url, event.data.transaction?.request?.url, event.data.transaction?.response?.url].filter(Boolean);

/** Parse one file before merging: EOF recovery is specific to each file. */
export function parseCapture(input) {
  const errors = [], warnings = [], events = [], locations = [];
  const warn = (_event, message) => warnings.push(`file: ${message}`);
  const lines = input.replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (i === lines.length - 1 && !input.endsWith('\n')) {
        warn(null, `incomplete final JSON line ${i + 1} ignored`);
      } else errors.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    if (!validateEvent(event)) {
      const details = validateEvent.errors.filter((e) => e.keyword !== 'const' && e.keyword !== 'oneOf').slice(0, 5);
      errors.push(`line ${i + 1}: schema validation failed: ${details.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
      continue;
    }
    events.push(event);
    locations.push({ eventId: event.event_id, line: i + 1 });
  }
  return { events, errors, warnings, locations };
}

/** Partial captures return warnings; contradictions return errors. */
export function validateCapture(input) {
  const parsed = parseCapture(input);
  return validateEvents(parsed.events, parsed);
}

/** Validate schema-checked events merged from one or more files. */
export function validateEvents(parsedEvents, initial = {}) {
  const errors = [...(initial.errors ?? [])];
  const warnings = [...(initial.warnings ?? [])];
  const events = [], ids = new Map(), records = new Map(), spans = new Map();
  let duplicateEvents = 0;
  const error = (event, message) => errors.push(`${event?.event_id ?? 'file'}: ${message}`);
  const warn = (event, message) => warnings.push(`${event?.event_id ?? 'file'}: ${message}`);
  for (const event of parsedEvents) {
    const existing = ids.get(event.event_id);
    if (existing) {
      if (stable(existing) !== stable(event)) error(event, 'conflicting duplicate event_id');
      else duplicateEvents++;
      continue;
    }
    ids.set(event.event_id, event);
    events.push(event);
    if (!records.has(event.recording_id)) records.set(event.recording_id, []);
    records.get(event.recording_id).push(event);
  }
  if (!events.length) error(null, 'no valid events');
  if (duplicateEvents) warn(null, `${duplicateEvents} identical duplicate event(s) deduplicated`);

  for (const recording of records.values()) {
    recording.sort((a, b) => a.sequence - b.sequence);
    const first = recording[0];
    const starts = recording.filter((e) => e.event_type === 'session.started');
    const ends = recording.filter((e) => e.event_type === 'session.ended');
    if (!starts.length) warn(first, 'missing session.started; recording metadata unavailable');
    if (!ends.length) warn(first, 'missing session.ended; recording is incomplete');
    if (starts.length > 1 || ends.length > 1) error(first, 'multiple session start/end events in one recording');
    if (starts[0] && (starts[0].sequence !== 1 || starts[0].monotonic_ns !== '0')) error(starts[0], 'session.started must have sequence 1 and monotonic_ns 0');
    if (ends[0] && ends[0] !== recording.at(-1)) error(ends[0], 'events occur after session.ended');
    if (starts[0]?.data.trace_propagation === 'disabled' && starts[0].data.propagation_origins.length) error(starts[0], 'disabled propagation must have an empty origin allowlist');
    if (starts[0]?.data.trace_propagation === 'allowlist' && !starts[0].data.propagation_origins.length) error(starts[0], 'allowlist propagation requires at least one origin');
    for (const origin of starts[0]?.data.propagation_origins ?? []) {
      try {
        if (new URL(origin).origin !== origin) error(starts[0], 'propagation allowlist entries must be normalized origins without paths');
      } catch { error(starts[0], 'invalid propagation origin'); }
    }
    let previous;
    for (const event of recording) {
      if (event.schema_version !== first.schema_version) error(event, 'schema version changed within recording');
      if (sessionKey(event) !== sessionKey(first)) error(event, 'recording_id reused across different sessions or namespaces');
      if (previous) {
        if (event.sequence === previous.sequence) error(event, 'duplicate sequence within recording');
        else if (event.sequence !== previous.sequence + 1) warn(event, 'sequence gap; some events are missing');
        if (BigInt(event.monotonic_ns) < BigInt(previous.monotonic_ns)) error(event, 'monotonic time moved backwards within recording');
      } else if (event.sequence !== 1) warn(event, 'recording begins after sequence 1');
      previous = event;
      if (event.event_type === 'capture.gap' || event.event_type === 'session.ended' && event.data.dropped_events > 0) warn(event, 'producer reports dropped events');
      if (event.context) {
        const key = spanKey(event.context);
        if (!spans.has(key)) spans.set(key, []);
        spans.get(key).push(event);
      }
      const urls = observedUrls(event);
      for (const url of urls) {
        try {
          const parsed = new URL(url);
          if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) error(event, 'HTTP URL must have a host, no userinfo, and no fragment');
        } catch { error(event, 'invalid absolute HTTP URL'); }
      }
      if (event.data.body) validateBody(event, error);
      if (event.event_type === 'http.request.started' && starts[0]) {
        const declared = starts[0].data.adapters.find((a) => stable(a.adapter) === stable(event.data.adapter));
        if (!declared) error(event, 'request adapter is not declared in session metadata');
        else if (declared.capabilities.attempts !== event.data.attempt.visibility) error(event, 'attempt visibility contradicts adapter capabilities');
      }
      if (event.event_type === 'http.response.headers') {
        const code = event.data.response.status_code;
        const informational = code < 200 && code !== 101;
        if (informational !== (event.data.phase === 'informational')) error(event, 'response phase disagrees with status code');
      }
      if (event.event_type === 'http.metrics') {
        for (const phase of event.data.phases) {
          if (phase.start_timestamp !== null && phase.end_timestamp !== null && Date.parse(phase.end_timestamp) < Date.parse(phase.start_timestamp)) warn(event, 'platform metric wall clock moved backwards; do not infer a negative duration');
        }
      }
      if (event.event_type === 'http.ended') validateHttpEnd(event, error);
    }
  }

  const spanStarts = new Map();
  const spanEnds = new Map();
  for (const [key, spanEvents] of spans) {
    spanEvents.sort((a, b) => a.sequence - b.sequence);
    const first = spanEvents[0];
    const starts = spanEvents.filter((e) => ['operation.started', 'http.request.started'].includes(e.event_type));
    const ends = spanEvents.filter((e) => ['operation.ended', 'http.ended'].includes(e.event_type));
    const start = starts[0];
    const end = ends[0];
    if (start) spanStarts.set(key, start);
    if (end) spanEnds.set(key, end);
    if (!start) warn(first, 'missing span start; retain as an orphan observation');
    if (!end) warn(first, 'missing span end; operation/request is unfinished');
    if (starts.length > 1 || ends.length > 1) error(first, 'multiple start/end events for one span');
    for (const event of spanEvents) {
      if (event.recording_id !== first.recording_id || stable(event.context) !== stable(first.context)) error(event, 'span identity/context changed or crossed recordings');
      if (start && event.sequence < start.sequence) error(event, 'span observation precedes its start');
      if (start?.event_type === 'operation.started' && event.event_type.startsWith('http.')) error(event, 'HTTP observation attached to a method operation span');
      if (start?.event_type === 'http.request.started' && event.event_type.startsWith('operation.')) error(event, 'operation event attached to an HTTP span');
    }
    if (start && end) {
      const expectedEnd = start.event_type === 'operation.started' ? 'operation.ended' : 'http.ended';
      if (end.event_type !== expectedEnd) error(end, 'span end type does not match its start');
      const elapsed = BigInt(end.monotonic_ns) - BigInt(start.monotonic_ns);
      if (elapsed < 0n || elapsed !== BigInt(end.data.duration_ns)) error(end, 'duration_ns does not equal monotonic end minus start');
    }
    if (start?.event_type === 'http.request.started') {
      const finals = spanEvents.filter((e) => e.event_type === 'http.response.headers' && e.data.phase === 'final');
      if (finals.length > 1) error(start, 'multiple final responses; retries/redirects need separate spans when observable');
      const response = finals[0];
      if (response && spanEvents.some((e) => e.event_type === 'http.response.headers' && e.data.phase === 'informational' && e.sequence > response.sequence)) error(response, 'informational response occurs after final response');
      const transactionIndexes = spanEvents.filter((e) => e.event_type === 'http.metrics' && e.data.transaction !== null).map((e) => e.data.transaction.index);
      if (new Set(transactionIndexes).size !== transactionIndexes.length) error(start, 'duplicate native transaction index within HTTP span');
      for (const direction of ['request', 'response']) {
        const bodies = spanEvents.filter((e) => e.event_type === 'http.body.captured' && e.data.direction === direction);
        if (bodies.length > 1) error(start, `multiple ${direction} body snapshots`);
        if (end && !bodies.length) warn(end, `missing ${direction} body capture state`);
        const trailers = spanEvents.filter((e) => e.event_type === 'http.trailers' && e.data.direction === direction);
        if (trailers.length > 1) error(start, `multiple ${direction} trailer snapshots`);
      }
      if (end) {
        if (response && end.data.status_code !== response.data.response.status_code) error(end, 'terminal status_code disagrees with final response');
        if (!response && end.data.status_code !== null) warn(end, 'final response headers are missing');
        if (response && response.sequence > end.sequence) error(response, 'response headers occur after HTTP end');
        for (const event of spanEvents.filter((e) => e.sequence > end.sequence)) {
          const allowed = event.event_type === 'http.metrics';
          if (!allowed) error(event, 'observation occurs after terminal HTTP boundary');
        }
      }
      const attempt = start.data.attempt;
      if (attempt.reason === 'initial') {
        if (attempt.index !== 0 || attempt.previous_span_id !== null) error(start, 'initial attempt must have index 0 and no previous span');
      } else if (attempt.index === 0 || attempt.previous_span_id === null) error(start, 'retry/redirect requires a positive index and previous span');
    }
    if (start?.data.invocation && end && !end.data.completion) error(end, 'handler end requires an explicit completion boundary');
    if (start && !start.data.invocation && end?.data.completion) error(end, 'handler completion attached to a non-handler operation');
    if (end?.event_type === 'operation.ended') {
      const outcomes = { returned: 'success', threw: 'error', cancelled: 'cancelled', observation_stopped: 'unknown' };
      if (end.data.completion && outcomes[end.data.completion] !== end.data.outcome) error(end, 'handler completion boundary disagrees with outcome');
      if (end.data.outcome === 'unknown' && end.data.completion !== 'observation_stopped') error(end, 'unknown operation requires observation_stopped handler boundary');
      if (end.data.completion === 'observation_stopped') {
        if (end.data.error !== null) error(end, 'stopped handler observation cannot claim a known error');
        if (typeof end.extensions?.['capture.observation_stop_reason'] !== 'string' || !end.extensions['capture.observation_stop_reason']) error(end, 'stopped handler observation requires a reason');
      }
      if (end.data.outcome === 'error' && end.data.error === null) error(end, 'failed operation requires error details');
      if (end.data.outcome === 'success' && end.data.error !== null) error(end, 'successful operation cannot carry an error');
    }
  }

  for (const [key, start] of spanStarts) {
    const context = start.context;
    if (context.parent_span_id === context.span_id) error(start, 'span cannot parent itself');
    if (context.parent_scope === 'local') {
      const parent = spanStarts.get(`${context.trace_id}/${context.parent_span_id}`);
      if (!parent) warn(start, 'local parent span missing');
      else if (parent.recording_id !== start.recording_id) error(start, 'local parent is in a different recording');
      else if (parent.sequence >= start.sequence) error(start, 'local child starts before its parent');
      if (parent && start.data.invocation) {
        if (parent.event_type !== 'operation.started' || stable(parent.data.origin) !== stable(start.data.invocation.caller)) error(start, 'handler caller must match its parent operation actor');
        const parentEnd = spanEnds.get(spanKey(parent.context));
        const handlerEnd = spanEnds.get(key);
        if (parentEnd && parentEnd.sequence < start.sequence) error(start, `${start.data.invocation.dispatch} handler starts after caller ended`);
        if (parentEnd && handlerEnd && handlerEnd.sequence > parentEnd.sequence) error(handlerEnd, `${start.data.invocation.dispatch} handler completes after caller ended`);
      }
    }
    if (start.event_type === 'http.request.started' && start.data.attempt.previous_span_id) {
      const previousKey = `${context.trace_id}/${start.data.attempt.previous_span_id}`;
      const previous = spanStarts.get(previousKey);
      if (!previous) warn(start, 'previous attempt missing');
      else {
        if (previous.event_type !== 'http.request.started' || previous.recording_id !== start.recording_id || previous.context.parent_span_id !== context.parent_span_id) error(start, 'previous attempt must be an HTTP sibling in the same recording');
        else {
          if (start.data.attempt.index !== previous.data.attempt.index + 1) error(start, 'attempt index must increment by one');
          if (start.data.attempt.visibility !== previous.data.attempt.visibility) error(start, 'attempt chain cannot mix logical calls and individual transport attempts');
        }
        const previousEnd = spanEnds.get(previousKey);
        if (previousEnd && previousEnd.sequence >= start.sequence) error(start, 'retry/redirect starts before the previous attempt ends');
        if (start.data.attempt.reason === 'redirect' && previousEnd && !(previousEnd.data.status_code >= 300 && previousEnd.data.status_code < 400 && previousEnd.data.status_code !== 304)) error(start, 'redirect predecessor must have a redirect status');
        if (previousKey === key) error(start, 'attempt cannot reference itself');
      }
    }
  }

  const requests = [...spanStarts.values()].filter((e) => e.event_type === 'http.request.started');
  const handlers = [...spanStarts.values()].filter(e => e.data.invocation?.kind === 'handler');
  const httpEnds = [...spanEnds.values()].filter((e) => e.event_type === 'http.ended');
  return {
    valid: errors.length === 0, errors, warnings, events,
    summary: {
      sessions: new Set(events.map(sessionKey)).size,
      recordings: records.size, events: events.length, duplicate_events: duplicateEvents,
      requests: requests.length,
      handler_calls: handlers.length,
      unfinished_handler_calls: handlers.filter(e => !spanEnds.has(spanKey(e.context))).length,
      unknown_handler_outcomes: handlers.filter(e => spanEnds.get(spanKey(e.context))?.data.completion === 'observation_stopped').length,
      failed_requests: httpEnds.filter((e) => e.data.status_code >= 400 || ['http_error', 'transport_error', 'timeout'].includes(e.data.outcome) || e.data.application_outcome === 'error').length,
      cancelled_requests: httpEnds.filter((e) => e.data.outcome === 'cancelled').length,
      unknown_outcomes: httpEnds.filter((e) => e.data.outcome === 'unknown').length,
      unfinished_requests: requests.filter((e) => !spanEnds.has(spanKey(e.context))).length,
      origins: [...new Set(events.flatMap(observedUrls).map((url) => { try { return new URL(url).origin; } catch { return 'invalid'; } }))].sort(),
    },
  };
}

function validateBody(event, error) {
  const body = event.data.body;
  if (body.observed_bytes !== null && body.total_bytes !== null && body.observed_bytes > body.total_bytes) error(event, 'observed_bytes exceeds total_bytes');
  if (body.availability !== 'captured') {
    if (body.availability === 'not_applicable' && (body.observed_bytes !== 0 || body.total_bytes !== 0)) error(event, 'not_applicable body must have zero observed and total bytes');
    return;
  }
  const { content } = body;
  let stored;
  if (content.encoding === 'base64') {
    try {
      const binary = atob(content.data);
      stored = binary.length;
      if (btoa(binary) !== content.data) error(event, 'body must use canonical padded base64');
    } catch {
      error(event, 'body must use canonical padded base64');
      stored = -1;
    }
  } else stored = new TextEncoder().encode(content.data).length;
  if (body.stored_bytes !== stored) error(event, 'stored_bytes does not match decoded captured content length');
  if (!body.truncated && body.observed_bytes !== null && body.total_bytes !== null && body.observed_bytes !== body.total_bytes) error(event, 'complete capture observed_bytes must equal total_bytes');
  if (!body.redacted && body.total_bytes !== null) {
    if (body.stored_bytes > body.total_bytes) error(event, 'unredacted stored bytes exceed total_bytes');
    if (!body.truncated && body.stored_bytes !== body.total_bytes) error(event, 'complete unredacted stored bytes must equal total_bytes');
  }
  if (!body.redacted && body.observed_bytes !== null) {
    if (body.stored_bytes > body.observed_bytes) error(event, 'unredacted stored bytes exceed observed bytes');
    if (!body.truncated && body.stored_bytes !== body.observed_bytes) error(event, 'complete unredacted capture must retain all observed bytes');
  }
}

function validateHttpEnd(event, error) {
  const { outcome, status_code: status, end_reason: reason } = event.data;
  if (outcome === 'success' && (status === null || status >= 400 || status < 200 && status !== 101)) error(event, 'successful HTTP exchange requires a final status below 400');
  if (outcome === 'http_error' && (status === null || status < 400)) error(event, 'http_error requires status 400–599');
  if (['transport_error', 'timeout'].includes(outcome) && (event.data.error === null || reason !== 'transport_failure')) error(event, 'transport failure requires error details and transport_failure boundary');
  if (outcome === 'cancelled' && reason !== 'cancelled') error(event, 'cancellation requires cancelled boundary');
  if (outcome !== 'cancelled' && reason === 'cancelled') error(event, 'cancelled boundary requires cancelled outcome');
  if ((outcome === 'unknown') !== (reason === 'observation_stopped')) error(event, 'unknown outcome requires observation_stopped boundary and vice versa');
  if (outcome === 'unknown' && event.data.error !== null) error(event, 'unknown outcome cannot carry a known transport failure');
  if (['success', 'http_error'].includes(outcome) && (event.data.error !== null || !['body_eof', 'body_closed'].includes(reason))) error(event, 'HTTP result must use an HTTP completion boundary and no transport error');
}
