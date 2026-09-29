# Viewer review and end-to-end evidence

This review checks the imported Claude design against the repository's capture contract and real native output. The [design specification](design/claude-export/Spec.dc.html) supplies the UI requirements; [CONTRACT.md](../CONTRACT.md) controls event semantics when the prototype differs. The imported prototype's synthetic `v: 1` events are not the SDK's format.

## Native verification

On 2026-09-29 UTC, this command completed successfully:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ANDROID_SERIAL=emulator-5554 scripts/run-android-e2e.sh
```

The Android 17 / API 37 emulator ran the real Kotlin sample flow against `https://dummyjson.com`, `https://httpbin.org`, and `https://jsonplaceholder.typicode.com`. Build tasks succeeded; the logger's 26-test JVM suite was up to date with zero failures, and a fresh device instrumentation run reported `OK (1 test)` in 6.311 seconds. The sample's HTTP adapter uses the platform HTTP connection API, and the customer handler records its own request through the manual API.

| Fresh local artifact | Events | Requests | Handlers | Failed HTTP | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `artifacts/live/successful-sign-in.ndjson` | 52 | 8 | 1 | 0 | Valid, no warnings |
| `artifacts/live/recovered-sign-in.ndjson` | 57 | 9 | 1 | 1 | Valid, no warnings; intentional 401 followed by recovery |
| `artifacts/live/multi-session.ndjson` | 109 | 17 | 2 | 1 | Valid, no warnings; two sessions and recordings |

The successful capture began at `2026-09-29T03:42:25.147Z`; recovery began at `2026-09-29T03:42:29.954Z`. These are new captures, separate from the checked-in samples. Device-side redaction occurred before persistence. The instrumentation asserts both successful business results, complete request endings, three origins, two manual HTTP calls nested in handlers, explicit handler return before `DemoAuthSdk.acceptTask`, and absence of the demonstration password and JWT prefix from persisted data. This verifies the Android integration; it makes no claim of an implemented or tested iOS recorder.

## Contract decisions for the viewer

- Sequence is authoritative within a recording; monotonic time and input line can break ties. The prototype's timestamp-based row-kind priorities do not override sequence. Separate recordings have independent clocks and never acquire a cross-recording elapsed-time gap.
- The design's H-15 refers to nine requests in the successful live sample. Its source capture actually contains eight; recovery has nine. Acceptance follows the captured records, not that stale count.
- A final response header is a header observation, not completion. A known 200 followed by a body timeout must retain both the 200 and timeout. Missing response status is unknown, never zero. Informational responses remain separate from a final response.
- `unknown`, unfinished, and cancelled are distinct from HTTP failure. A known status of 400 or higher still counts as failed if completion was stopped or cancelled; unknown and failed counters may overlap.
- Initial request URL, observed effective response URL, and native transaction snapshots have different meanings. A missing effective response URL must not silently become the initial URL. Origin lanes group scheme, hostname, and effective port while preserving source URLs for inspection.
- HTTP lane ownership and the owner filter use the recorded executor; the business initiator and callsite remain independently inspectable. This deliberately resolves a design inconsistency: §8 asks for initiator lanes, but the real SDK records the app as the business initiator of SDK-executed calls. Executor lanes distinguish calls made inside the SDK from app code, as the product requires. An SDK invoking an app handler does not turn the handler's manually executed HTTP into SDK-owned traffic.
- Handler calls and returns are paired by recording, trace, and span identity. The waiting region belongs to the one calling operation, never an entire SDK lane or thread. A child HTTP exchange can complete after its handler returns without extending the handler or inventing resumption.
- A stopped handler has no return arrow and no method-duration label. Its recorded interval may appear in Timing as an **observed interval**. A missing handler end has no end time or duration. Handler arguments, return values, and business results always say **Not captured**.
- Headers and query parameters retain repeated entries and their order. Raw body text remains canonical; pretty JSON is a derived display. Redaction, truncation, unavailability, not-applicable, and missing capture are independent states. Stored bytes are not inferred from `Content-Length`.
- Imported labels, URLs, and payloads remain inert text. Opening a capture must not execute its content or contact its destinations. Import validation diagnostics are distinct from network outcomes.

## Viewer verification

The three fresh native files were also imported through the implemented viewer model and sequence layout in a separate read-only check. All imported without diagnostics. Assertions verified the exact 8/9/17 request counts, two local arrows and one waiting segment for each handler, SDK request arrows starting at the SDK lane, manual handler request arrows starting at the App lane, and the SDK owner filter excluding exactly the app's manual request in each session.

Independent code review found and prompted fixes for opaque event IDs colliding with JavaScript object properties, missing span-ID search, source-line misalignment after duplicate-file import, local-only filtering that dropped ordinary methods, HTTP-only filtering that dropped no-HTTP handler ancestry, orphan response data creating a fabricated outbound request arrow, and remote parent IDs being incorrectly treated as local method ancestry. Model regression tests cover import identity, source attribution, filtering, application errors independent of HTTP status, and precision beyond JavaScript's safe integer range.

Five independent UI regression tests render the actual Inspector JSX through Vite and React server rendering. They passed for inert HTML in body/header/query data and repeated entries, never-displayed handler arguments/results, absent duration for stopped or unfinished handlers, caught handler errors retaining the caller's successful outcome, and HTTP 200 retaining timeout or independent application-error status. These exercise rendered markup, not browser focus, clipboard, or file-picker behavior.

## Browser verification

### SVG export

`npm run check:svg-export` builds the production viewer and tests actual downloads in an isolated Chrome profile. The 2026-09-29 run used Chrome 154.0.8037.58 and passed 12 downloads: a selected handler with expanded component lanes, the same sequence from List view, collapsed handler, HTTP-only ancestry, multiple servers, narrowed search, a second session, all recordings, one recording, a body timeout, mobile layout and hostile capture text. An empty search disables download. The selected SVG was also opened as a standalone file and embedded as an image with the browser offline; both rendered, with text inside the image bounds. Screenshots were visually compared with the live diagram.

The renderer consumes the live sequence's layout, so export follows session/recording selection, filters, collapse state, component lanes and item highlights. It adds a session title and lane headings and includes offscreen rows. Interactive controls, inspector data and hidden events are omitted. Native shapes/text keep the image self-contained; capture strings are XML-escaped and invalid XML characters replaced. Unit tests also cover every reference session, no fabricated handler return, successful headers followed by body failure, origin filtering and safe Unicode filenames.

`npm test` passes **214 tests** after this feature; the production viewer build passes. A strict console check also found inlined font subsets blocked by the existing CSP; the build now emits local font files instead of data URLs. Downloaded SVGs, standalone/embedded screenshots and the browser report are in ignored `artifacts/svg-export/`. This run checks Chrome; other browsers and document editors were not exercised. System font differences and very large diagrams remain portability/performance limits.

### Original viewer checks

The production bundle was served locally at `http://127.0.0.1:4173` and exercised in the owner's Chrome session on 2026-09-29 UTC. Desktop verification used 1440 × 1000; mobile used 390 × 844.

| Check | Observed result |
| --- | --- |
| Native file picker → fresh `artifacts/live/multi-session.ndjson` | 109 events accepted; two sessions; zero diagnostics; success has 8 requests and recovery has 9 with the intentional 401 |
| Successful native handler | SDK call → App handler → manual GET `/todos/1` → explicit return → SDK `acceptTask`; wait hatch scoped to `authenticate` |
| Child navigation / Attribution | Handler Children opened the real manual request; initiator `CustomerTaskHandler.loadTask`, executor `CustomerTaskClient.loadTask`; parent navigation and prior-selection button available |
| SDK filter | 7 of 8 success-session requests; the app handler request is excluded |
| No-HTTP handler | 0 requests, 1 handler, no server origins; call and return visible; HTTP-only retains the handler ancestry pill |
| Observation stopped | No return arrow; inspector duration `—`; completion `observation_stopped`; verbatim reason `capture_disabled` |
| Body-read timeout | Main sequence retains `200` headers and a separate `timed out` terminal outcome, including the partial payload preview |
| Repeated/nested handlers | Separate `loadTask() #1` and `#2`, nested App → SDK `currentToken`, distinct SDK component lanes on expansion |
| Keyboard | Right from call focuses its handler block without opening details; Enter opens Invocation |
| Six-origin / multi-recording fixture | Six distinct server lifelines, recording selection, independent-clock banners; empty search offers clear/reset |
| Malformed sample | Two invalid lines skipped, partial final line warned, 10 accepted events retained |
| Mobile | No document horizontal overflow at 390 px; sequence scroll is contained; List and filter sheet work; closing a sheet restores trigger focus |
| Mobile inspector | Full-screen dialog, background inert, initial Back focus, Tab/Shift+Tab wrap, Escape closes; request and handler inspectors both checked |
| Clipboard | Copy URL returned the exact captured URL; mobile copy controls measured 44 px tall |
| Browser errors | No captured console errors or warnings during tested flows |

The UI checks were performed against the built application, not the exported prototype. The exported design files remain unmodified references. Local captures were not sent to any remote service. Imported content is rendered by React as escaped text, reinforced by a CSP with no remote scripts, images, or connections; hostile markup is also covered by rendered-JSX regression tests.

## Acceptance coverage and final checks

- H-1 through H-9: no-HTTP/control outcomes, native owner attribution, caller-only wait, ID pairing, 1.0 compatibility and uninstrumented callers are covered by fixture/model/layout tests; representative flows were also exercised in Chrome.
- H-10 and H-11: added reproducible `handler-http-outlives-return` and `handler-repeated-nested` fixtures. Tests verify observed return before later HTTP completion, repeated identities, depth and SDK ownership. The repeated/nested fixture was checked in Chrome.
- H-12 through H-17: shared selection identity, HTTP-only ancestry, never-captured values, existing HTTP details, keyboard navigation and cancellation filtering are covered by layout/model/JSX tests and the browser checks above.
- `npm test`: **149 passed**, zero failures. This includes the pre-existing contract suite and new model, layout, and rendered-JSX tests.
- `npm run build:viewer`: passed. `npm install --package-lock-only` reported zero known dependency vulnerabilities.
- Fresh Android build and instrumented live run: passed as detailed above. iOS fixture import is tested; no native iOS SDK implementation is claimed.

Known scope limits are documented in `viewer/README.md`: no server-log merging, async continuation model, persisted imports or session comparison. The sequence canvas is intended for small development sessions and is not virtualized; the paginated list and method collapse assist with larger captures.
