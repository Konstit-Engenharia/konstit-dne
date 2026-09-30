/** Stable categories exposed by the binary database reader for programmatic error handling. */
export type DneBinaryDatabaseErrorCode = 'IO_ERROR' | 'INVALID_FORMAT' | 'UNSUPPORTED_VERSION' | 'READER_CLOSED';

/** Base class for all errors exposed by the binary database reader and its file helpers. */
export abstract class DneBinaryDatabaseError extends Error {
  /** Identifies the failure category without requiring callers to parse the message. */
  abstract readonly code: DneBinaryDatabaseErrorCode;

  /**
   * Initializes a reader error and preserves an underlying failure in `cause` when provided.
   * @param message - Human-readable diagnostic information.
   * @param options - Standard error options, including the original cause.
   */
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The database file could not be opened, mapped, or read. Inspect `cause` for the operating-system error. */
export class DneBinaryDatabaseIOError extends DneBinaryDatabaseError {
  /** Identifies a failure to access the database file. */
  readonly code = 'IO_ERROR';

  /**
   * Creates an access error for a database path.
   * @param path - Path supplied by the caller, without normalization.
   * @param options - Error options containing the original file-system failure.
   */
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Unable to read binary database: ${path}`, options);
  }
}

/** The file or a decoded record violates the supported binary format. */
export class DneBinaryDatabaseFormatError extends DneBinaryDatabaseError {
  /** Identifies invalid headers, sections, metadata, or record contents. */
  readonly code = 'INVALID_FORMAT';

  /**
   * Creates a validation or decoding error.
   * @param message - Description of the invalid structure or failed decoding operation.
   * @param options - Error options containing a native decoding error, when applicable.
   */
  // biome-ignore lint/complexity/noUselessConstructor: Exposes and documents the protected base constructor as a public API.
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The file declares a binary format version that this reader does not support. */
export class DneBinaryDatabaseVersionError extends DneBinaryDatabaseError {
  /** Identifies a format-version mismatch that requires a compatible reader or a rebuilt file. */
  readonly code = 'UNSUPPORTED_VERSION';

  /**
   * Creates a version mismatch error.
   * @param actualVersion - Version declared in the file header.
   * @param supportedVersion - Version accepted by this reader.
   */
  constructor(readonly actualVersion: number, readonly supportedVersion: number) {
    super(`Unsupported binary database version: ${actualVersion}. Rebuild the database with build --force.`);
  }
}

/** A lookup was attempted after the reader released its mapping references. */
export class DneBinaryDatabaseClosedError extends DneBinaryDatabaseError {
  /** Identifies use of a reader after `close()`. */
  readonly code = 'READER_CLOSED';

  /** Creates an error for a lookup attempted after `close()`. */
  constructor() {
    super('Binary database is closed');
  }
}
