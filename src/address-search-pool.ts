import { resolve } from 'node:path';
import {
  DneAddressSearchPoolClosedError,
  DneAddressSearchQueueFullError,
  DneAddressSearchWorkerError,
} from './address-search-pool-errors.ts';
import type {
  AddressSearchSnapshot,
  AddressSearchWorkerData,
  AddressSearchWorkerReply,
  AddressSearchWorkerRequest,
} from './address-search-worker-runtime.ts';
import type { AddressSearchOptions } from './address-search.ts';
import type { DneRow } from './types.ts';
import workerSource from './address-search-worker-source.ts';

/** Native Bun workers share immutable database/index bytes and own their search workspaces. */
export type AddressSearchPoolOptions = {
  /** Path to the binary database. Relative paths use the caller's current directory at open(). */
  databasePath: string;
  /** Path to the prebuilt index matching the database. */
  indexPath: string;
  /** Positive integer. Defaults to 1; additional workers consume additional memory. */
  workers?: number;
  /** Maximum waiting searches, excluding running searches. Defaults to 64; 0 disables waiting. */
  maxQueue?: number;
};

export type AddressSearchAsyncOptions = AddressSearchOptions & {
  /** Rejects with signal.reason. Running calculations finish, but their results are discarded. */
  signal?: AbortSignal;
};

type Job = {
  request: AddressSearchWorkerRequest;
  resolve: (rows: DneRow[]) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

type Slot = {
  worker: Worker;
  ready: ReturnType<typeof Promise.withResolvers<AddressSearchSnapshot | undefined>>;
  closed: ReturnType<typeof Promise.withResolvers<void>>;
  hasClosed: boolean;
  current?: Job;
};

/** Persistent workers keep synchronous address searches off the HTTP thread. Close the pool when the application stops. */
export class DneAddressSearchPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly drained = Promise.withResolvers<void>();
  private accepting = true;
  private terminating = false;
  private closing?: Promise<void>;
  private failure?: DneAddressSearchWorkerError;

  private constructor(private readonly maxQueue: number) {}

  /** Resolves only after every worker has loaded and validated its database and index. Cleans up all workers on failure. */
  static async open(options: AddressSearchPoolOptions): Promise<DneAddressSearchPool> {
    const { workers = 1, maxQueue = 64 } = options;
    if (!Number.isSafeInteger(workers) || workers < 1 || !Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError('Address search pool requires a positive worker count and a nonnegative queue size');
    }
    if (
      typeof options.indexPath !== 'string' || !options.indexPath.trim()
      || typeof options.databasePath !== 'string' || !options.databasePath.trim()
    ) {
      throw new TypeError('Address search pool requires nonempty file paths');
    }
    const pool = new DneAddressSearchPool(maxQueue);
    try {
      const data: AddressSearchWorkerData = {
        type: 'load',
        databasePath: resolve(options.databasePath),
        indexPath: resolve(options.indexPath),
      };
      const snapshot = await pool.spawn(data);
      await Promise.all(Array.from({ length: workers - 1 }, () => pool.spawn({ type: 'init', snapshot: snapshot as AddressSearchSnapshot })));
      return pool;
    } catch (error) {
      pool.fail(error);
      await pool.close();
      throw pool.failure;
    }
  }

  /** Matches the synchronous API's results and ranking. All failures are promise rejections. */
  async searchAddresses(text: string, options: AddressSearchAsyncOptions = {}): Promise<DneRow[]> {
    if (!this.accepting) {
      throw this.failure ?? new DneAddressSearchPoolClosedError();
    }
    const { signal, uf, municipioCodIbge, limit } = options;
    if (signal?.aborted) {
      throw signal.reason;
    }
    const idle = this.slots.find((slot) => !slot.current);
    if (!idle && this.queue.length >= this.maxQueue) {
      throw new DneAddressSearchQueueFullError();
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const position = this.queue.indexOf(job);
        if (position !== -1) {
          this.queue.splice(position, 1);
        }
        job.cleanup();
        reject(signal?.reason);
        // An aborted running job still occupies its worker until the reply arrives.
        this.finishDrain();
      };
      const job: Job = {
        request: { type: 'search', text, options: { uf, municipioCodIbge, limit } },
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (idle) {
        this.dispatch(idle, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  /** Stops admission, drains accepted searches (including cancelled calculations), then waits for every worker to exit. Idempotent. */
  close(): Promise<void> {
    this.accepting = false;
    this.closing ??= this.drained.promise.then(async () => {
      this.terminating = true;
      await Promise.all(this.slots.map((slot) => {
        if (!slot.hasClosed) {
          if (this.failure) {
            slot.worker.terminate();
          } else {
            try {
              slot.worker.postMessage({ type: 'close' } satisfies AddressSearchWorkerRequest);
            } catch {
              slot.worker.terminate();
            }
          }
        }
        return slot.closed.promise;
      }));
      // Readiness promises retain the published snapshot until these slots are released.
      this.slots.length = 0;
    });
    this.finishDrain();
    return this.closing;
  }

  private async spawn(data: AddressSearchWorkerData): Promise<AddressSearchSnapshot | undefined> {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    const slot: Slot = {
      worker,
      ready: Promise.withResolvers<AddressSearchSnapshot | undefined>(),
      closed: Promise.withResolvers<void>(),
      hasClosed: false,
    };
    this.slots.push(slot);
    worker.addEventListener('message', (event: MessageEvent<AddressSearchWorkerReply>) => this.receive(slot, event.data));
    worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault();
      this.fail(event.error ?? new Error(event.message));
    });
    worker.addEventListener('close', (event: CloseEvent) => {
      URL.revokeObjectURL(url);
      slot.hasClosed = true;
      slot.closed.resolve();
      if (!this.terminating) {
        this.fail(new Error(`Address search worker exited unexpectedly with code ${event.code}`));
      }
    });
    try {
      worker.postMessage(data);
    } catch (error) {
      this.fail(error);
    }
    return slot.ready.promise;
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.current = job;
    try {
      slot.worker.postMessage(job.request);
    } catch (error) {
      this.fail(error);
    }
  }

  private receive(slot: Slot, reply: AddressSearchWorkerReply): void {
    if (this.failure) {
      return;
    }
    if (reply.type === 'ready') {
      slot.ready.resolve(reply.snapshot);
      return;
    }
    if (reply.type === 'failed') {
      const error = new Error(reply.error.message);
      error.name = reply.error.name;
      this.fail(error);
      return;
    }
    const job = slot.current as Job;
    slot.current = undefined;
    job.cleanup();
    if (reply.type === 'result') {
      job.resolve(reply.rows);
    } else {
      const { name, message } = reply.error;
      const error = name === 'RangeError' ? new RangeError(message) : name === 'TypeError' ? new TypeError(message) : new Error(message);
      error.name = name;
      job.reject(error);
    }
    const next = this.queue.shift();
    if (next) {
      this.dispatch(slot, next);
    }
    this.finishDrain();
  }

  private finishDrain(): void {
    if (!this.accepting && this.queue.length === 0 && this.slots.every((slot) => !slot.current)) {
      this.drained.resolve();
    }
  }

  private fail(cause: unknown): void {
    if (this.failure || this.terminating) {
      return;
    }
    const error = new DneAddressSearchWorkerError(cause);
    this.failure = error;
    for (const slot of this.slots) {
      slot.ready.reject(error);
      if (slot.current) {
        slot.current.cleanup();
        slot.current.reject(error);
        slot.current = undefined;
      }
    }
    for (const job of this.queue.splice(0)) {
      job.cleanup();
      job.reject(error);
    }
    void this.close();
  }
}
