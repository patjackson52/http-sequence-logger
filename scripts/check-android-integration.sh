#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
consumer="$repo/integration/android-consumer"
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
analyzer="$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer"
if [[ ! -x "$analyzer" ]]; then
  echo "Install Android SDK command-line tools (latest); missing: $analyzer" >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==24||minor<13)throw Error("Node24.13+ (24.x) required")'

"$repo/android/gradlew" -p "$consumer" \
  :app:assembleDebug :app:assembleRelease \
  :app:testDebugUnitTest :app:testReleaseUnitTest :app:verifyReleaseDependencies

report="$repo/artifacts/android-integration"
mkdir -p "$report"
debug="$consumer/app/build/outputs/apk/debug/app-debug.apk"
release="$consumer/app/build/outputs/apk/release/app-release-unsigned.apk"
"$analyzer" dex packages --defined-only "$debug" > "$report/debug-packages.txt"
"$analyzer" dex packages --defined-only "$release" > "$report/release-packages.txt"
[[ "$("$analyzer" manifest debuggable "$release")" == "false" ]]
dependencies="$consumer/app/build/reports/release-dependencies.txt"
node --input-type=module - "$report" "$dependencies" <<'NODE'
import { readFileSync } from 'node:fs';
const [report, dependencies] = process.argv.slice(2);
const recorder = /dev\.networklog\.logger/;
if (!recorder.test(readFileSync(`${report}/debug-packages.txt`, 'utf8'))) throw Error('Debug positive control missing recorder classes');
if (recorder.test(readFileSync(`${report}/release-packages.txt`, 'utf8'))) throw Error('Release contains recorder classes');
if (/^project :(logger|demo-auth)$/m.test(readFileSync(dependencies, 'utf8'))) throw Error('Release includes recorder or original sample business module');
NODE
cp "$dependencies" "$report/release-dependencies.txt"
cp "$consumer/app/build/outputs/integration/synthetic-consumer.ndjson" "$report/synthetic-consumer.ndjson"
node "$repo/validate.mjs" "$report/synthetic-consumer.ndjson"
echo "External Android consumer verified: debug/release builds, business semantics, synthetic contract capture, and release exclusion."
echo "Reports: $report"
