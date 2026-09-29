#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
consumer_dir="$repo_dir/integration/ios-consumer"
production_dir="$consumer_dir/Production"
report_dir="$repo_dir/artifacts/integration-ios"
mkdir -p "$report_dir"

swift test --package-path "$consumer_dir" -c debug
swift test --package-path "$production_dir" -c release
swift run --package-path "$production_dir" -c release ProductionSmoke
swift package --package-path "$production_dir" dump-package > "$report_dir/production-package.json"
node --input-type=module - "$report_dir/production-package.json" <<'JS'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (manifest.dependencies.length !== 0) throw new Error('Production fixture has package dependencies');
console.log('Production fixture manifest has no package dependencies');
JS

binary_dir=$(swift build --package-path "$production_dir" -c release --show-bin-path)
nm "$binary_dir/ProductionSmoke" > "$report_dir/production-symbols.txt"
if rg 'NetworkLogTransfer|NDJSONTransferSink|DevelopmentCaptureDelivery' "$report_dir/production-symbols.txt"; then
    echo 'Development transfer symbols found in the production fixture' >&2
    exit 1
fi

if swift build --package-path "$consumer_dir" -c release > "$report_dir/development-release-rejection.log" 2>&1; then
    echo 'Development fixture unexpectedly built in Release' >&2
    exit 1
fi
if ! rg -q 'DevelopmentDelivery is a Debug-only consumer' "$report_dir/development-release-rejection.log"; then
    echo 'Development Release build failed for an unexpected reason' >&2
    exit 1
fi
echo 'iOS consumer API smoke passed on the host; this is not an iOS archive audit.'
