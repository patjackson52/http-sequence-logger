# Session HTTP request files

The single-session viewer offers an **HTTP requests** view. Select a source when several participate, then inspect or download identical UTF-8 text with a `.http` or `.rest` extension. This view includes all loaded requests for that source, regardless of sequence/list filters. It uses the common request syntax documented by [JetBrains](https://www.jetbrains.com/help/idea/exploring-http-syntax.html) and [VS Code REST Client](https://github.com/Huachao/vscode-restclient): `###` separators, method and URL, repeated header lines, then a blank line and captured text body.

## Source and capture fidelity

Collector event pages supply additive `recording_sources` metadata separately from original canonical lines. Paging and selection generation checks stage this attribution alongside capture text. Client groups combine app and SDK ownership using the registered environment, application and installation. Backend groups include the collector source, service, producer environment and runtime, so one collection adapter can hold several distinct services.

Canonical file imports do not establish physical device identity. Client recordings stay separate when identity is unavailable; imported backend invocations group by recorded service/environment/runtime. Sources include the selected session's related backend recordings. Ordering follows recording appearance and local request sequence; independent clocks are not aligned.

Request metadata, capture limitations, response observations and event provenance appear as comments before request payloads. Captured UTF-8 bodies and duplicate headers remain literal. Missing request starts stay observations. Binary/base64 payloads remain in comments with an explicit inline limitation. Payloads containing HTTP-client directives, delimiters or variable syntax are preserved as escaped JSON comments with the request disabled; they cannot become unintended requests, file includes or scripts. This is an inspection/export feature; no requests execute in the viewer.

## Reviews and verification — October 13, 2026

A separate agent reviewed the design. Independent agents reviewed serializer, UI and collector integration. Review fixes preserve source selection on pause, split services sharing an adapter, retain configured methods/request targets/header redaction metadata, and republish identical captures after collector identity reset.

Verified with Node 24.13.0 and installed Chrome 155.0.8059.40:

- `npm test`: 413 tests passed, including 22 request export cases and provenance paging/reset regressions.
- `npm run build:viewer`: production build passed.
- `npm run check:http-export`: production collector/browser source selection, two same-app devices, combined app/SDK ownership, combined backend invocation recordings, diagram filter independence, identical preview/download bytes for both extensions, new and unchanged events, pause selection/scroll, source selection through view/comparison round trips, mobile keyboard/downloads and inert file import passed.
- `npm run check:svg-export`: 12 downloads plus standalone/offline rendering passed.
- `npm run check:viewer-realtime`: empty and eight-request live sessions passed.
- `npm run check:live-setup`: 18 bootstrap, reconnect, selection and access checks passed.
- `npm run check:comparison`: production comparison acceptance passed.

Browser evidence is generated under ignored `artifacts/http-export/`. These checks use synthetic canonical fixtures through the real collector and production browser; they do not claim new native SDK capture behavior or binary replay support.
