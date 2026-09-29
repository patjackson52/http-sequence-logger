# Correctness review and resolution

Review scope: shared schema, reference validator, adapter lifecycle, fixtures, and the required customer manual logging API. Three separate agents reviewed network protocol, Android, and iOS concerns, then re-reviewed the corrections. The requested named `network_expert` agent role was unavailable; a separate reviewer applied the network-expert skill instead.

**Result:** all initial actionable findings resolved; all three reviewers found no remaining blockers for this contract/design phase. This result does not certify an implemented native SDK.

## Findings fixed

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | Successful completion at headers concealed later read failure/cancellation | Headers are nonterminal observations. HTTP remains open through body completion/close/failure/cancellation. Method operations can return sooner. Explicit capture stop retains unknown outcome and known status |
| P2 | Inconsistent observed/stored/total body sizes passed validation | Cross-field checks apply to complete and unavailable bodies; known total sizes must agree with completeness claims |
| P2 | Informational headers could follow the final response | Validator rejects interim responses after a final response |
| P2 | Android configured header subset appeared complete | Partial header capture preserves known entries and requires an explanation |
| P2 | Implicit HttpURLConnection execution/POST could produce incorrect metadata | Documented all executing accessors, snapshot-before-connect, inferred effective method, and optional configured-method source |
| P2 | Generic monotonic clock could undercount device sleep | Required sleep-inclusive platform clocks and synchronized observation/sequence allocation |
| P2 | “Refuse duplicate completion” could throw into customer code | Required nonthrowing, thread-safe, first-terminal-wins handles with optional diagnostics |
| P2 | iOS failed phases required an invented end timestamp | Native timing endpoints can be null, with at least one observed endpoint |
| P2 | Native transactions lost URL/status association under a logical task | Metrics retain a transaction index plus nullable redacted request/response snapshots |

Optional fidelity enhancement: custom clients can preserve exact request targets with source details, including forms not derivable from an ordinary absolute URL.

## Manual logging requirement

[MANUAL-LOGGING.md](MANUAL-LOGGING.md) now specifies the customer-facing path:

- Start a request directly from a logging session; method blocks are optional.
- Keep the existing HTTP client, request execution, callback routing, and original exceptions.
- The recorder supplies identity, timestamps, duration, adapter defaults, serialization, redaction, and unavailable capture states.
- Complete, fail, time out, cancel, or explicitly stop observation through a nonthrowing request handle.
- Provide metadata and body bytes only when already available; do not replay uploads or drain responses solely for logging.
- Use Kotlin synchronous or callback flows, URLSession completion handlers, async Swift flows, or equivalent Objective-C handles.

This is a required API design, not a released SDK feature. Examples deliberately label proposed API names; customers cannot import native SDK classes from this package yet.

## Verification

- `npm test`: **65 passed**.
- `npm run validate`: **16 reference captures valid**.
- Interrupted recording deliberately produces four missing-end warnings.
- Network reviewer reran the original failing mutations and confirmed rejection after the fixes.
- Android reviewer independently validated minimal manual capture, observation stop, and late stream timeout.
- iOS reviewer ran eight targeted fixture/manual/iOS tests.
- Generated schema/fixture reproducibility and local documentation links checked.

The manual-minimal fixture has a root HTTP span without method operations, omitted header/body content, and unknown effective response URL. The read-timeout fixture preserves HTTP 200 while classifying the later read failure correctly. iOS fixtures preserve incomplete phase timing and multiple native transactions without inventing observation timestamps.

## Remaining implementation validation

The package contains synthetic records and API/schema contracts. Native wrappers and a viewer still need implementation. Device-level tests must establish that capture preserves networking behavior, native stream semantics, redirects, async cancellation, sleep-inclusive timing, callback counts, and download-file lifetimes. Those properties cannot be established by JSON validation alone.


## Kotlin implementation follow-up

The contract review above preceded native implementation. The implemented Kotlin recorder and sample subsequently received independent network and Android reviews. Findings about relative Location redaction, GET/body rewriting, lazy connection error stages, retained stop reasons, and opaque session ID handling were fixed and re-reviewed. See [E2E.md](E2E.md) for tests and live evidence; [Android README](android/README.md) documents the implemented subset and remaining capabilities. Java API support is out of scope at the user's request.
