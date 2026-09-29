#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${ANDROID_SERIAL:?Set ANDROID_SERIAL explicitly to the target emulator/device.}"
PAIRING=${1:?Provide the loopback port-4319 collector connection JSON path.}
TLS_PAIRING=${2:-}
mkdir -p artifacts/transfer
./android/gradlew -p android :logger:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug :logger:lintDebug --console=plain > artifacts/transfer/android-build.txt
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$ANDROID_SERIAL" shell run-as dev.networklog.sample mkdir -p files/network-log
adb -s "$ANDROID_SERIAL" shell -T "run-as dev.networklog.sample sh -c 'cat > files/network-log/connection.json'" < "$PAIRING"
adb -s "$ANDROID_SERIAL" reverse tcp:4319 tcp:4319
run_case() {
    local name=$1
    local method=$2
    shift 2
    adb -s "$ANDROID_SERIAL" shell am instrument -w -r -e class "dev.networklog.app.TransferFlowTest#$method" "$@" dev.networklog.sample.test/androidx.test.runner.AndroidJUnitRunner > "artifacts/transfer/$name.txt"
    node --input-type=module -e 'import fs from "node:fs"; if (!fs.readFileSync(process.argv[1], "utf8").includes("OK (1 test)")) process.exit(1)' "artifacts/transfer/$name.txt"
}
run_case android-live-transfer pairedCollectorReceivesCaptureAndRetainsLocalExport -e transferLiveFlow true
run_case android-debug-factory factoryDoesNotReadPairingInNonDebuggableApplication
adb -s "$ANDROID_SERIAL" reverse --remove tcp:4319
trap 'adb -s "$ANDROID_SERIAL" reverse tcp:4319 tcp:4319 >/dev/null 2>&1 || true' EXIT
run_case android-offline-write offlineSpoolSurvivesCloseAndResumesWithoutNewIds -e transferOfflinePhase write
adb -s "$ANDROID_SERIAL" reverse tcp:4319 tcp:4319
run_case android-offline-resume offlineSpoolSurvivesCloseAndResumesWithoutNewIds -e transferOfflinePhase resume
adb -s "$ANDROID_SERIAL" exec-out run-as dev.networklog.sample cat files/captures/transfer-offline-e2e.ndjson > artifacts/transfer/android-offline-capture.ndjson
node validate.mjs artifacts/transfer/android-offline-capture.ndjson
if [[ -n "$TLS_PAIRING" ]]; then
    adb -s "$ANDROID_SERIAL" shell -T "run-as dev.networklog.sample sh -c 'cat > files/network-log/connection-tls.json'" < "$TLS_PAIRING"
    adb -s "$ANDROID_SERIAL" reverse tcp:4320 tcp:4320
    run_case android-tls-transfer pinnedTlsAcceptsPairedLeafAndRejectsDifferentPin
fi
echo 'Android live transfer, offline replay, and configured TLS checks passed.'
