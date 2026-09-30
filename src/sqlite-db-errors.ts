/** Stable categories exposed by the SQLite reader for programmatic error handling. */
export type DneDatabaseErrorCode = 'IO_ERROR' | 'INVALID_SCHEMA' | 'INVALID_DATA' | 'QUERY_ERROR' | 'READER_CLOSED';

/** Base class for failures exposed by the SQLite reader and its file helpers. */
export abstract class DneDatabaseError extends Error {
  /** Identifies the failure without requiring callers to parse its message. */
  abstract readonly code: DneDatabaseErrorCode;

  /** Preserves the original SQLite or filesystem failure in `cause`, when provided. */
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A SQLite connection could not be opened, configured, or closed. */
export class DneDatabaseIOError extends DneDatabaseError {
  readonly code = 'IO_ERROR';

  /** Creates an access error for the caller's database path. */
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Unable to access SQLite database: ${path}`, options);
  }
}

/** The database lacks the schema required for normalized address lookup. */
export class DneDatabaseSchemaError extends DneDatabaseError {
  readonly code = 'INVALID_SCHEMA';

  /** Describes the missing schema feature and how to rebuild the database. */
  // biome-ignore lint/complexity/noUselessConstructor: Exposes the protected base constructor as a public API.
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** A stored address contains invalid locality indicators. */
export class DneDatabaseDataError extends DneDatabaseError {
  readonly code = 'INVALID_DATA';

  /** Describes invalid stored data, preserving a decoding cause when available. */
  // biome-ignore lint/complexity/noUselessConstructor: Exposes the protected base constructor as a public API.
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** SQLite could not prepare or execute a read operation. */
export class DneDatabaseQueryError extends DneDatabaseError {
  readonly code = 'QUERY_ERROR';

  /** Preserves the diagnostic message and native SQLite failure in `cause`. */
  // biome-ignore lint/complexity/noUselessConstructor: Exposes the protected base constructor as a public API.
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** An operation was attempted after the reader closed its connection. */
export class DneDatabaseClosedError extends DneDatabaseError {
  readonly code = 'READER_CLOSED';

  /** Creates an error for any read operation attempted after `close()`. */
  constructor() {
    super('SQLite database is closed');
  }
}
