#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17.}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK.}"
mkdir -p artifacts/release-audit
./android/gradlew -p android :logger-api:test :logger:testDebugUnitTest \
  :demo-auth:testDebugUnitTest :demo-auth:testReleaseUnitTest \
  :app:assembleDebug :app:assembleDevDebug :app:assembleRelease :app:assembleReleaseUnminified \
  :demo-auth:bundleReleaseAar :app:verifyReleaseDependencies \
  --console=plain > artifacts/release-audit/build.txt 2>&1
python3 android/scripts/verify-release.py
if ./android/gradlew -p android :app:assembleRelease -PnetworklogLeakProbe=true --console=plain > artifacts/release-audit/rejected-dependency.txt 2>&1; then
  echo 'ERROR: production accepted an accidental recorder dependency' >&2
  exit 1
fi
python3 - <<'PY'
from pathlib import Path
import json
text = Path('artifacts/release-audit/rejected-dependency.txt').read_text()
assert 'No matching variant' in text and 'project :logger' in text, 'Negative probe failed for an unrelated reason'
path = Path('artifacts/release-audit/result.json')
result = json.loads(path.read_text())
result['accidental_release_dependency_rejected'] = True
path.write_text(json.dumps(result, indent=2) + '\n')
print('Release graph, API/AAR, APK, resource, R8 and accidental dependency checks passed.')
PY
