export interface Actor { owner: 'integrator' | 'sdk' | 'system' | 'unknown'; component: string; method?: string | null }
export interface Context { readonly trace_id: string; readonly span_id: string; readonly parent_span_id: string | null; readonly parent_scope: 'none' | 'local' | 'remote' }
export interface Origin { initiator: Actor; executor: Actor; callsite?: { file?: string; line?: number; function?: string } | null }
export type HeaderInput = Headers | Record<string, string> | Iterable<readonly [string, string]>;
export interface BodyObservation { data?: string | Uint8Array | ArrayBuffer; mediaType?: string | null; reason?: string; notApplicable?: boolean }
export interface RequestObservation { name?: string; method: string; url: string | URL; headers?: HeaderInput; origin: Origin; parent?: Context | null; adapter?: 'customer.manual' | 'browser.fetch' | 'browser.xhr'; reason?: string }
export interface Exchange {
  readonly context: Context | null;
  responseHeaders(supplier: () => { status: number; statusText?: string; url?: string; headers?: HeaderInput; reason?: string }): void;
  requestBody(supplier: () => BodyObservation): void;
  responseBody(supplier: () => BodyObservation): void;
  complete(): void; fail(error: unknown, stage?: 'dns' | 'connect' | 'tls' | 'write' | 'read' | 'unknown'): void;
  timeout(error?: unknown): void; cancel(): void; stopObservation(reason?: string): void;
}
export interface Operation { readonly context: Context | null; end(outcome?: 'success' | 'error' | 'cancelled', error?: unknown): void; returned(): void; threw(error: unknown): void; cancel(): void; stopObservation(reason?: string): void }
export interface OperationOptions { name: string; origin: Actor; parent?: Context | null }
export interface HandlerOptions extends OperationOptions { caller: Actor; dispatch?: 'synchronous' | 'awaited' }
export interface Session {
  readonly enabled: boolean; readonly propagationOrigins?: readonly string[]; readonly sessionId: string | null; readonly recordingId: string | null;
  startOperation(options: OperationOptions | (() => OperationOptions)): Operation;
  startHandler(options: HandlerOptions | (() => HandlerOptions)): Operation;
  startRequest(supplier: () => RequestObservation): Exchange;
  invokeHandler<T>(options: HandlerOptions, fn: (context: Context | null) => T): T;
  invokeAsyncHandler<T>(options: HandlerOptions, fn: (context: Context | null) => T | PromiseLike<T>): Promise<Awaited<T>>;
  end(reason?: 'completed' | 'stopped'): void;
}
export interface Logger { readonly enabled: boolean; startSession(options?: { name?: string; sessionId?: string }): Session }
export interface Sink { append(line: string): boolean | void }
export interface LoggerOptions { propagationOrigins?: string[]; namespace: string; appId: string; appVersion?: string; sink: Sink; policy?: { bodyLimitBytes?: number; redactHeaders?: string[]; redactQueryKeys?: string[]; redactBodyKeys?: string[] }; onDiagnostic?: (code: string) => void }
export const noOpLogger: Logger;
export function createLogger(options?: LoggerOptions): Logger;
export interface FetchClient {
  fetch(input: RequestInfo | URL, init?: RequestInit, metadata?: Partial<Pick<RequestObservation, 'name' | 'origin' | 'parent'>>): Promise<Response>;
  readText(response: Response): Promise<string>;
  readJson<T = unknown>(response: Response): Promise<T>;
  readArrayBuffer(response: Response): Promise<ArrayBuffer>;
  exchangeFor(response: Response): Exchange;
}
export function createFetchClient(session: Session, options?: { fetchImpl?: typeof fetch; origin?: Origin; parent?: Context | null }): FetchClient;
export function observeXHR(session: Session, xhr: XMLHttpRequest, metadataSupplier: () => RequestObservation & { body?: string | Uint8Array | ArrayBuffer | null; mediaType?: string }): { exchange: Exchange; dispose(): void };
