export interface TraceContext { readonly trace_id: string; readonly span_id: string; readonly parent_span_id: string | null; readonly parent_scope: 'none' | 'local' | 'remote'; }
export interface ServerContext extends TraceContext {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  operation<T>(name: string, handler: (context: ServerContext) => T | Promise<T>): Promise<T>;
  /** Message text must already be sanitized by the application. */
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
}
export interface CanonicalEvent { schema_version: '1.3'; event_type: string; event_id: string; session_namespace: string; session_id: string; recording_id: string; sequence: number; timestamp: string; monotonic_ns: string; context?: TraceContext; data: Record<string, unknown>; extensions?: Record<string, unknown>; }
export interface ServerLoggerOptions {
  service: string; environment?: string; sessionNamespace: string; appVersion?: string; runtime?: 'node' | 'cloudflare';
  emit(event: CanonicalEvent): unknown; propagationOrigins?: string[]; fetch?: typeof globalThis.fetch;
  policy?: { bodyLimitBytes?: number; redactHeaders?: string[]; redactQueryKeys?: string[]; redactBodyKeys?: string[] };
  onDiagnostic?(code: 'emit_failed' | 'context_closed' | 'capture_failed'): void;
}
export interface ServerLogger {
  handleRequest<T>(request: Request, handler: (context: ServerContext) => T | Promise<T>): Promise<T>;
  /** Await currently admitted async emissions. Does not wait for future invocations. */
  flush(): Promise<void>;
}
export const SDK_VERSION: string;
export function createServerLogger(options: ServerLoggerOptions): ServerLogger;
export function parseTraceparent(value: string | null | undefined): { trace_id: string; span_id: string; flags: string } | null;
export function traceparent(context: { trace_id: string; span_id: string; flags?: string }): string;
