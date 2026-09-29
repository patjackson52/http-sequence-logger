#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
: "${ANDROID_SERIAL:?Set ANDROID_SERIAL to the device/emulator to use (see adb devices).}"
OUTPUT=${1:-artifacts/live}
mkdir -p artifacts
./android/gradlew -p android :app:assembleDebug :app:assembleDebugAndroidTest :logger:testDebugUnitTest --console=plain
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$ANDROID_SERIAL" shell am instrument -w -r -e class dev.networklog.app.LiveFlowTest dev.networklog.sample.test/androidx.test.runner.AndroidJUnitRunner | tee artifacts/instrumentation.txt
node --input-type=module -e 'import {readFileSync} from "node:fs"; if (!readFileSync("artifacts/instrumentation.txt", "utf8").includes("OK (1 test)")) process.exit(1)'
adb -s "$ANDROID_SERIAL" exec-out run-as dev.networklog.sample cat files/captures/live-e2e.ndjson > artifacts/live-e2e.ndjson
node scripts/collect-live.mjs artifacts/live-e2e.ndjson "$OUTPUT" "$(adb -s "$ANDROID_SERIAL" shell getprop ro.build.version.release | tr -d '\r')" "$(adb -s "$ANDROID_SERIAL" shell getprop ro.build.version.sdk | tr -d '\r')"
node validate.mjs "$OUTPUT"/*.ndjson
