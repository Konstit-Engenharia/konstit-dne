// Experimental decoder for private reader snapshots of the version 3 format.
type Dictionary = {
  blockOffsetsOffset: number;
  count: number;
  fsstMode: number;
  lengthsOffset: number;
  prefixesOffset: number;
  suffixDataLength: number;
  suffixDataOffset: number;
};
const decoder = new TextDecoder();

/** Decode one independently compressed string or one front-coded block suffix chain. */
export function readFsstString(mapped: Uint8Array, data: DataView, dictionary: Dictionary, id: number, scratch: Uint8Array) {
  if (id === 0) {
    return null;
  }
  if (id < 0 || id > dictionary.count) {
    throw new Error(`Invalid FSST dictionary ID: ${id}`);
  }
  const index = id - 1;
  const blockStart = index & ~7;
  let cursor = dictionary.suffixDataOffset + data.getUint32(dictionary.blockOffsetsOffset + (index >>> 3) * 4, true);
  const compressedLengths = dictionary.lengthsOffset;
  const symbolLengths = dictionary.prefixesOffset + (dictionary.fsstMode === 2 ? dictionary.count : 0);
  const symbols = symbolLengths + 255;
  let previousLength = 0;
  for (let current = blockStart; current <= index; current++) {
    const compressedLength = mapped[compressedLengths + current] ?? 0;
    const end = cursor + compressedLength;
    if (end > dictionary.suffixDataOffset + dictionary.suffixDataLength) {
      throw new Error('Truncated FSST data');
    }
    // Full strings only need the lengths of preceding strings in the block.
    if (dictionary.fsstMode === 1 && current !== index) {
      cursor = end;
      continue;
    }
    const prefix = dictionary.fsstMode === 2 ? mapped[dictionary.prefixesOffset + current] ?? 0 : 0;
    if (prefix > previousLength) {
      throw new Error('Invalid FSST prefix');
    }
    let offset = prefix;
    while (cursor < end) {
      const code = mapped[cursor++] ?? 0;
      if (code === 255) {
        if (cursor >= end) {
          throw new Error('Truncated FSST escape');
        }
        scratch[offset++] = mapped[cursor++] ?? 0;
      } else {
        const length = mapped[symbolLengths + code] ?? 0;
        if (length < 1 || length > 8) {
          throw new Error('Invalid FSST symbol');
        }
        const symbol = symbols + code * 8;
        for (let byte = 0; byte < length; byte++) {
          scratch[offset++] = mapped[symbol + byte] ?? 0;
        }
      }
    }
    if (offset > scratch.length) {
      throw new Error('FSST decoded length exceeds the string limit');
    }
    previousLength = offset;
  }
  return decoder.decode(scratch.subarray(0, previousLength));
}
