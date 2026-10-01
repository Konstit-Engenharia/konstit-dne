import { Buffer } from 'node:buffer';
import { DneBinaryDatabaseFormatError } from './binary-db-errors.ts';
import {
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  FSST_SYMBOL_COUNT,
} from './binary-db-format.ts';

/** Validated locations of an FSST dictionary within the mapped database. */
export type FsstDictionary = {
  blockCount: number;
  blockOffsetsOffset: number;
  count: number;
  lengthsOffset: number;
  lengthWidth: 1 | 2;
  prefixesOffset: number;
  symbolsOffset: number;
  suffixDataLength: number;
  suffixDataOffset: number;
};

type DecoderState = {
  lengths: Uint8Array;
  words: Uint32Array;
  output: Buffer;
  view: DataView;
};

const states = new WeakMap<FsstDictionary, DecoderState>();
const textDecoder = new TextDecoder();

/** Checks the fixed symbol table during generation. */
export function validateFsstSymbols(data: DataView, symbolsOffset: number) {
  for (let code = 0; code < FSST_SYMBOL_COUNT; code++) {
    if (data.getUint8(symbolsOffset + code) > 8) {
      throw new DneBinaryDatabaseFormatError('Invalid binary FSST symbol length');
    }
  }
}

function prepareDecoder(data: DataView, dictionary: FsstDictionary): DecoderState {
  const lengths = new Uint8Array(FSST_SYMBOL_COUNT);
  const words = new Uint32Array(FSST_SYMBOL_COUNT * 2);
  for (let code = 0; code < lengths.length; code++) {
    lengths[code] = data.getUint8(dictionary.symbolsOffset + code);
  }
  for (let word = 0; word < words.length; word++) {
    words[word] = data.getUint32(dictionary.symbolsOffset + FSST_SYMBOL_COUNT + word * 4, true);
  }
  // Each symbol writes eight bytes, including padding after its useful bytes.
  const output = Buffer.alloc(272);
  const state = { lengths, words, output, view: new DataView(output.buffer, output.byteOffset, output.byteLength) };
  states.set(dictionary, state);
  return state;
}

/** Decode one string, checking the selected front-coding block as it is traversed. */
export function readFsstString(mapped: Uint8Array, data: DataView, dictionary: FsstDictionary, id: number): string | null {
  if (id === 0) {
    return null;
  }
  if (!Number.isInteger(id) || id < 0 || id > dictionary.count) {
    throw new DneBinaryDatabaseFormatError(`Invalid binary FSST string id: ${id}`);
  }
  const { lengths, words, output, view } = states.get(dictionary) ?? prepareDecoder(data, dictionary);
  const index = id - 1;
  const block = index >>> DICTIONARY_BLOCK_SHIFT;
  const blockStart = block * DICTIONARY_BLOCK_SIZE;
  const relative = data.getUint32(dictionary.blockOffsetsOffset + block * 4, true);
  const nextRelative = block + 1 < dictionary.blockCount
    ? data.getUint32(dictionary.blockOffsetsOffset + (block + 1) * 4, true)
    : dictionary.suffixDataLength;
  if (relative > nextRelative || nextRelative > dictionary.suffixDataLength) {
    throw new DneBinaryDatabaseFormatError('Invalid binary FSST block offset');
  }
  let cursor = dictionary.suffixDataOffset + relative;
  const blockEnd = dictionary.suffixDataOffset + nextRelative;
  let previousLength = 0;
  for (let current = blockStart; current <= index; current++) {
    const compressedLength = dictionary.lengthWidth === 1
      ? mapped[dictionary.lengthsOffset + current] ?? 0
      : data.getUint16(dictionary.lengthsOffset + current * 2, true);
    const end = cursor + compressedLength;
    if (compressedLength > 510 || end > blockEnd) {
      throw new DneBinaryDatabaseFormatError('Invalid binary FSST compressed length');
    }
    let offset = mapped[dictionary.prefixesOffset + current] ?? 0;
    if (offset > previousLength) {
      throw new DneBinaryDatabaseFormatError('Invalid binary FSST prefix');
    }
    while (cursor < end) {
      const code = mapped[cursor++] ?? 0;
      if (code === 255) {
        if (cursor >= end || offset === 255) {
          throw new DneBinaryDatabaseFormatError('Invalid binary FSST escape');
        }
        output[offset++] = mapped[cursor++] ?? 0;
      } else {
        const length = lengths[code] ?? 0;
        if (length === 0 || length > 8 || offset + length > 255) {
          throw new DneBinaryDatabaseFormatError('Invalid binary FSST symbol');
        }
        view.setUint32(offset, words[code * 2] ?? 0, true);
        view.setUint32(offset + 4, words[code * 2 + 1] ?? 0, true);
        offset += length;
      }
    }
    previousLength = offset;
  }
  // The final entry must consume the block exactly, including the final partial block.
  if ((index + 1 === dictionary.count || (index + 1) % DICTIONARY_BLOCK_SIZE === 0) && cursor !== blockEnd) {
    throw new DneBinaryDatabaseFormatError('Invalid binary FSST block length');
  }
  return textDecoder.decode(output.subarray(0, previousLength));
}

/** Decodes a validated FSST string directly; ID and stream bounds are trusted. */
export function readTrustedFsstString(mapped: Uint8Array, data: DataView, dictionary: FsstDictionary, id: number): string {
  const { lengths, words, output, view } = states.get(dictionary) ?? prepareDecoder(data, dictionary);
  const index = id - 1;
  const block = index >>> DICTIONARY_BLOCK_SHIFT;
  let cursor = dictionary.suffixDataOffset + data.getUint32(dictionary.blockOffsetsOffset + block * 4, true);
  let decodedLength = 0;
  for (let current = block * DICTIONARY_BLOCK_SIZE; current <= index; current++) {
    const compressedLength = dictionary.lengthWidth === 1
      ? mapped[dictionary.lengthsOffset + current] as number
      : data.getUint16(dictionary.lengthsOffset + current * 2, true);
    const end = cursor + compressedLength;
    let offset = mapped[dictionary.prefixesOffset + current] as number;
    while (cursor < end) {
      const code = mapped[cursor++] as number;
      if (code === 255) {
        output[offset++] = mapped[cursor++] as number;
      } else {
        view.setUint32(offset, words[code * 2] as number, true);
        view.setUint32(offset + 4, words[code * 2 + 1] as number, true);
        offset += lengths[code] as number;
      }
    }
    decodedLength = offset;
  }
  return textDecoder.decode(output.subarray(0, decodedLength));
}
