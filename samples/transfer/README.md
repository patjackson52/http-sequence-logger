# Real native captures delivered to the collector

Captured on 2026-09-29 UTC. These files contain original, already-sanitized event lines received and durably acknowledged by the local collector. No pairing tokens, private keys or connection configuration are included.

- `android-recovery.ndjson`: Android emulator, 57 events, 9 requests to httpbin, DummyJSON and JSONPlaceholder, including expected 401 recovery and an app handler invoked from the SDK. Final operation succeeds.
- `ios-native.ndjson`: iPhone 16e Simulator, iOS 26.3.1. Three successful real URLSession health requests, 21 events across 3 sessions. Delivery scenarios: refused connection then automatic recovery, HTTP, and explicitly paired HTTPS. `/api/v1/health` is the recorded demo request; the transport's own `/api/v1/events` calls are excluded. The health response's collector ID is a non-secret identifier.
- `multi-platform.ndjson`: those four independent sessions in one importable file. This demonstrates session selection across platforms, not client/server trace merging or synchronized clocks.

The iOS native test run was `820b68a8-6c2b-4b55-a2be-8622d4300c0f`. Local xcresult and detailed evidence are ignored under `ios/.local/`; see [verification](../../docs/transfer/VERIFICATION.md) and the [reproduction instructions](../../ios/README.md).

```sh
node validate.mjs samples/transfer/*.ndjson
```

Select **Transferred Android + iOS · native captures** from the web viewer's samples, or drop any of these files into it.
