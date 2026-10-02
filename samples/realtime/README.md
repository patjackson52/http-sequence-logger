# Current realtime native captures

These are actual schema 1.2 captures retrieved through the version 2 collector on October 1, 2026. They were not relabeled or imported from historical sources. `manifest.json` records current source environments and validator summaries, with no enrollment/source credentials.

A collector at loopback port44319 discovered the installed debug sample on two authorized Android emulators and two booted iOS simulators without a package/device selection. The Android samples publish `no_backup/HTTPSequenceLogger/source.json`; Swift publishes the Application Support descriptor. Push and file retrieval use one source attribution; the collector stored89 events across four sources at this snapshot. All four exported files validate with zero warnings.

- emulator-5556 completed the real nine-request recovery flow, including one SDK → app handler → SDK invocation and three public API origins. Its expected HTTP failure is retained.
- emulator-5554's real first request failed. The capture records that failure rather than manufacturing the rest of the flow.
- The iPhone16e simulator ran two failed manual requests against a closed test endpoint at4319. These complete failure captures remain valid evidence of error observation and delivery.
- The tf-ios-test simulator made a successful real manual request against the active test collector's health endpoint at44319. It validates the configurable test endpoint and successful native delivery.

The sample is a transfer package plus limited manual iOS instrumentation, not a general URLSession capture SDK. Emulator/simulator results do not verify physical iPhone signing, local-network permission, Bonjour permission prompts, foreground/suspension behavior or mobile Safari/Chrome. Those remain separate acceptance gates. Historical captures in sibling directories remain untouched and are not supported imports for the current collector.
