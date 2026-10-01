// Experimental FSST decoder: fixed-width symbol copies and reusable UTF-8 output.
import { Buffer } from 'node:buffer';

type Dictionary = {
  blockOffsetsOffset: number;
  count: number;
  fsstMode: number;
  lengthsOffset: number;
  prefixesOffset: number;
  suffixDataLength: number;
  suffixDataOffset: number;
};
type State = {
  lengths: Uint8Array;
  words: Uint32Array;
  output: Buffer;
  view: DataView;
  pairLengths?: Uint8Array;
  pairWords?: Uint32Array;
};
const states = new WeakMap<Dictionary, State>();
const decoder = new TextDecoder();
const useBuffer = Bun.env['DNE_FSST_TEXT'] === 'buffer';
const copyBytes = Bun.env['DNE_FSST_COPY'] === 'bytes';
const usePairs = Bun.env['DNE_FSST_PAIRS'] === '1';

/** Decode the same FSST/front-coding format using a prepared symbol table. */
export function readFsstString(mapped: Uint8Array, data: DataView, dictionary: Dictionary, id: number, _scratch: Uint8Array) {
  if (id === 0) {
    return null;
  }
  if (id < 0 || id > dictionary.count) {
    throw new Error(`Invalid FSST dictionary ID: ${id}`);
  }
  let state = states.get(dictionary);
  if (state === undefined) {
    const symbolLengths = dictionary.prefixesOffset + (dictionary.fsstMode === 2 ? dictionary.count : 0);
    const lengths = mapped.slice(symbolLengths, symbolLengths + 255);
    const words = new Uint32Array(510);
    for (let word = 0; word < words.length; word++) {
      words[word] = data.getUint32(symbolLengths + 255 + word * 4, true);
    }
    const output = Buffer.alloc(272);
    state = { lengths, words, output, view: new DataView(output.buffer, output.byteOffset, output.byteLength) };
    if (usePairs) {
      const pairLengths = new Uint8Array(65536);
      const pairWords = new Uint32Array(65536 * 4);
      const pairView = new DataView(pairWords.buffer);
      for (let first = 0; first < 256; first++) {
        for (let second = 0; second < 256; second++) {
          const pair = first | (second << 8);
          if (first === 255) {
            pairLengths[pair] = 1;
            pairWords[pair * 4] = second;
            continue;
          }
          const leftLength = lengths[first] ?? 0;
          const rightLength = lengths[second] ?? 0;
          if (leftLength < 1 || leftLength > 8 || rightLength < 1 || rightLength > 8) {
            continue;
          }
          pairLengths[pair] = leftLength + rightLength;
          pairView.setUint32(pair * 16, words[first * 2] ?? 0, true);
          pairView.setUint32(pair * 16 + 4, words[first * 2 + 1] ?? 0, true);
          pairView.setUint32(pair * 16 + leftLength, words[second * 2] ?? 0, true);
          pairView.setUint32(pair * 16 + leftLength + 4, words[second * 2 + 1] ?? 0, true);
        }
      }
      state.pairLengths = pairLengths;
      state.pairWords = pairWords;
    }
    states.set(dictionary, state);
  }
  const { lengths, words, output, view, pairLengths, pairWords } = state;
  const index = id - 1;
  const blockStart = index & ~7;
  const relative = data.getUint32(dictionary.blockOffsetsOffset + (index >>> 3) * 4, true);
  if (relative > dictionary.suffixDataLength) {
    throw new Error('Invalid FSST block offset');
  }
  let cursor = dictionary.suffixDataOffset + relative;
  const payloadEnd = dictionary.suffixDataOffset + dictionary.suffixDataLength;
  const suffixMode = dictionary.fsstMode === 2;
  let previousLength = 0;
  for (let current = blockStart; current <= index; current++) {
    const end = cursor + (mapped[dictionary.lengthsOffset + current] ?? 0);
    if (end > payloadEnd) {
      throw new Error('Truncated FSST data');
    }
    if (!suffixMode && current !== index) {
      cursor = end;
      continue;
    }
    let offset = suffixMode ? mapped[dictionary.prefixesOffset + current] ?? 0 : 0;
    if (offset > previousLength) {
      throw new Error('Invalid FSST prefix');
    }
    while (cursor < end) {
      if (pairLengths && pairWords && cursor + 1 < end) {
        const pair = data.getUint16(cursor, true);
        const pairLength = pairLengths[pair] ?? 0;
        if (pairLength) {
          if (offset + pairLength > 255) {
            throw new Error('Invalid FSST symbol pair');
          }
          const word = pair * 4;
          view.setUint32(offset, pairWords[word] ?? 0, true);
          view.setUint32(offset + 4, pairWords[word + 1] ?? 0, true);
          view.setUint32(offset + 8, pairWords[word + 2] ?? 0, true);
          view.setUint32(offset + 12, pairWords[word + 3] ?? 0, true);
          offset += pairLength;
          cursor += 2;
          continue;
        }
      }
      const code = mapped[cursor++] ?? 0;
      if (code === 255) {
        if (cursor >= end || offset === 255) {
          throw new Error('Invalid FSST escape');
        }
        output[offset++] = mapped[cursor++] ?? 0;
      } else {
        const length = lengths[code] ?? 0;
        if (length < 1 || length > 8 || offset + length > 255) {
          throw new Error('Invalid FSST symbol');
        }
        const low = words[code * 2] ?? 0;
        const high = words[code * 2 + 1] ?? 0;
        if (copyBytes) {
          output[offset] = low;
          output[offset + 1] = low >>> 8;
          output[offset + 2] = low >>> 16;
          output[offset + 3] = low >>> 24;
          output[offset + 4] = high;
          output[offset + 5] = high >>> 8;
          output[offset + 6] = high >>> 16;
          output[offset + 7] = high >>> 24;
        } else {
          view.setUint32(offset, low, true);
          view.setUint32(offset + 4, high, true);
        }
        offset += length;
      }
    }
    previousLength = offset;
  }
  if (!useBuffer) {
    return decoder.decode(output.subarray(0, previousLength));
  }
  // TextDecoder strips one leading UTF-8 BOM; Buffer.toString preserves it.
  const start = previousLength >= 3 && output[0] === 0xef && output[1] === 0xbb && output[2] === 0xbf ? 3 : 0;
  return output.toString('utf8', start, previousLength);
}
