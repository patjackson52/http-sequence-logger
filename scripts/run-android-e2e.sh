#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${ANDROID_SERIAL:?Set ANDROID_SERIAL explicitly to the target device/emulator.}"
if [[ $# -ne 0 ]]; then
  echo "Positional output/config arguments are unsupported. The maintained harness creates a fresh private collector and evidence directory." >&2
  exit 2
fi
exec node "$ROOT/scripts/check-android-instrumentation.mjs" --device "$ANDROID_SERIAL"
