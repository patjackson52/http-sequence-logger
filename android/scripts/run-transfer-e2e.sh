#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${ANDROID_SERIAL:?Set ANDROID_SERIAL explicitly to the target emulator/device.}"
if [[ $# -ne 0 ]]; then
  echo "Positional pairing/port arguments are unsupported. The maintained harness uses isolated fixture pairing and never overwrites manual app pairing." >&2
  exit 2
fi
exec node "$ROOT/scripts/check-android-instrumentation.mjs" --device "$ANDROID_SERIAL"
