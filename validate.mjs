import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapture } from './shared/validate.mjs';

export { validateCapture } from './shared/validate.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    process.stderr.write('Usage: node validate.mjs capture.ndjson [more-captures.ndjson ...]\n');
    process.exitCode = 2;
  }
  for (const path of paths) {
    try {
      const result = validateCapture(readFileSync(path, 'utf8'));
      process.stdout.write(`${path}: ${result.valid ? 'VALID' : 'INVALID'} ${JSON.stringify(result.summary)}\n`);
      for (const message of result.warnings) process.stdout.write(`  warning: ${message}\n`);
      for (const message of result.errors) process.stderr.write(`  error: ${message}\n`);
      if (!result.valid) process.exitCode = 1;
    } catch (e) {
      process.stderr.write(`${path}: ${e.message}\n`);
      process.exitCode = 1;
    }
  }
}
