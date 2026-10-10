import {
  DneAddressSearch,
  type AddressSearchOptions,
} from './address-search.ts';
import { DneBinaryDatabaseReader, readBinaryDatabaseBytes } from './binary-db-reader.ts';
import type { DneRow } from './types.ts';
import { readSharedFile } from './shared-file.ts';

/** Finish writing before publication; every consumer must treat these buffers as immutable. */
export type AddressSearchSnapshot = { database: SharedArrayBuffer; index: SharedArrayBuffer; };
export type AddressSearchWorkerData =
  | { type: 'load'; databasePath: string; indexPath: string; }
  | { type: 'init'; snapshot: AddressSearchSnapshot; };
export type AddressSearchWorkerRequest =
  | { type: 'search'; text: string; options: AddressSearchOptions; }
  | { type: 'close'; };
export type AddressSearchWorkerReply =
  | { type: 'ready'; snapshot?: AddressSearchSnapshot; }
  | { type: 'result'; rows: DneRow[]; }
  | { type: 'error' | 'failed'; error: { name: string; message: string; }; };

export type AddressSearchWorkerScope = {
  postMessage(reply: AddressSearchWorkerReply): void;
  onmessage: ((event: MessageEvent<AddressSearchWorkerRequest>) => void) | null;
};

/** Loads files only in the first worker; every worker validates its views and owns its mutable caches. */
export function startAddressSearchWorker(scope: AddressSearchWorkerScope, data: AddressSearchWorkerData): void {
  const snapshot = data.type === 'load'
    ? { database: readBinaryDatabaseBytes(data.databasePath, true).buffer as SharedArrayBuffer, index: readSharedFile(data.indexPath) }
    : data.snapshot;
  const database = new DneBinaryDatabaseReader(snapshot.database);
  let search: DneAddressSearch;
  try {
    search = new DneAddressSearch(database, snapshot.index);
  } catch (error) {
    database.close();
    throw error;
  }
  scope.onmessage = ({ data: request }: MessageEvent<AddressSearchWorkerRequest>) => {
    if (request.type === 'close') {
      search.close();
      database.close();
      // Removing the last listener lets Bun end the worker after this handler returns.
      scope.onmessage = null;
      return;
    }
    let reply: AddressSearchWorkerReply;
    try {
      reply = { type: 'result', rows: search.searchAddresses(request.text, request.options) };
    } catch (error) {
      const failure = error as Error;
      reply = { type: 'error', error: { name: failure.name, message: failure.message } };
    }
    scope.postMessage(reply);
  };
  scope.postMessage({ type: 'ready', snapshot: data.type === 'load' ? snapshot : undefined } satisfies AddressSearchWorkerReply);
}
