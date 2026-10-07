#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sequencesFromCapture, validateSequence, diffSequences, formatDiffText, SequenceDiffError } from './index.mjs';

const NORMALIZE_OPTIONS = `Normalize options:
  --namespace NAME         Select the session namespace
  --session ID             Select the session ID from a multi-session capture
  --output FILE            Create a new canonical session JSON file; refuses overwrite
`;
const COMPARE_OPTIONS = `Compare options:
  --format json|text       Diff output (default json)
  --output FILE            Create a new file; refuses to overwrite
  --options FILE           Engine profile JSON: exclusions, matches, JSON and timing rules
  --primary-session ID     Select from a multi-session primary capture
  --primary-namespace NAME Disambiguate the primary session namespace
  --secondary-session ID   Select from a multi-session secondary capture
  --secondary-namespace NAME Disambiguate the secondary session namespace
  --check                  Exit 0 equal, 1 different, 3 inconclusive; errors exit 2
`;
const INPUT_GUIDANCE = `
Inputs: canonical event-schema 1.3 NDJSON or http-sequence 1.0 session JSON.
Regular local files only; no URL or stdin input. Limit: 16 MiB per file.
JSON stdout contains only the result; fatal errors go to stderr and exit 2.
Use -- before filenames beginning with --. Help reads/writes no input/output files.
Profile, replay and API guide: sequence-diff/README.md.
`;
const COMPARISON_GUIDANCE = `Comparison also enforces 20000 events and 5000 nodes per side and engine work limits.
Nonfatal capture warnings are in diff.diagnostics (and text output), not stderr.
Without --check a completed comparison exits 0, including different/inconclusive.
Default profile: compare JSON fields, exclude timing, no ignored headers/paths or matches.
`;
const HELP = `sequence-diff — canonical session comparison
Usage:
  sequence-diff normalize INPUT [options]
  sequence-diff compare PRIMARY SECONDARY [options]
  sequence-diff [normalize|compare] --help

${NORMALIZE_OPTIONS}
${COMPARE_OPTIONS}
  --help                   Show general or command-specific help
${INPUT_GUIDANCE}${COMPARISON_GUIDANCE}`;
const commandHelp = command => `sequence-diff ${command} — ${command === 'normalize' ? 'select one canonical session' : 'compare two canonical sessions'}
Usage:
  sequence-diff ${command} ${command === 'normalize' ? 'INPUT' : 'PRIMARY SECONDARY'} [options]

${command === 'normalize' ? NORMALIZE_OPTIONS : COMPARE_OPTIONS}  --help                   Show this command's help
${INPUT_GUIDANCE}${command === 'compare' ? COMPARISON_GUIDANCE : 'Normalization selects one session and emits its canonical JSON; it does not assert complete capture.\n'}`;
const MAX_BYTES = 16 * 1024 * 1024;
async function readBounded(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new SequenceDiffError('Input must be a regular file of at most 16 MiB: ' + path);
    // Bound the actual read too, in case a live file grows after stat().
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new SequenceDiffError('Input grew beyond 16 MiB: ' + path);
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
function parse(argv) {
  const [command, ...args] = argv, flags = {}, paths = [];
  const allowed = command === 'normalize' ? ['namespace', 'session', 'output'] :
    ['format', 'output', 'options', 'primary-session', 'primary-namespace', 'secondary-session', 'secondary-namespace', 'check'];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { paths.push(...args.slice(i + 1)); break; }
    if (!args[i].startsWith('--')) { paths.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!allowed.includes(key) || Object.hasOwn(flags, key)) throw new SequenceDiffError('Unknown or repeated option: ' + args[i]);
    if (key === 'check') flags[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new SequenceDiffError('Missing value for ' + args[i]);
      flags[key] = args[++i];
    }
  }
  if (!['normalize', 'compare'].includes(command) || paths.length !== (command === 'compare' ? 2 : 1)) throw new SequenceDiffError('Invalid command or input count. Use --help.');
  if (flags.format && !['json', 'text'].includes(flags.format)) throw new SequenceDiffError('--format must be json or text.');
  return { command, flags, paths };
}
async function load(path, namespace, id) {
  const text = await readBounded(path);
  let value;
  try { value = JSON.parse(text); } catch { /* NDJSON has multiple JSON records. */ }
  let documents;
  if (value?.format) { validateSequence(value); documents = [value]; }
  else documents = sequencesFromCapture(Array.isArray(value) ? value : text);
  const choices = documents.filter(d => (!namespace || d.session.namespace === namespace) && (!id || d.session.id === id));
  if (choices.length !== 1) throw new SequenceDiffError('Select exactly one session from ' + path + '.', documents.map(d => JSON.stringify(d.session)));
  return choices[0];
}
export async function main(argv, io = process) {
  if (argv.length === 1 && argv[0] === '--help') { io.stdout.write(HELP); return 0; }
  if (['normalize', 'compare'].includes(argv[0])) {
    const separator = argv.indexOf('--');
    if (argv.slice(1, separator < 0 ? undefined : separator).includes('--help')) { io.stdout.write(commandHelp(argv[0])); return 0; }
  }
  try {
    const { command, flags, paths } = parse(argv);
    let value, output;
    if (command === 'normalize') value = await load(paths[0], flags.namespace, flags.session);
    else {
      const [a, b] = await Promise.all([load(paths[0], flags['primary-namespace'], flags['primary-session']), load(paths[1], flags['secondary-namespace'], flags['secondary-session'])]);
      let options = {};
      if (flags.options) options = JSON.parse(await readBounded(flags.options));
      value = diffSequences(a, b, options);
    }
    output = flags.format === 'text' ? formatDiffText(value) : JSON.stringify(value, null, 2) + '\n';
    if (flags.output) {
      const handle = await open(flags.output, 'wx');
      try { await handle.writeFile(output); } finally { await handle.close(); }
    } else io.stdout.write(output);
    if (!flags.check) return 0;
    return value.result === 'different' ? 1 : value.result === 'inconclusive' ? 3 : 0;
  } catch (error) {
    const message = [error.message, ...(error.details ?? [])].join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    io.stderr.write('sequence-diff: ' + message + '\n');
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
