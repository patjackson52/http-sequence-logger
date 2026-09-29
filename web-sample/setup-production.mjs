import { noOpLogger } from '#logger';
export async function setup() { return { logger: noOpLogger, async afterRun() {}, async exclusive(fn) { await fn(); } }; }
