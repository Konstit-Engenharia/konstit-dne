/**
 * Binary format revision accepted by the current reader and emitted by the writer.
 */
export const BINARY_DATABASE_VERSION = 4;
/**
 * Fixed file-header size in bytes, including the section directory and reserved space.
 */
export const BINARY_DATABASE_HEADER_SIZE = 256;

/** Neighborhood section header: row count and widths of the original DNE identifiers. */
export const BINARY_BAIRRO_HEADER_SIZE = 16;

/**
 * Eight-byte signature identifying a DNE binary database, independent of its version.
 */
export const BINARY_DATABASE_MAGIC = Uint8Array.from([68, 78, 69, 66, 73, 78, 0, 0]); // DNEBIN\0\0
/**
 * Largest integer representable by an unsigned four-byte field.
 */
export const MAX_UINT32 = 0xffff_ffff;
/**
 * Number of possible five-digit CEP prefixes.
 */
export const CEP_PREFIX_COUNT = 100_000;
/**
 * Number of CEP prefix offsets, including the final row-count sentinel.
 */
export const CEP_PREFIX_OFFSETS_COUNT = CEP_PREFIX_COUNT + 1;
/**
 * Number of bits used to store each three-digit CEP suffix.
 */
export const CEP_SUFFIX_BITS = 10;
/**
 * Size in bytes of a front-coded string dictionary header.
 */
export const DICTIONARY_HEADER_SIZE = 32;
/** Dictionary codec identifiers stored at byte 30 of each dictionary header. */
export const DICTIONARY_CODEC_PLAIN = 0;
export const DICTIONARY_CODEC_FSST = 2;
/** FSST uses 255 symbols of up to eight bytes; code 255 escapes one literal byte. */
export const FSST_SYMBOL_COUNT = 255;
export const FSST_SYMBOL_TABLE_SIZE = FSST_SYMBOL_COUNT * 9;
/**
 * Base-two logarithm of the number of strings in one dictionary block.
 */
export const DICTIONARY_BLOCK_SHIFT = 3;
/**
 * Number of strings decoded from a shared front-coding block.
 */
export const DICTIONARY_BLOCK_SIZE = 1 << DICTIONARY_BLOCK_SHIFT;
/**
 * Base-two logarithm of the row count covered by one sparse-rank block.
 */
export const SPARSE_RANK_SHIFT = 8;
/**
 * Number of rows covered by a sparse-rank index entry.
 */
export const SPARSE_RANK_ROWS = 1 << SPARSE_RANK_SHIFT;
/**
 * Absolute byte offset of the section directory within the file header.
 */
export const SECTION_TABLE_OFFSET = 32;

/**
 * Canonical section order used by the binary header directory and file writer.
 */
export const BINARY_SECTION_NAMES = [
  'metadata',
  'cepPrefixOffsets',
  'cepSuffixes',
  'logradouroIds',
  'complementoBitmap',
  'complementoRanks',
  'complementoIds',
  'bairroIds',
  'municipalityIds',
  'nomeBitmap',
  'nomeRanks',
  'nomeIds',
  'municipalities',
  'logradouroDictionary',
  'complementoDictionary',
  'bairroDictionary',
  'municipioDictionary',
  'ufDictionary',
  'nomeDictionary',
  'localidadeFlags',
  'bairros',
  'bairroFaixaOffsets',
  'bairroFaixas',
  'bairroAbreviadoDictionary',
  'localidadeNomeBitmap',
  'localidadeNomeRanks',
  'localidadeNomeIds',
] as const;

/**
 * Name of one section in the current binary file format.
 */
export type BinarySectionName = (typeof BINARY_SECTION_NAMES)[number];
/**
 * Supported byte widths for a packed unsigned integer.
 */
export type ByteWidth = 1 | 2 | 3 | 4;

/**
 * Byte range occupied by a section in the binary database.
 */
export type BinaryRegion = {
  /**
   * Section length in bytes, excluding alignment padding.
   */
  length: number;
  /**
   * Absolute byte offset from the beginning of the file.
   */
  offset: number;
};

/**
 * Decoded binary header, with section ranges expressed as absolute byte offsets.
 */
export type BinaryHeader = {
  /**
   * Byte width of each row offset in the CEP prefix directory.
   */
  cepPrefixOffsetWidth: ByteWidth;
  /**
   * Total file length in bytes, including final alignment padding.
   */
  fileSize: number;
  /**
   * Number of records in the municipality table.
   */
  municipalityCount: number;
  /**
   * Byte width of municipality IDs in the locality runs.
   */
  municipalityIdWidth: ByteWidth;
  /**
   * Number of CEP records across all row-oriented columns.
   */
  rowCount: number;
  /**
   * Location and size of each required section.
   */
  sections: Record<BinarySectionName, BinaryRegion>;
};

/**
 * Rounds a nonnegative byte offset up to the next eight-byte boundary.
 * @param value - Byte offset or length to align.
 * @returns An aligned offset greater than or equal to the input.
 */
export function alignBinaryOffset(value: number) {
  return Math.ceil(value / 8) * 8;
}

/**
 * Computes storage for one presence bit per row.
 * @param rowCount - Nonnegative number of rows.
 * @returns The minimum whole-byte length of the bitmap.
 */
export function bitmapByteLength(rowCount: number) {
  return Math.ceil(rowCount / 8);
}

/**
 * Computes storage for a column of fixed-width bit-packed values.
 * @param count - Nonnegative number of values.
 * @param bits - Positive bit width of each value.
 * @returns The minimum whole-byte length of the packed column.
 */
export function packedBitLength(count: number, bits: number) {
  return Math.ceil(count * bits / 8);
}

/**
 * Builds the lookup table used to count set bits in each possible byte.
 * @returns A new 256-entry array whose entry i is the population count of i.
 */
export function createPopcountTable() {
  const table = new Uint8Array(256);
  for (let value = 1; value < table.length; value++) {
    table[value] = (table[value >>> 1] ?? 0) + (value & 1);
  }
  return table;
}

/**
 * Chooses the smallest supported byte width for a nonnegative unsigned integer.
 * @param maxValue - Maximum value to store; callers must ensure it fits in four bytes.
 * @returns A width from one through four bytes.
 */
export function integerByteWidth(maxValue: number): ByteWidth {
  if (maxValue <= 0xff) {
    return 1;
  }
  if (maxValue <= 0xffff) {
    return 2;
  }
  if (maxValue <= 0xffffff) {
    return 3;
  }
  return 4;
}

/**
 * Validates a byte-width value decoded from a binary header.
 * @param value - Encoded width.
 * @param name - Field name included in diagnostics.
 * @returns The validated width.
 * @throws {Error} If the width is not 1, 2, 3, or 4.
 */
export function readByteWidth(value: number, name: string): ByteWidth {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4) {
    throw new Error(`Unsupported binary ${name} width: ${value}`);
  }
  return value;
}

/**
 * Returns the largest unsigned integer representable by a supported width.
 * @param width - Storage width in bytes.
 * @returns The inclusive maximum value for that width.
 */
export function maxPackedInteger(width: ByteWidth) {
  return width === 4 ? MAX_UINT32 : (2 ** (width * 8)) - 1;
}

/**
 * Validates an integer before writing it to a packed column.
 * @param value - Candidate unsigned integer.
 * @param width - Available storage in bytes.
 * @param name - Field name included in diagnostics.
 * @throws {Error} If the value is negative, unsafe, fractional, or too large for the width.
 */
export function assertPackedInteger(value: number, width: ByteWidth, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxPackedInteger(width)) {
    throw new Error(`Binary ${name} exceeds the ${width}-byte unsigned integer limit: ${value}`);
  }
}

/**
 * Reads one little-endian unsigned integer from a data view.
 * @param data - View over the binary bytes.
 * @param offset - Byte offset relative to the view.
 * @param width - Number of bytes to read.
 * @returns The decoded unsigned integer.
 * @throws {RangeError} If the requested bytes lie outside the view.
 */
export function readPackedInteger(data: DataView, offset: number, width: ByteWidth) {
  switch (width) {
    case 1:
      return data.getUint8(offset);
    case 2:
      return data.getUint16(offset, true);
    case 3:
      return data.getUint8(offset)
        | (data.getUint8(offset + 1) << 8)
        | (data.getUint8(offset + 2) << 16);
    case 4:
      return data.getUint32(offset, true);
  }
}

/**
 * Writes a little-endian unsigned integer to a caller-owned byte array.
 * @param target - Destination with room for the complete value.
 * @param offset - Starting byte offset within the destination.
 * @param value - Unsigned integer to encode.
 * @param width - Storage width in bytes.
 * @throws {Error} If the value does not fit the requested width. The caller must validate destination bounds.
 */
export function writePackedInteger(
  target: Uint8Array,
  offset: number,
  value: number,
  width: ByteWidth,
) {
  assertPackedInteger(value, width, 'column value');
  target[offset] = value & 0xff;
  if (width > 1) {
    target[offset + 1] = (value >>> 8) & 0xff;
  }
  if (width > 2) {
    target[offset + 2] = (value >>> 16) & 0xff;
  }
  if (width > 3) {
    target[offset + 3] = (value >>> 24) & 0xff;
  }
}

/**
 * Compares a byte sequence to the complete binary file signature.
 * @param bytes - Candidate signature; its length must exactly match the magic length.
 * @returns True only for an exact signature match.
 */
export function hasBinaryMagic(bytes: Uint8Array) {
  if (bytes.byteLength !== BINARY_DATABASE_MAGIC.length) {
    return false;
  }
  return BINARY_DATABASE_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Writes a ten-bit CEP suffix into a packed column.
 * @param target - Destination bytes sized for the full packed column.
 * @param index - Zero-based value index within the column.
 * @param value - Unsigned integer smaller than 1024.
 * @throws {Error} If the value exceeds the ten-bit range.
 */
export function writePacked10(target: Uint8Array, index: number, value: number) {
  if (value < 0 || value >= 1 << CEP_SUFFIX_BITS) {
    throw new Error(`CEP suffix exceeds ${CEP_SUFFIX_BITS} bits: ${value}`);
  }
  const bitOffset = index * CEP_SUFFIX_BITS;
  const byteIndex = bitOffset >>> 3;
  const shift = bitOffset & 7;
  const shifted = value << shift;
  target[byteIndex] = (target[byteIndex] ?? 0) | (shifted & 0xff);
  if (byteIndex + 1 < target.byteLength) {
    target[byteIndex + 1] = (target[byteIndex + 1] ?? 0) | ((shifted >>> 8) & 0xff);
  }
  if (byteIndex + 2 < target.byteLength) {
    target[byteIndex + 2] = (target[byteIndex + 2] ?? 0) | ((shifted >>> 16) & 0xff);
  }
}
