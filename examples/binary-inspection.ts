/** Run: bun examples/binary-inspection.ts ./data/dne.bin */
import {
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_VERSION,
  isBinaryDatabase,
  readBinaryDatabaseMetadata,
} from '../src/library.ts';

const path = process.argv[2] ?? './data/dne.bin';
console.log({ supportedVersion: BINARY_DATABASE_VERSION, headerBytes: BINARY_DATABASE_HEADER_SIZE });

// Signature detection alone does not validate the contents or checksum.
const binary = await isBinaryDatabase(path);
console.log({ path, binary });
if (binary) {
  // This helper opens, validates and closes the file before returning its metadata.
  console.log({ metadata: await readBinaryDatabaseMetadata(path) });
}
