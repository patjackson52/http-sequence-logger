# Desktop viewer screenshots

These PNGs are actual 1440 × 1000 desktop captures of the repository viewer in Google Chrome, with local fonts loaded. No diagram data, labels, or UI styling was replaced for the screenshots. The root README uses relative Markdown image links so GitHub can render the committed files without an external image host.

| Screenshot | Capture / selected view |
| --- | --- |
| [Multi-server sign-in](desktop-multi-server.png) | [Real Android sessions](../../samples/live/multi-session.ndjson), successful sign-in selected |
| [Awaited handler](desktop-awaited-handler.png) | [Real browser auth sample](../../samples/web/browser-auth-recovery.ndjson), app handler invocation inspector |
| [HTTP retry](desktop-retry.png) | [Synthetic retry fixture](../../examples/retry.ndjson), HTTP 503 response inspector |
| [Body timeout](desktop-body-timeout.png) | [Synthetic read-timeout fixture](../../examples/stream-read-timeout.ndjson), response inspector |

Refresh from the repository root with Node 22.12+ and Google Chrome installed:

```sh
npm ci
node scripts/capture-readme-screenshots.mjs
```

The script builds the viewer, serves it on an available loopback port, launches an isolated browser profile, imports committed captures, selects the displayed scenarios, and writes these four images. It closes the browser/server afterward and does not use the user's signed-in browser session. Inspect each PNG before committing a refresh. `WEB_TEST_CHANNEL` can select another installed Playwright Chromium channel.
