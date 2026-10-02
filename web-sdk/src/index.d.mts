export * from './api.mjs';
import type { LoggerOptions, Logger } from './api.mjs';
export function createLogger(options: LoggerOptions): Logger;
export const SDK_VERSION: string;
export interface JournalOptions { maxBytes?: number; maxEvents?: number }
export interface JournalStats { bytes: number; events: number; dropped: number; error: string | null }
export class MemoryJournal {
  constructor(options?: JournalOptions);
  append(line: string): boolean;
  exportNDJSON(): string | Promise<string>;
  readPage(after?:number, options?:{maxEvents?:number;maxBytes?:number}):Promise<{lines:string[];next:number}>;
  subscribe(listener:()=>void):()=>void;
  readonly identity:{journal_id:string;installation_id:string;environment_id:string;instance_id:string};
  getDeliveryCursor(collectorId:string,sourceId:string):number;
  acknowledge(collectorId:string,sourceId:string,cursor:number):Promise<void>;
  flush(): Promise<void>;
  readonly stats: JournalStats;
}
export class IndexedDBJournal extends MemoryJournal {
  static open(options: JournalOptions & { databaseName?: string; journalId: string; indexedDB?: IDBFactory; openTimeoutMs?: number; leaseMs?:number; now?:()=>number; locks?:LockManager|null }): Promise<IndexedDBJournal>;
  exportPendingNDJSON(): string;
  close(): Promise<void>;
  readonly stats: JournalStats & { persistedEvents: number; pending: number; closed: boolean };
}
export interface DeliveryOptions {basePath?:string;origin?:string;fetchImpl?:typeof fetch;timeoutMs?:number;appId?:string;environmentName?:string;collectorId?:string;signal?:AbortSignal;onStatus?:(status:{state:string;error?:string})=>void}
export function uploadJournal(journal:MemoryJournal,options?:DeliveryOptions):Promise<{events:number;batches:number;collectorId:string;sourceId:string}>;
export function startJournalDelivery(journal:MemoryJournal,options?:DeliveryOptions):{wake:()=>Promise<void>;stop:()=>void};
