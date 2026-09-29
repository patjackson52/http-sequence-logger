import type { IncomingMessage, ServerResponse } from 'node:http';
/** Node-only development middleware. Pairing is read once at startup. */
export function createNetworkLogRelay(options: { connectionFile: string; origin: string; basePath?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): (req: IncomingMessage, res: ServerResponse, next?: () => void) => Promise<void>;
