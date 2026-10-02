import { diffSequences, validateDiff } from '../../sequence-diff/index.mjs';
import { importFiles } from './model.mjs';
import { validateSourceReferences, snapshotsFromCapture } from './comparison-data.mjs';

/** Shared by the real browser worker and worker parity tests. No alternate engine. */
export function compareRequest(data) {
  try {
    if (data.operation === 'import') return { id: data.id, snapshots: snapshotsFromCapture(importFiles(data.files)) };
    const primary = data.primary.document ?? data.primary.sequence ?? data.primary;
    const secondary = data.secondary.document ?? data.secondary.sequence ?? data.secondary;
    const diff = diffSequences(primary, secondary, data.profile ?? {});
    validateDiff(diff); validateSourceReferences(diff, primary, secondary);
    const model = document => importFiles([{ name: 'Comparison snapshot', text: document.events.map(event => JSON.stringify(event)).join('\n') + '\n' }]).sessions[0];
    return { id: data.id, diff, models: { primary: model(primary), secondary: model(secondary) } };
  } catch (error) {
    return { id: data.id, error: { name: error.name, message: error.message, details: error.details ?? [] } };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.onmessage = ({ data }) => self.postMessage(compareRequest(data));
}
