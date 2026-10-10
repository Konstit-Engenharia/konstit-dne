/** Run: bun examples/database-errors.ts [cep]. Configure DNE_DATABASE and DNE_SQLITE_DATABASE as needed. */
import {
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseError,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseIOError,
  DneBinaryDatabaseReader,
  DneBinaryDatabaseVersionError,
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseReader,
  DneDatabaseSchemaError,
  type DneBinaryDatabaseErrorCode,
  type DneDatabaseErrorCode,
} from '../src/library.ts';

function report(error: unknown): void {
  // The base classes and stable codes avoid matching human-readable messages.
  if (error instanceof DneBinaryDatabaseError) {
    const code: DneBinaryDatabaseErrorCode = error.code;
    console.error({ reader: 'binary', code, message: error.message, cause: error.cause });
  } else if (error instanceof DneDatabaseError) {
    const code: DneDatabaseErrorCode = error.code;
    console.error({ reader: 'sqlite', code, message: error.message, cause: error.cause });
  } else {
    throw error;
  }

  if (error instanceof DneBinaryDatabaseIOError || error instanceof DneDatabaseIOError) {
    console.error('Check the path and read permissions:', error.path);
  } else if (error instanceof DneBinaryDatabaseVersionError) {
    console.error('Use a compatible reader or rebuild the database:', {
      actual: error.actualVersion,
      supported: error.supportedVersion,
    });
  } else if (error instanceof DneBinaryDatabaseFormatError) {
    console.error('Replace or rebuild the invalid binary database.');
  } else if (error instanceof DneDatabaseSchemaError) {
    console.error('Rebuild SQLite with the current normalized schema.');
  } else if (error instanceof DneDatabaseDataError) {
    console.error('Inspect the invalid stored locality indicators and rebuild the data.');
  } else if (error instanceof DneDatabaseQueryError) {
    console.error('Inspect the SQL and the original SQLite failure in cause.');
  } else if (error instanceof DneBinaryDatabaseClosedError || error instanceof DneDatabaseClosedError) {
    console.error('Reader closed: create another reader if further queries are needed.');
  }
}

for (const kind of ['binary', 'sqlite'] as const) {
  let reader: DneBinaryDatabaseReader | DneDatabaseReader | undefined;
  try {
    reader = kind === 'binary'
      ? new DneBinaryDatabaseReader(process.env['DNE_DATABASE'])
      : new DneDatabaseReader(process.env['DNE_SQLITE_DATABASE'] ?? './data/dne.db');
    console.log({ kind, address: reader.queryCep(process.argv[2] ?? '01001-000') });
    reader.close();
    // Deliberately trigger a typed error to demonstrate the handler.
    reader.queryCep('01001-000');
  } catch (error) {
    report(error);
  } finally {
    reader?.close();
  }
}
