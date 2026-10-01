import { DneBinaryDatabaseFormatError } from './binary-db-errors.ts';
import { BINARY_DATABASE_CHECKSUM_SIZE } from './binary-db-format.ts';
import { validateBinaryDatabaseBytes } from './binary-db-validator.ts';

/** Fully validates serialized bytes before recording their SHA-256 in the reserved footer. */
export function sealBinaryDatabaseBytes(bytes: Uint8Array): void {
  validateBinaryDatabaseBytes(bytes);
  const end = bytes.byteLength - BINARY_DATABASE_CHECKSUM_SIZE;
  bytes.set(new Bun.CryptoHasher('sha256').update(bytes.subarray(0, end)).digest(), end);
}

/** Checks integrity under the trusted producer and immutable file contract. */
export function verifyBinaryDatabaseChecksum(bytes: Uint8Array): void {
  const end = bytes.byteLength - BINARY_DATABASE_CHECKSUM_SIZE;
  const digest = new Bun.CryptoHasher('sha256').update(bytes.subarray(0, end)).digest();
  for (let index = 0; index < BINARY_DATABASE_CHECKSUM_SIZE; index++) {
    if (bytes[end + index] !== digest[index]) {
      throw new DneBinaryDatabaseFormatError('Binary database SHA-256 checksum mismatch');
    }
  }
}
