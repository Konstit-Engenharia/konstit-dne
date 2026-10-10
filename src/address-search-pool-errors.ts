/** All workers are busy and the bounded waiting queue is full. */
export class DneAddressSearchQueueFullError extends Error {
  readonly code = 'SEARCH_QUEUE_FULL';

  constructor() {
    super('Address search queue is full');
    this.name = 'DneAddressSearchQueueFullError';
  }
}

/** The pool no longer accepts new searches. */
export class DneAddressSearchPoolClosedError extends Error {
  readonly code = 'SEARCH_POOL_CLOSED';

  constructor() {
    super('Address search pool is closed');
    this.name = 'DneAddressSearchPoolClosedError';
  }
}

/** A worker could not start or stopped unexpectedly. The entire pool is closed. */
export class DneAddressSearchWorkerError extends Error {
  readonly code = 'SEARCH_WORKER_FAILED';

  constructor(cause: unknown) {
    super('Address search worker failed', { cause });
    this.name = 'DneAddressSearchWorkerError';
  }
}
