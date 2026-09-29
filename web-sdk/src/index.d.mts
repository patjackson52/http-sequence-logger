export * from './api.mjs';
import type { LoggerOptions, Logger } from './api.mjs';
export function createLogger(options: LoggerOptions): Logger;
export const SDK_VERSION: string;
export interface JournalOptions { maxBytes?: number; maxEvents?: number }
export interface JournalStats { bytes: number; events: number; dropped: number; error: string | null }
export class MemoryJournal {
  constructor(options?: JournalOptions);
  append(line: string): boolean;
  exportNDJSON(): string;
  flush(): Promise<void>;
  readonly stats: JournalStats;
}
export class IndexedDBJournal extends MemoryJournal {
  static open(options: JournalOptions & { databaseName?: string; journalId: string; indexedDB?: IDBFactory; openTimeoutMs?: number }): Promise<IndexedDBJournal>;
  close(): Promise<void>;
  readonly stats: JournalStats & { persistedEvents: number; pending: number; closed: boolean };
}
export function uploadJournal(journal: MemoryJournal, options?: { basePath?: string; origin?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ events: number; batches: number; collectorId: string }>;
