# Collection and parsing adapters

An adapter integration has two independently reusable components. A collection adapter retrieves bounded source records using an application-owned file path or provider credential. A parsing adapter extracts canonical events or normalizes an existing raw format. The collector owns both; the viewer chooses configured sources and trace seeds without receiving credentials or arbitrary file access.

```text
Local journal / Cloudflare retained logs / custom source
  -> collection adapter -> parsing adapter -> canonical collector events
  -> trace-indexed snapshot -> distributed sequence viewer
```

## Logging paths

- Emit canonical event JSON through the existing application logger. The parser unwraps provider envelopes; no separate file is required.
- Write canonical NDJSON to a dedicated local journal or deliver it directly. This is useful when the ordinary pipeline truncates/samples records.
- Parse existing JSON/text logs. Supply trace/span/parent identifiers where available. Plain messages become associated messages, not fabricated request starts/ends.

## Built-in collection

The local-file adapter reads a configured retained journal within byte/record limits. Stable original event IDs make repeated reads safe. Providers may wrap JSON records, so parsing should be chosen independently of the transport.

The Cloudflare adapter queries an application-provided authenticated bounded retained-NDJSON endpoint. This is an explicit host integration, useful for a development Worker that retains structured console records. It is not an implementation of the native Workers Logs history API. The endpoint and credential remain in private collector source configuration. The host owns authorization, retention and source-level sampling/truncation metadata.

See [collector adapter source](../../collector/adapters.mjs) for exact factory/configuration signatures and [collector guide](../../collector/README.md) for CLI setup. Do not commit source files containing tokens or private captures. Missing credentials, HTTP failures and unavailable files are source diagnostics, not empty successful traces.

## Parsers and custom formats

Use the canonical parser for event JSON, including supported provider envelopes. Use a declarative JSON mapping when the application already logs known fields for message, trace/span context, timestamp and level. An injectable custom parser handles bespoke conventions. Its output must obey the canonical schema and preserve provenance, stable identity and partial knowledge.

A parser can connect records only when the original data supplies correlation identity. Matching the same URL or nearby time is insufficient for a confirmed remote link. Custom parsers must not invent durations, network headers, successful completion or missing parent observations. Uncorrelated messages can remain uncorrelated.

Keep parsing bounded. Define framing for multiline records, maximum record size and behavior for malformed/truncated input. Return diagnostics with original source references; retain enough origin information to investigate a failed normalization. Never hide failed parsing to report an apparently complete trace.

## Jobs and extension acceptance

The collector exposes bounded related-log collection jobs with per-source status and cancellation. Repeated concurrent requests coalesce where applicable; replay never regenerates canonical event identity. A finished query describes retrieval completion, while retention, sampling and missing observations limit trace completeness.

For a custom adapter/parser, verify real retained data, malformed records, unchanged replay, independent-source parentage, cancellation, failure and explicit bounds. Test two concurrent traces to prove request context isolation. Preserve application logger and HTTP behavior when instrumentation is disabled.
