import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapture } from './shared/validate.mjs';

export { validateCapture } from './shared/validate.mjs';

const HELP = `Validate canonical schema-1.2 capture files
Usage: node validate.mjs capture.ndjson [more-captures.ndjson ...]
       node validate.mjs --help

Run from the repository root with Node 24.13.x after npm ci. Inputs are local
UTF-8 NDJSON files; each file is checked separately for schema, relationships,
timing, retry, body-byte and outcome contradictions. This validates captures,
not sequence documents, diff JSON or pairing configuration.

Exit codes: 0 no detected contradictions (inspect warnings for missing data),
            1 invalid capture or unreadable file, 2 missing input.
Summaries/warnings go to stdout; validation and I/O errors go to stderr.
Validation does not establish capture completeness or remove secrets.
Guide: docs/integration/SPECS.md; comparison CLI: sequence-diff/README.md
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 1 && paths[0] === '--help') {
    process.stdout.write(HELP);
  } else if (!paths.length) {
    process.stderr.write(HELP);
    process.exitCode = 2;
  } else for (const path of paths) {
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
