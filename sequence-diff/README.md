# Standalone sequence diff

A filesystem-independent ESM module and local CLI for comparing canonical HTTP sequence captures. The module has no viewer, collector, React, filesystem or network dependency. The CLI supplies file I/O. Node 24.13.x is the supported CLI runtime.

The formats are **project-defined, versioned interchange contracts**, not OTLP, HAR or an RFC JSON Patch. A diff explains correspondence and observations; it is not an executable or reversible patch.

## Use from this checkout

Run commands from the repository root after its normal dependency installation:

```sh
node sequence-diff/cli.mjs compare examples/success.ndjson examples/retry.ndjson --format text

node sequence-diff/cli.mjs normalize examples/success.ndjson --output success.sequence.json

node sequence-diff/cli.mjs compare primary.sequence.json secondary.sequence.json --output comparison.diff.json --check
```

JSON is the default output. stdout contains only the requested result; errors go to stderr. Output files are created exclusively: existing files are never overwritten. Inputs are regular local files, bounded to 16 MiB each; URLs and stdin are not supported in v1. Incomplete final JSON lines are rejected rather than silently discarded.

For captures containing multiple sessions, use `--primary-session` / `--secondary-session` and the corresponding `--primary-namespace` / `--secondary-namespace` when needed. Normalization uses `--session` and `--namespace`. Ambiguous selection returns the available session identities and exits without producing a diff.

Without `--check`, successfully producing a comparison exits 0 regardless of its findings. With `--check`:

| Code | Meaning |
| --- | --- |
| 0 | Equal within the declared comparison scope and profile |
| 1 | At least one observed difference |
| 2 | Invalid input, options, I/O, schema, or comparison-limit error |
| 3 | Inconclusive: no known difference, but unknown data or correspondence remains |

Differences and uncertainties can coexist. Always inspect `summary.uncertain_pairs`, individual uncertainties and diagnostics, even when `result` is `different`. A difference is not a determination that secondary is defective.

## Standalone package and module

```sh
npm pack ./sequence-diff
# In a separate consumer project:
npm install /path/to/http-sequence-logger-sequence-diff-0.1.0.tgz
npx sequence-diff --help
```

The package is prepared for local distribution; no registry publication is implied.

```js
import {
  sequencesFromCapture, validateSequence, diffSequences,
  validateDiff, formatDiffText, SequenceDiffError
} from '@http-sequence-logger/sequence-diff';

// Each string contains existing canonical event-schema 1.2 NDJSON.
const [primary] = sequencesFromCapture(primaryNDJSON);
const [secondary] = sequencesFromCapture(secondaryNDJSON);

const diff = diffSequences(primary, secondary, {
  compare_timing: false,
  json_fields: true,
  ignore_headers: ['x-request-id'],
  ignore_paths: []
});
validateDiff(diff);
console.log(formatDiffText(diff));
```

`sequencesFromCapture` also accepts an event array and returns one document per session. Do not select the first element blindly in production; resolve the intended namespace and session ID. `validateSequence` validates schema and cross-event semantics and returns the canonical validator's result. `validateDiff` validates the output schema; it does not load source documents to verify externally edited references.

Functions do not mutate their inputs. Output has no generation timestamp or random identifiers: identical inputs and options produce identical JSON. Pair IDs are deterministic for a comparison, not permanent identities across different comparisons or profiles.

## Input contract

[sequence.schema.json](schema/sequence.schema.json) defines:

```json
{
  "format": "http-sequence",
  "schema_version": "1.0",
  "session": { "namespace": "example/development", "id": "sign-in-184" },
  "events": []
}
```

The illustrative empty array must be replaced with actual schema-1.2 events. It is invalid as an input on its own. The wrapper preserves canonical event data, including body bytes/text, repeated headers and queries. It does not change native/browser producer contracts or serialize the viewer's internal objects. Reconstruction is a derived model.

Schema validation plus semantic validation reject contradictory events. Identical replayed event IDs deduplicate. Missing observations can remain valid partial captures with explicit warnings. Input event pointers refer to the original input document; event IDs retain traceability across normalization.

## Matching and order

1. Match recording nodes using stable source identity for the same session, otherwise a unique producer platform/app ID plus recording name, with a unique producer identity fallback.
2. Match sibling calls only inside paired parents. HTTP signatures use executor, method, exact normalized origin/path, and observable attempt index/reason/visibility. Query values and response data do not influence matching.
3. Operation/handler signatures use kind, actor, operation name and invocation information. Changed signatures stay one-sided unless explicitly paired. There is no fuzzy endpoint, component, environment or path-parameter aliasing in v1.
4. Duplicate signatures remain unresolved instead of matching by occurrence. Match confidence `exact` means exact source identity or a unique exact key, not proof of equivalent behavior.
5. Order comparisons describe pairwise sibling relationships. Completed non-overlapping spans establish before/after; overlaps remain overlaps. Start-order differences with overlapping or unfinished spans are labeled `observed_order_only`. Recording-file order is not compared as causal order across independent clocks.
6. A call with no counterpart in an incomplete parent/recording is unresolved. One-sided children beneath an unpaired subtree inherit that uncertainty.

Use an options JSON file with `--options options.json` to pin otherwise ambiguous matches:

```json
{
  "matches": [
    { "primary": "COPY_PRIMARY_NODE_ID", "secondary": "COPY_SECONDARY_NODE_ID" }
  ],
  "recording_matches": [],
  "ignore_paths": [],
  "ignore_headers": [],
  "compare_timing": false,
  "json_fields": true
}
```

Copy `node_id` values from the diff. Both endpoints must exist, have the same kind and be within paired parents; pair recordings and ancestors first. Overrides are one-to-one. Reparenting is represented as one-sided subtrees in v1, not silently repaired.

## Content, uncertainty and scope

The result always records the applied profile and included/excluded scope.

- Compare request/response metadata, ordered repeated headers and query values, bodies, outcomes, attempts, actors, informational responses, trailers and producer metadata.
- Preserve raw body content. Where both bodies contain complete, unredacted UTF-8 JSON, add field-level `/request_body/json/...` or `/response_body/json/...` differences. Duplicate JSON keys, unsafe numeric tokens and excessive JSON nesting fall back to raw comparison.
- Missing, unavailable, truncated or redacted body content is unknown. Redacted header and URL values are not compared as original values. Known capture metadata can differ independently of unknown content.
- Null and absent are distinct: each change side contains `present` and `value`. Paths use escaped JSON Pointer segments; body `json` fields and request `query` arrays are documented derived projections.
- `ignore_paths` contains exact pointers into the projected call/recording data, applying to entire subtrees. These rules affect field comparison, not structural matching. Ignoring a derived JSON field does not suppress the raw-body difference; explicit raw-content/metadata exclusions are required if that is intended.
- `ignore_headers` matches names case-insensitively while preserving remaining order, duplicates and original casing. V1 does not automatically equate differently ordered/coalesced library header observations.
- Timing is opt-in and compares completed `duration_ns` strings exactly. It never subtracts independent clocks. Wall timestamps, monotonic origins, native metrics, arbitrary extensions, and uncaptured handler arguments/return values are outside v1 comparison scope.
- Partial headers, stopped observations, missing bodies, unfinished spans, missing parents and incomplete recordings stay visible as uncertainties. Equal retained data alone does not prove equal uncaptured data.
- This tool consumes already-sanitized captures and preserves their values. It is not a redaction engine.

## Output contract

[diff.schema.json](schema/diff.schema.json) is a self-contained Draft 2020-12 JSON Schema. The main sections are:

| Field | Consumer use |
| --- | --- |
| `inputs`, `engine`, `profile`, `scope` | Identify sessions, algorithm and comparison rules |
| `pairs` | Corresponding or unmatched recording/operation/handler/HTTP nodes |
| `pairs[].parent_pair_id` | Build the shared hierarchy |
| `primary` / `secondary` references | Original ordering, event IDs and input JSON pointers |
| `matching` | Source/key/manual basis and ambiguous candidates |
| `presence`, `equivalence` | Separate correspondence from field equality |
| `changes` | Field paths, dimensions and values from both sides |
| `uncertainties`, `ignored_paths` | Explain limits and applied exclusions |
| `order_changes` | Reorder/concurrency relationships between paired siblings |
| `summary`, `diagnostics` | Machine triage and human overview |

Counts include recording and operation nodes as well as HTTP calls; `changed_pairs` and `uncertain_pairs` can overlap. Order changes are counted separately, so equal field values do not imply an unchanged sequence. A node ref's `position` is its recording ordinal or span's event-sequence position, not a shared timestamp. Pair-array order is deterministic traversal, not a precomputed aligned visual layout.

All three planned viewer representations consume this format. AI consumers should cite pair IDs plus source event pointers, retain uncertainties and distinguish observed differences from causal hypotheses.

## Limits and maintenance

The engine bounds inputs at 20,000 events and 5,000 reconstructed nodes per side, parent nesting at 128 levels, sibling-order work at 1,000,000 pair comparisons, and field/order changes at 20,000. Limit violations fail explicitly; they do not emit a partial result labeled complete. This initial conservative engine targets development captures, not million-span traces.

Author the two schemas in `scripts/build-diff-schema.mjs`. Run `npm run generate:diff` after changing them or canonical capture validation. Generated package-local validators and capture-validation copies keep the npm package self-contained; their authoritative capture sources remain `shared/`. Run `node --test test/sequence-diff.test.mjs`, the full repository suite, and a standalone-package smoke check before distributing changes.
